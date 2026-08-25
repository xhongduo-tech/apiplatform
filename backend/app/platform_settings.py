"""平台级单例配置读写：`platform_settings` 表按 key 存一份 JSON。

`fallback_policy`（全平台兜底策略）与 `ask_docs_config`（Ask Docs LLM 接入配置）
此前各占一张结构相同的"单行、admin 可编辑、一堆开关+参数"表；每加一个新的平台级
配置就要新建 ORM 类 + alembic 迁移。2026-08 合并为一张通用表，具体配置仍以
dataclass 形式在应用层读写——调用方拿到的还是强类型对象，只是持久化载体变了。

以后再新增"单行配置"类需求，直接在本模块加一个 dataclass + get/save 函数，
不必再建表。
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from app.models import PlatformSettingORM

FALLBACK_POLICY_KEY = "fallback_policy"
ASK_DOCS_CONFIG_KEY = "ask_docs_config"
BRANDING_CONFIG_KEY = "branding_config"


def _row(db: Session, key: str) -> PlatformSettingORM | None:
    return db.get(PlatformSettingORM, key)


def _get_or_create_row(db: Session, key: str) -> PlatformSettingORM:
    row = _row(db, key)
    if row is None:
        row = PlatformSettingORM(key=key, value={})
        db.add(row)
        db.flush()
        db.refresh(row)  # 拿到 created_at/updated_at 的服务端默认值
    return row


# ── 平台品牌与组织信息 ─────────────────────────────────────────────────
@dataclass
class BrandingConfig:
    """对外展示的品牌、组织与联系人信息。

    默认值故意使用中性的开源示例文案，不带入任何原部署方的真实名称或
    人员。管理员可在后台修改，前台通过 /api/public/config 统一读取。
    """
    brand_name: str = "Open API Platform"
    platform_name: str = "开放平台"
    browser_title: str = "Open API Platform"
    hero_title: str = "使用大模型 API\n开启你的开发之旅"
    slogan: str = "连接模型能力，加速应用创新"
    organization_name: str = "示例组织"
    footer_text: str = "© 2026 示例组织"
    support_department: str = "平台运营部"
    support_contact: str = "平台管理员"
    support_email: str = "support@example.com"
    approval_department: str = "平台运营部"
    approval_contact: str = "管理员"
    approval_email: str = "approval@example.com"
    updated_at: datetime | None = None


def get_branding_config(db: Session) -> BrandingConfig:
    """读取品牌设置；尚未保存时返回中性默认值，不产生读操作写库副作用。"""
    row = _row(db, BRANDING_CONFIG_KEY)
    if row is None or not isinstance(row.value, dict):
        return BrandingConfig()
    defaults = BrandingConfig()
    v = row.value

    def _text(key: str) -> str:
        value = v.get(key)
        return str(value).strip() if value is not None and str(value).strip() else getattr(defaults, key)

    return BrandingConfig(
        brand_name=_text("brand_name"),
        platform_name=_text("platform_name"),
        browser_title=_text("browser_title"),
        hero_title=_text("hero_title"),
        slogan=_text("slogan"),
        organization_name=_text("organization_name"),
        footer_text=_text("footer_text"),
        support_department=_text("support_department"),
        support_contact=_text("support_contact"),
        support_email=_text("support_email"),
        approval_department=_text("approval_department"),
        approval_contact=_text("approval_contact"),
        approval_email=_text("approval_email"),
        updated_at=row.updated_at,
    )


def save_branding_config(db: Session, config: BrandingConfig) -> BrandingConfig:
    """写入品牌设置并 flush（调用方仍需自行 commit）。"""
    row = _get_or_create_row(db, BRANDING_CONFIG_KEY)
    row.value = {
        "brand_name": config.brand_name.strip(),
        "platform_name": config.platform_name.strip(),
        "browser_title": config.browser_title.strip(),
        "hero_title": config.hero_title.strip(),
        "slogan": config.slogan.strip(),
        "organization_name": config.organization_name.strip(),
        "footer_text": config.footer_text.strip(),
        "support_department": config.support_department.strip(),
        "support_contact": config.support_contact.strip(),
        "support_email": config.support_email.strip(),
        "approval_department": config.approval_department.strip(),
        "approval_contact": config.approval_contact.strip(),
        "approval_email": config.approval_email.strip(),
    }
    db.flush()
    db.refresh(row)
    config.updated_at = row.updated_at
    return config


# ── 全平台兜底策略 ─────────────────────────────────────────────────────────────
@dataclass
class FallbackPolicy:
    """字段与原 FallbackPolicyORM 一一对应，调用方无需感知底层存储变化。"""
    enabled: bool = False
    target_model_id: str | None = None
    source_model_ids: list = field(default_factory=list)
    trip_fails: int = 5
    trip_rate: float = 0.5
    window_s: int = 60
    cooldown_s: int = 120
    max_cooldown_s: int = 1800
    circuit_enabled: bool = False
    forced: bool = False
    updated_at: datetime | None = None


def get_fallback_policy(db: Session) -> FallbackPolicy:
    """读取（不存在则创建默认行，调用方需自行 db.commit()）。"""
    row = _get_or_create_row(db, FALLBACK_POLICY_KEY)
    v = row.value if isinstance(row.value, dict) else {}
    return FallbackPolicy(
        enabled=bool(v.get("enabled", False)),
        target_model_id=v.get("target_model_id"),
        source_model_ids=list(v.get("source_model_ids") or []),
        trip_fails=int(v.get("trip_fails", 5)),
        trip_rate=float(v.get("trip_rate", 0.5)),
        window_s=int(v.get("window_s", 60)),
        cooldown_s=int(v.get("cooldown_s", 120)),
        max_cooldown_s=int(v.get("max_cooldown_s", 1800)),
        circuit_enabled=bool(v.get("circuit_enabled", False)),
        forced=bool(v.get("forced", False)),
        updated_at=row.updated_at,
    )


def save_fallback_policy(db: Session, policy: FallbackPolicy) -> FallbackPolicy:
    """写入并 flush（调用方仍需自行 db.commit()）。"""
    row = _get_or_create_row(db, FALLBACK_POLICY_KEY)
    row.value = {
        "enabled": policy.enabled,
        "target_model_id": policy.target_model_id,
        "source_model_ids": list(policy.source_model_ids),
        "trip_fails": policy.trip_fails,
        "trip_rate": policy.trip_rate,
        "window_s": policy.window_s,
        "cooldown_s": policy.cooldown_s,
        "max_cooldown_s": policy.max_cooldown_s,
        "circuit_enabled": policy.circuit_enabled,
        "forced": policy.forced,
    }
    db.flush()
    db.refresh(row)
    policy.updated_at = row.updated_at
    return policy


# ── Ask Docs 配置 ─────────────────────────────────────────────────────────────
@dataclass
class AskDocsConfig:
    """字段与原 AskDocsConfigORM 一一对应。"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    provider: str = "openai"
    model: str = "gpt-4o"
    api_base: str | None = None
    api_key: str | None = None
    system_prompt: str | None = None
    max_tokens: int = 4096
    temperature: float = 0.3
    enabled: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


