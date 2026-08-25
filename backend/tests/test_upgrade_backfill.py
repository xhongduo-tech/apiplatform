"""存量高并发补录为已通过升级申请。"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient


async def _noop_async(*_a, **_k):
    return None


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr("app.main._startup_db_work", lambda: None)
    monkeypatch.setattr("app.ops_scheduler.ops_scheduler.start", _noop_async)
    monkeypatch.setattr("app.ops_scheduler.ops_scheduler.stop", _noop_async)
    monkeypatch.setattr("app.usage_retention.usage_retention.start", _noop_async)
    monkeypatch.setattr("app.usage_retention.usage_retention.stop", _noop_async)
    monkeypatch.setattr("app.usage_writer.usage_writer.start", _noop_async)
    monkeypatch.setattr("app.usage_writer.usage_writer.stop", _noop_async)

    async def _ping():
        return True

    monkeypatch.setattr("app.redis_client.redis.ping", _ping)

    from app.main import app

    with TestClient(app) as c:
        yield c


def test_ensure_approved_upgrade_for_elevated_key(requires_db, client: TestClient):
    """高并发密钥补录后具备 标准已通过申请属性。"""
    from app.config import settings
    from app.database import SessionLocal
    from app.models import ApiKeyORM, UpgradeApplicationORM, UserORM
    from app.upgrade_flow import ensure_approved_upgrade_for_key
    from sqlalchemy import select

    suffix = uuid.uuid4().hex[:8]
    auth_id = f"ut-bf-{suffix}"
    db = SessionLocal()
    key_id = None
    try:
        db.add(UserORM(auth_id=auth_id, name="补录测试员", department="示例团队甲"))
        k = ApiKeyORM(
            name=f"存量高并发-{suffix}",
            auth_id=auth_id,
            project_name=f"存量高并发-{suffix}",
            department="示例团队甲",
            key_hash=f"bf_{suffix}",
            key_prefix="sk-bf",
            rpm_limit=settings.RATE_LIMIT_HIGH_RPM,
            tpm_limit=settings.RATE_LIMIT_HIGH_TPM,
        )
        db.add(k)
        db.commit()
        key_id = k.id

        app = ensure_approved_upgrade_for_key(db, k)
        db.commit()
        assert app is not None
        assert app.status == "approved"
        assert app.target_tier == "high"
        assert app.key_id == key_id
        assert app.key_name == f"存量高并发-{suffix}"
        assert app.project_name == f"存量高并发-{suffix}"
        assert app.name == "补录测试员"
        assert app.department == "示例团队甲"
        assert app.auth_id == auth_id
        assert app.reviewer == "admin"
        assert "存量" in (app.reason or "")

        # 幂等：再次调用不新建
        ensure_approved_upgrade_for_key(db, k)
        db.commit()
        n = db.execute(
            select(UpgradeApplicationORM).where(UpgradeApplicationORM.key_id == key_id)
        ).scalars().all()
        assert len(n) == 1
    finally:
        if key_id:
            for a in db.execute(
                select(UpgradeApplicationORM).where(UpgradeApplicationORM.key_id == key_id)
            ).scalars():
                db.delete(a)
            row = db.get(ApiKeyORM, key_id)
            if row:
                db.delete(row)
        u = db.execute(select(UserORM).where(UserORM.auth_id == auth_id)).scalar_one_or_none()
        if u:
            db.delete(u)
        db.commit()
        db.close()
