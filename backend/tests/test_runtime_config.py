"""生产运行时配置必须拒绝示例、开发和缺失凭据。"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.config import _b, settings
from app.encrypted_types import clear_encryption_key_cache
from app.config_preflight import validate_runtime_config as _validate_runtime_config


_VALID = {
    "DATABASE_URL": "postgresql+psycopg://platform:random-db-secret@postgres:5432/openapi_platform",
    "REDIS_URL": "redis://:random-redis-secret@redis:6379/0",
    "REDIS_PASSWORD": "random-redis-secret",
    "JWT_SECRET": "a-unique-production-jwt-secret-with-48-characters-123",
    "DATA_ENCRYPTION_KEY": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    "ADMIN_BOOTSTRAP_TOKEN": "7ef83612a4c90bd5e2810f47a693bc58d1046efa92b7c503bd816e02d579ac43",
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


def test_production_rejects_missing_admin_bootstrap_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _production(monkeypatch)
    monkeypatch.delenv("ADMIN_BOOTSTRAP_TOKEN")
    with pytest.raises(RuntimeError, match="ADMIN_BOOTSTRAP_TOKEN"):
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
    _production(monkeypatch, ADMIN_BOOTSTRAP_TOKEN="too-short")
    with pytest.raises(RuntimeError, match="ADMIN_BOOTSTRAP_TOKEN"):
        _validate_runtime_config()


def test_production_rejects_low_diversity_admin_bootstrap_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _production(monkeypatch, ADMIN_BOOTSTRAP_TOKEN="a" * 64)
    with pytest.raises(RuntimeError, match="ADMIN_BOOTSTRAP_TOKEN"):
        _validate_runtime_config()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("true", True), ("TRUE", True), ("1", True), ("yes", True), ("on", True),
        ("false", False), ("FALSE", False), ("0", False), ("no", False), ("off", False),
    ],
)
def test_boolean_parser_accepts_only_explicit_values(monkeypatch, raw, expected):
    monkeypatch.setenv("STRICT_BOOLEAN_TEST", raw)
    assert _b("STRICT_BOOLEAN_TEST", not expected) is expected


def test_boolean_parser_rejects_typo_instead_of_downgrading(monkeypatch):
    monkeypatch.setenv("STRICT_BOOLEAN_TEST", "ture")
    with pytest.raises(ValueError, match="STRICT_BOOLEAN_TEST"):
        _b("STRICT_BOOLEAN_TEST", False)


def test_invalid_boolean_fails_during_fresh_config_import():
    env = os.environ.copy()
    env["NIGHT_UNLIMITED_ENABLED"] = "enable"
    result = subprocess.run(
        [sys.executable, "-c", "import app.config"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "NIGHT_UNLIMITED_ENABLED" in result.stderr


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("RATE_LIMIT_RPM", "six-hundred"),
        ("REDIS_CONNECT_TIMEOUT_S", "soon"),
        ("REDIS_SOCKET_TIMEOUT_S", "NaN"),
    ],
)
def test_invalid_explicit_number_fails_during_fresh_config_import(name, value):
    env = os.environ.copy()
    env[name] = value
    result = subprocess.run(
        [sys.executable, "-c", "import app.config"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert name in result.stderr


@pytest.mark.parametrize("name", ["RATE_LIMIT_RPM", "RATE_LIMIT_TPM"])
@pytest.mark.parametrize("value", [0, -1])
def test_production_rejects_disabled_global_rate_limit(monkeypatch, name, value):
    _production(monkeypatch)
    monkeypatch.setattr(settings, name, value)
    with pytest.raises(RuntimeError, match=name):
        _validate_runtime_config()


@pytest.mark.parametrize(
    "name",
    [
        "REDIS_CONNECT_TIMEOUT_S",
        "REDIS_SOCKET_TIMEOUT_S",
        "RATE_LIMIT_ADMISSION_TIMEOUT_S",
        "RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS",
    ],
)
def test_production_rejects_nonpositive_rate_limit_safety_bound(monkeypatch, name):
    _production(monkeypatch)
    monkeypatch.setattr(settings, name, 0)
    with pytest.raises(RuntimeError, match=name):
        _validate_runtime_config()


def test_production_accepts_valid_night_window_timezone(monkeypatch):
    _production(monkeypatch)
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(settings, "PLATFORM_TIMEZONE", "Asia/Shanghai")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_START", "19:00")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_END", "07:30")
    _validate_runtime_config()


def test_development_also_rejects_invalid_enabled_night_window(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(settings, "PLATFORM_TIMEZONE", "not/an-iana-zone")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_START", "19:00")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_END", "07:30")
    with pytest.raises(RuntimeError, match="PLATFORM_TIMEZONE"):
        _validate_runtime_config()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("PLATFORM_TIMEZONE", "Mars/Olympus"),
        ("NIGHT_UNLIMITED_START", "7:30"),
        ("NIGHT_UNLIMITED_END", "25:00"),
        ("NIGHT_UNLIMITED_END", "19:00"),
    ],
)
def test_production_rejects_invalid_enabled_night_window(monkeypatch, name, value):
    _production(monkeypatch)
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(settings, "PLATFORM_TIMEZONE", "Asia/Shanghai")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_START", "19:00")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_END", "07:30")
    monkeypatch.setattr(settings, name, value)
    with pytest.raises(RuntimeError, match="PLATFORM_TIMEZONE|HH:MM"):
        _validate_runtime_config()
