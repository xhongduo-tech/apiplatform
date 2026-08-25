"""高并发升级申请：提交校验 + 管理员审批集成测试。"""
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
    """默认关掉申请/升级提交限流，避免测试共享计数互相干扰；限流用例单独测。"""
    from app.routers import public as public_router

    async def _noop(*_a):  # noqa: ANN002
        return None

    monkeypatch.setattr(public_router, "_check_upgrade_apply_rate", _noop)
    monkeypatch.setattr(public_router, "_check_apply_rate", _noop)


@pytest.fixture(autouse=True)
def _cleanup_upgrade_test_artifacts(requires_db):
    """用例结束后清掉 test_* 密钥与「升级申请测试密钥」申请，避免污染共享开发库。"""
    yield
    from datetime import datetime, timezone

    from sqlalchemy import or_, select

    from app.database import SessionLocal
    from app.models import ApiKeyORM, UpgradeApplicationORM

    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        keys = db.execute(
            select(ApiKeyORM).where(
                or_(
                    ApiKeyORM.key_hash.like("test_%"),
                    ApiKeyORM.name == "升级申请测试密钥",
                    ApiKeyORM.project_name == "升级申请测试密钥",
                )
            )
        ).scalars().all()
        key_ids = [k.id for k in keys]
        app_conds = [UpgradeApplicationORM.key_name == "升级申请测试密钥"]
        if key_ids:
            app_conds.append(UpgradeApplicationORM.key_id.in_(key_ids))
        for a in db.execute(select(UpgradeApplicationORM).where(or_(*app_conds))).scalars().all():
            db.delete(a)
        for k in keys:
            if k.deleted_at is None:
                k.deleted_at = now
        db.commit()
    finally:
        db.close()


def _dev_token(client: TestClient) -> str:
    r = client.post("/api/user/dev-login")
    assert r.status_code == 200
    return r.json()["token"]


def _make_key(
    *,
    auth_id: str = _DEV_AUTH_ID,
    name: str = "升级申请测试密钥",
    rpm: int | None = None,
    tpm: int | None = None,
) -> str:
    """直接落一条已发放密钥（默认档位 rpm/tpm 为 None=平台默认），返回 id。"""
    from app.database import SessionLocal
    from app.models import ApiKeyORM

    db = SessionLocal()
    try:
        k = ApiKeyORM(
            name=name,
            auth_id=auth_id,
            project_name=name,
            department="示例团队甲",
            key_hash="test_" + uuid.uuid4().hex,
            key_prefix="sk-test",
            rpm_limit=rpm,
            tpm_limit=tpm,
        )
        db.add(k)
        db.commit()
        return k.id
    finally:
        db.close()


def _submit(client: TestClient, token: str, key_id: str, reason: str):
    return client.post(
        "/api/apply/upgrade",
        json={"key_id": key_id, "reason": reason},
        headers={"Authorization": f"Bearer {token}"},
    )


def test_submit_upgrade_application(requires_db, client: TestClient):
    """提交成功：落库一条 pending 的高并发升级申请。"""
    from app.database import SessionLocal
    from app.models import UpgradeApplicationORM

    token = _dev_token(client)
    key_id = _make_key()

    reason = "示例批处理项目需要高并发调用以处理模拟任务。"
    r = _submit(client, token, key_id, reason)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert body["keyId"] == key_id

    db = SessionLocal()
    try:
        a = db.get(UpgradeApplicationORM, body["id"])
        assert a is not None
        assert a.auth_id == _DEV_AUTH_ID
        assert a.key_id == key_id
        assert a.key_name == "升级申请测试密钥"
        assert a.reason == reason
        assert a.target_tier == "high"
        assert a.status == "pending"
    finally:
        db.close()


def test_submit_upgrade_rejects_short_reason(requires_db, client: TestClient):
    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "太短")
    assert r.status_code == 422


def test_submit_upgrade_rejects_missing_key(requires_db, client: TestClient):
    token = _dev_token(client)
    r = _submit(client, token, "no-such-key", "这个密钥并不存在，用于校验 404 分支。")
    assert r.status_code == 404


def test_submit_upgrade_rejects_non_owner(requires_db, client: TestClient):
    token = _dev_token(client)
    key_id = _make_key(auth_id="another-user")
    r = _submit(client, token, key_id, "试图升级别人的密钥，应当被拒绝。")
    assert r.status_code == 403


