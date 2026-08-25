"""客户端鉴权头归一化。"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import normalize_client_auth
from app.models import UserORM


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


def test_normalize_bearer_passthrough():
    assert normalize_client_auth("Bearer sk-platform-abc") == "Bearer sk-platform-abc"


def test_normalize_x_api_key():
    assert normalize_client_auth(None, "sk-platform-abc") == "Bearer sk-platform-abc"


# ── 登录态的 role 隔离 ────────────────────────────────────────────────────────
def _bearer(token: str) -> str:
    return f"Bearer {token}"


def test_require_user_accepts_user_token(user_db):
    from app.auth import create_user_token, require_user

    user = UserORM(auth_id="12345", name="张三", department="研发")
    user_db.add(user)
    user_db.commit()
    tok = create_user_token(user.auth_id, user.name, user.department, user.token_version)["token"]
    claims = require_user(None, _bearer(tok), None, user_db)
    assert claims["sub"] == "12345" and claims["role"] == "user"


def test_require_user_rejects_admin_token(user_db):
    """admin token 的 sub 是 "admin" 而非工号；放进按工号过滤的用户端点没有意义。"""
    import pytest
    from fastapi import HTTPException

    from app.auth import issue_token, require_user

    tok = issue_token("admin", "admin")
    with pytest.raises(HTTPException) as e:
        require_user(None, _bearer(tok), None, user_db)
    assert e.value.status_code == 403


def test_require_admin_rejects_user_token():
    import pytest
    from fastapi import HTTPException

    from app.auth import create_user_token, require_admin

    tok = create_user_token("12345", "张三", "研发")["token"]
    with pytest.raises(HTTPException) as e:
        require_admin(None, _bearer(tok))
    assert e.value.status_code == 403
