"""用户端点：自助用量/日志查询 + 社区。"""
from __future__ import annotations

import logging
import math
import time
import asyncio
from datetime import date as date_type, datetime, timedelta, timezone

from fastapi import APIRouter, Body, Cookie, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import extract, func, or_, select
from sqlalchemy.dialects.postgresql import array as pg_array
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    KEY_PREFIX,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PasswordPolicyError,
    clear_user_session_cookie,
    create_user_token,
    dummy_password_hash,
    generate_api_key,
    hash_key,
    hash_password,
    mask_key_prefix,
    optional_user_session,
    password_needs_rehash,
    require_user,
    set_user_session_cookie,
    validate_password,
    verify_password,
)
from app import platform_time
from app.session_stats import (
    TOOL_CALL_BUCKETS,
    CONTEXT_LENGTH_LABELS,
    build_tool_call_distribution,
    empty_context_buckets,
)
from app.config import settings
from app.csv_export import csv_download
from app.database import get_db
from app.auth_rate_limit import enforce_auth_rate
from app.early_access import (
    AGREEMENT_VERSION, EARLY_ACCESS_STATUS, RESUBMITTABLE, STATUS_APPROVED,
    STATUS_PENDING, iso_utc,
)
from app.heatmap_stats import build_cumulative_heatmap, build_month_heatmap, build_week_heatmap
from app.platform_usage_stats import build_scenes_dist
from app.stats_breakdown import query_summary_breakdown
from app.models import (
    ApiKeyORM,
    ApplicationORM,
    EarlyAccessApplicationORM,
    ForumPostORM,
    ForumReactionORM,
    ForumReplyORM,
    ModelRegistryORM,
    SceneTypeORM,
    UsageDailySummaryORM,
    UsageLogORM,
    UsageContextBucketDailyORM,
    UsageRequestProfileORM,
    UserORM,
)
from app.proxy.db_bridge import invalidate_prepare_cache
from app.redis_client import redis
from app.upgrade_flow import cancel_pending_upgrades
from app.tier_flow import USER_TIERS, apply_tier_preset, can_downgrade_to, display_tier
from app.scenario_name import assert_scenario_name_available

log = logging.getLogger("apiplatform.user")

router = APIRouter()


class TierChangeIn(BaseModel):
    target_tier: str = Field(..., description="default | high | unlimited")


class ForumPostIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)
    author_name: str | None = None


# ── 账号：注册 / 登录 / 找回密码 ──────────────────────────────────────────────
class UserRegisterIn(BaseModel):
    authId: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    department: str = Field(default="", max_length=200)
    password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH)


class UserLoginIn(BaseModel):
    authId: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=PASSWORD_MAX_LENGTH)


class UserRecoverIn(BaseModel):
    authId: str = Field(min_length=1, max_length=128)
    apiKey: str = Field(min_length=1, max_length=512)


class UserResetPasswordIn(UserRecoverIn):
    newPassword: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH)


def _password_policy_or_400(password: str) -> None:
    try:
        validate_password(password)
    except PasswordPolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _verify_recover_identity(db: Session, auth_id: str, api_key: str) -> None:
    """找回密码身份核验：账号 ID + 名下一把有效 API Key（真正的秘密）。

    旧实现仅凭「账号 ID + 项目名」即可重置——二者均非秘密、可被枚举/猜测，存在账号
    接管风险。现要求出示该账号 ID名下任意一把未吊销/未删除的 API Key 原文。
    """
    raw = (api_key or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="请提供该账号 ID名下任意一把有效 API Key 以验证身份")
    key = db.execute(
        select(ApiKeyORM).where(
            ApiKeyORM.auth_id == auth_id,
            ApiKeyORM.key_hash == hash_key(raw),
            ApiKeyORM.deleted_at.is_(None),
            ApiKeyORM.revoked.is_(False),
        )
    ).scalar_one_or_none()
    if key is None:
        raise HTTPException(status_code=404, detail="身份验证失败：账号 ID与 API Key 不匹配")


