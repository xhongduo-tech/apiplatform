from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_docker_build_context_excludes_credentials_and_test_artifacts():
    rules = (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

    required = {
        ".git/",
        ".env",
        "**/.env",
        "**/.dev-jwt-secret",
        "**/*.local",
        "**/*.dump",
        "**/*.sql",
        "**/*.db",
        "**/*.sqlite3",
        "**/*.pem",
        "**/*.key",
        "**/.coverage",
        "**/coverage.xml",
        "**/test-results/",
        "**/playwright-report/",
        "/release/",
        "/backend/data/usage_failover.jsonl",
        "/seed/",
    }
    assert required <= set(rules)

    backend_rules = (ROOT / "backend/.dockerignore").read_text(
        encoding="utf-8"
    ).splitlines()
    assert {"*.local", "**/*.local", "*.db", "*.sqlite3", "data/*"} <= set(
        backend_rules
    )


def test_offline_build_identity_covers_all_source_and_variant_inputs():
    script = (ROOT / "build-offline.sh").read_text(encoding="utf-8")

    assert "grep -Ev '^release/'" not in script
    assert 'BUILD_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"' in script
    assert 'VITE_ORIGIN="${VITE_PUBLIC_API_ORIGIN:-http://localhost}"' in script
    assert 'BUILD_VARIANT_SHA256="$(' in script
    assert 'content_tag_for() {' in script
    assert "printf '%s:sha256-%s\\n'" in script
    assert 'bind_content_tag() {' in script
    assert 'existing_id}" != "${build_id}' in script


def test_read_only_backend_disables_gunicorn_control_socket():
    entrypoint = (ROOT / "backend/entrypoint.sh").read_text(encoding="utf-8")

    assert "--no-control-socket" in entrypoint


def test_offline_health_probe_is_independent_of_host_bind_and_port():
    deploy = (ROOT / "deploy-offline.sh").read_text(encoding="utf-8")

    assert "exec -T nginx" in deploy
    assert "http://127.0.0.1:8080/health" in deploy
    assert "port nginx 8080" in deploy
    assert 'PORT="${HTTP_PORT:-80}"' not in deploy
    assert 'http://127.0.0.1:${PORT}/health' not in deploy
