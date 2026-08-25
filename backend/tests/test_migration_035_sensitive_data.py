"""PostgreSQL migration coverage for revision 035 sensitive configuration."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import validate_api_key
from app.config import settings
from app.models import ModelRegistryORM


_BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture
def temporary_database(requires_db):
    source = make_url(settings.DATABASE_URL)
    name = f"apiplatform_mig035_{uuid.uuid4().hex}"
    assert re.fullmatch(r"apiplatform_mig035_[0-9a-f]{32}", name)
    maintenance_url = source.set(database="postgres")
    admin_engine = create_engine(maintenance_url, isolation_level="AUTOCOMMIT")
    created = False
    try:
        try:
            with admin_engine.connect() as conn:
                conn.execute(text(f'CREATE DATABASE "{name}"'))
                created = True
        except SQLAlchemyError as exc:
            pytest.skip(f"当前隔离 PostgreSQL 用户无 CREATE DATABASE 权限: {exc}")
        yield source.set(database=name)
    finally:
        try:
            if created:
                with admin_engine.connect() as conn:
                    conn.execute(text(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                        "WHERE datname = :name AND pid <> pg_backend_pid()"
                    ), {"name": name})
                    conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        finally:
            admin_engine.dispose()


def _upgrade(url: URL, revision: str) -> None:
    rendered = url.render_as_string(hide_password=False)
    env = os.environ.copy()
    env["DATABASE_URL"] = rendered
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision],
        cwd=_BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout).strip())


def _insert_legacy_model_and_key(engine) -> tuple[str, str]:
    raw_client_key = "test-client-key-migration-035"
    wrong_hash = hashlib.sha256(b"wrong-verifier").hexdigest()
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO model_registry
                (id, name, provider, status, category, base_url, api_key,
                 custom_headers, extra)
            VALUES
                ('migration-035-model', 'Migration 035', 'test', 'online', 'chat',
                 'https://upstream.example.test/v1?api-version=2026-08-01',
                 'upstream-api-secret', CAST(:headers AS json), CAST(:extra AS json))
        """), {
            "headers": json.dumps({"Authorization": "Bearer upstream-secret"}),
            "extra": json.dumps({"endpoints": [{
                "base_url": "https://node.example.test/v1",
                "api_key": "node-secret",
            }]}),
        })
        conn.execute(text("""
            INSERT INTO api_keys
                (id, name, auth_id, project_name, department, scene_type, models,
                 api_key, key_hash, granted_at, revoked)
            VALUES
                ('migration-035-key', 'Migration key', 'migration-user',
                 'Migration project', 'Test', 'explore', CAST('[]' AS json),
                 :raw_key, :wrong_hash, now(), false)
        """), {"raw_key": raw_client_key, "wrong_hash": wrong_hash})
    return raw_client_key, wrong_hash


def test_clean_database_upgrades_to_035(temporary_database: URL) -> None:
    _upgrade(temporary_database, "head")
    engine = create_engine(temporary_database)
    try:
        with engine.connect() as conn:
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == (
                "035_encrypt_secrets"
            )
    finally:
        engine.dispose()


def test_035_encrypts_base_url_and_repairs_client_key_hash(
    temporary_database: URL,
) -> None:
    _upgrade(temporary_database, "034_user_auth_hardening")
    engine = create_engine(temporary_database)
    raw_client_key, wrong_hash = _insert_legacy_model_and_key(engine)
    _upgrade(temporary_database, "head")
    expected_hash = hashlib.sha256(raw_client_key.encode()).hexdigest()
    try:
        with engine.connect() as conn:
            raw = conn.execute(text("""
                SELECT base_url, api_key, custom_headers, extra
                FROM model_registry WHERE id = 'migration-035-model'
            """)).mappings().one()
            assert raw["base_url"].startswith("enc:v1:")
            assert "upstream.example.test" not in raw["base_url"]
            assert raw["api_key"].startswith("enc:v1:")
            assert "__apiplatform_encrypted_v1__" in raw["custom_headers"]
            assert "__apiplatform_encrypted_v1__" in raw["extra"]
            client_row = conn.execute(text("""
                SELECT api_key, key_hash FROM api_keys WHERE id = 'migration-035-key'
            """)).one()
            assert client_row.api_key is None
            assert client_row.key_hash == expected_hash
            assert client_row.key_hash != wrong_hash

        with Session(engine) as db:
            model = db.get(ModelRegistryORM, "migration-035-model")
            assert model.base_url == "https://upstream.example.test/v1?api-version=2026-08-01"
            assert model.api_key == "upstream-api-secret"
            assert model.custom_headers == {"Authorization": "Bearer upstream-secret"}
            assert validate_api_key(db, f"Bearer {raw_client_key}").id == "migration-035-key"
    finally:
        engine.dispose()


def test_035_duplicate_client_verifier_aborts_without_erasing_plaintext(
    temporary_database: URL,
) -> None:
    _upgrade(temporary_database, "034_user_auth_hardening")
    engine = create_engine(temporary_database)
    raw_key = "test-client-key-duplicate-035"
    expected_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    wrong_hash = hashlib.sha256(b"wrong").hexdigest()
    try:
        with engine.begin() as conn:
            common = """
                (id, name, auth_id, project_name, department, scene_type, models,
                 api_key, key_hash, granted_at, revoked)
            """
            conn.execute(text(f"""
                INSERT INTO api_keys {common} VALUES
                ('existing-owner', 'Existing', 'owner', 'Owner project', 'Test',
                 'explore', CAST('[]' AS json), NULL, :expected, now(), false)
            """), {"expected": expected_hash})
            conn.execute(text(f"""
                INSERT INTO api_keys {common} VALUES
                ('legacy-duplicate', 'Legacy', 'legacy', 'Legacy project', 'Test',
                 'explore', CAST('[]' AS json), :raw, :wrong, now(), false)
            """), {"raw": raw_key, "wrong": wrong_hash})

        with pytest.raises(Exception, match="重复客户端密钥"):
            _upgrade(temporary_database, "head")

        with engine.connect() as conn:
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == (
                "034_user_auth_hardening"
            )
            row = conn.execute(text("""
                SELECT api_key, key_hash FROM api_keys WHERE id = 'legacy-duplicate'
            """)).one()
            assert row.api_key == raw_key
            assert row.key_hash == wrong_hash
    finally:
        engine.dispose()


def test_035_unsafe_legacy_url_aborts_before_hiding_evidence(
    temporary_database: URL,
) -> None:
    _upgrade(temporary_database, "034_user_auth_hardening")
    engine = create_engine(temporary_database)
    unsafe = "https://legacy-user:legacy-password@upstream.example.test/v1"
    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO model_registry
                    (id, name, provider, status, category, base_url)
                VALUES
                    ('unsafe-legacy-model', 'Unsafe legacy', 'test', 'offline',
                     'chat', :unsafe)
            """), {"unsafe": unsafe})

        with pytest.raises(Exception, match="不安全的 base_url"):
            _upgrade(temporary_database, "head")

        with engine.connect() as conn:
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == (
                "034_user_auth_hardening"
            )
            assert conn.execute(text("""
                SELECT base_url FROM model_registry WHERE id = 'unsafe-legacy-model'
            """)).scalar_one() == unsafe
    finally:
        engine.dispose()
