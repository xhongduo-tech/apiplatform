"""SQLAlchemy ORM 模型 + Pydantic schema。"""
from __future__ import annotations

import secrets
import uuid
from datetime import date as _date, datetime, timezone

from pydantic import BaseModel, Field
from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, func,
)
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.database import Base
from app.encrypted_types import EncryptedJSON, EncryptedString
from app.model_secrets import normalize_model_base_url


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _token_version() -> int:
    # 新账号用不可预测的非零版本，避免删除后同 auth_id 重建时旧 JWT 重新生效。
    return secrets.randbelow(2**31 - 1) + 1


# ── API Keys ─────────────────────────────────────────────────────────────────
class ApiKeyORM(Base):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    auth_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    project_name: Mapped[str] = mapped_column(String, nullable=False)
    project_desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    department: Mapped[str] = mapped_column(String, nullable=False)
    # 业务场景分类：key|dept_explore|innovation|labor_contest|explore（详见 stats_breakdown.SCENE_TYPES）；
    # 存量/缺失默认归入「探索场景」，新申请由申请人在表单里选择。
    scene_type: Mapped[str] = mapped_column(String(32), nullable=False, default="explore")
    models: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # 允许调用的模型 id，空=全部
    # 仅存哈希与前缀；明文密钥仅在创建时一次性返回，绝不落库（防止库/备份泄露即全量泄露）。
    api_key: Mapped[str | None] = mapped_column(String, nullable=True)
    key_hash: Mapped[str | None] = mapped_column(String, nullable=True, unique=True, index=True)
    key_prefix: Mapped[str | None] = mapped_column(String, nullable=True)
    granted_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    # 审批产生的密钥只向申请人交付一次。NULL 表示申请人尚未领取；领取时才生成
    # （或为历史未使用密钥轮换）明文并写入哈希，管理员审批响应不再接触明文。
    user_claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # 017 迁移加的外键：申请被删时密钥保留，只是解除关联（不级联删密钥）
    application_id: Mapped[str | None] = mapped_column(
        ForeignKey("applications.id", ondelete="SET NULL"), nullable=True, index=True,
    )

    # ── 限额（平台仅保留 RPM/TPM 两种维度；IP 白名单 / 可用时段已整体移除，
    #    改由并发档位 + 夜间不限流窗口覆盖）─────────────────────────────────
    # 单 Key RPM/TPM 覆盖：None = 使用平台默认（settings.RATE_LIMIT_*）。
    # 平台只有 RPM/TPM 两种限额（月度配额已于 2026-07-19 整体移除）；
    # tpm_limit 用 BigInteger：int4 上限 21.4 亿，超高并发档可能超过。
    rpm_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tpm_limit: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


# ── 场景分类（业务场景，admin 可增删改；api_keys.scene_type 引用 key）──────────
class SceneTypeORM(Base):
    __tablename__ = "scene_types"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 申请 ─────────────────────────────────────────────────────────────────────
