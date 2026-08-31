"""本地账号会话、密码策略与认证限流安全回归。"""
from __future__ import annotations

import time

import pytest
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.auth import (
    PASSWORD_MAX_LENGTH,
    PasswordPolicyError,
    clear_user_session_cookie,
    create_user_token,
    decode_token,
    issue_token,
    hash_password,
    require_recent_admin,
    require_user,
    set_user_session_cookie,
    validate_password,
    validate_user_session,
)
from app.auth_rate_limit import enforce_auth_rate, reset_local_auth_rate_limits
from app.config import settings
from app.models import UserORM
from app.routers.user import UserLoginIn, UserRegisterIn


@pytest.fixture
def user_db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    UserORM.__table__.create(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        yield db
    engine.dispose()


def test_password_policy_and_request_length_bounds():
    validate_password("Correct-Horse-7!")
    validate_password("管理员平台安全密码-2026")
    for weak in ("Short1!", "alllowercasepassword", "1234567890123456"):
        with pytest.raises(PasswordPolicyError):
            validate_password(weak)
    with pytest.raises(ValidationError):
        UserRegisterIn(authId="u", name="n", password="A" * (PASSWORD_MAX_LENGTH + 1))
    with pytest.raises(ValidationError):
        UserLoginIn(authId="u", password="A" * (PASSWORD_MAX_LENGTH + 1))


def test_public_registration_and_api_key_recovery_default_closed():
    assert settings.ALLOW_PUBLIC_REGISTRATION is False
    assert settings.ALLOW_PASSWORD_RECOVERY is False


def test_jwt_has_bound_context_and_distinct_token_types():
    admin_token = issue_token("admin", "admin")
    admin = decode_token(admin_token)
    assert admin["iss"] == settings.JWT_ISSUER
    assert admin["aud"] == settings.JWT_AUDIENCE
    assert admin["token_type"] == "admin_session"
    assert admin["jti"] and admin["iat"] and admin["exp"]

    user_token = create_user_token("u-1", "用户", "研发", 42)["token"]
    user = decode_token(user_token)
    assert user["token_type"] == "user_session"
    assert user["ver"] == 42
    assert user["jti"] != admin["jti"]


def test_recent_admin_uses_configured_reauthentication_window(monkeypatch):
    claims = decode_token(issue_token("admin", "admin"))
    monkeypatch.setattr(settings, "ADMIN_SENSITIVE_ACTION_MAX_AGE_S", 60)
    claims["iat"] = int(time.time()) - 61
    with pytest.raises(HTTPException) as stale:
        require_recent_admin(claims)
    assert stale.value.status_code == 401


def test_password_reset_version_and_account_status_revoke_old_jwt(user_db):
    user = UserORM(auth_id="session-user", name="会话用户", department="研发")
    user_db.add(user)
    user_db.commit()
    token = create_user_token(user.auth_id, user.name, user.department, user.token_version)["token"]
    assert validate_user_session(user_db, token)["sub"] == user.auth_id

    user.token_version += 1
    user_db.commit()
    with pytest.raises(HTTPException) as stale:
        validate_user_session(user_db, token)
    assert stale.value.status_code == 401

    current = create_user_token(user.auth_id, user.name, user.department, user.token_version)["token"]
    user.is_active = False
    user_db.commit()
    with pytest.raises(HTTPException) as disabled:
        validate_user_session(user_db, current)
    assert disabled.value.status_code == 401


def test_user_cookie_is_http_only_same_site_and_clearable(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_COOKIE_SECURE", True)
    response = Response()
    set_user_session_cookie(response, "signed-token")
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert "Secure" in cookie
    assert "signed-token" in cookie
    assert "Path=/api" in cookie

    cleared = Response()
    clear_user_session_cookie(cleared)
    clear_header = cleared.headers["set-cookie"]
    assert "Max-Age=0" in clear_header
    assert "HttpOnly" in clear_header
    assert "Path=/api" in clear_header


def test_browser_session_uses_cookie_while_bearer_remains_compatible(user_db, monkeypatch):
    from app.database import get_db
    from app.routers import user as user_router

    async def _no_rate(*_args, **_kwargs):
        return None

    monkeypatch.setattr(user_router, "enforce_auth_rate", _no_rate)
    monkeypatch.setattr(settings, "SESSION_COOKIE_SECURE", False)
    user = UserORM(
        auth_id="cookie-user", name="Cookie 用户", department="研发",
        password_hash=hash_password("Correct-Horse-7!"),
    )
    user_db.add(user)
    user_db.commit()

    app = FastAPI()
    app.include_router(user_router.router, prefix="/api")

    def _get_test_db():
        yield user_db

    app.dependency_overrides[get_db] = _get_test_db
    with TestClient(app) as client:
        login = client.post("/api/user/login", json={
            "authId": "cookie-user", "password": "Correct-Horse-7!",
        })
        assert login.status_code == 200
        token = login.json()["token"]
        assert "HttpOnly" in login.headers["set-cookie"]
        assert login.headers["cache-control"] == "no-store"

        restored = client.get("/api/user/session")
        assert restored.status_code == 200
        assert restored.json()["authId"] == "cookie-user"
        assert "token" not in restored.json()
        assert restored.headers["cache-control"] == "no-store"

        logged_out = client.post("/api/user/logout")
        assert logged_out.status_code == 200
        assert client.get("/api/user/session").status_code == 401

        # 清 cookie 不影响显式 Bearer 客户端；服务端撤销由 token_version 负责。
        bearer = client.get(
            "/api/user/session", headers={"Authorization": f"Bearer {token}"},
        )
        assert bearer.status_code == 200


def test_cookie_session_rejects_cross_site_mutation_but_bearer_remains_compatible(user_db):
    from app.database import get_db

    user = UserORM(auth_id="csrf-user", name="CSRF 用户", department="研发")
    user_db.add(user)
    user_db.commit()
    token = create_user_token(user.auth_id, user.name, user.department, user.token_version)["token"]

    app = FastAPI()

    @app.post("/api/protected")
    def protected(_claims: dict = Depends(require_user)):
        return {"ok": True}

    def _get_test_db():
        yield user_db

    app.dependency_overrides[get_db] = _get_test_db
    with TestClient(app, base_url="http://gateway.example:18080") as client:
        client.cookies.set(settings.USER_SESSION_COOKIE, token, path="/api")
        assert client.post("/api/protected").status_code == 200
        assert client.post(
            "/api/protected",
            headers={
                "Origin": "http://gateway.example:18080",
                "Sec-Fetch-Site": "same-origin",
            },
        ).status_code == 200
        assert client.post(
            "/api/protected", headers={"Origin": "https://attacker.example"},
        ).status_code == 403
        assert client.post(
            "/api/protected", headers={"Sec-Fetch-Site": "same-site"},
        ).status_code == 403
        bearer = client.post(
            "/api/protected",
            headers={
                "Origin": "https://attacker.example",
                "Authorization": f"Bearer {token}",
            },
        )
        assert bearer.status_code == 200


class _BrokenRedis:
    def pipeline(self):
        raise ConnectionError("redis unavailable")


@pytest.mark.asyncio
async def test_auth_rate_limit_keeps_local_protection_when_redis_fails(monkeypatch):
    from app import auth_rate_limit

    monkeypatch.setattr(auth_rate_limit, "redis", _BrokenRedis())
    reset_local_auth_rate_limits()
    request = Request({
        "type": "http",
        "method": "POST",
        "path": "/api/user/login",
        "headers": [],
        "client": ("203.0.113.9", 12345),
    })
    for _ in range(2):
        await enforce_auth_rate(
            request, action="unit-login", account="same-account",
            client_limit=2, account_limit=2, window_s=60,
        )
    with pytest.raises(HTTPException) as limited:
        await enforce_auth_rate(
            request, action="unit-login", account="same-account",
            client_limit=2, account_limit=2, window_s=60,
        )
    assert limited.value.status_code == 429
    assert int(limited.value.headers["Retry-After"]) >= 1
