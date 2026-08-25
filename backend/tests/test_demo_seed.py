"""开源演示数据必须是虚构、不可调用且不会污染已有实例。"""
from __future__ import annotations

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker


def _session():
    from app import models  # noqa: F401
    from app.database import Base

    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, future=True)()


def test_demo_seed_contains_only_disabled_synthetic_credentials():
    from app.demo_seed import DEMO_SEED_KEY, seed_demo_data
    from app.models import (
        ApiKeyORM,
        PlatformSettingORM,
        UsageDailySummaryORM,
        UserORM,
    )

    db = _session()
    try:
        assert seed_demo_data(db) is True
        db.commit()

        users = db.scalars(select(UserORM).order_by(UserORM.auth_id)).all()
        keys = db.scalars(select(ApiKeyORM).order_by(ApiKeyORM.id)).all()
        assert [u.auth_id for u in users] == ["demo-001", "demo-002", "demo-003"]
        assert all(u.password_hash is None for u in users)
        assert all(k.revoked for k in keys)
        assert all(k.api_key is None and k.key_hash is None for k in keys)
        assert db.scalar(select(func.count()).select_from(UsageDailySummaryORM)) == 270

        marker = db.get(PlatformSettingORM, DEMO_SEED_KEY)
        assert marker is not None
        assert marker.value["synthetic"] is True

        # 幂等：第二次不增加任何记录。
        assert seed_demo_data(db) is False
        assert db.scalar(select(func.count()).select_from(UserORM)) == 3
    finally:
        engine = db.get_bind()
        db.close()
        engine.dispose()


def test_demo_seed_never_mixes_with_existing_runtime_data():
    from app.demo_seed import DEMO_SEED_KEY, seed_demo_data
    from app.models import PlatformSettingORM, UserORM

    db = _session()
    try:
        db.add(UserORM(auth_id="existing-user", name="已有用户", department="现有部门"))
        db.commit()

        assert seed_demo_data(db) is False
        assert db.get(PlatformSettingORM, DEMO_SEED_KEY) is None
        assert db.scalar(select(func.count()).select_from(UserORM)) == 1
    finally:
        engine = db.get_bind()
        db.close()
        engine.dispose()