def test_submit_upgrade_rejects_already_high(requires_db, client: TestClient):
    from app.config import settings

    token = _dev_token(client)
    high_key = _make_key(rpm=settings.RATE_LIMIT_HIGH_RPM, tpm=settings.RATE_LIMIT_HIGH_TPM)
    unlimited_key = _make_key(rpm=-1, tpm=-1)

    r1 = _submit(client, token, high_key, "已经是高并发档位，不应该能再次申请。")
    assert r1.status_code == 400
    r2 = _submit(client, token, unlimited_key, "超高并发档位无需再申请升级。")
    assert r2.status_code == 400


def test_submit_upgrade_rejects_duplicate_pending(requires_db, client: TestClient):
    token = _dev_token(client)
    key_id = _make_key()

    r1 = _submit(client, token, key_id, "这是第一次提交的申请原因，内容足够长。")
    assert r1.status_code == 200
    r2 = _submit(client, token, key_id, "重复提交同一密钥的升级申请应当被拒绝。")
    assert r2.status_code == 400


def test_my_upgrade_applications_list(requires_db, client: TestClient):
    token = _dev_token(client)
    key_id = _make_key()
    _submit(client, token, key_id, "列表接口应能查到刚提交的申请。")
    r = client.get("/api/apply/upgrade", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    rows = r.json()["data"]
    assert any(row["keyId"] == key_id and row["status"] == "pending" for row in rows)


def test_admin_approve_applies_high_tier(requires_db, client: TestClient):
    """管理员审批通过后，密钥档位套用高并发预设并立即写入。"""
    from app.auth import require_admin
    from app.config import settings
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM

    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "审批通过后应把该密钥升到高并发档位。")
    assert r.status_code == 200
    app_id = r.json()["id"]

    app.dependency_overrides[require_admin] = lambda: None
    try:
        ar = client.post(f"/api/admin/upgrade-applications/{app_id}/approve", json={})
        assert ar.status_code == 200, ar.text
        body = ar.json()
        assert body["keyId"] == key_id
        assert body["rpmLimit"] == settings.RATE_LIMIT_HIGH_RPM
        assert body["tpmLimit"] == settings.RATE_LIMIT_HIGH_TPM
    finally:
        app.dependency_overrides.pop(require_admin, None)

    db = SessionLocal()
    try:
        k = db.get(ApiKeyORM, key_id)
        assert k is not None
        assert k.rpm_limit == settings.RATE_LIMIT_HIGH_RPM
        assert k.tpm_limit == settings.RATE_LIMIT_HIGH_TPM
    finally:
        db.close()


def test_admin_reject_sets_note(requires_db, client: TestClient):
    from app.auth import require_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import UpgradeApplicationORM

    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "用于验证驳回分支的申请原因，内容足够长。")
    assert r.status_code == 200
    app_id = r.json()["id"]

    app.dependency_overrides[require_admin] = lambda: None
    try:
        rr = client.post(
            f"/api/admin/upgrade-applications/{app_id}/reject",
            json={"note": "当前资源紧张，暂不支持升级"},
        )
        assert rr.status_code == 200
    finally:
        app.dependency_overrides.pop(require_admin, None)

    db = SessionLocal()
    try:
        a = db.get(UpgradeApplicationORM, app_id)
        assert a is not None
        assert a.status == "rejected"
        assert a.note == "当前资源紧张，暂不支持升级"
    finally:
        db.close()


def test_submit_upgrade_rate_limited(requires_db, client, monkeypatch):
    """超过每小时提交上限时返回 429（限流计数的真正递增逻辑见 _check_apply_rate）。"""
    from fastapi import HTTPException

    from app.routers import public as public_router

    async def _raise_limited(_ip: str):
        raise HTTPException(
            status_code=429,
            detail={"code": "upgrade_apply_rate_limited", "retry_minutes": 1, "limit": 10},
        )

    monkeypatch.setattr(public_router, "_check_upgrade_apply_rate", _raise_limited)
    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "触发限流：超过每小时提交上限应当被拒绝。")
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "upgrade_apply_rate_limited"


def test_submit_upgrade_rejects_too_long_reason(requires_db, client):
    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "长" * 501)
    assert r.status_code == 422


