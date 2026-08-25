"""2026-08 安全加固回归测试：登录频控锁定、删用户吊销密钥、base_url scheme 校验、
匿名状态页不再泄露 by_project、模型列表掩码密钥。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import ApiKeyORM, ModelRegistryORM, UserORM


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_admin_login_lockout(requires_db, client: TestClient, monkeypatch):
    """连续失败达到阈值 → 429 锁定；成功登录清除计数。"""
    from app.admin_credentials import AdminAuthentication
    from app.routers import admin as admin_router
    from app.routers.admin import _ADMIN_LOGIN_MAX_FAILURES

    class _Pipeline:
        def __init__(self, owner):
            self.owner = owner
            self.commands = []

        def incr(self, key):
            self.commands.append(("incr", key))
            return self

        def expire(self, key, _seconds):
            self.commands.append(("expire", key))
            return self

        async def execute(self):
            results = []
            for command, key in self.commands:
                if command == "incr":
                    self.owner.values[key] = int(self.owner.values.get(key, 0)) + 1
                    results.append(self.owner.values[key])
                else:
                    results.append(True)
            return results

    class _Redis:
        def __init__(self):
            self.values = {}

        async def get(self, key):
            return self.values.get(key)

        def pipeline(self):
            return _Pipeline(self)

        async def set(self, key, value, **_kwargs):
            self.values[key] = value

        async def delete(self, *keys):
            for key in keys:
                self.values.pop(key, None)

    monkeypatch.setattr(admin_router, "redis", _Redis())

    # 锁定测试只关心失败计数，不依赖全局管理员是否已完成首次设密。
    monkeypatch.setattr(
        admin_router,
        "authenticate_or_initialize_admin",
        lambda *_args, **_kwargs: AdminAuthentication(authenticated=False),
    )

    # 前 4 次错误密码 → 401（n=1..4 < 5）
    for _ in range(_ADMIN_LOGIN_MAX_FAILURES - 1):
        r = client.post("/api/admin/login", json={"password": "wrongpass"})
        assert r.status_code == 401
    # 第 5 次（n=5，达阈值）→ 429 锁定
    r = client.post("/api/admin/login", json={"password": "wrongpass"})
    assert r.status_code == 429
    # 锁定检查先于密码验证，锁定期内任意密码都应直接 429。
    r = client.post("/api/admin/login", json={"password": "AnyPassword1!"})
    assert r.status_code == 429


def test_delete_user_revokes_keys_and_erases_linked_identity(requires_db, client: TestClient):
    """删除用户吊销会话/Key，并删除或不可逆匿名化各业务表中的身份信息。"""
    from datetime import datetime, timedelta, timezone
    import uuid
    from sqlalchemy import select

    from app.auth import create_user_token, require_admin, validate_user_session
    from fastapi import HTTPException
    from app.models import (
        ApplicationORM, AuditLogORM, DocFeedbackORM, EarlyAccessApplicationORM,
        ForumPostORM, ForumReactionORM, ForumReplyORM, NightBatchRegistrationORM,
        UpgradeApplicationORM, UsageLogORM,
    )

    app.dependency_overrides[require_admin] = lambda: None
    db = SessionLocal()
    auth_id = "pytest-del-user-" + uuid.uuid4().hex
    try:
        u = UserORM(auth_id=auth_id, name="待删用户", department="UT")
        db.add(u)
        db.flush()
        k = ApiKeyORM(
            name="del-key", auth_id=auth_id, project_name="待删项目",
            department="UT", key_hash="pytest-hash-" + uuid.uuid4().hex, key_prefix="pytest",
        )
        db.add(k)
        db.flush()
        usage_log = UsageLogORM(
            api_key_id=k.id, model_id="pytest-model", status_code="500",
            error_detail="待删用户（UT）调用失败",
            response_preview="待删用户的响应内容",
        )
        db.add(usage_log)
        application = ApplicationORM(
            name="待删用户", auth_id=auth_id, department="UT",
            project_name="待删项目", models=[], status="pending",
        )
        early = EarlyAccessApplicationORM(
            auth_id=auth_id, name="待删用户", department="UT",
        )
        upgrade = UpgradeApplicationORM(
            auth_id=auth_id, name="待删用户", department="UT",
            key_id=k.id, key_name="del-key", project_name="待删项目",
            reason="删除测试", target_tier="high",
        )
        post = ForumPostORM(
            author_auth_id=auth_id, author_name="待删用户",
            title="待删帖子", content="包含个人内容",
        )
        other_post = ForumPostORM(
            author_auth_id="other-user", author_name="其他用户",
            title="保留帖子", content="公共内容",
        )
        db.add_all([application, early, upgrade, post, other_post])
        db.flush()
        reply = ForumReplyORM(
            post_id=other_post.id, author_auth_id=auth_id,
            author_name="待删用户", content="待删回复",
        )
        reaction = ForumReactionORM(
            post_id=other_post.id, user_auth_id=auth_id,
            reaction_type=ForumReactionORM.LIKE,
        )
        start_at = datetime.now(timezone.utc).replace(tzinfo=None)
        night = NightBatchRegistrationORM(
            series_id="pytest-delete-series", series_total=1,
            creator_auth_id=auth_id, creator_name="待删用户", project="UT",
            model_id="pytest-model", model_name="测试模型", contact_name="待删用户",
            description="待删登记", start_at=start_at,
            end_at=start_at + timedelta(hours=1),
        )
        feedback = DocFeedbackORM(
            section="auth", vote="down", comment="待删反馈", auth_id=auth_id,
        )
        audit = AuditLogORM(
            actor="admin", action="user.create", target=u.id,
            detail={"auth_id": auth_id, "name": "待删用户", "department": "UT"},
        )
        db.add_all([reply, reaction, night, feedback, audit])
        db.commit()
        uid, kid, usage_log_id, other_post_id = u.id, k.id, usage_log.id, other_post.id
        old_token = create_user_token(u.auth_id, u.name, u.department, u.token_version)["token"]

        r = client.delete(f"/api/admin/users/{uid}")
        assert r.status_code == 200
        body = r.json()
        assert body.get("keysRevoked") == 1

        db.expire_all()
        k2 = db.get(ApiKeyORM, kid)
        assert k2 is not None and k2.revoked is True and k2.revoked_at is not None
        assert auth_id not in (k2.auth_id, k2.name, k2.department, k2.project_name)
        deleted_user = db.get(UserORM, uid)
        assert deleted_user is not None and deleted_user.is_active is False
        assert deleted_user.auth_id.startswith("deleted-")
        assert deleted_user.name == "已注销用户" and deleted_user.department is None
        scrubbed_log = db.get(UsageLogORM, usage_log_id)
        assert scrubbed_log is not None
        assert scrubbed_log.error_detail is None and scrubbed_log.response_preview is None

        for model, column in (
            (ApplicationORM, ApplicationORM.auth_id),
            (EarlyAccessApplicationORM, EarlyAccessApplicationORM.auth_id),
            (UpgradeApplicationORM, UpgradeApplicationORM.auth_id),
            (NightBatchRegistrationORM, NightBatchRegistrationORM.creator_auth_id),
            (DocFeedbackORM, DocFeedbackORM.auth_id),
            (ForumReplyORM, ForumReplyORM.author_auth_id),
            (ForumReactionORM, ForumReactionORM.user_auth_id),
        ):
            assert db.scalar(select(model).where(column == auth_id)) is None
        assert db.scalar(select(ForumPostORM).where(
            ForumPostORM.author_auth_id == auth_id
        )) is None
        assert db.get(ForumPostORM, other_post_id) is not None
        db.refresh(audit)
        assert auth_id not in str(audit.detail)
        assert "待删用户" not in str(audit.detail)

        with pytest.raises(HTTPException) as exc:
            validate_user_session(db, old_token)
        assert getattr(exc.value, "status_code", None) == 401
    finally:
        db.rollback()
        if "usage_log_id" in locals():
            db.execute(__import__("sqlalchemy").delete(UsageLogORM).where(UsageLogORM.id == usage_log_id))
        if "kid" in locals():
            db.execute(__import__("sqlalchemy").delete(ApiKeyORM).where(ApiKeyORM.id == kid))
        if "uid" in locals():
            db.execute(__import__("sqlalchemy").delete(UserORM).where(UserORM.id == uid))
        if "other_post_id" in locals():
            db.execute(__import__("sqlalchemy").delete(ForumPostORM).where(ForumPostORM.id == other_post_id))
        db.commit()
        app.dependency_overrides.pop(require_admin, None)
        db.close()


def test_model_base_url_scheme_rejected(requires_db, client: TestClient):
    """SSRF 防护：非 http/https 的 base_url 一律 400。"""
    from app.auth import require_admin

    app.dependency_overrides[require_admin] = lambda: None
    try:
        r = client.put("/api/admin/models/test-scheme", json={
            "id": "test-scheme", "name": "t", "base_url": "file:///etc/passwd",
            "status": "online", "category": "chat", "import_format": "openai",
        })
        assert r.status_code == 400
        r = client.put("/api/admin/models/test-scheme", json={
            "id": "test-scheme", "name": "t", "base_url": "http://internal:8080",
            "status": "online", "category": "chat", "import_format": "openai",
        })
        assert r.status_code == 200
        # 清理
        client.delete("/api/admin/models/test-scheme")
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_public_status_no_by_project(requires_db, client: TestClient):
    """匿名状态页不得泄露 by_project（项目名点名具体业务）。"""
    r = client.get("/api/public/platform-status")
    assert r.status_code == 200
    assert "by_project" not in r.json()


def test_list_models_masks_api_key(requires_db, client: TestClient):
    """模型列表回显的 apiKey 必须是掩码，而非明文。"""
    from app.auth import require_admin

    app.dependency_overrides[require_admin] = lambda: None
    db = SessionLocal()
    try:
        db.add(ModelRegistryORM(
            id="pytest-mask-model", name="掩码测试", base_url="http://u:1", api_key="sk-plain-1234567890",
        ))
        db.commit()
        r = client.get("/api/admin/models")
        assert r.status_code == 200
        rows = {m["id"]: m for m in r.json()}
        assert rows["pytest-mask-model"]["apiKey"] == "******"
        assert "sk-plain-1234567890" not in str(rows["pytest-mask-model"])
    finally:
        m = db.get(ModelRegistryORM, "pytest-mask-model")
        if m:
            db.delete(m)
            db.commit()
        app.dependency_overrides.pop(require_admin, None)
        db.close()
