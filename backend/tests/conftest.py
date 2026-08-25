"""测试环境变量（必须在 import app 之前生效）+ 依赖 Postgres 的用例门控。

绝大多数用例是纯逻辑单测，不碰任何外部服务。集成用例必须通过环境变量显式
指向 CI service 或临时测试容器；本地默认使用非标准端口和独立测试库名，避免
误连开发库、旧系统数据库或其持久卷。
"""
from __future__ import annotations

import os

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("REDIS_REQUIRED_ON_STARTUP", "false")
# 安全默认值刻意不指向常见的 5432/6379；需要集成测试时显式覆盖。
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://platform:platform_test_postgres@127.0.0.1:65432/openapi_platform_test",
)
os.environ.setdefault("REDIS_URL", "redis://:platform_test_redis@127.0.0.1:6399/0")
os.environ.setdefault("JWT_SECRET", "platform-test-jwt-secret-only-for-tests")
# Keep encrypted fixtures stable across test processes and local reruns.  The
# isolated test database must never depend on a developer's ambient secrets.
os.environ.setdefault(
    "DATA_ENCRYPTION_KEY",
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
)

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_auth_rate_limits():
    """认证限流是进程内状态；每个测试用例必须使用独立窗口。"""
    from app.auth_rate_limit import reset_local_auth_rate_limits

    reset_local_auth_rate_limits()
    yield
    reset_local_auth_rate_limits()


@pytest.fixture(scope="session")
def db_ready() -> bool:
    """库可达则建表（幂等）并返回 True；不可达返回 False，由用例自行 skip。"""
    from app.database import init_db

    try:
        init_db()
        return True
    except Exception:
        return False


@pytest.fixture
def requires_db(db_ready: bool) -> None:
    if not db_ready:
        pytest.skip("需要通过 DATABASE_URL 显式提供隔离的测试 Postgres")
