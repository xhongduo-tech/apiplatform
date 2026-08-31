"""Rendered Compose manifests must carry the runtime security contract."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _render(*files: str) -> dict:
    env = os.environ.copy()
    env.update({
        "POSTGRES_PASSWORD": "compose-test-postgres-password",
        "REDIS_PASSWORD": "compose-test-redis-password",
        "REDIS_SENTINEL_PASSWORD": "compose-test-sentinel-password",
        "JWT_SECRET": "compose-test-jwt-secret-at-least-32-characters",
        "DATA_ENCRYPTION_KEY": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        "ADMIN_BOOTSTRAP_TOKEN": "compose-test-bootstrap-token-at-least-32-random-bytes-2026",
        "RATE_LIMIT_RPM": "321",
        "RATE_LIMIT_TPM": "654321",
        "RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS": "2345",
        "PLATFORM_TIMEZONE": "Europe/Paris",
        "REDIS_CONNECT_TIMEOUT_S": "1.25",
        "REDIS_SOCKET_TIMEOUT_S": "2.5",
        "RATE_LIMIT_ADMISSION_TIMEOUT_S": "2.75",
        "REDIS_DB": "4",
    })
    command = ["docker", "compose"]
    for filename in files:
        command.extend(("-f", filename))
    command.extend(("config", "--format", "json"))
    result = subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker compose unavailable")
def test_standard_compose_passes_rate_limit_and_redis_safety_settings():
    rendered = _render("docker-compose.app.yml")
    environment = rendered["services"]["backend"]["environment"]
    assert environment["RATE_LIMIT_RPM"] == "321"
    assert environment["RATE_LIMIT_TPM"] == "654321"
    assert environment["RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS"] == "2345"
    assert environment["PLATFORM_TIMEZONE"] == "Europe/Paris"
    assert environment["REDIS_CONNECT_TIMEOUT_S"] == "1.25"
    assert environment["REDIS_SOCKET_TIMEOUT_S"] == "2.5"
    assert environment["RATE_LIMIT_ADMISSION_TIMEOUT_S"] == "2.75"
    assert environment["REDIS_DB"] == "4"


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker compose unavailable")
def test_sentinel_overlay_actually_switches_backend_to_sentinel_discovery():
    rendered = _render("docker-compose.app.yml", "docker-compose.sentinel.yml")
    environment = rendered["services"]["backend"]["environment"]
    assert environment["REDIS_SENTINEL_NODES"] == (
        "redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379"
    )
    assert environment["REDIS_SENTINEL_MASTER"] == "apiplatform-master"
    assert environment["REDIS_SENTINEL_PASSWORD"] == "compose-test-sentinel-password"
    assert environment["REDIS_DB"] == "4"
    for service_name in ("redis-sentinel-1", "redis-sentinel-2", "redis-sentinel-3"):
        sentinel = rendered["services"][service_name]
        assert sentinel["environment"]["REDIS_SENTINEL_PASSWORD"] == (
            "compose-test-sentinel-password"
        )
        assert "requirepass %s" in "\n".join(sentinel["command"])