def test_admin_approve_rejects_revoked_key(requires_db, client):
    """申请在途期间密钥被吊销，审批应拒绝而不是把档位写进死密钥。"""
    from app.auth import require_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM

    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "用于验证密钥吊销后无法审批的申请原因。")
    assert r.status_code == 200
    app_id = r.json()["id"]

    db = SessionLocal()
    try:
        k = db.get(ApiKeyORM, key_id)
        assert k is not None
        k.revoked = True
        db.commit()
    finally:
        db.close()

    app.dependency_overrides[require_admin] = lambda: None
    try:
        ar = client.post(f"/api/admin/upgrade-applications/{app_id}/approve", json={})
        assert ar.status_code == 400
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_user_keys_reports_tier(requires_db, client):
    """用户密钥列表带档位，供前端隐藏已升级密钥的升级入口。"""
    from app.config import settings

    token = _dev_token(client)
    default_key = _make_key()
    high_key = _make_key(
        name="已是高并发密钥",
        rpm=settings.RATE_LIMIT_HIGH_RPM,
        tpm=settings.RATE_LIMIT_HIGH_TPM,
    )
    r = client.post("/api/user/keys", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    by_id = {row["id"]: row for row in r.json()["data"]}
    assert by_id[default_key]["tier"] == "default"
    assert by_id[high_key]["tier"] == "high"


def test_submit_upgrade_rejects_above_high_custom(requires_db, client):
    """自定义档位任一维度已高于高并发预设时，再申请升级会把该维度拉低，应拒绝。"""
    token = _dev_token(client)
    # rpm=5000 高于高并发预设 3000（tpm 未达标 → 归为 custom 而非 high）：审批通过会把 rpm 写成 3000，等于降级
    key_id = _make_key(rpm=5000, tpm=100)
    r = _submit(client, token, key_id, "高于高并发预设的密钥不应允许再申请升级。")
    assert r.status_code == 400


def test_submit_upgrade_to_unlimited_rejected(requires_db, client):
    """超高并发须邮件申请，系统不接受 unlimited 目标档位。"""
    from app.config import settings

    token = _dev_token(client)
    key_id = _make_key(
        rpm=settings.RATE_LIMIT_HIGH_RPM,
        tpm=settings.RATE_LIMIT_HIGH_TPM,
    )
    reason = "业务峰值需突破高并发上限，申请升级至超高并发档位。"
    r = client.post(
        "/api/apply/upgrade",
        json={"key_id": key_id, "reason": reason, "target_tier": "unlimited"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 422
    assert "邮件" in r.json()["detail"]


def test_user_downgrade_high_to_default(requires_db, client):
    """用户可将高并发密钥立即降至默认档，无需审批。"""
    from app.config import settings
    from app.database import SessionLocal
    from app.models import ApiKeyORM

    token = _dev_token(client)
    key_id = _make_key(
        rpm=settings.RATE_LIMIT_HIGH_RPM,
        tpm=settings.RATE_LIMIT_HIGH_TPM,
    )
    r = client.post(
        f"/api/user/keys/{key_id}/tier",
        json={"target_tier": "default"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.json()["tier"] == "default"

    db = SessionLocal()
    try:
        k = db.get(ApiKeyORM, key_id)
        assert k is not None
        assert k.rpm_limit is None
        assert k.tpm_limit is None
    finally:
        db.close()


def test_user_tier_rejects_upgrade(requires_db, client):
    """升高档位不能走 tier 接口，须提交升级申请。"""
    token = _dev_token(client)
    key_id = _make_key()
    r = client.post(
        f"/api/user/keys/{key_id}/tier",
        json={"target_tier": "high"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400


def test_update_pending_upgrade_application(requires_db, client):
    """待审批的升级申请可修改目标档位与原因。"""
    from app.database import SessionLocal
    from app.models import UpgradeApplicationORM

    token = _dev_token(client)
    key_id = _make_key()
    reason = "初次提交：示例项目需要高并发调用以处理模拟任务。"
    r = _submit(client, token, key_id, reason)
    assert r.status_code == 200
    app_id = r.json()["id"]

    new_reason = "更新说明：峰值并发进一步上升，补充更详细的业务背景与用量预估。"
    r2 = client.patch(
        f"/api/apply/upgrade/{app_id}",
        json={"reason": new_reason, "target_tier": "high"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200
    body = r2.json()
    assert body["targetTier"] == "high"
    assert body["reason"] == new_reason

    db = SessionLocal()
    try:
        a = db.get(UpgradeApplicationORM, app_id)
        assert a is not None
        assert a.target_tier == "high"
        assert a.status == "pending"
    finally:
        db.close()


def test_update_pending_rejects_unlimited(requires_db, client):
    """待审批申请不可改为 unlimited（须走邮件）。"""
    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "初次提交：示例项目需要高并发调用以处理模拟任务。")
    app_id = r.json()["id"]
    r2 = client.patch(
        f"/api/apply/upgrade/{app_id}",
        json={"reason": "尝试改为超高并发档位的更新说明文字。", "target_tier": "unlimited"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 422


def test_withdraw_pending_upgrade(requires_db, client):
    """用户可撤回待审批的升级申请。"""
    from app.database import SessionLocal
    from app.models import UpgradeApplicationORM

    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "撤回测试：提交后应可删除这条在途申请。")
    app_id = r.json()["id"]

    r2 = client.delete(
        f"/api/apply/upgrade/{app_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200

    db = SessionLocal()
    try:
        assert db.get(UpgradeApplicationORM, app_id) is None
    finally:
        db.close()


def test_dismiss_rejected_upgrade(requires_db, client):
    """用户可清除已驳回的升级申请记录。"""
    from app.auth import require_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import UpgradeApplicationORM

    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "驳回后清除测试：这条申请将被管理员驳回。")
    app_id = r.json()["id"]

    app.dependency_overrides[require_admin] = lambda: None
    try:
        r_rej = client.post(
            f"/api/admin/upgrade-applications/{app_id}/reject",
            json={"note": "暂不开放超高并发"},
        )
        assert r_rej.status_code == 200
    finally:
        app.dependency_overrides.pop(require_admin, None)

    r2 = client.delete(
        f"/api/apply/upgrade/{app_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200

    db = SessionLocal()
    try:
        assert db.get(UpgradeApplicationORM, app_id) is None
    finally:
        db.close()


def test_user_keys_includes_revoked(requires_db, client):
    """被吊销（未删除）的密钥在用户列表中可见，status=revoked，便于删除/轮换恢复。"""
    from datetime import datetime, timezone

    from app.database import SessionLocal
    from app.models import ApiKeyORM

    token = _dev_token(client)
    key_id = _make_key()
    db = SessionLocal()
    try:
        k = db.get(ApiKeyORM, key_id)
        assert k is not None
        k.revoked = True
        k.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    finally:
        db.close()

    r = client.post("/api/user/keys", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    by_id = {row["id"]: row for row in r.json()["data"]}
    assert by_id[key_id]["status"] == "revoked"


def test_regenerate_rejects_revoked_key(requires_db, client):
    """吊销后不允许用户自助轮换恢复，须删除后重新申请（走审批）。"""
    from datetime import datetime, timezone

    from app.database import SessionLocal
    from app.models import ApiKeyORM

    token = _dev_token(client)
    key_id = _make_key()

    db = SessionLocal()
    try:
        k = db.get(ApiKeyORM, key_id)
        assert k is not None
        k.revoked = True
        k.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    finally:
        db.close()

    r = client.post(
        f"/api/user/keys/{key_id}/regenerate",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400
    assert "吊销" in r.json()["detail"]


def test_delete_key_cancels_pending_upgrade(requires_db, client):
    """用户删除密钥后，该密钥的在途升级申请自动失效（rejected + system 备注）。"""
    from app.database import SessionLocal
    from app.models import UpgradeApplicationORM

    token = _dev_token(client)
    key_id = _make_key()
    r = _submit(client, token, key_id, "删除密钥后这条在途申请应自动失效。")
    assert r.status_code == 200
    app_id = r.json()["id"]

    r2 = client.delete(f"/api/user/keys/{key_id}", headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code == 200

    db = SessionLocal()
    try:
        a = db.get(UpgradeApplicationORM, app_id)
        assert a is not None
        assert a.status == "rejected"
        assert a.reviewer == "system"
        assert a.note  # 固定备注说明自动失效原因
    finally:
        db.close()


def test_apply_department_from_claims(requires_db, client):
    """申请部门一律取登录态，请求体里的 department 被忽略（防伪造归属）。"""
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.models import ApplicationORM, UserORM

    # dev-login 复用库内账号，department 可能被种子数据覆盖，故以库内实际值为准
    db = SessionLocal()
    try:
        user = db.execute(
            select(UserORM).where(UserORM.auth_id == _DEV_AUTH_ID)
        ).scalar_one()
        expected_dept = user.department
    finally:
        db.close()

    token = _dev_token(client)
    r = client.post(
        "/api/apply",
        json={
            "project_name": "部门取自登录态测试",
            "project_desc": "用于验证申请部门取自登录态的测试项目，描述足够长以满足校验。",
            "department": "伪造部门",
            "scene_type": "explore",
            "models": [],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    app_id = r.json()["id"]
    db = SessionLocal()
    try:
        a = db.get(ApplicationORM, app_id)
        assert a is not None
        assert a.department == expected_dept  # 取自登录态，而非请求体里的"伪造部门"
    finally:
        db.close()
