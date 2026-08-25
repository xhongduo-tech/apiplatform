"""同一用户下场景名（project_name / name）不可重复。"""
from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import ApiKeyORM, ApplicationORM

_SCENARIO_NAME_TAKEN = "该场景名称已被使用，请更换名称"


def scenario_name_taken(
    db: Session,
    auth_id: str,
    name: str,
    *,
    exclude_key_id: str | None = None,
    exclude_application_id: str | None = None,
) -> bool:
    """检查登录用户下是否已有同名场景（有效密钥或待处理/已驳回申请）。"""
    normalized = (name or "").strip()
    if not normalized or not auth_id:
        return False

    key_stmt = (
        select(ApiKeyORM.id)
        .where(
            ApiKeyORM.auth_id == auth_id,
            ApiKeyORM.deleted_at.is_(None),
            or_(ApiKeyORM.name == normalized, ApiKeyORM.project_name == normalized),
        )
        .limit(1)
    )
    if exclude_key_id:
        key_stmt = key_stmt.where(ApiKeyORM.id != exclude_key_id)
    if db.execute(key_stmt).scalar_one_or_none() is not None:
        return True

    app_stmt = (
        select(ApplicationORM.id)
        .where(
            ApplicationORM.auth_id == auth_id,
            ApplicationORM.status.in_(("pending", "rejected")),
            ApplicationORM.project_name == normalized,
        )
        .limit(1)
    )
    if exclude_application_id:
        app_stmt = app_stmt.where(ApplicationORM.id != exclude_application_id)
    return db.execute(app_stmt).scalar_one_or_none() is not None


def assert_scenario_name_available(
    db: Session,
    auth_id: str,
    name: str,
    *,
    exclude_key_id: str | None = None,
    exclude_application_id: str | None = None,
) -> str:
    """校验场景名可用，重复则抛 ValueError（路由层转 HTTP 400）。"""
    normalized = (name or "").strip()
    if scenario_name_taken(
        db,
        auth_id,
        normalized,
        exclude_key_id=exclude_key_id,
        exclude_application_id=exclude_application_id,
    ):
        raise ValueError(_SCENARIO_NAME_TAKEN)
    return normalized
