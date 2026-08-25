"""CSV 导入（users / api_keys）回归测试。

覆盖 2026-08 审计修复：rpm/tpm/scene_type 字段映射、明文密钥不落库、
key_hash 必须为 sha256、时区时间戳解析、skip_existing 语义。
"""
from __future__ import annotations

import hashlib

from sqlalchemy import delete, select

from app.auth import hash_key
from app.database import SessionLocal
from app.migration_import import import_api_keys_csv, import_users_csv
from app.models import ApiKeyORM, UserORM


def _cleanup(db) -> None:
    db.execute(delete(UserORM).where(UserORM.auth_id.like("pytest-imp-%")))
    db.execute(delete(ApiKeyORM).where(ApiKeyORM.auth_id.like("pytest-imp-%")))
    db.commit()


def _get_key(db, auth_id: str) -> ApiKeyORM:
    return db.execute(
        select(ApiKeyORM).where(ApiKeyORM.auth_id == auth_id)
    ).scalar_one()


def test_import_key_full_fields(requires_db):
    """rpm/tpm/scene_type/时区时间戳全部正确落库；明文密钥不落库。"""
    db = SessionLocal()
    try:
        _cleanup(db)
        csv_ = (
            "auth_id,project_name,department,name,api_key,scene_type,rpm_limit,tpm_limit,"
            "granted_at,created_at,status\n"
            "pytest-imp-1,项目A,研发部,测试key1,pytest-plaintext-secret-aaaa,innovation,"
            "3000,60000000,2026-07-01T08:00:00+08:00,2026-06-01T00:00:00Z,\n"
        )
        r = import_api_keys_csv(db, csv_.encode())
        db.commit()
        assert r["inserted"] == 1 and r["errors"] == 0
        k = _get_key(db, "pytest-imp-1")
        assert k.scene_type == "innovation"
        assert k.rpm_limit == 3000
        assert k.tpm_limit == 60_000_000
        assert k.api_key is None  # 明文绝不落库
        assert k.key_hash == hash_key("pytest-plaintext-secret-aaaa")
        # 带 +08:00 的本地时间 → UTC 2026-07-01 00:00
        assert k.granted_at.isoformat() == "2026-07-01T00:00:00"
        assert k.created_at.isoformat() == "2026-06-01T00:00:00"
    finally:
        _cleanup(db)
        db.close()


def test_import_key_limit_semantics(requires_db):
    """0/空 → 平台默认(None)；-1 → 无限。"""
    db = SessionLocal()
    try:
        _cleanup(db)
        csv_ = (
            "auth_id,project_name,api_key,rpm_limit,tpm_limit\n"
            "pytest-imp-2,项目B,sk-test-bbbb,0,-1\n"
        )
        import_api_keys_csv(db, csv_.encode())
        db.commit()
        k = _get_key(db, "pytest-imp-2")
        assert k.rpm_limit is None  # 0 回落平台默认
        assert k.tpm_limit == -1     # -1 无限
    finally:
        _cleanup(db)
        db.close()


def test_import_key_rejects_non_sha256_hash(requires_db):
    """只有非 sha256 的 key_hash（如旧平台 MD5）→ 报错，不产生死 key。"""
    db = SessionLocal()
    try:
        _cleanup(db)
        csv_ = "auth_id,project_name,key_hash\npytest-imp-3,项目C,5f4dcc3b5aa765d61d8327deb882cf99\n"
        r = import_api_keys_csv(db, csv_.encode())
        db.commit()
        assert r["errors"] == 1
        assert "sha256" in r["error_samples"][0]
    finally:
        _cleanup(db)
        db.close()


def test_import_key_accepts_sha256_hash_only(requires_db):
    """只有合法 sha256 key_hash、无明文 → 直接采用，不留明文。"""
    db = SessionLocal()
    try:
        _cleanup(db)
        good = hashlib.sha256(b"sk-goodhash").hexdigest()
        csv_ = f"auth_id,project_name,key_hash\npytest-imp-4,项目D,{good}\n"
        r = import_api_keys_csv(db, csv_.encode())
        db.commit()
        assert r["inserted"] == 1
        k = _get_key(db, "pytest-imp-4")
        assert k.key_hash == good and k.api_key is None
    finally:
        _cleanup(db)
        db.close()


def test_import_key_skip_existing_semantics(requires_db):
    """skip_existing=True 跳过；False 就地更新业务字段。"""
    db = SessionLocal()
    try:
        _cleanup(db)
        first = (
            "auth_id,project_name,department,name,api_key,scene_type,rpm_limit\n"
            "pytest-imp-5,项目E,研发部,key5,sk-test-eeeee,explore,1000\n"
        )
        import_api_keys_csv(db, first.encode())
        db.commit()
        update = (
            "auth_id,project_name,department,name,api_key,scene_type,rpm_limit\n"
            "pytest-imp-5,项目E改,研发部,key5改,sk-test-eeeee,key,8000\n"
        )
        r = import_api_keys_csv(db, update.encode())  # 默认跳过
        db.commit()
        assert r["updated"] == 0 and r["skipped"] == 1
        r = import_api_keys_csv(db, update.encode(), skip_existing=False)
        db.commit()
        assert r["updated"] == 1
        k = _get_key(db, "pytest-imp-5")
        assert k.name == "key5改" and k.project_name == "项目E改"
        assert k.scene_type == "key" and k.rpm_limit == 8000
    finally:
        _cleanup(db)
        db.close()


def test_import_users(requires_db):
    """users 导入：时区时间戳正确，重复 auth_id 按 skip_existing 跳过/更新。"""
    db = SessionLocal()
    try:
        _cleanup(db)
        csv_ = (
            "auth_id,name,department,created_at\n"
            "pytest-imp-u1,用户一,研发部,2026-07-01T00:00:00Z\n"
        )
        r = import_users_csv(db, csv_.encode())
        db.commit()
        assert r["inserted"] == 1 and r["errors"] == 0
        u = db.execute(select(UserORM).where(UserORM.auth_id == "pytest-imp-u1")).scalar_one()
        assert u.created_at.isoformat() == "2026-07-01T00:00:00"
    finally:
        _cleanup(db)
        db.close()
