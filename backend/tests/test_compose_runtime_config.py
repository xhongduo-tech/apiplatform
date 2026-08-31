"""Rendered Compose manifests must carry the runtime security contract."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _render(*files: str, env_overrides: dict[str, str] | None = None) -> dict:
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
    if env_overrides:
        env.update(env_overrides)
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


def _assert_restricted(
    service: dict,
    *,
    tmpfs: str,
    allowed_cap_add: list[str] | None = None,
) -> None:
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service.get("cap_add", []) == (allowed_cap_add or [])
    assert service["security_opt"] == ["no-new-privileges:true"]
    assert tmpfs in service["tmpfs"]


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
def test_standard_compose_renders_third_party_container_boundaries():
    rendered = _render("docker-compose.app.yml")
    services = rendered["services"]

    postgres = services["postgres"]
    _assert_restricted(postgres, tmpfs="/tmp:size=32m,mode=1777")
    assert postgres["user"] == "70:70"
    assert "/var/run/postgresql:size=16m,uid=70,gid=70,mode=3775" in (
        postgres["tmpfs"]
    )
    assert postgres["ports"][0]["host_ip"] == "127.0.0.1"

    backup = services["pg-backup"]
    _assert_restricted(
        backup,
        tmpfs="/tmp:size=32m,mode=1777",
        allowed_cap_add=["CHOWN"],
    )
    assert backup["entrypoint"] == ["/bin/sh", "/backup-loop.sh"]

    redis = services["redis"]
    _assert_restricted(redis, tmpfs="/tmp:size=32m,mode=1777")
    assert redis["user"] == "999:1000"
    assert redis["ports"][0]["host_ip"] == "127.0.0.1"

    prometheus = services["prometheus"]
    _assert_restricted(prometheus, tmpfs="/tmp:size=32m,mode=1777")
    assert prometheus["ports"][0]["host_ip"] == "127.0.0.1"

    grafana = services["grafana"]
    _assert_restricted(grafana, tmpfs="/tmp:size=64m,mode=1777")
    assert grafana["ports"][0]["host_ip"] == "127.0.0.1"
    grafana_environment = grafana["environment"]
    assert grafana_environment["GF_AUTH_ANONYMOUS_ENABLED"] == "false"
    assert grafana_environment["GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION"] == "true"
    assert grafana_environment["GF_PLUGINS_PLUGIN_ADMIN_ENABLED"] == "false"


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
    backend_dependencies = rendered["services"]["backend"]["depends_on"]
    assert backend_dependencies["redis-sentinel-quorum"]["condition"] == (
        "service_completed_successfully"
    )

    redis = rendered["services"]["redis"]
    assert redis["entrypoint"] == [
        "/bin/sh",
        "/usr/local/bin/redis-sentinel-bootstrap.sh",
    ]
    assert redis["environment"]["REDIS_NODE_NAME"] == "redis"
    assert any(
        volume["target"] == "/usr/local/bin/redis-sentinel-bootstrap.sh"
        and volume["read_only"] is True
        for volume in redis["volumes"]
    )

    replica = rendered["services"]["redis-replica"]
    _assert_restricted(replica, tmpfs="/tmp:size=16m,mode=1777")
    assert replica["user"] == "999:1000"
    assert replica.get("depends_on") is None
    assert replica["entrypoint"] == [
        "/bin/sh",
        "/usr/local/bin/redis-sentinel-bootstrap.sh",
    ]
    assert replica["environment"]["REDIS_NODE_NAME"] == "redis-replica"
    assert any(
        volume["source"] == "redisreplicadata" and volume["target"] == "/data"
        for volume in replica["volumes"]
    )
    for index, service_name in enumerate(
        ("redis-sentinel-1", "redis-sentinel-2", "redis-sentinel-3"), start=1
    ):
        sentinel = rendered["services"][service_name]
        _assert_restricted(sentinel, tmpfs="/tmp:size=16m,mode=1777")
        assert sentinel["user"] == "999:1000"
        assert sentinel["volumes"] == [
            {
                "type": "volume",
                "source": f"redissentinel{index}data",
                "target": "/data",
                "volume": {},
            }
        ]
        sentinel_command = "\n".join(sentinel["command"])
        assert "config=/data/sentinel.conf" in sentinel_command
        assert "if [ ! -s \"$$config\" ]" in sentinel_command
        assert "exec redis-sentinel \"$$config\"" in sentinel_command
        assert sentinel["environment"]["REDIS_SENTINEL_PASSWORD"] == (
            "compose-test-sentinel-password"
        )
        assert sentinel["environment"]["SENTINEL_ANNOUNCE_HOST"] == service_name
        assert "requirepass %s" in "\n".join(sentinel["command"])
        sentinel_command = "\n".join(sentinel["command"])
        assert "sentinel announce-ip $${SENTINEL_ANNOUNCE_HOST}" in sentinel_command
        assert "known-sentinel apiplatform-master" in sentinel_command
        assert "passwords must be independent" in sentinel_command

    gate = rendered["services"]["redis-sentinel-quorum"]
    _assert_restricted(gate, tmpfs="/tmp:size=16m,mode=1777")
    assert gate["user"] == "999:1000"
    assert gate["restart"] == "no"
    assert gate["environment"]["REDIS_SENTINEL_BOOTSTRAP_MODE"] == "gate"


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker compose unavailable")
def test_sentinel_overlay_rejects_an_empty_management_password():
    with pytest.raises(subprocess.CalledProcessError):
        _render(
            "docker-compose.app.yml",
            "docker-compose.sentinel.yml",
            env_overrides={"REDIS_SENTINEL_PASSWORD": ""},
        )
