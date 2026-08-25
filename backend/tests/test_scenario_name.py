"""同一用户场景名不可重复。"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings


_DEV_AUTH_ID = settings.DEV_LOGIN_AUTH_ID


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


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.routers import public as public_router

    async def _noop(*_a):  # noqa: ANN002
        return None

    monkeypatch.setattr(public_router, "_check_apply_rate", _noop)


def _dev_token(client: TestClient) -> str:
    r = client.post("/api/user/dev-login")
    assert r.status_code == 200
    return r.json()["token"]


def _apply_body(project_name: str) -> dict:
    return {
        "project_name": project_name,
        "project_desc": "用于验证场景名唯一性约束的测试申请，描述需超过三十字。",
        "scene_type": "explore",
        "models": [],
    }


def test_apply_rejects_duplicate_existing_key_name(requires_db, client: TestClient):
    """已有密钥的场景名不可再次申请。"""
    from app.database import SessionLocal
    from app.models import ApiKeyORM

    token = _dev_token(client)
    name = f"重复场景-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        db.add(ApiKeyORM(
            name=name,
            auth_id=_DEV_AUTH_ID,
            project_name=name,
            department="示例团队甲",
            key_hash="dup_" + uuid.uuid4().hex,
            key_prefix="sk-dup",
        ))
        db.commit()
    finally:
        db.close()

    r = client.post(
        "/api/apply",
        json=_apply_body(name),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400
    assert "场景名称" in r.json()["detail"]


def test_apply_rejects_duplicate_pending_application(requires_db, client: TestClient):
    """审批中的场景名不可重复申请。"""
    token = _dev_token(client)
    name = f"待审重复-{uuid.uuid4().hex[:8]}"
    headers = {"Authorization": f"Bearer {token}"}

    r1 = client.post("/api/apply", json=_apply_body(name), headers=headers)
    assert r1.status_code == 200

    r2 = client.post("/api/apply", json=_apply_body(name), headers=headers)
    assert r2.status_code == 400
    assert "场景名称" in r2.json()["detail"]


def test_update_rejects_duplicate_scenario_name(requires_db, client: TestClient):
    """编辑时不可改为与其他密钥/申请重复的场景名。"""
    from app.database import SessionLocal
    from app.models import ApiKeyORM

    token = _dev_token(client)
    taken = f"已占用-{uuid.uuid4().hex[:8]}"
    mine = f"我的场景-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        db.add(ApiKeyORM(
            name=taken,
            auth_id=_DEV_AUTH_ID,
            project_name=taken,
            department="示例团队甲",
            key_hash="taken_" + uuid.uuid4().hex,
            key_prefix="sk-tk",
        ))
        other = ApiKeyORM(
            name=mine,
            auth_id=_DEV_AUTH_ID,
            project_name=mine,
            department="示例团队甲",
            key_hash="mine_" + uuid.uuid4().hex,
            key_prefix="sk-mn",
        )
        db.add(other)
        db.commit()
        other_id = other.id
    finally:
        db.close()

    r = client.patch(
        f"/api/user/keys/{other_id}",
        json={"name": taken, "project_desc": "尝试改成重复场景名的背景描述，内容需超过三十字。"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400
    assert "场景名称" in r.json()["detail"]


def test_update_allows_keeping_same_scenario_name(requires_db, client: TestClient):
    """编辑自身场景名保持不变时应允许。"""
    from app.database import SessionLocal
    from app.models import ApiKeyORM

    token = _dev_token(client)
    name = f"保持不变-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        k = ApiKeyORM(
            name=name,
            auth_id=_DEV_AUTH_ID,
            project_name=name,
            department="示例团队甲",
            key_hash="same_" + uuid.uuid4().hex,
            key_prefix="sk-sm",
            project_desc="原始背景需求描述，长度超过三十个字用于通过校验与更新测试。",
        )
        db.add(k)
        db.commit()
        key_id = k.id
    finally:
        db.close()

    r = client.patch(
        f"/api/user/keys/{key_id}",
        json={"name": name, "project_desc": "更新后的背景需求描述，仍然超过三十个字以便保存成功。"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
