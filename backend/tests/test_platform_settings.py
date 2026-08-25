"""platform_settings 合并表相关测试：

- forum_likes / forum_follows → forum_reactions（按 reaction_type 区分）
- fallback_policy / ask_docs_config → platform_settings（key → JSON）
"""
from __future__ import annotations

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


# ── platform_settings 模块级读写 ───────────────────────────────────────────────
def test_branding_config_rejects_html():
    from pydantic import ValidationError
    from app.routers.admin import BrandingConfigIn

    with pytest.raises(ValidationError):
        BrandingConfigIn(
            brand_name="<img src=x>",
            platform_name="开放平台",
            browser_title="Platform",
            hero_title="Hello",
            slogan="Build",
            organization_name="Example",
            footer_text="© Example",
            support_department="Operations",
            support_contact="Support",
            support_email="support@example.com",
            approval_department="Operations",
            approval_contact="Reviewer",
            approval_email="approval@example.com",
        )


def test_branding_config_accepts_and_normalizes_footer_and_contacts():
    from app.routers.admin import BrandingConfigIn

    config = BrandingConfigIn(
        brand_name="  Community AI  ",
        platform_name="Open Platform",
        browser_title="Community AI",
        hero_title="Build with models",
        slogan="Open and configurable",
        organization_name="Community",
        footer_text="  © Community  ",
        support_department="Operations",
        support_contact="Support",
        support_email="  support@example.com  ",
        approval_department="Operations",
        approval_contact="Reviewer",
        approval_email="approval@example.com",
    )

    assert config.brand_name == "Community AI"
    assert config.footer_text == "© Community"
    assert config.support_email == "support@example.com"


def test_ask_docs_messages_use_active_branding(monkeypatch):
    from app.ask_docs import build_messages
    from app.platform_settings import AskDocsConfig, BrandingConfig

    monkeypatch.setattr(
        "app.ask_docs.search_docs",
        lambda _question: "{brand} / {platformName} / {supportDepartment}",
    )
    messages = build_messages(
        "How do I start?",
        AskDocsConfig(),
        BrandingConfig(
            brand_name="Community AI",
            platform_name="Open Platform",
            support_department="Community Support",
        ),
    )

    assert "Community AI" in messages[0]["content"]
    assert "Community AI / Open Platform / Community Support" in messages[1]["content"]


def test_fallback_policy_roundtrip(requires_db):
    from app import platform_settings
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        original = platform_settings.get_fallback_policy(db)
        db.commit()
        try:
            saved = platform_settings.save_fallback_policy(
                db,
                platform_settings.FallbackPolicy(
                    enabled=True,
                    target_model_id="pytest-target",
                    source_model_ids=["pytest-src-1", "pytest-src-2"],
                    trip_fails=7,
                    trip_rate=0.42,
                ),
            )
            db.commit()
            assert saved.updated_at is not None

            reread = platform_settings.get_fallback_policy(db)
            assert reread.enabled is True
            assert reread.target_model_id == "pytest-target"
            assert reread.source_model_ids == ["pytest-src-1", "pytest-src-2"]
            assert reread.trip_fails == 7
            assert reread.trip_rate == pytest.approx(0.42)
        finally:
            # 还原，避免污染其它用例/开发库
            platform_settings.save_fallback_policy(db, original)
            db.commit()
    finally:
        db.close()


def test_ask_docs_config_roundtrip(requires_db):
    from app import platform_settings
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        original = platform_settings.get_ask_docs_config(db)
        try:
            saved = platform_settings.save_ask_docs_config(
                db,
                platform_settings.AskDocsConfig(
                    provider="platform",
                    model="pytest-model",
                    system_prompt="pytest-system-prompt",
                    enabled=True,
                ),
            )
            db.commit()
            assert saved.id
            assert saved.created_at is not None
            assert saved.updated_at is not None

            reread = platform_settings.get_ask_docs_config(db)
            assert reread is not None
            assert reread.id == saved.id
            assert reread.provider == "platform"
            assert reread.model == "pytest-model"
            assert reread.system_prompt == "pytest-system-prompt"
            assert reread.enabled is True
        finally:
            if original is not None:
                platform_settings.save_ask_docs_config(db, original)
            else:
                from app.models import PlatformSettingORM

                row = db.get(PlatformSettingORM, platform_settings.ASK_DOCS_CONFIG_KEY)
                if row is not None:
                    db.delete(row)
            db.commit()
    finally:
        db.close()


