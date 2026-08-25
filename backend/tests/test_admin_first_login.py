"""管理员首次登录设密回归测试。"""
from __future__ import annotations

import base64
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.admin_credentials import (
    ADMIN_CREDENTIALS_KEY,
    AdminAuthentication,
    AdminPasswordPolicyError,
    AdminSetupRequired,
    admin_password_is_initialized,
    authenticate_or_initialize_admin,
    validate_admin_password,
)
from app.auth import hash_password, verify_password
from app.models import PlatformSettingORM


@pytest.fixture
def credential_db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    PlatformSettingORM.__table__.create(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    with session_factory() as db:
        yield db
    engine.dispose()


def test_password_hash_is_versioned_and_legacy_hashes_still_verify():
    password = "Correct-Horse-7!"
    stored = hash_password(password)
    assert stored.startswith("pbkdf2_sha256$600000$")
    assert password not in stored
    assert verify_password(password, stored)
    assert not verify_password("wrong", stored)

    # 旧用户记录是 base64(16-byte salt + 32-byte PBKDF2 digest)，必须继续可登录。
    salt = b"0123456789abcdef"
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)
    legacy = base64.b64encode(salt + digest).decode("ascii")
    assert verify_password(password, legacy)
    assert not verify_password("wrong", legacy)
    assert not verify_password(password, "not-a-valid-hash")


@pytest.mark.parametrize("password", [
    "Short1!",
    "alllowercasepassword",
    "1234567890123456",
    "A" * 129 + "1!",
])
def test_admin_password_policy_rejects_weak_passwords(password: str):
    with pytest.raises(AdminPasswordPolicyError):
        validate_admin_password(password)


def test_admin_password_policy_accepts_a_unicode_passphrase():
    validate_admin_password("管理员平台安全密码-2026")


def test_first_login_requires_confirmation_and_only_stores_hash(credential_db):
    password = "Open-Platform-7!"
    assert not admin_password_is_initialized(credential_db)

    with pytest.raises(AdminSetupRequired):
        authenticate_or_initialize_admin(credential_db, password)
    with pytest.raises(AdminPasswordPolicyError, match="不一致"):
        authenticate_or_initialize_admin(credential_db, password, "Different-Password-8!")

    result = authenticate_or_initialize_admin(credential_db, password, password)
    assert result == AdminAuthentication(authenticated=True, initialized_now=True)
    assert admin_password_is_initialized(credential_db)

    row = credential_db.get(PlatformSettingORM, ADMIN_CREDENTIALS_KEY)
    assert row is not None
    assert row.value.get("version") == 1
    assert row.value["password_hash"].startswith("pbkdf2_sha256$")
    assert password not in str(row.value)

    assert authenticate_or_initialize_admin(credential_db, password).authenticated
    assert not authenticate_or_initialize_admin(credential_db, "Wrong-Password-8!").authenticated


def test_first_login_recovers_an_empty_migration_placeholder(credential_db):
    credential_db.add(PlatformSettingORM(key=ADMIN_CREDENTIALS_KEY, value={}))
    credential_db.commit()

    result = authenticate_or_initialize_admin(
        credential_db, "Open-Platform-7!", "Open-Platform-7!",
    )
    assert result == AdminAuthentication(authenticated=True, initialized_now=True)
    assert admin_password_is_initialized(credential_db)


class _AvailableRedis:
    async def get(self, _key):
        return None

    async def delete(self, *_keys):
        return 0


def test_admin_login_endpoint_initializes_then_authenticates(credential_db, monkeypatch):
    from app.database import get_db
    from app.routers import admin as admin_router

    app = FastAPI()
    app.include_router(admin_router.router, prefix="/api")

    def _get_test_db():
        yield credential_db

    app.dependency_overrides[get_db] = _get_test_db
    monkeypatch.setattr(admin_router, "redis", _AvailableRedis())

    with TestClient(app) as client:
        status = client.get("/api/admin/login/status")
        assert status.status_code == 200
        assert status.json() == {
            "initialized": False,
            "bootstrapRequired": False,
            "passwordMinLength": 12,
            "passwordMaxLength": 128,
        }
        assert status.headers["cache-control"] == "no-store"

        assert client.post(
            "/api/admin/login", json={"password": "Open-Platform-7!"},
        ).status_code == 409
        assert client.post(
            "/api/admin/login",
            json={"password": "too-weak", "password_confirmation": "too-weak"},
        ).status_code == 400

        initialized = client.post("/api/admin/login", json={
            "password": "Open-Platform-7!",
            "password_confirmation": "Open-Platform-7!",
        })
        assert initialized.status_code == 200
        assert initialized.json()["initializedNow"] is True
        assert initialized.json()["token"]
        assert "platform_admin_session=" in initialized.headers.get("set-cookie", "")
        assert "HttpOnly" in initialized.headers.get("set-cookie", "")
        assert "SameSite=lax" in initialized.headers.get("set-cookie", "")
        assert "Path=/api/admin" in initialized.headers.get("set-cookie", "")
        assert initialized.headers["cache-control"] == "no-store"

        logged_in = client.post(
            "/api/admin/login", json={"password": "Open-Platform-7!"},
        )
        assert logged_in.status_code == 200
        assert logged_in.json()["initializedNow"] is False

        # 浏览器默认走 HttpOnly cookie；退出只清浏览器会话，不破坏显式 Bearer
        # 客户端的兼容性。
        assert client.get("/api/admin/session").status_code == 200
        logged_out = client.post("/api/admin/logout")
        assert logged_out.status_code == 200
        assert "Path=/api/admin" in logged_out.headers.get("set-cookie", "")
        assert client.get("/api/admin/session").status_code == 401
        bearer = client.get("/api/admin/session", headers={
            "Authorization": f"Bearer {logged_in.json()['token']}",
        })
        assert bearer.status_code == 200


def test_admin_bootstrap_token_is_required_only_for_first_claim(credential_db, monkeypatch):
    from app.config import settings
    from app.database import get_db
    from app.routers import admin as admin_router

    app = FastAPI()
    app.include_router(admin_router.router, prefix="/api")

    def _get_test_db():
        yield credential_db

    app.dependency_overrides[get_db] = _get_test_db
    monkeypatch.setattr(admin_router, "redis", _AvailableRedis())
    monkeypatch.setattr(settings, "ADMIN_BOOTSTRAP_TOKEN", "one-time-bootstrap-secret")

    with TestClient(app) as client:
        status = client.get("/api/admin/login/status")
        assert status.json()["bootstrapRequired"] is True

        denied = client.post("/api/admin/login", json={
            "password": "Open-Platform-7!",
            "password_confirmation": "Open-Platform-7!",
            "bootstrap_token": "wrong",
        })
        assert denied.status_code == 403

        claimed = client.post("/api/admin/login", json={
            "password": "Open-Platform-7!",
            "password_confirmation": "Open-Platform-7!",
            "bootstrap_token": "one-time-bootstrap-secret",
        })
        assert claimed.status_code == 200

        # 初始化后环境中的 bootstrap token 被忽略，普通密码登录即可。
        logged_in = client.post("/api/admin/login", json={"password": "Open-Platform-7!"})
        assert logged_in.status_code == 200
