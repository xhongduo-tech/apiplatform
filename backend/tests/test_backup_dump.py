"""按需 pg_dump 备份下载（/api/admin/backup/dump）。"""
from __future__ import annotations

import os
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import require_admin, require_recent_admin
from app.database import get_db
from app.routers import admin as admin_module


class _FakeDB:
    """_audit 只用到 add/commit，替身即可，不碰真库。"""

    def __init__(self):
        self.added: list = []
        self.commits = 0

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(admin_module.router, prefix="/api")
    app.dependency_overrides[require_admin] = lambda: None
    app.dependency_overrides[require_recent_admin] = lambda: None
    fake_db = _FakeDB()
    app.dependency_overrides[get_db] = lambda: fake_db
    with TestClient(app) as c:
        yield c, fake_db


def test_status_on_demand_is_disabled_by_default(client, monkeypatch):
    c, _db = client
    monkeypatch.setattr(admin_module.settings, "ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD", False)
    r = c.get("/api/admin/backup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["on_demand"] is False
    assert {"age_seconds", "verified", "stale"} <= set(body)
    assert body["stale"] is True


def test_dump_on_demand(client, monkeypatch, tmp_path):
    c, fake_db = client
    payload = b"PGDMP verified custom-format fixture"
    dump_file = tmp_path / "openapi_platform_test.dump"
    dump_file.write_bytes(payload)

    monkeypatch.setattr(admin_module.settings, "ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD", True)
    monkeypatch.setattr("app.db_backup.create_sql_dump", lambda: dump_file)

    r = c.get("/api/admin/backup/dump")
    assert r.status_code == 200
    assert r.content == payload
    assert ".dump" in r.headers["content-disposition"]
    assert fake_db.commits == 1
    assert any(getattr(o, "action", None) == "backup.dump_export" for o in fake_db.added)


def test_dump_failure(client, monkeypatch):
    c, _db = client
    monkeypatch.setattr(admin_module.settings, "ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD", True)

    def _boom():
        raise RuntimeError("服务器未安装 pg_dump，无法生成数据库备份")

    monkeypatch.setattr("app.db_backup.create_sql_dump", _boom)
    r = c.get("/api/admin/backup/dump")
    assert r.status_code == 500
    assert "pg_dump" in r.json()["detail"]


def test_dump_is_forbidden_until_operator_enables_it(client, monkeypatch):
    c, _db = client
    monkeypatch.setattr(admin_module.settings, "ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD", False)
    r = c.get("/api/admin/backup/dump")
    assert r.status_code == 403


def test_pg_dump_env_parses_sqlalchemy_url(monkeypatch):
    monkeypatch.setattr(
        "app.db_backup.settings.DATABASE_URL",
        "postgresql+psycopg://platform:s3cret@dbhost:5433/openapi_platform",
    )
    from app.db_backup import pg_dump_env

    env = pg_dump_env()
    assert env["PGHOST"] == "dbhost"
    assert env["PGPORT"] == "5433"
    assert env["PGUSER"] == "platform"
    assert env["PGPASSWORD"] == "s3cret"
    assert env["PGDATABASE"] == "openapi_platform"


def test_pg_dump_env_preserves_tls_and_connection_options(monkeypatch):
    monkeypatch.setattr(
        "app.db_backup.settings.DATABASE_URL",
        "postgresql+psycopg://platform:s3cret@dbhost/prod"
        "?sslmode=verify-full&sslrootcert=%2Frun%2Fca.pem&options=-c%20statement_timeout%3D5s",
    )
    from app.db_backup import pg_dump_env

    env = pg_dump_env()
    assert env["PGSSLMODE"] == "verify-full"
    assert env["PGSSLROOTCERT"] == "/run/ca.pem"
    assert env["PGOPTIONS"] == "-c statement_timeout=5s"


def test_dump_requires_pg_restore_before_creating_tempfile(monkeypatch):
    from app import db_backup

    monkeypatch.setattr(db_backup.shutil, "which", lambda name: "/usr/bin/pg_dump" if name == "pg_dump" else None)
    monkeypatch.setattr(
        db_backup.tempfile,
        "mkstemp",
        lambda **_kwargs: pytest.fail("must not create a dump without pg_restore"),
    )
    with pytest.raises(RuntimeError, match="pg_restore"):
        db_backup.create_sql_dump()


def test_restore_verification_timeout_removes_partial_dump(monkeypatch, tmp_path):
    from app import db_backup

    dump_path = tmp_path / "pending.dump"
    monkeypatch.setattr(db_backup.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        db_backup.tempfile,
        "mkstemp",
        lambda **_kwargs: (
            os.open(dump_path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600),
            str(dump_path),
        ),
    )
    calls = 0

    def run(args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            dump_path.write_bytes(b"PGDMP")
            return subprocess.CompletedProcess(args, 0, "", "")
        raise subprocess.TimeoutExpired(args, 60)

    monkeypatch.setattr(db_backup.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="校验超时"):
        db_backup.create_sql_dump()
    assert not dump_path.exists()