def test_branding_config_roundtrip(requires_db):
    from app import platform_settings
    from app.database import SessionLocal
    from app.models import PlatformSettingORM

    db = SessionLocal()
    try:
        original_row = db.get(PlatformSettingORM, platform_settings.BRANDING_CONFIG_KEY)
        original_value = dict(original_row.value) if original_row is not None else None
        try:
            saved = platform_settings.save_branding_config(
                db,
                platform_settings.BrandingConfig(
                    brand_name="Pytest Platform",
                    platform_name="测试开放平台",
                    browser_title="Pytest Platform",
                    hero_title="测试标题",
                    slogan="测试口号",
                    organization_name="测试组织",
                    footer_text="© Pytest",
                    support_department="运营部",
                    support_contact="小编",
                    support_email="support@pytest.invalid",
                    approval_department="审批部",
                    approval_contact="审批员",
                    approval_email="approval@pytest.invalid",
                ),
            )
            db.commit()
            assert saved.updated_at is not None

            reread = platform_settings.get_branding_config(db)
            assert reread.brand_name == "Pytest Platform"
            assert reread.organization_name == "测试组织"
            assert reread.approval_contact == "审批员"
        finally:
            row = db.get(PlatformSettingORM, platform_settings.BRANDING_CONFIG_KEY)
            if original_value is None:
                if row is not None:
                    db.delete(row)
            elif row is not None:
                row.value = original_value
            db.commit()
    finally:
        db.close()


def test_admin_branding_config_updates_public_config(requires_db, client: TestClient):
    from app.auth import require_admin
    from app.main import app
    from app import platform_settings
    from app.database import SessionLocal
    from app.models import PlatformSettingORM

    db = SessionLocal()
    original_row = db.get(PlatformSettingORM, platform_settings.BRANDING_CONFIG_KEY)
    original_value = dict(original_row.value) if original_row is not None else None
    db.close()

    app.dependency_overrides[require_admin] = lambda: None
    try:
        payload = {
            "brand_name": "Community AI",
            "platform_name": "社区开放平台",
            "browser_title": "Community AI",
            "hero_title": "欢迎使用社区平台",
            "slogan": "开放、稳定、可配置",
            "organization_name": "Community",
            "footer_text": "© Community",
            "support_department": "Operations",
            "support_contact": "Support",
            "support_email": "support@community.invalid",
            "approval_department": "Operations",
            "approval_contact": "Reviewer",
            "approval_email": "approval@community.invalid",
        }
        saved = client.put("/api/admin/branding-config", json=payload)
        assert saved.status_code == 200
        assert saved.json()["config"]["brandName"] == "Community AI"

        public = client.get("/api/public/config")
        assert public.status_code == 200
        body = public.json()
        assert body["brand"] == "Community AI"
        assert body["organization_name"] == "Community"
        assert body["footer_text"] == "© Community"
        assert body["approval_contact"] == "Reviewer"
    finally:
        db = SessionLocal()
        row = db.get(PlatformSettingORM, platform_settings.BRANDING_CONFIG_KEY)
        if original_value is None:
            if row is not None:
                db.delete(row)
        elif row is not None:
            row.value = original_value
        db.commit()
        db.close()
        app.dependency_overrides.pop(require_admin, None)