class ApplicationORM(Base):
    __tablename__ = "applications"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    auth_id: Mapped[str] = mapped_column(String, nullable=False)
    department: Mapped[str] = mapped_column(String, nullable=False)
    project_name: Mapped[str] = mapped_column(String, nullable=False)
    project_desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    scene_type: Mapped[str] = mapped_column(String(32), nullable=False, default="explore")
    models: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")  # pending|approved|rejected
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # 管理员审批备注
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewer: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 模型注册表 ───────────────────────────────────────────────────────────────
class ModelRegistryORM(Base):
    __tablename__ = "model_registry"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    provider: Mapped[str] = mapped_column(String, nullable=False, default="")
    short_desc: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    readme: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_window: Mapped[str | None] = mapped_column(String, nullable=True)  # 展示用字符串（如 "128K"）
    # online|offline|exclusive|unstable|maintenance|upcoming|upgrading
    # upcoming = 抢先体验计划（原「即将上线」，2026-07-21 起语义为「仅授权用户可调用」）
    status: Mapped[str] = mapped_column(String, nullable=False, default="online")
    category: Mapped[str] = mapped_column(String, nullable=False, default="chat")  # chat|vision|flagship|embedding|reranker|image_gen|ocr|lts
    speed: Mapped[str | None] = mapped_column(String, nullable=True)

    base_url: Mapped[str | None] = mapped_column(
        EncryptedString("model_registry.base_url"), nullable=True,
    )
    api_key: Mapped[str | None] = mapped_column(
        EncryptedString("model_registry.api_key"), nullable=True,
    )
    model_api_name: Mapped[str | None] = mapped_column(String, nullable=True)
    import_format: Mapped[str | None] = mapped_column(String, nullable=True, default="openai")  # openai|anthropic|custom
    custom_headers: Mapped[dict | None] = mapped_column(
        EncryptedJSON("model_registry.custom_headers"), nullable=True,
    )
    extra: Mapped[dict | None] = mapped_column(
        EncryptedJSON("model_registry.extra"), nullable=True,
    )

    pricing_input: Mapped[float | None] = mapped_column(Float, nullable=True)   # ¥/百万 token
    pricing_output: Mapped[float | None] = mapped_column(Float, nullable=True)

    # 虚拟模型路由：platform-sota / platform-flash → 真实模型
    resolve_to_model_id: Mapped[str | None] = mapped_column(String, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    @validates("base_url")
    def _validate_base_url(self, _key: str, value: str | None) -> str | None:
        return normalize_model_base_url(value)


class CatalogSeededIdORM(Base):
    """记录 catalog_seed 曾经插入过哪些 model_id——空库引导只做一次。

    只看 model_registry 里"当前有没有这个 id"不够：管理员改名/删除模型后，
    这里没有登记的 id 会在下次启动被 seed_catalog_models() 悄悄插回去。
    这张表登记的是"历史上插过"，而不是"现在还在"，删除/改名之后这里的记录
    不会被清掉，seed 因此能永久放行 admin 的改动。
    """
    __tablename__ = "catalog_seeded_ids"

    model_id: Mapped[str] = mapped_column(String, primary_key=True)
    seeded_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 用量日志 ─────────────────────────────────────────────────────────────────
class UsageLogORM(Base):
    __tablename__ = "usage_logs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # 全链路 request-id（响应头 X-Request-Id 同值），用户报障时凭此精确定位
    request_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    # 017 迁移加的外键：ondelete=SET NULL 只是为了兼容万一将来改成硬删；
    # api_keys 目前一律软删（deleted_at），从不真的 DELETE，这条 SET NULL
    # 实际从未触发过——该列仍是 NOT NULL，与"若触发会设为 NULL"并不矛盾，
    # 因为在当前软删语义下它根本不会被触发。
    api_key_id: Mapped[str] = mapped_column(
        ForeignKey("api_keys.id", ondelete="SET NULL"), nullable=False, index=True,
    )
    # model_id 是"调用当时的标签"，不是活引用：模型硬删除时不该级联影响历史用量，
    # 也不该被抹成 NULL，故不加外键（详见 017 迁移文件顶部说明）
    model_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 用量来源标记：usage_estimated=True 表示上游未回报 usage、token 为网关估算
    # （流式路径正文/请求体字符级估算）；stream=True 表示本次是流式调用。
    usage_estimated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    stream: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # cache-ready：透传上游命中指标（本期不自建缓存）
    cache_hit_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_miss_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status_code: Mapped[str | None] = mapped_column(String, nullable=True)
    # 兜底归因：circuit=熔断被动切流，retry=请求级即时切换
    fallback_from: Mapped[str | None] = mapped_column(String, nullable=True)
    fallback_trigger: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    response_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    estimated_cost: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (
        Index("ix_usage_created", "created_at"),
        Index("ix_usage_key_created", "api_key_id", "created_at"),
        Index("ix_usage_model_created", "model_id", "created_at"),
        Index("ix_usage_fallback_from_created", "fallback_from", "created_at"),
        Index("ix_usage_fallback_trigger_created", "fallback_trigger", "created_at"),
    )


# ── 用量日汇总（永久保留）────────────────────────────────────────────────────
class UsageDailySummaryORM(Base):
    """按 天 + API Key + 模型 的调用/Token 永久汇总。

    usage_logs 明细可按 USAGE_LOG_RETENTION_DAYS 定期清理（详情、错误、响应预览等仅用于
    近期排查），但用户维度的用量统计需要永久保留、且不受 Key 被删除影响 —— 因此在
    usage_writer 写入明细的同时原子递增本表，各统计接口一律从本表聚合，不再依赖 usage_logs。
    """
    __tablename__ = "usage_daily_summary"

    day: Mapped[_date] = mapped_column(Date, primary_key=True)
    api_key_id: Mapped[str] = mapped_column(String, primary_key=True)
    model_id: Mapped[str] = mapped_column(String, primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # token 列 BigInteger：无限档 Key 的夜间批量单日可逼近 int4 上限（21.4 亿），
    # 溢出会让 usage_writer 整批写入失败、该批计量全部丢失
    prompt_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cache_hit_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    __table_args__ = (
        Index("ix_usage_summary_key_day", "api_key_id", "day"),
    )


class UsageHourlySummaryORM(Base):
    """按 天 + 小时 + API Key 的调用次数永久汇总（热力图）。"""
    __tablename__ = "usage_hourly_summary"

    day: Mapped[_date] = mapped_column(Date, primary_key=True)
    hour: Mapped[int] = mapped_column(Integer, primary_key=True)
    api_key_id: Mapped[str] = mapped_column(String, primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_usage_hourly_key_day", "api_key_id", "day"),
    )


class UsageRequestProfileORM(Base):
    """单次请求的 slim 画像（prompt tokens + tool call 数），供 Session 分布统计。

    usage_logs 清理后仍保留；行体积小，默认保留 180 天（见 USAGE_PROFILE_RETENTION_DAYS）。
    """
    __tablename__ = "usage_request_profile"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    api_key_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tool_calls_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_usage_profile_key_created", "api_key_id", "created_at"),
    )


class UsageContextBucketDailyORM(Base):
    """按 天 + API Key + 分桶索引 的 prompt tokens 分布永久汇总。"""
    __tablename__ = "usage_context_bucket_daily"

    day: Mapped[_date] = mapped_column(Date, primary_key=True)
    api_key_id: Mapped[str] = mapped_column(String, primary_key=True)
    bucket: Mapped[int] = mapped_column(Integer, primary_key=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_usage_ctx_bucket_key_day", "api_key_id", "day"),
    )


# ── 用户 ─────────────────────────────────────────────────────────────────────
class UserORM(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    auth_id: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    department: Mapped[str | None] = mapped_column(String, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    # 用户 JWT 带签发时版本；改密/管理员重置/停用时递增，旧 JWT 即时失效。
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=_token_version)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 抢先体验计划 ──────────────────────────────────────────────────────────────
class EarlyAccessApplicationORM(Base):
    """抢先体验计划（Early Access）准入申请：每个账号 ID一行。

    模型侧不新增任何列——「抢先体验计划」复用 model_registry.status == "upcoming"
    这一既有取值（原「即将上线」），语义改为「仅授权用户可调用」。授权与否只看
    本表：status == "approved" 即放行，其余（无记录 / pending / rejected）一律
    在代理入口 403。

    用户可在被驳回后重新提交（复用同一行，status 回到 pending）。
    """
    __tablename__ = "early_access_applications"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    auth_id: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    department: Mapped[str] = mapped_column(String, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")  # pending|approved|rejected
    # 提交时用户勾选确认的使用规范/免责协议版本，留痕用
    agreement_version: Mapped[str] = mapped_column(String, nullable=False, default="v1")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # 管理员审批备注
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewer: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 高并发升级申请 ─────────────────────────────────────────────────────────────
class UpgradeApplicationORM(Base):
    """高并发档位升级申请：申请人对某一密钥提交申请原因，管理员审批通过后
    由后台把该密钥套用「高并发」预设档位。与密钥申请（applications）不同——
    审批动作是"提升既有密钥档位"，不是"发放新密钥"，故单独建表、单独审批流。
    """
    __tablename__ = "upgrade_applications"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    auth_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    department: Mapped[str] = mapped_column(String, nullable=False, default="")
    # 申请升级的密钥；被删后置 NULL（申请记录保留，后台显示「密钥已删除」）
    key_id: Mapped[str | None] = mapped_column(
        ForeignKey("api_keys.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    # 提交时密钥名/项目名快照，便于后台展示与追溯（密钥可能后续改名/删除）
    key_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    project_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    reason: Mapped[str] = mapped_column(Text, nullable=False)  # 申请原因
    target_tier: Mapped[str] = mapped_column(String(32), nullable=False, default="high")  # 当前仅 high
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")  # pending|approved|rejected
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # 管理员审批备注
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewer: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 社区 ─────────────────────────────────────────────────────────────────────
class ForumPostORM(Base):
    __tablename__ = "forum_posts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    author_auth_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    author_name: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    resolved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ForumReplyORM(Base):
    __tablename__ = "forum_replies"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    post_id: Mapped[str] = mapped_column(
        ForeignKey("forum_posts.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    author_auth_id: Mapped[str] = mapped_column(String, nullable=False)
    author_name: Mapped[str] = mapped_column(String, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 社区互动 ─────────────────────────────────────────────────────────────────
class ForumReactionORM(Base):
    """用户对帖子的一次性互动标记（赞 / 关注），按 reaction_type 区分。

    forum_likes 与 forum_follows 曾是结构完全相同的两张表（同样的
    post_id + user_auth_id + created_at + 唯一约束），2026-08 合并于此——
    以后再加"收藏""举报"这类同构互动，插一个新 reaction_type 即可，
    不必再新建表。
    """
    __tablename__ = "forum_reactions"

    LIKE = "like"
    FOLLOW = "follow"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    post_id: Mapped[str] = mapped_column(
        ForeignKey("forum_posts.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    user_auth_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    reaction_type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index(
            "ix_forum_reaction_post_user_type", "post_id", "user_auth_id", "reaction_type",
            unique=True,
        ),
    )


# ── 通知 / 公告 ──────────────────────────────────────────────────────────────
class NotificationORM(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(String, nullable=False, default="info")  # online|offline|maintenance|info
    title: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 审计 ─────────────────────────────────────────────────────────────────────
class AuditLogORM(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    actor: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    target: Mapped[str | None] = mapped_column(String, nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── 算力拓扑资源登记 ──────────────────────────────────────────────────────────
class InfraResourceORM(Base):
    """管理员登记的服务器、模型与应用节点（算力拓扑权威来源）。"""
    __tablename__ = "infra_resources"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)  # server|model|application
    name: Mapped[str] = mapped_column(String, nullable=False)
    subtitle: Mapped[str] = mapped_column(String, nullable=False, default="")
    pool: Mapped[str | None] = mapped_column(String, nullable=True)  # primary|secondary/custom
    extra: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_infra_resource_kind_name", "kind", "name"),
    )


class InfraTopologyLinkORM(Base):
    """拓扑节点关系；资源节点引用登记 ID，资源池使用中性内置 ID。"""
    __tablename__ = "infra_topology_links"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    source_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    target_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    relation: Mapped[str] = mapped_column(String, nullable=False, default="serves")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_infra_topology_source_target", "source_id", "target_id", unique=True),
    )



# ── 运营巡检报告 ──────────────────────────────────────────────────────────────
class OpsReportORM(Base):
    """定期巡检生成的运营分析报告（多维聚合 + 异常摘要，按周期幂等）。"""
    __tablename__ = "ops_reports"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String, nullable=False, default="daily")  # daily|weekly|monthly|quarterly|yearly|cumulative|manual
    # 巡检覆盖的时间窗（半开区间 [period_start, period_end)）
    period_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)  # 人类可读标题，如 "2026-06-28 日报"
    # 整体健康：ok|warning|critical（由异常等级推导）
    health: Mapped[str] = mapped_column(String, nullable=False, default="ok")
    summary_md: Mapped[str] = mapped_column(Text, nullable=False, default="")  # Markdown 摘要
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # 结构化多维指标
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_ops_report_kind_start", "kind", "period_start", unique=True),
        Index("ix_ops_report_generated", "generated_at"),
    )


# ── 夜间批量调用登记 ──────────────────────────────────────────────────────────
class NightBatchRegistrationORM(Base):
    """夜间批量调用登记处：登记计划中的夜间批量调用时段，供他人查看以规避资源冲突。

    一次提交（若勾选重复星期）会展开为多条独立行，共享同一个 series_id；除创建时的
    展开与"删除整个系列"外，读路径（列表、冲突检测）一律按扁平行处理。
    """
    __tablename__ = "night_batch_registrations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    series_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    series_total: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    creator_auth_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    creator_name: Mapped[str] = mapped_column(String, nullable=False)
    project: Mapped[str] = mapped_column(String, nullable=False, default="")  # 取自 claims["department"]，不接受手填

    model_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    model_name: Mapped[str] = mapped_column(String, nullable=False)  # 创建时从 ModelRegistryORM 冗余，不接受手填

    contact_name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    intensity_note: Mapped[str | None] = mapped_column(String, nullable=True)

    start_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    repeat_weekdays: Mapped[list | None] = mapped_column(JSON, nullable=True)  # 0=周一..6=周日；展示用，不参与查询
    repeat_until: Mapped[_date | None] = mapped_column(Date, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_night_batch_start_end", "start_at", "end_at"),
    )


# ── 平台单例配置（通用 key → JSON）──────────────────────────────────────────────
class PlatformSettingORM(Base):
    """平台级"单行开关+参数"配置的统一载体，按 key 区分具体功能。

    fallback_policy（全平台兜底策略）与 ask_docs_config（Ask Docs LLM 接入）
    此前各占一张结构相同的单行表——每加一个新的平台级配置就要新建 ORM 类 +
    alembic 迁移。2026-08 合并于此；具体字段的类型校验与默认值改由
    app/platform_settings.py 的 dataclass 在应用层负责，不再靠数据库列类型兜底。
    """
    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(
        EncryptedJSON("platform_settings.value"), nullable=False, default=dict,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


# ── 文档反馈 ─────────────────────────────────────────────────────────────────
class DocFeedbackORM(Base):
    """接口文档页的「这篇文档有帮助吗」赞踩与意见。

    此前这份反馈只写进浏览器 localStorage，且用固定 key——同一浏览器第二次
    提交会覆盖第一次，后端从未收到过任何一条，没有人能读到。落库后管理员可在
    后台按文档章节看到集中反馈。

    匿名友好：`auth_id` 可空。文档页对未登录用户也开放，强制实名会直接压掉
    反馈量；需要追问细节时仍可通过论坛。
    """

    __tablename__ = "doc_feedback"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # 文档章节 id（docs 页的 section anchor），便于定位是哪一段说不清楚
    section: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    vote: Mapped[str] = mapped_column(String, nullable=False)          # up | down
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    auth_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    lang: Mapped[str | None] = mapped_column(String, nullable=True)    # zh-CN | zh-TW | en
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        # 后台按时间倒序翻页；无索引时随反馈量增长会退化为全表扫 + 排序
        Index("ix_doc_feedback_created_at", "created_at"),
    )


# ════════════════════════════════════════════════════════════════════════════
# Pydantic schema（请求/响应）
# ════════════════════════════════════════════════════════════════════════════
class ApplicationIn(BaseModel):
    # 注意：auth_id/department 后端一律以登录态 JWT 为准，请求体里即使带了也会被忽略。
    project_name: str
    project_desc: str | None = None
    # 业务场景分类，缺省归入「探索场景」（explore）；见 stats_breakdown.SCENE_TYPES
    scene_type: str | None = None
    models: list[str] = Field(default_factory=list)
    reason: str | None = None


class UpgradeApplyIn(BaseModel):
    """并发档位升级申请：指定密钥、目标档位与申请原因。"""
    key_id: str
    reason: str
    target_tier: str = "high"  # high | unlimited


class UpgradeUpdateIn(BaseModel):
    """修改待审批的升级申请（目标档位 + 原因）。"""
    reason: str
    target_tier: str