@router.post("/user/register")
async def user_register(
    payload: UserRegisterIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    if not settings.ALLOW_PUBLIC_REGISTRATION:
        raise HTTPException(status_code=403, detail="当前部署已关闭自助注册")
    auth_id = payload.authId.strip()
    name = payload.name.strip()
    department = payload.department.strip()
    password = payload.password
    if not auth_id or not name or not password:
        raise HTTPException(status_code=400, detail="账号 ID、姓名、密码均为必填")
    _password_policy_or_400(password)
    await enforce_auth_rate(
        request, action="register", account=auth_id,
        client_limit=5, account_limit=3, window_s=3600,
    )
    existing = db.execute(
        select(UserORM).where(UserORM.auth_id == auth_id)
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="该账号 ID 已注册，请直接登录")
    user = UserORM(
        auth_id=auth_id,
        name=name,
        department=department,
        password_hash=await asyncio.to_thread(hash_password, password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="该账号 ID 已注册，请直接登录") from exc
    session = create_user_token(auth_id, name, department, user.token_version)
    set_user_session_cookie(response, session["token"])
    return session


@router.post("/user/login")
async def user_login(
    payload: UserLoginIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    auth_id = payload.authId.strip()
    password = payload.password
    await enforce_auth_rate(
        request, action="login", account=auth_id,
        client_limit=30, account_limit=10, window_s=900,
    )
    user = db.execute(
        select(UserORM).where(UserORM.auth_id == auth_id)
    ).scalar_one_or_none()
    # 不区分不存在、已停用与密码错误，避免凭错误消息枚举账号。
    stored_hash = user.password_hash if user is not None and user.is_active else dummy_password_hash()
    password_valid = await asyncio.to_thread(verify_password, password, stored_hash)
    valid = bool(user is not None and user.is_active and password_valid)
    if not valid:
        raise HTTPException(status_code=401, detail="账号 ID 或密码错误")
    if password_needs_rehash(user.password_hash):
        user.password_hash = await asyncio.to_thread(hash_password, password)
        db.commit()
    session = create_user_token(auth_id, user.name, user.department, user.token_version)
    set_user_session_cookie(response, session["token"])
    return session


@router.post("/user/recover")
async def user_recover(
    payload: UserRecoverIn,
    request: Request,
    db: Session = Depends(get_db),
):
    if not settings.ALLOW_PASSWORD_RECOVERY:
        raise HTTPException(status_code=403, detail="当前部署已关闭密码找回")
    auth_id = payload.authId.strip()
    api_key = payload.apiKey.strip()
    await enforce_auth_rate(
        request, action="recover", account=auth_id,
        client_limit=10, account_limit=5, window_s=3600,
    )
    _verify_recover_identity(db, auth_id, api_key)
    return {"message": "身份验证成功"}


@router.post("/user/reset-password")
async def user_reset_password(
    payload: UserResetPasswordIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    if not settings.ALLOW_PASSWORD_RECOVERY:
        raise HTTPException(status_code=403, detail="当前部署已关闭密码找回")
    auth_id = payload.authId.strip()
    api_key = payload.apiKey.strip()
    new_password = payload.newPassword
    _password_policy_or_400(new_password)
    await enforce_auth_rate(
        request, action="reset", account=auth_id,
        client_limit=10, account_limit=5, window_s=3600,
    )
    _verify_recover_identity(db, auth_id, api_key)
    user = db.execute(
        select(UserORM).where(UserORM.auth_id == auth_id)
    ).scalar_one_or_none()
    if user is None:
        # 已有密钥但从未注册过账号：依据已核验的身份补建账号。
        user = UserORM(auth_id=auth_id, name=auth_id, department="")
        db.add(user)
    elif not user.is_active:
        # 密码找回不能越过管理员停用/注销状态重新激活账号。
        raise HTTPException(status_code=404, detail="身份验证失败")
    user.password_hash = await asyncio.to_thread(hash_password, new_password)
    user.token_version = int(user.token_version or 0) + 1
    db.commit()
    clear_user_session_cookie(response)
    return {"message": "密码重置成功"}


@router.post("/user/dev-login")
async def user_dev_login(response: Response, db: Session = Depends(get_db)):
    """开发环境专用假登录：用本地演示账号直接换用户 JWT。

    仅在 ENVIRONMENT == "development" 时可用（其他环境直接 404，防止测试账号漏进部署，
    也避免暴露为可任意模拟真实账号 ID 的后门）。auth_id 已存在则沿用库内
    姓名/部门，避免把已有账号覆盖成泛化测试名。
    """
    response.headers["Cache-Control"] = "no-store"
    if settings.ENVIRONMENT != "development":
        raise HTTPException(status_code=404, detail="Not Found")
    auth_id = settings.DEV_LOGIN_AUTH_ID
    user = db.execute(
        select(UserORM).where(UserORM.auth_id == auth_id)
    ).scalar_one_or_none()
    if user is None:
        user = UserORM(
            auth_id=auth_id,
            name=settings.DEV_LOGIN_NAME,
            department=settings.DEV_LOGIN_DEPARTMENT,
        )
        db.add(user)
        db.commit()
    if not user.is_active:
        raise HTTPException(status_code=403, detail="开发账号已停用")
    session = create_user_token(auth_id, user.name, user.department, user.token_version)
    set_user_session_cookie(response, session["token"])
    return session


@router.get("/user/session")
def user_session(response: Response, claims: dict = Depends(require_user)):
    """用 HttpOnly cookie 恢复浏览器会话；不把 JWT 重新暴露给 JavaScript。"""
    response.headers["Cache-Control"] = "no-store"
    try:
        expires_in = max(0, int(float(claims["exp"]) - datetime.now(timezone.utc).timestamp()))
    except (KeyError, TypeError, ValueError):
        expires_in = 0
    return {
        "authId": claims["sub"],
        "name": claims.get("name", ""),
        "department": claims.get("department", ""),
        "expiresIn": expires_in,
    }


@router.post("/user/logout")
def user_logout(response: Response):
    """幂等退出：即使 cookie 已过期也返回成功并覆盖删除。"""
    clear_user_session_cookie(response)
    return {"ok": True}


# ── 抢先体验计划 ──────────────────────────────────────────────────────────────
def _early_access_row(db: Session, auth_id: str) -> EarlyAccessApplicationORM | None:
    return db.execute(
        select(EarlyAccessApplicationORM)
        .where(EarlyAccessApplicationORM.auth_id == auth_id)
    ).scalar_one_or_none()


def _early_access_models(db: Session) -> list[dict]:
    """当前处于抢先体验计划的模型（弹窗里如实列出，不写死名字）。"""
    rows = db.execute(
        select(ModelRegistryORM.id, ModelRegistryORM.name)
        .where(ModelRegistryORM.status == EARLY_ACCESS_STATUS)
        .order_by(ModelRegistryORM.name)
    ).all()
    return [{"id": r[0], "name": r[1]} for r in rows]


def _early_access_dict(row: EarlyAccessApplicationORM | None) -> dict:
    """status: none（从未申请）| pending | approved | rejected | revoked。"""
    if row is None:
        return {"status": "none", "submitted_at": None, "reviewed_at": None, "note": None}
    return {
        "status": row.status,
        "submitted_at": iso_utc(row.submitted_at),
        "reviewed_at": iso_utc(row.reviewed_at),
        "note": row.note,
    }


#: 每个认证号每小时最多提交次数。唯一约束 + 幂等已经挡住了刷库，这里只是防止
#: rejected↔pending 被无限翻转把审批列表刷爆。
_EARLY_ACCESS_RATE_PER_HOUR = 5


async def _check_early_access_rate(auth_id: str) -> None:
    """fail-open：Redis 异常一律放行，不因协调层抖动挡住正常申请。"""
    bucket = int(time.time() // 3600)
    key = f"ea:apply:{auth_id}:{bucket}"
    try:
        n = int(await redis.incr(key))
        if n == 1:
            await redis.expire(key, 3700)
        if n > _EARLY_ACCESS_RATE_PER_HOUR:
            raise HTTPException(status_code=429, detail="提交过于频繁，请稍后再试")
    except HTTPException:
        raise
    except Exception:
        pass


@router.get("/user/early-access")
def get_early_access(
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    auth_id = claims.get("sub") or ""
    return {
        **_early_access_dict(_early_access_row(db, auth_id)),
        "agreement_version": AGREEMENT_VERSION,
        "models": _early_access_models(db),
    }


@router.post("/user/early-access")
async def submit_early_access(
    payload: dict = Body(default={}),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """提交抢先体验计划申请。必须显式确认使用规范与免责协议。

    已通过的申请不可重复提交；待审批的重复提交为幂等 no-op；被驳回/被撤销的
    可复用同一行重新提交（status 回到 pending，清掉上次的审批备注）。
    """
    auth_id = claims.get("sub") or ""
    if not auth_id:
        raise HTTPException(status_code=401, detail="登录态无效")
    if not payload.get("agreed"):
        raise HTTPException(status_code=400, detail="请先确认使用规范与免责协议")
    await _check_early_access_rate(auth_id)

    row = _early_access_row(db, auth_id)
    if row is None:
        row = EarlyAccessApplicationORM(
            auth_id=auth_id,
            name=claims.get("name") or auth_id,
            department=claims.get("department") or "",
            agreement_version=AGREEMENT_VERSION,
        )
        db.add(row)
    elif row.status == STATUS_APPROVED:
        raise HTTPException(status_code=400, detail="你已获得抢先体验计划授权，无需重复申请")
    elif row.status in RESUBMITTABLE:
        row.status = STATUS_PENDING
        row.name = claims.get("name") or row.name
        row.department = claims.get("department") or row.department
        row.agreement_version = AGREEMENT_VERSION
        row.submitted_at = datetime.now(timezone.utc).replace(tzinfo=None)
        row.reviewed_at = None
        row.reviewer = None
        row.note = None
    try:
        db.commit()
    except IntegrityError:
        # 同一认证号并发首次提交：auth_id 唯一约束会让其中一个失败。这不是错误，
        # 提交本就该幂等——回滚后返回另一个请求已经建好的那行，而不是抛 500。
        db.rollback()
        existing = _early_access_row(db, auth_id)
        if existing is None:
            raise
        return _early_access_dict(existing)
    return _early_access_dict(_early_access_row(db, auth_id))


# ── 账号维度的统计 / 日志（登录态聚合该用户全部密钥）────────────────────────────
def _user_key_ids(db: Session, auth_id: str) -> list[str]:
    """该账号 ID名下全部密钥 id（含已撤销，保留历史统计）。"""
    return list(
        db.execute(select(ApiKeyORM.id).where(ApiKeyORM.auth_id == auth_id)).scalars().all()
    )


def _parse_dt(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


@router.get("/user/stats")
def user_stats(
    year: int | None = Query(default=None),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """月度 + 历史累计统计：一律从永久汇总表聚合，不受 usage_logs 清理策略、Key 删除影响。"""
    auth_id = claims.get("sub") or ""
    y = year or platform_time.now_local().year
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return {"year": y, "monthly": [], "total_calls": 0, "total_tokens": 0,
                "all_time_calls": 0, "all_time_tokens": 0}

    _month_expr = extract("month", UsageDailySummaryORM.day)
    rows = db.execute(
        select(
            _month_expr.label("m"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .where(UsageDailySummaryORM.api_key_id.in_(key_ids), extract("year", UsageDailySummaryORM.day) == y)
        .group_by(_month_expr)
    ).all()
    by_month = {int(r.m): r for r in rows}
    monthly = []
    for m in range(1, 13):
        r = by_month.get(m)
        monthly.append({
            "month": m,
            "calls": int(r.calls) if r else 0,
            "tokens": int(r.tokens) if r else 0,
        })

    all_row = db.execute(
        select(
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0),
        )
        .where(UsageDailySummaryORM.api_key_id.in_(key_ids))
    ).one()
    return {
        "year": y,
        "monthly": monthly,
        "total_calls": sum(m["calls"] for m in monthly),
        "total_tokens": sum(m["tokens"] for m in monthly),
        "all_time_calls": int(all_row[0]),
        "all_time_tokens": int(all_row[1]),
    }


@router.get("/user/stats/yearly")
def user_stats_yearly(
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """按年聚合的使用趋势：展示用户全部 Key 在各年度的调用次数与 Token 消耗。"""
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return []
    _year_expr = extract("year", UsageDailySummaryORM.day)
    rows = db.execute(
        select(
            _year_expr.label("y"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .where(UsageDailySummaryORM.api_key_id.in_(key_ids))
        .group_by(_year_expr)
        .order_by(_year_expr)
    ).all()
    return [{"year": int(r.y), "calls": int(r.calls), "tokens": int(r.tokens)} for r in rows]


@router.get("/user/stats/daily")
def user_stats_daily(
    days: int = Query(default=30, ge=1, le=180),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return []
    since_day = platform_time.today_local() - timedelta(days=days - 1)
    rows = db.execute(
        select(
            UsageDailySummaryORM.day.label("d"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .where(UsageDailySummaryORM.api_key_id.in_(key_ids), UsageDailySummaryORM.day >= since_day)
        .group_by(UsageDailySummaryORM.day).order_by(UsageDailySummaryORM.day)
    ).all()
    by_day = {str(r.d): r for r in rows}
    out = []
    base = since_day
    for i in range(days):
        d = base + timedelta(days=i)
        d_iso = d.isoformat()
        r = by_day.get(d_iso)
        out.append({
            "day": d_iso,
            "calls": int(r.calls) if r else 0,
            "tokens": int(r.tokens) if r else 0,
        })
    return out


@router.get("/user/stats/models")
def user_stats_models(
    claims: dict = Depends(require_user),
    project: str | None = Query(default=None),
    days: int | None = Query(default=None, ge=1, le=180),
    db: Session = Depends(get_db),
):
    """按模型聚合的调用分布；days 缺省时聚合全量历史，传入后限定近 N 天窗口。"""
    auth_id = claims.get("sub") or ""
    if project:
        key_ids = list(
            db.execute(
                select(ApiKeyORM.id).where(
                    ApiKeyORM.auth_id == auth_id,
                    ApiKeyORM.project_name == project,
                )
            ).scalars().all()
        )
    else:
        key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return []
    query = (
        select(
            UsageDailySummaryORM.model_id.label("model_id"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .where(UsageDailySummaryORM.api_key_id.in_(key_ids))
    )
    if days is not None:
        since_day = platform_time.today_local() - timedelta(days=days - 1)
        query = query.where(UsageDailySummaryORM.day >= since_day)
    rows = db.execute(
        query.group_by(UsageDailySummaryORM.model_id).order_by(func.sum(UsageDailySummaryORM.calls).desc())
    ).all()
    return [{"model_id": r.model_id, "calls": int(r.calls), "tokens": int(r.tokens)} for r in rows]


@router.get("/user/stats/projects")
def user_stats_projects(
    claims: dict = Depends(require_user),
    days: int | None = Query(default=None, ge=1, le=180),
    db: Session = Depends(get_db),
):
    """按业务场景（API Key 的 project_name）聚合；密钥表为软删除，已删除 Key 的历史统计仍会保留。
    days 缺省时聚合全量历史，传入后限定近 N 天窗口。"""
    auth_id = claims.get("sub") or ""
    query = (
        select(
            ApiKeyORM.project_name.label("project"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .join(ApiKeyORM, ApiKeyORM.id == UsageDailySummaryORM.api_key_id)
        .where(ApiKeyORM.auth_id == auth_id)
    )
    if days is not None:
        since_day = platform_time.today_local() - timedelta(days=days - 1)
        query = query.where(UsageDailySummaryORM.day >= since_day)
    rows = db.execute(
        query.group_by(ApiKeyORM.project_name).order_by(func.sum(UsageDailySummaryORM.calls).desc())
    ).all()
    return [{"project": r.project, "calls": int(r.calls), "tokens": int(r.tokens)} for r in rows]


@router.get("/user/stats/scenes")
def user_stats_scenes(
    claims: dict = Depends(require_user),
    days: int = Query(default=30, ge=1, le=180),
    db: Session = Depends(get_db),
):
    """按业务场景分类（scene_type）聚合。"""
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return []
    return build_scenes_dist(db, days=days, key_ids=key_ids)


@router.get("/user/stats/breakdown")
def user_stats_breakdown(
    dimension: str = Query(...),
    days: int = Query(default=30, ge=1, le=180),
    search: str | None = None,
    sort_field: str = "calls",
    sort_dir: str = "desc",
    limit: int = 50,
    offset: int = 0,
    filter_dimension: str | None = None,
    filter_value: str | None = None,
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """用户看板「查看全部」：仅本人密钥范围内的 model/project 明细，支持交叉筛选。"""
    if dimension not in ("model", "project", "scene"):
        raise HTTPException(status_code=400, detail=f"不支持的维度: {dimension}")
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return {"rows": [], "total_groups": 0, "totals": None}

    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    result = query_summary_breakdown(
        db, dimension=dimension, days=days, search=search,
        sort_field=sort_field, sort_dir=sort_dir, limit=limit, offset=offset,
        key_ids=key_ids, filter_dimension=filter_dimension, filter_value=filter_value,
    )
    if dimension == "model":
        model_names = {
            r[0]: r[1] for r in db.execute(select(ModelRegistryORM.id, ModelRegistryORM.name)).all()
        }
        for row in result["rows"]:
            row["display_label"] = model_names.get(row["label"], row["label"])
    elif dimension == "scene":
        scene_labels = {
            r[0]: r[1] for r in db.execute(select(SceneTypeORM.key, SceneTypeORM.label)).all()
        }
        for row in result["rows"]:
            row["display_label"] = scene_labels.get(row["label"], row["label"])
    elif dimension == "project":
        for row in result["rows"]:
            row["display_label"] = row["label"]
    return result


@router.get("/user/stats/timeseries")
def user_stats_timeseries(
    days: int = Query(default=30, ge=1, le=180),
    model_id: str | None = Query(default=None),
    project: str | None = Query(default=None),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """按天聚合的用量时序：调用次数 + token 三段拆分（命中缓存输入 / 未命中输入 / 输出）。

    支持按模型（model_id）与业务场景（project）筛选；缺口日期补 0，便于前端折线/柱状连续展示。
    源自永久汇总表，不受 usage_logs 清理策略影响（即使超出 USAGE_LOG_RETENTION_DAYS 也仍可查询）。
    """
    auth_id = claims.get("sub") or ""
    # 场景筛选：限定到该场景对应的密钥集合
    if project:
        key_ids = list(
            db.execute(
                select(ApiKeyORM.id).where(
                    ApiKeyORM.auth_id == auth_id,
                    ApiKeyORM.project_name == project,
                )
            ).scalars().all()
        )
    else:
        key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return {"data": []}

    since_day = platform_time.today_local() - timedelta(days=days - 1)
    conds = [UsageDailySummaryORM.api_key_id.in_(key_ids), UsageDailySummaryORM.day >= since_day]
    if model_id:
        conds.append(UsageDailySummaryORM.model_id == model_id)

    rows = db.execute(
        select(
            UsageDailySummaryORM.day.label("d"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.cache_hit_tokens), 0).label("hit"),
            func.coalesce(func.sum(UsageDailySummaryORM.prompt_tokens), 0).label("prompt"),
            func.coalesce(func.sum(UsageDailySummaryORM.completion_tokens), 0).label("output"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("total"),
        )
        .where(*conds)
        .group_by(UsageDailySummaryORM.day)
    ).all()
    by_day = {str(r.d): r for r in rows}

    out = []
    base = since_day
    for i in range(days):
        d_iso = (base + timedelta(days=i)).isoformat()
        r = by_day.get(d_iso)
        if r is None:
            out.append({
                "day": d_iso, "calls": 0,
                "input_cache_hit": 0, "input_cache_miss": 0,
                "output": 0, "total_tokens": 0,
            })
            continue
        hit = int(r.hit)
        # 未命中输入 = 总输入 - 命中输入（保证 hit + miss == prompt，口径一致）
        miss = max(0, int(r.prompt) - hit)
        out.append({
            "day": d_iso,
            "calls": int(r.calls),
            "input_cache_hit": hit,
            "input_cache_miss": miss,
            "output": int(r.output),
            "total_tokens": int(r.total),
        })
    return {"data": out}


# Session context length 分档区间（tokens），左闭右开，最后一个区间无上界
_CONTEXT_BUCKETS: list[tuple[str, int | None]] = [
    ("<1k",       1_000),
    ("1k–2k",     2_000),
    ("2k–4k",     4_000),
    ("4k–8k",     8_000),
    ("8k–16k",    16_000),
    ("16k–32k",   32_000),
    ("32k–64k",   64_000),
    ("64k–128k",  128_000),
    ("128k–256k", 256_000),
    ("256k–512k", 512_000),
    ("512k–1m",   1_000_000),
    ("1m+",       None),
]


@router.get("/user/stats/context-length")
def user_stats_context_length(
    days: int = Query(default=30, ge=1, le=180),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Session context length 分布：prompt tokens 分档。

    分桶优先 usage_context_bucket_daily（永久汇总）；分位数优先 usage_request_profile。
    """
    def _empty():
        return {
            "buckets": empty_context_buckets(),
            "total": 0, "avg": 0, "p50": 0, "p90": 0, "p99": 0,
            "max": 0, "min": 0, "days": days,
        }

    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return _empty()

    since_day = platform_time.today_local() - timedelta(days=days - 1)
    since_utc = platform_time.to_utc_naive(platform_time.now_local() - timedelta(days=days))
    boundaries = [b for _, b in _CONTEXT_BUCKETS if b is not None]

    bkt_map: dict[int, int] = {}
    bucket_rows = db.execute(
        select(
            UsageContextBucketDailyORM.bucket,
            func.coalesce(func.sum(UsageContextBucketDailyORM.count), 0).label("cnt"),
        )
        .where(
            UsageContextBucketDailyORM.api_key_id.in_(key_ids),
            UsageContextBucketDailyORM.day >= since_day,
        )
        .group_by(UsageContextBucketDailyORM.bucket)
    ).all()
    for r in bucket_rows:
        bkt_map[int(r.bucket)] = int(r.cnt)
    total = sum(bkt_map.values())

    stats_row = None
    for src in (UsageRequestProfileORM, UsageLogORM):
        conds = [src.api_key_id.in_(key_ids), src.created_at >= since_utc, src.prompt_tokens > 0]
        row = db.execute(
            select(
                func.count().label("total"),
                func.coalesce(func.avg(src.prompt_tokens), 0).label("avg"),
                func.percentile_cont(0.50).within_group(src.prompt_tokens).label("p50"),
                func.percentile_cont(0.90).within_group(src.prompt_tokens).label("p90"),
                func.percentile_cont(0.99).within_group(src.prompt_tokens).label("p99"),
                func.coalesce(func.max(src.prompt_tokens), 0).label("mx"),
                func.coalesce(func.min(src.prompt_tokens), 0).label("mn"),
            ).where(*conds)
        ).one()
        if int(row.total or 0) > 0:
            stats_row = row
            if total == 0:
                bucket_expr = func.width_bucket(src.prompt_tokens, pg_array(boundaries))
                fb_rows = db.execute(
                    select(bucket_expr.label("bkt"), func.count().label("cnt"))
                    .where(*conds)
                    .group_by("bkt")
                ).all()
                bkt_map = {int(r.bkt): int(r.cnt) for r in fb_rows if r.bkt is not None}
                total = sum(bkt_map.values())
            break

    if total == 0:
        return _empty()

    bucket_counts = []
    running = 0
    for i, label in enumerate(CONTEXT_LENGTH_LABELS):
        cnt = bkt_map.get(i, 0)
        running += cnt
        bucket_counts.append({
            "label": label,
            "count": cnt,
            "share": round(cnt / total * 100, 1),
            "cum_share": round(running / total * 100, 1),
        })

    def _r(v):
        return int(round(float(v))) if v is not None else 0

    avg = int(float(stats_row.avg or 0)) if stats_row else 0
    return {
        "buckets": bucket_counts,
        "total": total,
        "avg": avg,
        "p50": _r(stats_row.p50) if stats_row else 0,
        "p90": _r(stats_row.p90) if stats_row else 0,
        "p99": _r(stats_row.p99) if stats_row else 0,
        "max": int(stats_row.mx or 0) if stats_row else 0,
        "min": int(stats_row.mn or 0) if stats_row else 0,
        "days": days,
    }


@router.get("/user/stats/tool-calls")
def user_stats_tool_calls(
    days: int = Query(default=30, ge=1, le=180),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Tool call 分布：一次对话（一次 API 请求）独立计入并分档。

    口径与上下文长度一致；优先 usage_request_profile；无数据时回落
    usage_logs.response_preview 解析。
    """
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        return {
            "buckets": [{"label": label, "count": 0, "share": 0.0} for label, _, _ in TOOL_CALL_BUCKETS],
            "total_sessions": 0,
            "days": days,
        }
    since_local = platform_time.now_local() - timedelta(days=days)
    since_utc = platform_time.to_utc_naive(since_local)
    result = build_tool_call_distribution(db, key_ids=key_ids, since_utc=since_utc)
    result["days"] = days
    return result


@router.get("/user/stats/heatmap")
def user_stats_heatmap(
    days: int = Query(default=30, ge=1, le=180),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """按「星期几 × 小时」聚合调用量，用于前端热力图。

    返回 7×24 网格 matrix[weekday][hour]，weekday: 0=Mon..6=Sun，hour: 0..23（北京时间）。
    全景统计：不支持按模型/场景筛选，反映用户全部调用的时间分布。
    时间过滤与分桶均统一使用平台本地时区（Asia/Shanghai）。
    """
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if not key_ids:
        empty = [[0]*24 for _ in range(7)]
        return {"matrix": empty, "max": 0, "days": days, "total": 0}

    since_local = platform_time.now_local() - timedelta(days=days)
    since_utc = platform_time.to_utc_naive(since_local)
    conds = [UsageLogORM.api_key_id.in_(key_ids), UsageLogORM.created_at >= since_utc]

    local_col = platform_time.local_ts(UsageLogORM.created_at)
    rows = db.execute(
        select(
            extract("dow", local_col).label("wd"),
            extract("hour", local_col).label("hr"),
            func.count().label("c"),
        ).where(*conds)
        .group_by("wd", "hr")
    ).all()

    matrix = [[0]*24 for _ in range(7)]
    total = 0
    for r in rows:
        wd_pg = int(r.wd)
        hr = int(r.hr)
        c = int(r.c)
        wd = (wd_pg - 1) % 7
        matrix[wd][hr] = c
        total += c

    mx = max((matrix[w][h] for w in range(7) for h in range(24)), default=0)
    return {"matrix": matrix, "max": mx, "days": days, "total": total}


@router.get("/user/stats/heatmap/week")
def user_stats_heatmap_week(
    mode: str = Query(default="week", description="week | month | cumulative"),
    date: str | None = Query(default=None, description="锚点日期（平台本地时区）；周/月模式使用"),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """用户侧调用热力图。与 /public/platform-status/heatmap 同一契约，仅限定该用户全部 Key。"""
    if mode not in ("week", "month", "cumulative"):
        raise HTTPException(status_code=400, detail="mode 应为 week、month 或 cumulative")
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    if mode == "cumulative":
        return build_cumulative_heatmap(db, key_ids=key_ids)
    anchor = platform_time.today_local()
    if date:
        try:
            anchor = date_type.fromisoformat(date)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="date 格式应为 YYYY-MM-DD",
            ) from exc
    if mode == "month":
        return build_month_heatmap(db, anchor=anchor, key_ids=key_ids)
    return build_week_heatmap(db, anchor=anchor, key_ids=key_ids)


def _log_filter_conds(
    key_ids: list[str],
    date_from: str | None,
    date_to: str | None,
    model_id: str | None,
    status_code: str | None,
    key_name: str | None = None,
    request_id: str | None = None,
    cache_filter: str | None = None,
    wd: str | None = None,
    hour: str | None = None,
    db: Session | None = None,
) -> list:
    conds = [UsageLogORM.api_key_id.in_(key_ids)]
    df, dt = _parse_dt(date_from) if date_from else None, _parse_dt(date_to) if date_to else None
    if df:
        conds.append(UsageLogORM.created_at >= df)
    if dt:
        conds.append(UsageLogORM.created_at <= dt)
    if model_id:
        # 支持逗号分隔多选——多选之间是 OR（任一匹配即可），
        # 之前逐个 append 条件是 AND 语义，多选不同模型必然查空
        pats = [f"%{x.strip()}%" for x in model_id.split(",") if x.strip()]
        if pats:
            conds.append(or_(*[UsageLogORM.model_id.ilike(p) for p in pats]))
    if status_code:
        if status_code in ("2xx", "4xx", "5xx"):
            conds.append(UsageLogORM.status_code.like(f"{status_code[0]}%"))
        elif status_code == "429":
            conds.append(UsageLogORM.status_code == "429")
        else:
            conds.append(UsageLogORM.status_code == status_code)
    if key_name and db is not None:
        # 支持逗号分隔多选
        names = [x.strip() for x in key_name.split(",") if x.strip()]
        if names:
            key_subq = select(ApiKeyORM.id).where(
                *[ApiKeyORM.auth_id.in_(
                    select(ApiKeyORM.auth_id).where(ApiKeyORM.id.in_(key_ids))
                )],
                ApiKeyORM.name.in_(names),
            )
            conds.append(UsageLogORM.api_key_id.in_(key_subq))
    if request_id:
        conds.append(UsageLogORM.request_id.ilike(f"%{request_id.strip()}%"))
    if cache_filter == "hit":
        conds.append(UsageLogORM.cache_hit_tokens > 0)
    elif cache_filter == "miss":
        conds.append((UsageLogORM.cache_hit_tokens == 0) | UsageLogORM.cache_hit_tokens.is_(None))
        conds.append((UsageLogORM.cache_miss_tokens > 0))
    local_col = platform_time.local_ts(UsageLogORM.created_at)
    if wd is not None:
        try:
            wd_int = int(wd)
            if 0 <= wd_int <= 6:
                pg_dow = (wd_int + 1) % 7
                conds.append(extract("dow", local_col) == pg_dow)
        except (ValueError, TypeError):
            pass
    if hour is not None:
        try:
            hr_int = int(hour)
            if 0 <= hr_int <= 23:
                conds.append(extract("hour", local_col) == hr_int)
        except (ValueError, TypeError):
            pass
    return conds


def _log_sort_order(sort_field: str | None, sort_dir: str | None):
    """将前端排序字段映射为 SQLAlchemy order_by 表达式。"""
    dir_desc = (sort_dir or "desc").lower() == "desc"
    col_map = {
        "token": UsageLogORM.total_tokens,
        "prompt": UsageLogORM.prompt_tokens,
        "completion": UsageLogORM.completion_tokens,
        "ttft": UsageLogORM.latency_ms,
        "duration": UsageLogORM.total_duration_ms,
        "time": UsageLogORM.created_at,
    }
    col = col_map.get(sort_field or "", UsageLogORM.created_at)
    return col.desc() if dir_desc else col.asc()


def _retention_info(db: Session, key_ids: list[str], date_from: str | None) -> tuple[int, str | None, bool]:
    """日志保留期天数 + 保留起点 + 当前查询范围内是否存在已被 usage_retention 清理的记录。

    仅当查询下界触及保留起点之前、且该账号 ID名下密钥确实早于保留起点（账龄足够老，
    早年调用才可能落在被清理的区间内）时才提示，避免对新账号造成误报噪音。
    保留起点统一换算为北京时间口径。
    """
    days = settings.USAGE_LOG_RETENTION_DAYS
    if days <= 0:
        return days, None, False
    # 保留起点：当前时间往前 days 天，以北京时间为基准，转 UTC naive 与 created_at 比较
    cutoff_local = platform_time.now_local() - timedelta(days=days)
    cutoff_utc = platform_time.to_utc_naive(cutoff_local)
    df = _parse_dt(date_from) if date_from else None
    query_reaches_before_cutoff = df is None or df < cutoff_utc
    if not query_reaches_before_cutoff or not key_ids:
        return days, cutoff_utc.isoformat(), False
    earliest_key_at = db.execute(
        select(func.min(ApiKeyORM.granted_at)).where(ApiKeyORM.id.in_(key_ids))
    ).scalar()
    has_purged_range = bool(earliest_key_at and earliest_key_at < cutoff_utc)
    return days, cutoff_utc.isoformat(), has_purged_range


@router.get("/user/logs")
def user_logs_paged(
    limit: int = Query(default=50),
    offset: int = Query(default=0),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    model_id: str | None = Query(default=None),
    status_code: str | None = Query(default=None),
    key_name: str | None = Query(default=None),
    request_id: str | None = Query(default=None),
    cache_filter: str | None = Query(default=None),
    wd: int | None = Query(default=None, ge=0, le=6),
    hour: int | None = Query(default=None, ge=0, le=23),
    sort_field: str | None = Query(default=None),
    sort_dir: str | None = Query(default=None),
    export: str | None = Query(default=None),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    retention_days, retention_cutoff, has_purged_range = _retention_info(db, key_ids, date_from)
    if not key_ids:
        return {
            "total": 0, "records": [], "retention_days": retention_days,
            "retention_cutoff": retention_cutoff, "has_purged_range": has_purged_range,
            "unique_models": [], "unique_key_names": [],
        }

    conds = _log_filter_conds(
        key_ids, date_from, date_to, model_id, status_code,
        key_name=key_name, request_id=request_id,
        cache_filter=cache_filter, wd=str(wd) if wd is not None else None,
        hour=str(hour) if hour is not None else None,
        db=db,
    )

    # 该账号 ID名下全部密钥的名称（含已撤销），用于在日志明细中标注调用所属 API Key / 场景
    key_rows = db.execute(
        select(ApiKeyORM.id, ApiKeyORM.name, ApiKeyORM.project_name).where(ApiKeyORM.auth_id == auth_id)
    ).all()
    key_names = {row.id: (row.name or row.project_name or row.id[:8]) for row in key_rows}
    unique_key_names_all = sorted({(row.name or row.project_name or row.id[:8]) for row in key_rows if (row.name or row.project_name)})

    order_col = _log_sort_order(sort_field, sort_dir)

    if export == "csv":
        # 导出全部筛选结果（上限 10000 条避免内存爆炸）
        rows = db.execute(
            select(UsageLogORM).where(*conds)
            .order_by(order_col)
            .limit(10000)
        ).scalars().all()
        csv_rows = []
        for r in rows:
            csv_rows.append([
                r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else "",
                r.model_id or "",
                key_names.get(r.api_key_id, r.api_key_id[:8]),
                r.request_id or "",
                r.prompt_tokens or 0,
                r.completion_tokens or 0,
                r.total_tokens or 0,
                r.cache_hit_tokens or 0,
                r.cache_miss_tokens or 0,
                r.cache_write_tokens or 0,
                r.latency_ms or 0,
                r.total_duration_ms or 0,
                round(float(r.estimated_cost), 6) if r.estimated_cost is not None else 0,
                r.status_code or "",
                "是" if r.stream else "否",
                "是" if r.usage_estimated else "否",
                (r.error_detail or "").replace("\n", " ").replace("\r", " "),
            ])
        return csv_download(
            [
                "时间", "模型", "API Key", "Request ID",
                "Prompt Tokens", "Completion Tokens", "总Token",
                "缓存命中Token", "缓存未命中Token", "缓存写入Token",
                "TTFT(ms)", "整体耗时(ms)", "预估费用",
                "状态码", "流式", "Token为估算值", "错误信息",
            ],
            csv_rows,
            f"api-logs-{platform_time.now_local().strftime('%Y-%m-%d')}.csv",
        )

    total = db.execute(select(func.count()).select_from(UsageLogORM).where(*conds)).scalar() or 0
    rows = db.execute(
        select(UsageLogORM).where(*conds)
        .order_by(order_col)
        .limit(min(limit, 200)).offset(offset)
    ).scalars().all()
    records = [
        {
            "id": r.id, "model_id": r.model_id,
            "request_id": r.request_id,
            "api_key_name": key_names.get(r.api_key_id, r.api_key_id[:8]),
            "prompt_tokens": r.prompt_tokens or 0,
            "completion_tokens": r.completion_tokens or 0,
            "total_tokens": r.total_tokens or 0,
            "cache_hit_tokens": r.cache_hit_tokens or 0,
            "cache_miss_tokens": r.cache_miss_tokens or 0,
            "cache_write_tokens": r.cache_write_tokens or 0,
            "latency_ms": r.latency_ms or 0,
            "total_duration_ms": r.total_duration_ms or 0,
            "estimated_cost": float(r.estimated_cost) if r.estimated_cost is not None else 0.0,
            "usage_estimated": bool(r.usage_estimated),
            "stream": bool(r.stream),
            "status_code": int(r.status_code) if (r.status_code or "").isdigit() else 0,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "error_detail": r.error_detail,
            "response_preview": r.response_preview,
        }
        for r in rows
    ]

    # 去重模型列表（从全部匹配结果中取，非当前页）——limit 1000 防止大用户慢查询。
    # 注意要排除模型筛选条件本身：否则选中某个模型后，筛选面板里的其它模型选项
    # 会跟着塌缩消失，用户无法再追加/改选。
    model_conds = _log_filter_conds(
        key_ids, date_from, date_to, None, status_code,
        key_name=key_name, request_id=request_id,
        cache_filter=cache_filter, wd=str(wd) if wd is not None else None,
        hour=str(hour) if hour is not None else None,
        db=db,
    )
    model_rows = db.execute(
        select(UsageLogORM.model_id).where(*model_conds).distinct().limit(1000)
    ).scalars().all()
    unique_models = sorted(set(m for m in model_rows if m))

    return {
        "total": total, "records": records, "retention_days": retention_days,
        "retention_cutoff": retention_cutoff, "has_purged_range": has_purged_range,
        "unique_models": unique_models, "unique_key_names": unique_key_names_all,
    }


@router.get("/user/logs/stats")
def user_logs_stats(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    model_id: str | None = Query(default=None),
    status_code: str | None = Query(default=None),
    key_name: str | None = Query(default=None),
    request_id: str | None = Query(default=None),
    cache_filter: str | None = Query(default=None),
    wd: int | None = Query(default=None, ge=0, le=6),
    hour: int | None = Query(default=None, ge=0, le=23),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """筛选范围内的整体耗时统计：平均/P95 TTFT、平均/P95 整体耗时、成功率、缓存命中率。

    统计覆盖全部匹配记录（不受分页限制），与列表使用同一套筛选条件。
    """
    auth_id = claims.get("sub") or ""
    key_ids = _user_key_ids(db, auth_id)
    retention_days, retention_cutoff, has_purged_range = _retention_info(db, key_ids, date_from)
    empty = {
        "total": 0, "success_count": 0, "success_rate": 0.0,
        "avg_latency_ms": None, "p95_latency_ms": None,
        "avg_duration_ms": None, "p95_duration_ms": None,
        "cache_hit_tokens": 0, "cache_miss_tokens": 0, "cache_hit_rate": None,
        "retention_days": retention_days,
        "retention_cutoff": retention_cutoff,
        "has_purged_range": has_purged_range,
    }
    if not key_ids:
        return empty

    conds = _log_filter_conds(
        key_ids, date_from, date_to, model_id, status_code,
        key_name=key_name, request_id=request_id,
        cache_filter=cache_filter, wd=str(wd) if wd is not None else None,
        hour=str(hour) if hour is not None else None, db=db,
    )

    total = db.execute(select(func.count()).select_from(UsageLogORM).where(*conds)).scalar() or 0
    if not total:
        return empty
    success = db.execute(
        select(func.count()).select_from(UsageLogORM).where(*conds, UsageLogORM.status_code.like("2%"))
    ).scalar() or 0

    lat_row = db.execute(
        select(
            func.avg(UsageLogORM.latency_ms),
            func.percentile_cont(0.95).within_group(UsageLogORM.latency_ms),
        ).where(*conds, UsageLogORM.latency_ms.isnot(None), UsageLogORM.latency_ms > 0)
    ).one()
    dur_row = db.execute(
        select(
            func.avg(UsageLogORM.total_duration_ms),
            func.percentile_cont(0.95).within_group(UsageLogORM.total_duration_ms),
        ).where(*conds, UsageLogORM.total_duration_ms.isnot(None), UsageLogORM.total_duration_ms > 0)
    ).one()

    # 缓存命中聚合（基于筛选范围全量）
    cache_row = db.execute(
        select(
            func.coalesce(func.sum(UsageLogORM.cache_hit_tokens), 0),
            func.coalesce(func.sum(UsageLogORM.cache_miss_tokens), 0),
        ).where(*conds)
    ).one()
    cache_hit = int(cache_row[0] or 0)
    cache_miss = int(cache_row[1] or 0)
    cache_total = cache_hit + cache_miss
    cache_hit_rate = round(cache_hit / cache_total * 100, 1) if cache_total > 0 else None

    return {
        "total": total,
        "success_count": success,
        "success_rate": round(success / total * 100, 1),
        "avg_latency_ms": round(lat_row[0]) if lat_row[0] is not None else None,
        "p95_latency_ms": round(lat_row[1]) if lat_row[1] is not None else None,
        "avg_duration_ms": round(dur_row[0]) if dur_row[0] is not None else None,
        "p95_duration_ms": round(dur_row[1]) if dur_row[1] is not None else None,
        "cache_hit_tokens": cache_hit,
        "cache_miss_tokens": cache_miss,
        "cache_hit_rate": cache_hit_rate,
        "retention_days": retention_days,
        "retention_cutoff": retention_cutoff,
        "has_purged_range": has_purged_range,
    }


def _key_by_raw(db: Session, raw: str) -> ApiKeyORM:
    k = db.execute(
        select(ApiKeyORM).where(ApiKeyORM.key_hash == hash_key((raw or "").strip()))
    ).scalar_one_or_none()
    if k is None:
        raise HTTPException(status_code=404, detail="API key 不存在")
    return k


# ── 实时速率限制状态（Redis 计数器读取）─────────────────────────────────────────
@router.get("/user/rate-limits")
async def user_rate_limits(
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """当前分钟 RPM/TPM 实时用量 + 限额，供前端进度条可视化。Redis 异常时用量归零（fail-open）。"""
    auth_id = (claims.get("sub") or "").strip()
    keys = db.execute(
        select(ApiKeyORM).where(
            ApiKeyORM.auth_id == auth_id,
            ApiKeyORM.deleted_at.is_(None),
            ApiKeyORM.revoked.is_(False),
        ).order_by(ApiKeyORM.created_at.desc())
    ).scalars().all()

    now = time.time()
    bucket = int(now // 60)
    resets_in = 60 - int(now % 60)

    from app.proxy.policy import effective_rate_limits, in_night_window
    # 夜间不限流窗口的判定必须由服务端给出布尔值：窗口按 PLATFORM_TIMEZONE 计算，
    # 前端拿 start/end 自己算会因浏览器时区不同而错判。窗口内 enforce_pre 直接
    # 早退，连计数键都不写——所以此时 used 恒为 0，前端须据此改文案，否则用户
    # 会把"0 / 600"误读成"我夜间没有调用"。
    night = in_night_window()
    night_window = f"{settings.NIGHT_UNLIMITED_START}–{settings.NIGHT_UNLIMITED_END}"

    results = []
    for k in keys:
        # 与 policy.enforce_pre 同一取值逻辑；limit==0 表示无限
        rpm_limit, tpm_limit = effective_rate_limits(k)
        try:
            rpm_raw, tpm_raw = await redis.mget(
                f"rl:rpm:{k.id}:{bucket}",
                f"rl:tpm:{k.id}:{bucket}",
            )
            rpm_used = int(rpm_raw or 0)
            tpm_used = int(tpm_raw or 0)
        except Exception:
            rpm_used = tpm_used = 0
        results.append({
            "key_id": k.id,
            "key_name": k.name or k.project_name or k.id[:8],
            "resets_in": resets_in,
            # limit=0 → 无限（前端以 unlimited 标记展示，不画进度条）。
            # 这里的 unlimited 只表示"该 Key 的档位是超高并发"，与夜间窗口无关——
            # 窗口是全平台临时状态，用顶层 night_unlimited 表达，两者在前端合并展示。
            "rpm": {"used": rpm_used, "limit": rpm_limit, "unlimited": rpm_limit == 0},
            "tpm": {"used": tpm_used, "limit": tpm_limit, "unlimited": tpm_limit == 0},
        })
    return {
        "data": results,
        "resets_in": resets_in,
        "night_unlimited": night,
        "night_window": night_window,
    }


# ── API Keys 列表（按账号 ID）────────────────────────────────────────────────────
@router.post("/user/keys")
def user_keys(
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    # 身份取自登录态 JWT，禁止凭 body 账号 ID查询他人密钥（防越权枚举）。
    auth_id = (claims.get("sub") or "").strip()
    if not auth_id:
        raise HTTPException(status_code=401, detail="登录态无效")

    # 含已被吊销的密钥：用户需要能看到并处置（删除 / 轮换恢复），而不是凭空消失
    rows = db.execute(
        select(ApiKeyORM).where(
            ApiKeyORM.auth_id == auth_id,
            ApiKeyORM.deleted_at.is_(None),
        ).order_by(ApiKeyORM.created_at.desc())
    ).scalars().all()

    # 从永久汇总表按 key 批量取"最近使用日"，不受 usage_logs 清理策略影响（早年调用的
    # Key 也不会误显示"从未使用"）；一条 GROUP BY 顶替原来每把 key 一次查询。
    key_ids = [k.id for k in rows]
    last_used_by_key: dict[str, object] = {}
    if key_ids:
        last_used_by_key = dict(db.execute(
            select(UsageDailySummaryORM.api_key_id, func.max(UsageDailySummaryORM.day))
            .where(UsageDailySummaryORM.api_key_id.in_(key_ids))
            .group_by(UsageDailySummaryORM.api_key_id)
        ).all())
    used_key_ids = set(last_used_by_key)
    claim_candidates = [
        k.id for k in rows if k.application_id and k.user_claimed_at is None
    ]
    if claim_candidates:
        # 覆盖异步日汇总尚未落库的短窗口；有任何明细的密钥都不能自动轮换领取。
        used_key_ids.update(db.execute(
            select(UsageLogORM.api_key_id)
            .where(UsageLogORM.api_key_id.in_(claim_candidates))
            .distinct()
        ).scalars().all())

    data = []
    for k in rows:
        last_used_day = last_used_by_key.get(k.id)
        data.append({
            "id": k.id,
            "name": k.name or k.project_name,
            "project_desc": k.project_desc,
            "key_masked": mask_key_prefix(k.key_prefix) if k.key_hash else None,
            # 新审批密钥，以及升级前尚未实际使用的历史审批密钥，由申请人领取。
            # 已有永久用量的历史密钥绝不自动轮换，以免中断线上业务。
            "needs_claim": bool(
                k.application_id
                and k.user_claimed_at is None
                and k.id not in used_key_ids
            ),
            # 档位供前端决定是否展示「升级高并发」入口：high/unlimited 已升级，隐藏
            "tier": display_tier(settings.key_tier(k.rpm_limit, k.tpm_limit)),
            "created_at": k.created_at.isoformat() if k.created_at else None,
            "last_used_at": last_used_day.isoformat() if last_used_day else None,
            "status": "revoked" if k.revoked else "active",
        })

    # 已批准的申请无需单列——对应的 ApiKeyORM 已经通过 application_id 落地，
    # 上面的主查询已经展示了；这里只需要「还没结果」和「刚被拒绝」两种。
    apps = db.execute(
        select(ApplicationORM).where(
            ApplicationORM.auth_id == auth_id,
            ApplicationORM.status.in_(("pending", "rejected")),
        ).order_by(ApplicationORM.created_at.desc())
    ).scalars().all()
    for a in apps:
        data.append({
            "id": a.id,
            "name": a.project_name,
            "project_desc": a.project_desc,
            "key_masked": None,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "last_used_at": None,
            "status": a.status,
            "note": a.note,
            "reviewed_at": a.reviewed_at.isoformat() if a.reviewed_at else None,
        })

    return {"data": data}


@router.post("/user/keys/{key_id}/claim")
def claim_approved_key(
    key_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """申请人领取审批通过的 Key；明文只在本次响应中返回。

    对历史审批且从未使用的密钥，领取会轮换掉此前只展示给管理员的旧值；一旦有
    永久用量记录则禁止轮换，避免影响已上线业务。
    """
    auth_id = (claims.get("sub") or "").strip()
    k = db.execute(
        select(ApiKeyORM).where(ApiKeyORM.id == key_id).with_for_update()
    ).scalar_one_or_none()
    if k is None or k.deleted_at is not None or k.auth_id != auth_id:
        raise HTTPException(status_code=404, detail="API key 不存在")
    if k.revoked:
        raise HTTPException(status_code=400, detail="密钥已被吊销，无法领取")
    if not k.application_id:
        raise HTTPException(status_code=400, detail="该密钥不是审批发放的密钥")

    application = db.get(ApplicationORM, k.application_id)
    if application is None or application.status != "approved" or application.auth_id != auth_id:
        raise HTTPException(status_code=400, detail="密钥申请尚未审批通过")
    if k.user_claimed_at is not None:
        raise HTTPException(status_code=409, detail="密钥已领取；如已遗失，请使用轮换功能")

    has_summary = db.execute(
        select(UsageDailySummaryORM.api_key_id)
        .where(UsageDailySummaryORM.api_key_id == k.id)
        .limit(1)
    ).first() is not None
    has_detail = db.execute(
        select(UsageLogORM.api_key_id)
        .where(UsageLogORM.api_key_id == k.id)
        .limit(1)
    ).first() is not None
    has_usage = has_summary or has_detail
    if has_usage:
        # 兼容迁移未回填/竞态：已有业务使用时宁可不展示，也不能擅自换掉凭据。
        k.user_claimed_at = k.granted_at
        db.commit()
        raise HTTPException(status_code=409, detail="密钥已投入使用；如需新明文，请使用轮换功能")

    raw = generate_api_key()
    k.key_hash = hash_key(raw)
    k.key_prefix = raw[: len(KEY_PREFIX) + 6]
    k.api_key = None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    k.granted_at = now
    k.user_claimed_at = now
    db.commit()
    invalidate_prepare_cache()
    return {"id": k.id, "api_key": raw, "status": "active"}


@router.patch("/user/keys/{key_id}")
def update_user_key(
    key_id: str,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """用户自助修改：已生效 key 或审批中申请，仅允许改名称与描述。"""
    auth_id = (claims.get("sub") or "").strip()
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    desc_raw = payload.get("project_desc") if "project_desc" in payload else None
    project_desc = desc_raw.strip() if isinstance(desc_raw, str) and desc_raw.strip() else None

    k = db.get(ApiKeyORM, key_id)
    if k is not None and k.deleted_at is None and k.auth_id == auth_id:
        try:
            name = assert_scenario_name_available(db, auth_id, name, exclude_key_id=k.id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        k.name = name
        k.project_name = name  # 与用量统计「场景」维度保持一致
        if "project_desc" in payload:
            k.project_desc = project_desc
        db.commit()
        return {"ok": True, "id": k.id, "name": k.name, "project_desc": k.project_desc}

    a = db.get(ApplicationORM, key_id)
    if a is not None and a.auth_id == auth_id and a.status == "pending":
        try:
            name = assert_scenario_name_available(db, auth_id, name, exclude_application_id=a.id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        a.name = name
        a.project_name = name
        if "project_desc" in payload:
            a.project_desc = project_desc
        db.commit()
        return {"ok": True, "id": a.id, "name": a.project_name, "project_desc": a.project_desc}

    raise HTTPException(status_code=404, detail="API key 不存在")


@router.delete("/user/keys/{key_id}")
def delete_user_key(
    key_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """用户自助删除 key、撤销审批中的申请，或清除已读的驳回记录。"""
    auth_id = (claims.get("sub") or "").strip()

    k = db.get(ApiKeyORM, key_id)
    if k is not None and k.deleted_at is None and k.auth_id == auth_id:
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        k.deleted_at = now
        if not k.revoked:
            k.revoked = True
            k.revoked_at = now
        cancel_pending_upgrades(db, key_id)  # 密钥已删，在途升级申请一并失效
        db.commit()
        invalidate_prepare_cache()  # 删除即吊销，全网关即时生效
        return {"ok": True, "id": key_id}

    a = db.get(ApplicationORM, key_id)
    if a is not None and a.auth_id == auth_id and a.status in ("pending", "rejected"):
        db.delete(a)
        db.commit()
        return {"ok": True, "id": key_id}

    raise HTTPException(status_code=404, detail="API key 不存在")


@router.post("/user/keys/{key_id}/regenerate")
def regenerate_user_key(
    key_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """用户轮换密钥：保留同一条记录（id/name/限额/历史用量），重新生成明文。
    旧 key_hash 立即失效，新明文仅本次返回。"""
    auth_id = (claims.get("sub") or "").strip()
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None or k.auth_id != auth_id:
        raise HTTPException(status_code=404, detail="API key 不存在")
    # 管理员吊销后不允许用户自助轮换恢复——须删除后重新提交申请（走审批），
    # 或由管理员在后台 restore；否则吊销形同虚设（泄露保护/违规处置可被绕过）。
    if k.revoked:
        raise HTTPException(
            status_code=400,
            detail="密钥已被吊销，请删除后重新提交申请，或联系管理员恢复",
        )
    raw = generate_api_key()
    k.key_hash = hash_key(raw)
    k.key_prefix = raw[: len(KEY_PREFIX) + 6]
    k.granted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    invalidate_prepare_cache()
    return {"id": k.id, "api_key": raw, "status": "active"}


@router.post("/user/keys/{key_id}/tier")
def user_change_key_tier(
    key_id: str,
    payload: TierChangeIn,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """用户自助降低并发档位（立即生效）。升高档位须走升级申请审批。"""
    auth_id = (claims.get("sub") or "").strip()
    target = (payload.target_tier or "").strip()
    if target not in USER_TIERS:
        raise HTTPException(status_code=422, detail="目标档位无效，仅支持 default、high 或 unlimited")

    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None or k.auth_id != auth_id:
        raise HTTPException(status_code=404, detail="API key 不存在")
    if k.revoked:
        raise HTTPException(status_code=400, detail="密钥已被吊销，无法调整档位")

    ok, msg = can_downgrade_to(k, target)
    if not ok:
        raise HTTPException(status_code=400, detail=msg or "仅支持降至更低档位，升级请提交申请")

    apply_tier_preset(k, target)
    db.commit()
    invalidate_prepare_cache()
    return {
        "ok": True,
        "id": k.id,
        "tier": display_tier(settings.key_tier(k.rpm_limit, k.tpm_limit)),
    }


# ── 用量信息（自助，需登录且 key 须归属当前用户）──────────────────────────────
def _assert_key_owner(key: ApiKeyORM, auth_id: str) -> None:
    if key.auth_id != auth_id:
        raise HTTPException(status_code=403, detail="无权访问该 API key")


@router.post("/user/usage")
def user_usage(
    payload: dict = Body(...),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    auth_id = claims.get("sub") or ""
    k = _key_by_raw(db, payload["api_key"])
    _assert_key_owner(k, auth_id)
    days = int(payload.get("days", 30))
    since_local = platform_time.now_local() - timedelta(days=days)
    since_utc = platform_time.to_utc_naive(since_local)

    by_model = db.execute(
        select(UsageLogORM.model_id,
               func.count().label("requests"),
               func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
               func.coalesce(func.sum(UsageLogORM.estimated_cost), 0).label("cost"))
        .where(UsageLogORM.api_key_id == k.id, UsageLogORM.created_at >= since_utc)
        .group_by(UsageLogORM.model_id)
    ).all()

    local_col = platform_time.local_ts(UsageLogORM.created_at)
    by_day = db.execute(
        select(func.date(local_col).label("day"),
               func.count().label("requests"),
               func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"))
        .where(UsageLogORM.api_key_id == k.id, UsageLogORM.created_at >= since_utc)
        .group_by(func.date(local_col))
        .order_by(func.date(local_col))
    ).all()

    return {
        "project_name": k.project_name,
        "by_model": [{"model_id": r.model_id, "requests": r.requests,
                      "tokens": int(r.tokens), "cost": float(r.cost)} for r in by_model],
        "by_day": [{"day": str(r.day), "requests": r.requests, "tokens": int(r.tokens)} for r in by_day],
    }


# ── 调用日志（排查）──────────────────────────────────────────────────────────
@router.post("/user/logs")
def user_logs(
    payload: dict = Body(...),
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    auth_id = claims.get("sub") or ""
    k = _key_by_raw(db, payload["api_key"])
    _assert_key_owner(k, auth_id)
    limit = min(int(payload.get("limit", 100)), 500)
    rows = db.execute(
        select(UsageLogORM).where(UsageLogORM.api_key_id == k.id)
        .order_by(UsageLogORM.created_at.desc()).limit(limit)
    ).scalars().all()
    return {"data": [
        {"id": r.id, "model_id": r.model_id, "status_code": r.status_code,
         "request_id": r.request_id,
         "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
         "total_tokens": r.total_tokens, "latency_ms": r.latency_ms,
         "created_at": r.created_at.isoformat() if r.created_at else None,
         "error_detail": r.error_detail}
        for r in rows
    ]}


# ── 社区 ─────────────────────────────────────────────────────────────────────
def _try_get_user(
    db: Session,
    authorization: str | None = None,
    session_cookie: str | None = None,
) -> str | None:
    """可选登录：支持 HttpOnly cookie 与 Bearer，无效时按匿名处理。"""
    claims = optional_user_session(db, authorization, session_cookie)
    return (claims.get("sub") or "").strip() or None if claims else None


def _forum_reaction_counts(db: Session, post_ids: list[str], reaction_type: str) -> dict[str, int]:
    if not post_ids:
        return {}
    try:
        out: dict[str, int] = {}
        for pid, cnt in db.execute(
            select(ForumReactionORM.post_id, func.count().label("cnt"))
            .where(
                ForumReactionORM.post_id.in_(post_ids),
                ForumReactionORM.reaction_type == reaction_type,
            )
            .group_by(ForumReactionORM.post_id)
        ).all():
            out[pid] = int(cnt)
        return out
    except Exception:
        return {}


def _forum_like_counts(db: Session, post_ids: list[str]) -> dict[str, int]:
    return _forum_reaction_counts(db, post_ids, ForumReactionORM.LIKE)


def _forum_follow_counts(db: Session, post_ids: list[str]) -> dict[str, int]:
    return _forum_reaction_counts(db, post_ids, ForumReactionORM.FOLLOW)


def _forum_post_dict(
    p: ForumPostORM,
    department: str | None,
    reply_stats: dict[str, tuple[int, datetime | None]],
    like_counts: dict[str, int] | None = None,
    follow_counts: dict[str, int] | None = None,
) -> dict:
    cnt, last_at = reply_stats.get(p.id, (0, None))
    return {
        "id": p.id,
        "title": p.title,
        "content": p.content,
        "author_name": p.author_name,
        "author_department": department or "",
        "resolved": p.resolved,
        "pinned": p.pinned,
        "view_count": p.view_count,
        "reply_count": cnt,
        "like_count": (like_counts or {}).get(p.id, 0),
        "follow_count": (follow_counts or {}).get(p.id, 0),
        "last_reply_at": last_at.isoformat() if last_at else None,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


def _forum_reply_stats(db: Session, post_ids: list[str]) -> dict[str, tuple[int, datetime | None]]:
    if not post_ids:
        return {}
    out: dict[str, tuple[int, datetime | None]] = {}
    for pid, cnt, last_at in db.execute(
        select(
            ForumReplyORM.post_id,
            func.count().label("cnt"),
            func.max(ForumReplyORM.created_at).label("last_at"),
        )
        .where(ForumReplyORM.post_id.in_(post_ids))
        .group_by(ForumReplyORM.post_id)
    ).all():
        out[pid] = (int(cnt), last_at)
    return out


def _post_age_days(created_at: datetime | None, now: datetime) -> float:
    """帖子已存在天数（秒转天，最小 0）。"""
    if not created_at:
        return 0.0
    return max(0.0, (now - created_at).total_seconds() / 86400)


def _hot_score(view_count: int | None, reply_count: int | None, age_days: float) -> float:
    """时间衰减热度分：浏览/回复越多分越高，帖子越老衰减越大，避免旧帖霸榜。

    score = log2(浏览 + 3×回复 + 1) − 年龄(天)×0.5
    """
    raw = (view_count or 0) + 3 * (reply_count or 0)
    return math.log2(raw + 1) - age_days * 0.5


@router.get("/forum/overview")
def forum_overview(db: Session = Depends(get_db)):
    now_utc = platform_time.to_utc_naive(platform_time.now_local())
    total = int(db.scalar(select(func.count()).select_from(ForumPostORM)) or 0)
    pending = int(
        db.scalar(select(func.count()).select_from(ForumPostORM).where(ForumPostORM.resolved.is_(False))) or 0
    )
    recent7_new = int(
        db.scalar(
            select(func.count())
            .select_from(ForumPostORM)
            .where(ForumPostORM.created_at >= now_utc - timedelta(days=7))
        )
        or 0
    )

    # 平均首次回复时间：仅统计有回复的帖子，避免误导性指标
    avg_response_hours: float | None = None
    reply_pairs = db.execute(
        select(
            ForumPostORM.created_at,
            func.min(ForumReplyORM.created_at).label("first_reply_at"),
        )
        .join(ForumReplyORM, ForumReplyORM.post_id == ForumPostORM.id)
        .where(ForumPostORM.created_at.isnot(None))
        .group_by(ForumPostORM.id, ForumPostORM.created_at)
    ).all()
    deltas = [
        (first_reply - created).total_seconds() / 3600
        for created, first_reply in reply_pairs
        if created and first_reply and first_reply > created
    ]
    if deltas:
        avg_response_hours = round(sum(deltas) / len(deltas), 1)

    # 时间衰减热度：全量打分后取前 6
    post_rows = db.execute(
        select(
            ForumPostORM.id,
            ForumPostORM.title,
            ForumPostORM.view_count,
            ForumPostORM.resolved,
            ForumPostORM.created_at,
        )
    ).all()
    reply_counts = _forum_reply_stats(db, [r[0] for r in post_rows])
    scored = sorted(
        (
            (
                _hot_score(
                    view_count,
                    reply_counts.get(pid, (0, None))[0],
                    _post_age_days(created, now_utc),
                ),
                pid,
                title,
                view_count,
                reply_counts.get(pid, (0, None))[0],
                resolved,
            )
            for pid, title, view_count, resolved, created in post_rows
        ),
        key=lambda x: x[0],
        reverse=True,
    )

    return {
        "total": total,
        "pending": pending,
        "recent7_new": recent7_new,
        "avg_response_hours": avg_response_hours,
        "hot": [
            {
                "id": pid,
                "title": title,
                "view_count": view_count or 0,
                "reply_count": reply_count,
                "resolved": resolved,
            }
            for _, pid, title, view_count, reply_count, resolved in scored[:6]
        ],
    }


@router.get("/forum/posts")
def list_posts(
    limit: int = 20,
    offset: int = 0,
    search: str | None = Query(default=None),
    filter: str | None = Query(default=None),
    sort: str | None = Query(default="latest"),
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=settings.USER_SESSION_COOKIE),
):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    user_auth_id = _try_get_user(db, authorization, session_cookie)

    conds = []
    join_replies = False
    join_follows = False

    # 搜索：标题或内容模糊匹配
    if search:
        kw = f"%{search.strip()}%"
        conds.append(
            (ForumPostORM.title.ilike(kw)) | (ForumPostORM.content.ilike(kw))
        )

    # 筛选
    if filter == "resolved":
        conds.append(ForumPostORM.resolved.is_(True))
    elif filter == "unresolved":
        conds.append(ForumPostORM.resolved.is_(False))
    elif filter == "mine" and user_auth_id:
        conds.append(ForumPostORM.author_auth_id == user_auth_id)
    elif filter == "commented" and user_auth_id:
        join_replies = True
    elif filter == "followed" and user_auth_id:
        join_follows = True

    # 排序：latest 直接 DB 侧排；hot 用时间衰减分，需在 Python 侧打分（见下方 execute 分支）

    base_q = select(ForumPostORM, UserORM.department).outerjoin(
        UserORM, UserORM.auth_id == ForumPostORM.author_auth_id
    )

    if join_replies:
        base_q = base_q.where(
            ForumPostORM.id.in_(
                select(ForumReplyORM.post_id).where(
                    ForumReplyORM.author_auth_id == user_auth_id
                )
            )
        )
    if join_follows:
        base_q = base_q.where(
            ForumPostORM.id.in_(
                select(ForumReactionORM.post_id).where(
                    ForumReactionORM.user_auth_id == user_auth_id,
                    ForumReactionORM.reaction_type == ForumReactionORM.FOLLOW,
                )
            )
        )

    total_q = select(func.count()).select_from(ForumPostORM)
    if join_replies:
        total_q = total_q.where(
            ForumPostORM.id.in_(
                select(ForumReplyORM.post_id).where(
                    ForumReplyORM.author_auth_id == user_auth_id
                )
            )
        )
    if join_follows:
        total_q = total_q.where(
            ForumPostORM.id.in_(
                select(ForumReactionORM.post_id).where(
                    ForumReactionORM.user_auth_id == user_auth_id,
                    ForumReactionORM.reaction_type == ForumReactionORM.FOLLOW,
                )
            )
        )
    if conds:
        base_q = base_q.where(*conds)
        total_q = total_q.where(*conds)

    total = int(db.scalar(total_q) or 0)
    if sort == "hot":
        # 时间衰减热度排序：全量打分后按分数取页
        now_utc = platform_time.to_utc_naive(platform_time.now_local())
        all_rows = db.execute(base_q).all()
        reply_counts = _forum_reply_stats(db, [p.id for p, _ in all_rows])
        scored = sorted(
            (
                (
                    _hot_score(
                        p.view_count,
                        reply_counts.get(p.id, (0, None))[0],
                        _post_age_days(p.created_at, now_utc),
                    ),
                    p,
                    department,
                )
                for p, department in all_rows
            ),
            key=lambda x: x[0],
            reverse=True,
        )
        rows = [(p, department) for _, p, department in scored[offset:offset + limit]]
    else:
        rows = db.execute(
            base_q.order_by(ForumPostORM.pinned.desc(), ForumPostORM.created_at.desc())
            .limit(limit)
            .offset(offset)
        ).all()

    post_ids = [p.id for p, _ in rows]
    reply_stats = _forum_reply_stats(db, post_ids)
    like_counts = _forum_like_counts(db, post_ids)
    follow_counts = _forum_follow_counts(db, post_ids)

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "data": [
            _forum_post_dict(p, department, reply_stats, like_counts, follow_counts)
            for p, department in rows
        ],
    }


@router.post("/forum/posts")
def create_post(
    payload: ForumPostIn,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    # 身份取自登录态，禁止伪造 auth_id；昵称可用登录名兜底。
    author_auth_id = (claims.get("sub") or "anonymous").strip()
    author_name = (payload.author_name or claims.get("name") or author_auth_id).strip()
    p = ForumPostORM(
        author_auth_id=author_auth_id,
        author_name=author_name,
        title=payload.title.strip(),
        content=payload.content.strip(),
    )
    db.add(p)
    db.commit()
    return {"id": p.id}


@router.get("/forum/posts/{post_id}")
def get_post(
    post_id: str,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=settings.USER_SESSION_COOKIE),
):
    row = db.execute(
        select(ForumPostORM, UserORM.department)
        .outerjoin(UserORM, UserORM.auth_id == ForumPostORM.author_auth_id)
        .where(ForumPostORM.id == post_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    p, department = row
    p.view_count += 1
    db.commit()
    replies = db.execute(
        select(ForumReplyORM).where(ForumReplyORM.post_id == post_id).order_by(ForumReplyORM.created_at)
    ).scalars().all()

    user_auth_id = _try_get_user(db, authorization, session_cookie)

    def _reaction_count(reaction_type: str) -> int:
        try:
            return db.scalar(
                select(func.count()).select_from(ForumReactionORM).where(
                    ForumReactionORM.post_id == post_id,
                    ForumReactionORM.reaction_type == reaction_type,
                )
            ) or 0
        except Exception:
            return 0

    def _has_reaction(reaction_type: str) -> bool:
        if not user_auth_id:
            return False
        try:
            return db.execute(
                select(ForumReactionORM).where(
                    ForumReactionORM.post_id == post_id,
                    ForumReactionORM.user_auth_id == user_auth_id,
                    ForumReactionORM.reaction_type == reaction_type,
                )
            ).scalar_one_or_none() is not None
        except Exception:
            return False

    like_count = _reaction_count(ForumReactionORM.LIKE)
    follow_count = _reaction_count(ForumReactionORM.FOLLOW)
    liked = _has_reaction(ForumReactionORM.LIKE)
    followed = _has_reaction(ForumReactionORM.FOLLOW)

    return {
        "id": p.id, "title": p.title, "content": p.content, "author_name": p.author_name,
        "author_department": department or "",
        # 账号 ID属于内部身份信息：仅登录用户可见，匿名访问者不暴露
        "author_auth_id": p.author_auth_id if user_auth_id else None,
        "resolved": p.resolved, "pinned": p.pinned,
        "view_count": p.view_count,
        "like_count": int(like_count), "follow_count": int(follow_count),
        "liked": liked, "followed": followed,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "replies": [
            {"id": r.id, "author_name": r.author_name, "is_admin": r.is_admin, "content": r.content,
             "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in replies
        ],
    }


@router.post("/forum/posts/{post_id}/replies")
def reply_post(
    post_id: str,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    if db.get(ForumPostORM, post_id) is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    author_auth_id = (claims.get("sub") or "anonymous").strip()
    author_name = (payload.get("author_name") or claims.get("name") or author_auth_id).strip()
    # is_admin 严格取自登录态角色，禁止 body 伪造官方身份。
    r = ForumReplyORM(
        post_id=post_id, author_auth_id=author_auth_id,
        author_name=author_name, is_admin=(claims.get("role") == "admin"),
        content=payload["content"],
    )
    db.add(r)
    db.commit()
    return {"id": r.id}


@router.post("/forum/posts/{post_id}/like")
def like_post(
    post_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """Toggle 点赞：已赞则取消，未赞则点赞。"""
    if db.get(ForumPostORM, post_id) is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    user_auth_id = (claims.get("sub") or "").strip()
    existing = db.execute(
        select(ForumReactionORM).where(
            ForumReactionORM.post_id == post_id,
            ForumReactionORM.user_auth_id == user_auth_id,
            ForumReactionORM.reaction_type == ForumReactionORM.LIKE,
        )
    ).scalar_one_or_none()
    if existing:
        db.delete(existing)
        db.commit()
    else:
        db.add(ForumReactionORM(post_id=post_id, user_auth_id=user_auth_id, reaction_type=ForumReactionORM.LIKE))
        db.commit()
    cnt = db.scalar(
        select(func.count()).select_from(ForumReactionORM).where(
            ForumReactionORM.post_id == post_id, ForumReactionORM.reaction_type == ForumReactionORM.LIKE,
        )
    ) or 0
    return {"liked": existing is None, "like_count": cnt}


@router.post("/forum/posts/{post_id}/follow")
def follow_post(
    post_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """Toggle 关注：已关注则取消，未关注则关注。"""
    if db.get(ForumPostORM, post_id) is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    user_auth_id = (claims.get("sub") or "").strip()
    existing = db.execute(
        select(ForumReactionORM).where(
            ForumReactionORM.post_id == post_id,
            ForumReactionORM.user_auth_id == user_auth_id,
            ForumReactionORM.reaction_type == ForumReactionORM.FOLLOW,
        )
    ).scalar_one_or_none()
    if existing:
        db.delete(existing)
        db.commit()
    else:
        db.add(ForumReactionORM(post_id=post_id, user_auth_id=user_auth_id, reaction_type=ForumReactionORM.FOLLOW))
        db.commit()
    cnt = db.scalar(
        select(func.count()).select_from(ForumReactionORM).where(
            ForumReactionORM.post_id == post_id, ForumReactionORM.reaction_type == ForumReactionORM.FOLLOW,
        )
    ) or 0
    return {"followed": existing is None, "follow_count": cnt}


@router.post("/forum/posts/{post_id}/resolve")
def resolve_post(
    post_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """用户确认问题已解决（仅作者本人或管理员）。"""
    p = db.get(ForumPostORM, post_id)
    if p is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    if claims.get("role") != "admin" and p.author_auth_id != (claims.get("sub") or ""):
        raise HTTPException(status_code=403, detail="仅帖子作者或管理员可操作")
    p.resolved = True
    db.commit()
    return {"ok": True}


@router.post("/forum/posts/{post_id}/pin")
def pin_post(
    post_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """置顶是版面策展动作，仅管理员可操作（任意用户可置顶会被刷屏/顶掉官方公告）。"""
    p = db.get(ForumPostORM, post_id)
    if p is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    if claims.get("role") != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可置顶")
    p.pinned = not p.pinned
    db.commit()
    return {"pinned": p.pinned}