# ── /api/admin/fallback/policy ───────────────────────────────────────────────
def test_admin_fallback_policy_get_and_put(requires_db, client: TestClient):
    from app.auth import require_admin
    from app.main import app

    app.dependency_overrides[require_admin] = lambda: None
    try:
        r = client.get("/api/admin/fallback/policy")
        assert r.status_code == 200
        body = r.json()
        assert "enabled" in body and "sourceModelIds" in body
        prev = {k: body[k] for k in (
            "enabled", "targetModelId", "sourceModelIds", "circuitEnabled",
            "tripFails", "tripRate", "windowS", "cooldownS", "maxCooldownS", "forced",
        )}

        r = client.put("/api/admin/fallback/policy", json={
            "enabled": False, "sourceModelIds": [], "forced": False,
        })
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert r.json()["enabled"] is False

        r = client.get("/api/admin/fallback/policy")
        assert r.status_code == 200
        assert r.json()["enabled"] is False
    finally:
        # 还原
        client.put("/api/admin/fallback/policy", json={
            "enabled": prev["enabled"],
            "targetModelId": prev["targetModelId"],
            "sourceModelIds": prev["sourceModelIds"],
            "circuitEnabled": prev["circuitEnabled"],
            "tripFails": prev["tripFails"],
            "tripRate": prev["tripRate"],
            "windowS": prev["windowS"],
            "cooldownS": prev["cooldownS"],
            "maxCooldownS": prev["maxCooldownS"],
            "forced": prev["forced"],
        })
        app.dependency_overrides.pop(require_admin, None)


# ── /api/admin/ask-docs-config ───────────────────────────────────────────────
def test_admin_ask_docs_config_get_and_put(requires_db, client: TestClient):
    from app.auth import require_admin
    from app.main import app

    app.dependency_overrides[require_admin] = lambda: None
    try:
        before = client.get("/api/admin/ask-docs-config").json()["config"]

        r = client.put("/api/admin/ask-docs-config", json={
            "provider": "openai", "model": "pytest-gpt", "enabled": True,
            "system_prompt": "pytest 专用",
        })
        assert r.status_code == 200
        cfg = r.json()["config"]
        assert cfg["model"] == "pytest-gpt"
        assert cfg["enabled"] is True
        assert cfg["apiKey"] == ""  # 不回传明文密钥

        r = client.get("/api/admin/ask-docs-config")
        assert r.status_code == 200
        assert r.json()["config"]["model"] == "pytest-gpt"
    finally:
        if before is not None:
            client.put("/api/admin/ask-docs-config", json={
                "provider": before["provider"], "model": before["model"],
                "api_base": before["apiBase"], "system_prompt": before["systemPrompt"],
                "max_tokens": before["maxTokens"], "temperature": before["temperature"],
                "enabled": before["enabled"],
            })
        app.dependency_overrides.pop(require_admin, None)


# ── forum_reactions（点赞 / 关注）───────────────────────────────────────────────
def test_forum_like_and_follow_are_independent_reactions(requires_db, client: TestClient):
    from app.database import SessionLocal
    from app.models import ForumPostORM, ForumReactionORM

    db = SessionLocal()
    post = ForumPostORM(author_auth_id="pytest", author_name="pytest", title="t", content="c")
    db.add(post)
    db.commit()
    post_id = post.id
    db.close()

    try:
        token = client.post("/api/user/dev-login").json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        r = client.post(f"/api/forum/posts/{post_id}/like", headers=headers)
        assert r.status_code == 200
        assert r.json() == {"liked": True, "like_count": 1}

        # 关注是独立的 reaction_type，不受点赞影响
        detail = client.get(f"/api/forum/posts/{post_id}", headers=headers).json()
        assert detail["like_count"] == 1
        assert detail["follow_count"] == 0
        assert detail["liked"] is True
        assert detail["followed"] is False

        r = client.post(f"/api/forum/posts/{post_id}/follow", headers=headers)
        assert r.status_code == 200
        assert r.json() == {"followed": True, "follow_count": 1}

        detail = client.get(f"/api/forum/posts/{post_id}", headers=headers).json()
        assert detail["like_count"] == 1
        assert detail["follow_count"] == 1

        # 再次点赞 = 取消点赞，不影响关注
        r = client.post(f"/api/forum/posts/{post_id}/like", headers=headers)
        assert r.json() == {"liked": False, "like_count": 0}
        detail = client.get(f"/api/forum/posts/{post_id}", headers=headers).json()
        assert detail["like_count"] == 0
        assert detail["follow_count"] == 1
    finally:
        db = SessionLocal()
        try:
            db.query(ForumReactionORM).filter(ForumReactionORM.post_id == post_id).delete()
            db.query(ForumPostORM).filter(ForumPostORM.id == post_id).delete()
            db.commit()
        finally:
            db.close()