def get_ask_docs_config(db: Session) -> AskDocsConfig | None:
    """未配置过时返回 None（语义等价于原表"还没有任何一行"）。"""
    row = _row(db, ASK_DOCS_CONFIG_KEY)
    if row is None or not isinstance(row.value, dict) or not row.value:
        return None
    v = row.value
    return AskDocsConfig(
        id=v.get("id") or str(uuid.uuid4()),
        provider=v.get("provider", "openai"),
        model=v.get("model", "gpt-4o"),
        api_base=v.get("api_base"),
        api_key=v.get("api_key"),
        system_prompt=v.get("system_prompt"),
        max_tokens=int(v.get("max_tokens", 4096)),
        temperature=float(v.get("temperature", 0.3)),
        enabled=bool(v.get("enabled", False)),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def save_ask_docs_config(db: Session, config: AskDocsConfig) -> AskDocsConfig:
    row = _get_or_create_row(db, ASK_DOCS_CONFIG_KEY)
    row.value = {
        "id": config.id,
        "provider": config.provider,
        "model": config.model,
        "api_base": config.api_base,
        "api_key": config.api_key,
        "system_prompt": config.system_prompt,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
        "enabled": config.enabled,
    }
    db.flush()
    db.refresh(row)
    config.created_at = row.created_at
    config.updated_at = row.updated_at
    return config
