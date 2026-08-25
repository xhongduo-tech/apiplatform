"""生产运行时配置必须拒绝示例、开发和缺失凭据。"""
from __future__ import annotations

import pytest

from app.config import settings
from app.encrypted_types import clear_encryption_key_cache
from app.config_preflight import validate_runtime_config as _validate_runtime_config


_VALID = {
    "DATABASE_URL": "postgresql+psycopg://platform:random-db-secret@postgres:5432/openapi_platform",
    "REDIS_URL": "redis://:random-redis-secret@redis:6379/0",
    "REDIS_PASSWORD": "random-redis-secret",
    "JWT_SECRET": "a-unique-production-jwt-secret-with-48-characters-123",
    "DATA_ENCRYPTION_KEY": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
}


def _production(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    for name, value in (_VALID | overrides).items():
        monkeypatch.setenv(name, value)
    clear_encryption_key_cache()


def test_production_accepts_explicit_random_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    _production(monkeypatch)
    _validate_runtime_config()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("JWT_SECRET", "replace-with-at-least-32-random-bytes"),
        ("JWT_SECRET", "platform-dev-only-jwt-secret-not-for-production"),
        ("REDIS_PASSWORD", "platform_dev_redis"),
        (
            "DATABASE_URL",
            "postgresql+psycopg://platform:platform_dev_postgres@postgres:5432/openapi_platform",
        ),
    ],
)
def test_production_rejects_known_placeholder_or_dev_credentials(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    _production(monkeypatch, **{name: value})
    with pytest.raises(RuntimeError, match="示例或开发凭据"):
        _validate_runtime_config()


def test_production_rejects_missing_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    _production(monkeypatch)
    monkeypatch.delenv("JWT_SECRET")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        _validate_runtime_config()


def test_development_keeps_local_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    for name in _VALID:
        monkeypatch.delenv(name, raising=False)
    _validate_runtime_config()


def test_unknown_environment_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "prod")
    with pytest.raises(RuntimeError, match="ENVIRONMENT"):
        _validate_runtime_config()


def test_production_rejects_invalid_data_encryption_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _production(monkeypatch, DATA_ENCRYPTION_KEY="not-a-256-bit-key")
    with pytest.raises(RuntimeError, match="URL-safe base64|32 字节"):
        _validate_runtime_config()


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("JWT_TTL_HOURS", 0, "JWT_TTL_HOURS"),
        ("USER_JWT_TTL_HOURS", 25, "USER_JWT_TTL_HOURS"),
        ("ADMIN_SENSITIVE_ACTION_MAX_AGE_S", 59, "ADMIN_SENSITIVE_ACTION_MAX_AGE_S"),
        ("BACKUP_INTERVAL_S", 59, "BACKUP_INTERVAL_S"),
    ],
)
def test_production_rejects_unsafe_session_windows(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: int,
    message: str,
) -> None:
    _production(monkeypatch)
    monkeypatch.setattr(settings, name, value)
    with pytest.raises(RuntimeError, match=message):
        _validate_runtime_config()


def test_production_rejects_short_admin_bootstrap_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _production(monkeypatch)
    monkeypatch.setattr(settings, "ADMIN_BOOTSTRAP_TOKEN", "too-short")
    with pytest.raises(RuntimeError, match="ADMIN_BOOTSTRAP_TOKEN"):
        _validate_runtime_config()
