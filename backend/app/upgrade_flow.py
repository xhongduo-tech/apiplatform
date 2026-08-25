"""高并发升级申请相关的小型共享逻辑（避免在各 router 里重复写同一段 UPDATE）。"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ApiKeyORM, UpgradeApplicationORM, UserORM

# 存量补录原因：补齐统一升级申请字段结构（reason 必填）
_BACKFILL_REASON = (
    "存量高并发密钥补录：该密钥此前已处于高并发档位（审批升级或管理员直接调档），"
    "现按升级申请流程归档为已通过，便于后台统一管理与追溯。"
)
_BACKFILL_NOTE = "存量补录（按统一升级申请字段归档）"


def cancel_pending_upgrades(
    db: Session,
    key_id: str,
    note: str = "对应密钥已删除/吊销，升级申请自动失效",
) -> None:
    """密钥被删除或吊销时，把该密钥所有在途升级申请标记为驳回（带固定备注）。

    否则申请会永久滞留为"审批中"——审批端因密钥不可用只能驳回，形成待办积压。
    调用方需自行 db.commit()。
    """
    db.execute(
        update(UpgradeApplicationORM)
        .where(
            UpgradeApplicationORM.key_id == key_id,
            UpgradeApplicationORM.status == "pending",
        )
        .values(
            status="rejected",
            note=note,
            reviewed_at=datetime.now(timezone.utc).replace(tzinfo=None),
            reviewer="system",
        )
    )


def _elevated_key_clause():
    """与 settings.key_tier 的 high / unlimited 判定一致。"""
    high_rpm = settings.RATE_LIMIT_HIGH_RPM
    high_tpm = settings.RATE_LIMIT_HIGH_TPM
    return or_(
        ApiKeyORM.rpm_limit == -1,
        ApiKeyORM.tpm_limit == -1,
        and_(
            ApiKeyORM.rpm_limit.is_not(None),
            ApiKeyORM.tpm_limit.is_not(None),
            ApiKeyORM.rpm_limit >= high_rpm,
            ApiKeyORM.tpm_limit >= high_tpm,
        ),
    )


def ensure_approved_upgrade_for_key(
    db: Session,
    k: ApiKeyORM,
    *,
    reason: str = _BACKFILL_REASON,
    note: str | None = _BACKFILL_NOTE,
    reviewer: str = "admin",
) -> UpgradeApplicationORM | None:
    """保证高并发/超高并发密钥有一条 status=approved 的标准升级申请。

    - 已有 approved → 同步快照字段（key_name/project_name/department），不改 reason
    - 有 pending → 直接批过（套用当前档位，不降档）
    - 否则新建 approved 记录
    非 elevated 档位返回 None。调用方自行 commit。
    """
    tier = settings.key_tier(k.rpm_limit, k.tpm_limit)
    if tier not in ("high", "unlimited"):
        return None

    target_tier = "unlimited" if tier == "unlimited" else "high"
    key_label = (k.project_name or k.name or "").strip() or k.id
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # 申请人姓名：优先 users 表，与密钥申请的用户资料保持一致。
    user = db.execute(
        select(UserORM).where(UserORM.auth_id == k.auth_id).limit(1)
    ).scalar_one_or_none()
    applicant = (user.name if user and user.name else "") or k.auth_id
    department = (k.department or (user.department if user else "") or "").strip()

    existing_approved = db.execute(
        select(UpgradeApplicationORM).where(
            UpgradeApplicationORM.key_id == k.id,
            UpgradeApplicationORM.status == "approved",
        ).limit(1)
    ).scalar_one_or_none()
    if existing_approved is not None:
        existing_approved.key_name = key_label
        existing_approved.project_name = key_label
        existing_approved.department = department or existing_approved.department
        existing_approved.name = existing_approved.name or applicant
        if existing_approved.target_tier != target_tier and target_tier == "unlimited":
            existing_approved.target_tier = "unlimited"
        return existing_approved

    pending = db.execute(
        select(UpgradeApplicationORM).where(
            UpgradeApplicationORM.key_id == k.id,
            UpgradeApplicationORM.status == "pending",
        ).limit(1)
    ).scalar_one_or_none()
    if pending is not None:
        pending.status = "approved"
        pending.target_tier = target_tier
        pending.key_name = key_label
        pending.project_name = key_label
        pending.department = department or pending.department
        pending.name = pending.name or applicant
        pending.reviewed_at = now
        pending.reviewer = reviewer
        if note and not pending.note:
            pending.note = note
        return pending

    app = UpgradeApplicationORM(
        auth_id=k.auth_id,
        name=applicant,
        department=department,
        key_id=k.id,
        key_name=key_label,
        project_name=key_label,
        reason=reason,
        target_tier=target_tier,
        status="approved",
        note=note,
        reviewed_at=now,
        reviewer=reviewer,
        created_at=k.granted_at or now,
    )
    db.add(app)
    return app


def backfill_elevated_upgrade_apps(db: Session) -> int:
    """为所有有效高并发/超高并发密钥补齐已通过升级申请，返回新建/升级条数。"""
    keys = db.execute(
        select(ApiKeyORM).where(
            ApiKeyORM.deleted_at.is_(None),
            ApiKeyORM.revoked.is_(False),
            _elevated_key_clause(),
        )
    ).scalars().all()
    touched = 0
    for k in keys:
        before = db.execute(
            select(UpgradeApplicationORM.id).where(
                UpgradeApplicationORM.key_id == k.id,
                UpgradeApplicationORM.status == "approved",
            ).limit(1)
        ).scalar_one_or_none()
        app = ensure_approved_upgrade_for_key(db, k)
        if app is not None and before is None:
            touched += 1
    return touched
