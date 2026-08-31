"""公开端点（无需鉴权）：模型清单、配置、公告。Key 创建需登录。"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import logging
import threading
import time
from datetime import date as date_type

from fastapi import APIRouter, Body, Cookie, Depends, Header, HTTPException, Request, Query
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.auth import optional_user_session, require_user
from app.auth_rate_limit import client_identity
from app.config import settings
from app.database import SessionLocal, get_db
from app.platform_settings import get_branding_config
from app.early_access import iso_utc
from app.platform_stats import query_platform_stats
from app.platform_time import sql_tz_param, today_local
from app.models import (
    ApiKeyORM, ApplicationIn, ApplicationORM, DocFeedbackORM, ModelRegistryORM,
    NotificationORM, SceneTypeORM, UpgradeApplicationORM, UpgradeApplyIn, UpgradeUpdateIn,
)
from app.redis_client import redis
from app.heatmap_stats import build_cumulative_heatmap, build_month_heatmap, build_week_heatmap
from app.scenario_name import assert_scenario_name_available
from app.platform_usage_stats import build_context_length, build_tool_calls
from app.stats_breakdown import query_public_breakdown
from app.tier_flow import UPGRADE_TARGETS, can_upgrade_to

router = APIRouter()
log = logging.getLogger("apiplatform.public")

_PUBLIC_STATUS = ("online", "exclusive", "unstable", "maintenance", "upcoming", "upgrading", "sunsetting", "offline")
# 公开页只暴露非敏感维度：不含 user/department（会点名具体调用人/团队），不含 cost（内部定价口径）；
# project 项目名会点名具体业务（如安全类项目），需管理员权限，管理员在后台统计的「查看全部」里查看。
_PUBLIC_BREAKDOWN_DIMENSIONS = {"model", "scene"}
_APPLY_RATE_PER_HOUR = 10
_STATUS_CACHE: dict[str, tuple[float, dict]] = {}
_STATUS_CACHE_LOCK = threading.Lock()
_STATUS_BUILD_LOCK = threading.Lock()
_STATUS_LOCAL_RATE: dict[tuple[int, str], int] = {}
_STATUS_LOCAL_RATE_LOCK = threading.Lock()


def _status_cache_get(key: str) -> dict | None:
    now = time.monotonic()
    with _STATUS_CACHE_LOCK:
        item = _STATUS_CACHE.get(key)
        if item is None:
            return None
        expires_at, value = item
        if expires_at <= now:
            _STATUS_CACHE.pop(key, None)
            return None
        return deepcopy(value)


def _status_cache_set(key: str, value: dict) -> None:
    ttl = max(0, settings.PUBLIC_STATUS_CACHE_TTL_S)
    if ttl == 0:
        return
    with _STATUS_CACHE_LOCK:
        # 参数组合理论上有 8,100 个；进程缓存只保留最近 256 组，Redis 仍由 TTL 回收。
        if len(_STATUS_CACHE) >= 256:
            now = time.monotonic()
            expired = [cache_key for cache_key, (expires, _) in _STATUS_CACHE.items() if expires <= now]
            for cache_key in expired:
                _STATUS_CACHE.pop(cache_key, None)
            while len(_STATUS_CACHE) >= 256:
                _STATUS_CACHE.pop(next(iter(_STATUS_CACHE)))
        _STATUS_CACHE[key] = (time.monotonic() + ttl, deepcopy(value))


async def _check_public_status_rate(request: Request) -> None:
    """匿名状态聚合的基础限流；Redis 不可用时退化为每进程有界计数。"""
    limit = max(1, settings.PUBLIC_STATUS_RATE_PER_MINUTE)
    identity = _client_ip(request)
    bucket = int(time.time() // 60)
    key = f"public:status:rate:{identity}:{bucket}"
    try:
        pipe = redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, 70)
        result = await pipe.execute()
        if int(result[0]) > limit:
            raise HTTPException(
                status_code=429,
                detail="平台状态查询过于频繁，请稍后重试",
                headers={"Retry-After": "60"},
            )
        return
    except HTTPException:
        raise
    except Exception:
        pass

    with _STATUS_LOCAL_RATE_LOCK:
        # 每分钟顺手清掉旧桶，避免恶意构造 IP 造成无界内存增长。
        stale = [item for item in _STATUS_LOCAL_RATE if item[0] != bucket]
        for item in stale:
            _STATUS_LOCAL_RATE.pop(item, None)
        local_key = (bucket, identity)
        count = _STATUS_LOCAL_RATE.get(local_key, 0) + 1
        _STATUS_LOCAL_RATE[local_key] = count
    if count > limit:
        raise HTTPException(
            status_code=429,
            detail="平台状态查询过于频繁，请稍后重试",
            headers={"Retry-After": "60"},
        )


async def _public_status_rate_dependency(request: Request) -> None:
    """Apply the same abuse boundary to every public status query."""
    await _check_public_status_rate(request)


def _yoy(cur: int, prev: int) -> float | None:
    """同比增长百分比。去年同期无记录（prev 为 0）时返回 None，前端显示 —；
    避免除零与把"平台还没跑满一年"误算成虚高增长。"""
    return round((cur - prev) / prev * 100, 1) if prev > 0 else None


def _client_ip(request: Request) -> str:
    # Only trust forwarded addresses when the deployment explicitly declares a
    # trusted reverse-proxy boundary. Direct deployments must not let callers
    # rotate X-Real-IP to evade public or authentication rate limits.
    return client_identity(request)


async def _check_apply_rate(identity: str) -> None:
    """密钥申请限流：按**登录用户**（auth_id）计，NAT 后多人不再共享计数；
    identity 兜底为 IP（理论上 require_user 已保证非空）。Redis 异常放行。"""
    bucket = int(time.time() // 3600)
    key = f"apply:rate:{identity}:{bucket}"
    try:
        n = int(await redis.incr(key))
        if n == 1:
            await redis.expire(key, 3700)
        if n > _APPLY_RATE_PER_HOUR:
            ttl = await redis.ttl(key)
            retry = max(1, int(ttl) if ttl and ttl > 0 else 3600)
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "apply_rate_limited",
                    "retry_minutes": retry // 60,
                    "limit": _APPLY_RATE_PER_HOUR,
                },
                headers={"Retry-After": str(retry)},
            )
    except HTTPException:
        raise
    except Exception:
        pass


async def _apply_remaining(identity: str) -> dict:
    """返回当前小时剩余可创建次数（供前端提示用）。Redis 异常时不限。"""
    bucket = int(time.time() // 3600)
    key = f"apply:rate:{identity}:{bucket}"
    try:
        n_raw = await redis.get(key)
        used = int(n_raw) if n_raw else 0
        ttl = await redis.ttl(key)
        return {
            "limit": _APPLY_RATE_PER_HOUR,
            "used": used,
            "remaining": max(0, _APPLY_RATE_PER_HOUR - used),
            "resets_in": int(ttl) if ttl and ttl > 0 else 3600,
        }
    except Exception:
        return {"limit": _APPLY_RATE_PER_HOUR, "used": 0, "remaining": _APPLY_RATE_PER_HOUR, "resets_in": 3600}


# 升级申请限流：按登录用户计，每小时最多提交的升级申请数（防对名下多密钥批量刷屏）。
_UPGRADE_APPLY_RATE_PER_HOUR = 10


async def _check_upgrade_apply_rate(identity: str) -> None:
    """与 _check_apply_rate 同构，但用独立 key 前缀（按用户计），避免与密钥申请共享计数。"""
    bucket = int(time.time() // 3600)
    key = f"upgrade_apply:rate:{identity}:{bucket}"
    try:
        n = int(await redis.incr(key))
        if n == 1:
            await redis.expire(key, 3700)
        if n > _UPGRADE_APPLY_RATE_PER_HOUR:
            ttl = await redis.ttl(key)
            retry = max(1, int(ttl) if ttl and ttl > 0 else 3600)
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "upgrade_apply_rate_limited",
                    "retry_minutes": retry // 60,
                    "limit": _UPGRADE_APPLY_RATE_PER_HOUR,
                },
                headers={"Retry-After": str(retry)},
            )
    except HTTPException:
        raise
    except Exception:
        pass


@router.get("/public/config")
def public_config(db: Session = Depends(get_db)):
    """前端展示用的非敏感配置（平台统计等）。"""
    branding = get_branding_config(db)
    return {
        "title": branding.hero_title,
        "brand": branding.brand_name,
        "platform_name": branding.platform_name,
        "browser_title": branding.browser_title,
        "slogan": branding.slogan,
        "organization_name": branding.organization_name,
        "footer_text": branding.footer_text,
        "support_department": branding.support_department,
        "support_contact": branding.support_contact,
        "support_email": branding.support_email,
        "approval_department": branding.approval_department,
        "approval_contact": branding.approval_contact,
        "approval_email": branding.approval_email,
        # 实际生效的全平台限流值（文档/管理端展示与管控同源，避免硬编码漂移）
        "rate_limit": {
            "rpm": settings.RATE_LIMIT_RPM,
            "tpm": settings.RATE_LIMIT_TPM,
            # 夜间不限流窗口：窗口内跳过全部 RPM/TPM 检查
            "night_unlimited": {
                "enabled": settings.NIGHT_UNLIMITED_ENABLED,
                "start": settings.NIGHT_UNLIMITED_START,
                "end": settings.NIGHT_UNLIMITED_END,
                "timezone": settings.PLATFORM_TIMEZONE,
            },
        },
        # 并发档位预设（admin 一键提升；平台默认/高并发/超高并发·无限）
        "rate_limit_presets": settings.rate_limit_presets(),
        # 仅显式开发环境显示假登录入口，未知环境按关闭处理。
        "dev_login_enabled": settings.ENVIRONMENT == "development",
        "registration_enabled": settings.ALLOW_PUBLIC_REGISTRATION,
        "password_recovery_enabled": settings.ALLOW_PASSWORD_RECOVERY,
        "platform_timezone": settings.PLATFORM_TIMEZONE,
        "platform_stats": query_platform_stats(db),
    }


def _query_public_period(db: Session) -> dict:
    row = db.execute(text("""
        SELECT
            COALESCE(SUM(calls) FILTER (WHERE day = date((now() AT TIME ZONE :tz))), 0) AS today_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE day = date((now() AT TIME ZONE :tz))), 0) AS today_tokens,
            COALESCE(SUM(calls) FILTER (WHERE to_char(day, 'YYYY-MM') = to_char((now() AT TIME ZONE :tz), 'YYYY-MM')), 0) AS month_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE to_char(day, 'YYYY-MM') = to_char((now() AT TIME ZONE :tz), 'YYYY-MM')), 0) AS month_tokens,
            COALESCE(SUM(calls) FILTER (WHERE day = date((now() AT TIME ZONE :tz) - INTERVAL '1 year')), 0) AS day_yoy_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE day = date((now() AT TIME ZONE :tz) - INTERVAL '1 year')), 0) AS day_yoy_tokens,
            COALESCE(SUM(calls) FILTER (
                WHERE to_char(day, 'YYYY-MM') = to_char((now() AT TIME ZONE :tz) - INTERVAL '1 year', 'YYYY-MM')
                  AND day <= date((now() AT TIME ZONE :tz) - INTERVAL '1 year')
            ), 0) AS month_yoy_calls,
            COALESCE(SUM(total_tokens) FILTER (
                WHERE to_char(day, 'YYYY-MM') = to_char((now() AT TIME ZONE :tz) - INTERVAL '1 year', 'YYYY-MM')
                  AND day <= date((now() AT TIME ZONE :tz) - INTERVAL '1 year')
            ), 0) AS month_yoy_tokens,
            COALESCE(SUM(calls) FILTER (WHERE day <= date((now() AT TIME ZONE :tz) - INTERVAL '1 year')), 0) AS cum_yoy_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE day <= date((now() AT TIME ZONE :tz) - INTERVAL '1 year')), 0) AS cum_yoy_tokens
        FROM usage_daily_summary
    """), sql_tz_param()).fetchone()
    return {
        "today_calls": int(row[0] or 0), "today_tokens": int(row[1] or 0),
        "month_calls": int(row[2] or 0), "month_tokens": int(row[3] or 0),
        "day_yoy_calls": int(row[4] or 0), "day_yoy_tokens": int(row[5] or 0),
        "month_yoy_calls": int(row[6] or 0), "month_yoy_tokens": int(row[7] or 0),
        "cum_yoy_calls": int(row[8] or 0), "cum_yoy_tokens": int(row[9] or 0),
    }


def _query_public_realtime(db: Session):
    return db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '5 minutes') AS r5_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= now() - INTERVAL '5 minutes'), 0) AS r5_tokens,
            COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '1 hour') AS r1h_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= now() - INTERVAL '1 hour'), 0) AS r1h_tokens
        FROM usage_logs
    """)).fetchone()


def _query_public_health(db: Session, dist_days: int):
    return db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status_code LIKE '2%') AS success,
            AVG(latency_ms) FILTER (WHERE latency_ms > 0) AS avg_latency,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms > 0) AS p95_latency
        FROM usage_logs
        WHERE created_at >= now() - CAST(:dist_interval AS INTERVAL)
    """), {"dist_interval": f"{dist_days} days"}).fetchone()


def _query_public_trend(db: Session, trend_days: int):
    return db.execute(text("""
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
               COALESCE(SUM(s.calls), 0) AS calls,
               COALESCE(SUM(s.total_tokens), 0) AS tokens
        FROM generate_series(date((now() AT TIME ZONE :tz)) - CAST(:trend_interval AS INTERVAL), date((now() AT TIME ZONE :tz)), INTERVAL '1 day') AS d(day)
        LEFT JOIN usage_daily_summary s ON s.day = d.day
        GROUP BY d.day
        ORDER BY d.day
    """), {"trend_interval": f"{trend_days - 1} days", **sql_tz_param()}).fetchall()


def _query_public_scenes(db: Session, dist_days: int) -> list[tuple]:
    aggregate_rows = db.execute(text("""
        SELECT COALESCE(k.scene_type, 'explore') AS category,
               SUM(s.calls) AS calls,
               SUM(s.total_tokens) AS tokens
        FROM usage_daily_summary s
        LEFT JOIN api_keys k ON s.api_key_id = k.id
        WHERE s.day >= date((now() AT TIME ZONE :tz)) - CAST(:dist_interval AS INTERVAL)
        GROUP BY k.scene_type
    """), {"dist_interval": f"{dist_days} days", **sql_tz_param()}).fetchall()
    scene_by_type = {row[0]: row for row in aggregate_rows}
    scene_type_rows = db.execute(
        select(SceneTypeORM.key, SceneTypeORM.label).order_by(SceneTypeORM.sort_order, SceneTypeORM.key)
    ).all()
    scene_types = {row[0]: row[1] for row in scene_type_rows}
    rows = [
        (key, label, *(scene_by_type.get(key) or (key, 0, 0))[1:])
        for key, label in scene_types.items()
    ]
    unknown = {key: row for key, row in scene_by_type.items() if key not in scene_types}
    if unknown:
        rows.append((
            "other", "其他",
            sum(row[1] for row in unknown.values()),
            sum(row[2] for row in unknown.values()),
        ))
    return rows


def _query_public_models(db: Session, dist_days: int) -> tuple[list, dict]:
    rows = db.execute(text("""
        SELECT s.model_id,
               SUM(s.calls) AS calls,
               SUM(s.total_tokens) AS tokens
        FROM usage_daily_summary s
        WHERE s.day >= date((now() AT TIME ZONE :tz)) - CAST(:dist_interval AS INTERVAL)
        GROUP BY s.model_id
        ORDER BY calls DESC
    """), {"dist_interval": f"{dist_days} days", **sql_tz_param()}).fetchall()
    names = {
        row[0]: row[1]
        for row in db.execute(select(ModelRegistryORM.id, ModelRegistryORM.name)).all()
    }
    return rows, names


def _query_monthly_active_keys(db: Session) -> int:
    return int(db.execute(text("""
            SELECT COUNT(DISTINCT api_key_id)
            FROM usage_daily_summary
            WHERE day >= date((now() AT TIME ZONE :tz)) - INTERVAL '29 days'
        """), sql_tz_param()).scalar() or 0)


def _public_yoy(ps: dict, period: dict) -> dict:
    return {
        "day": {
            "calls": _yoy(period["today_calls"], period["day_yoy_calls"]),
            "tokens": _yoy(period["today_tokens"], period["day_yoy_tokens"]),
        },
        "month": {
            "calls": _yoy(period["month_calls"], period["month_yoy_calls"]),
            "tokens": _yoy(period["month_tokens"], period["month_yoy_tokens"]),
        },
        "cumulative": {
            "calls": _yoy(ps["total_calls"], period["cum_yoy_calls"]),
            "tokens": _yoy(ps["total_tokens"], period["cum_yoy_tokens"]),
        },
    }


def _public_health(row) -> dict:
    total = int(row[0] or 0) if row else 0
    return {
        "success_rate": round((row[1] or 0) / total * 100, 2) if total else None,
        "avg_latency_ms": round(row[2]) if row and row[2] is not None else None,
        "p95_latency_ms": round(row[3]) if row and row[3] is not None else None,
        "sample_calls": total,
    }


def _public_scene_rows(rows: list[tuple]) -> list[dict]:
    total = sum(row[2] for row in rows) or 0
    return [
        {
            "category": row[0], "label": row[1], "calls": row[2], "tokens": row[3] or 0,
            "pct": round(row[2] / total * 100, 1) if total else 0.0,
        }
        for row in rows
    ]


def _render_public_status(
    *, ps: dict, period: dict, realtime, health, trend_rows: list,
    scene_rows: list[tuple], model_rows: list, model_names: dict,
    monthly_active_keys: int, trend_days: int, dist_days: int,
) -> dict:
    return {
        "cumulative": {
            "calls": ps["total_calls"], "tokens": ps["total_tokens"], "active_keys": ps["active_keys"],
        },
        "today": {"calls": period["today_calls"], "tokens": period["today_tokens"]},
        "month": {"calls": period["month_calls"], "tokens": period["month_tokens"]},
        "yoy": _public_yoy(ps, period),
        "monthly_active_keys": monthly_active_keys,
        "trend_days": trend_days,
        "dist_days": dist_days,
        "trend": [{"day": row[0], "calls": row[1], "tokens": row[2] or 0} for row in trend_rows],
        "realtime": {
            "recent_5min": {"calls": int(realtime[0] or 0), "tokens": int(realtime[1] or 0)},
            "recent_1h": {"calls": int(realtime[2] or 0), "tokens": int(realtime[3] or 0)},
        },
        "health": _public_health(health),
        "by_scene": _public_scene_rows(scene_rows),
        "by_model": [
            {
                "model_id": row[0], "name": model_names.get(row[0], row[0]),
                "calls": row[1], "tokens": row[2] or 0,
            }
            for row in model_rows
        ],
    }


def _build_platform_status(
    trend_days: int = 14,
    dist_days: int = 30,
    db: Session | None = None,
):
    """构建匿名状态页；查询、归一化和响应渲染分别由小函数负责。"""
    if db is None:
        raise RuntimeError("_build_platform_status 需要数据库 Session")
    trend_days = max(1, min(trend_days, 90))
    dist_days = max(1, min(dist_days, 90))
    model_rows, model_names = _query_public_models(db, dist_days)
    return _render_public_status(
        ps=query_platform_stats(db),
        period=_query_public_period(db),
        realtime=_query_public_realtime(db),
        health=_query_public_health(db, dist_days),
        trend_rows=_query_public_trend(db, trend_days),
        scene_rows=_query_public_scenes(db, dist_days),
        model_rows=model_rows,
        model_names=model_names,
        monthly_active_keys=_query_monthly_active_keys(db),
        trend_days=trend_days,
        dist_days=dist_days,
    )


def _query_platform_status_cached(cache_key: str, trend_days: int, dist_days: int) -> dict:
    """在线程池内执行同步 SQL，并以进程锁抑制同 worker 的冷缓存击穿。"""
    cached = _status_cache_get(cache_key)
    if cached is not None:
        return cached
    with _STATUS_BUILD_LOCK:
        cached = _status_cache_get(cache_key)
        if cached is not None:
            return cached
        with SessionLocal() as db:
            timeout_ms = max(100, settings.PUBLIC_STATUS_QUERY_TIMEOUT_MS)
            db.execute(
                text("SELECT set_config('statement_timeout', :timeout, true)"),
                {"timeout": f"{timeout_ms}ms"},
            )
            result = _build_platform_status(trend_days=trend_days, dist_days=dist_days, db=db)
        _status_cache_set(cache_key, result)
        return result


@router.get("/public/platform-status")
async def platform_status(
    request: Request,
    trend_days: int = 14,
    dist_days: int = 30,
):
    """带短 TTL 两级缓存、SQL 超时与匿名限流的平台状态聚合。"""
    trend_days = max(1, min(trend_days, 90))
    dist_days = max(1, min(dist_days, 90))
    await _check_public_status_rate(request)
    cache_key = f"public:status:v2:{trend_days}:{dist_days}"

    cached = _status_cache_get(cache_key)
    if cached is not None:
        return cached
    if settings.PUBLIC_STATUS_CACHE_TTL_S > 0:
        try:
            raw = await redis.get(cache_key)
            if raw:
                value = json.loads(raw)
                if isinstance(value, dict):
                    _status_cache_set(cache_key, value)
                    return value
        except Exception:
            pass

    try:
        result = await asyncio.to_thread(
            _query_platform_status_cached, cache_key, trend_days, dist_days,
        )
    except Exception as exc:
        log.warning("公开平台状态聚合失败: %s", exc)
        raise HTTPException(status_code=503, detail="平台状态暂时不可用，请稍后重试") from exc

    if settings.PUBLIC_STATUS_CACHE_TTL_S > 0:
        try:
            await redis.set(
                cache_key,
                json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                ex=max(1, settings.PUBLIC_STATUS_CACHE_TTL_S),
            )
        except Exception:
            pass
    return result


@router.get("/public/platform-status/breakdown")
def platform_status_breakdown(
    dimension: str,
    days: int = 30,
    search: str | None = None,
    sort_field: str = "calls",
    sort_dir: str = "desc",
    limit: int = 50,
    offset: int = 0,
    filter_dimension: str | None = None,
    filter_value: str | None = None,
    db: Session = Depends(get_db),
    _rate: None = Depends(_public_status_rate_dependency),
):
    """状态页"查看全部"的分页/搜索接口——只开放 project/model/scene 三个非敏感
    维度，不含 user/department、不含成本，口径与 platform_status() 一致。
    """
    if dimension not in _PUBLIC_BREAKDOWN_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的维度: {dimension}")
    days = max(1, min(days, 90))
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    # 走永久汇总表 usage_daily_summary（与 platform_status 的分布同口径），避免
    # usage_logs 清理后"查看全部"空窗；summary 无 latency/success/cost，前端显示 —。
    result = query_public_breakdown(
        db, dimension=dimension, days=days, search=search,
        sort_field=sort_field, sort_dir=sort_dir, limit=limit, offset=offset,
        filter_dimension=filter_dimension, filter_value=filter_value,
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

    return result


@router.get("/public/platform-status/tool-calls")
def platform_status_tool_calls(
    days: int = Query(default=30, ge=1, le=90),
    db: Session = Depends(get_db),
    _rate: None = Depends(_public_status_rate_dependency),
):
    """状态页 Tool Call 分布：全平台 session 分桶，口径与 user/admin 看板一致。"""
    return build_tool_calls(db, key_ids=None, days=days)


@router.get("/public/platform-status/context-length")
def platform_status_context_length(
    days: int = Query(default=30, ge=1, le=90),
    db: Session = Depends(get_db),
    _rate: None = Depends(_public_status_rate_dependency),
):
    """状态页上下文长度分布：全平台 prompt tokens 分桶。"""
    return build_context_length(db, key_ids=None, days=days)


@router.get("/public/platform-status/heatmap")
def platform_status_heatmap(
    mode: str = Query(default="week", description="week | month | cumulative"),
    date: str | None = Query(default=None, description="锚点日期（平台本地时区）；周/月模式使用"),
    db: Session = Depends(get_db),
    _rate: None = Depends(_public_status_rate_dependency),
):
    """状态页调用热力图。

    - week：7 行（周一~周日）× 24 列（小时），数据来自 usage_logs；
    - month：7 行（时段带）× 当月自然日列，明细窗口内按小时分桶，更早日期用日汇总；
    - cumulative：同 month 矩阵结构，列为首条汇总日至今天（最多 365 天）。
    """
    if mode not in ("week", "month", "cumulative"):
        raise HTTPException(status_code=400, detail="mode 应为 week、month 或 cumulative")
    if mode == "cumulative":
        return build_cumulative_heatmap(db, key_ids=None)
    anchor = today_local()
    if date:
        try:
            anchor = date_type.fromisoformat(date)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="date 格式应为 YYYY-MM-DD",
            ) from exc
    if mode == "month":
        return build_month_heatmap(db, anchor=anchor, key_ids=None)
    return build_week_heatmap(db, anchor=anchor, key_ids=None)


@router.get("/public/scene-types")
def public_scene_types(db: Session = Depends(get_db)):
    """申请表单用：场景分类列表（按 sort_order 排序）。"""
    rows = db.execute(
        select(SceneTypeORM.key, SceneTypeORM.label).order_by(SceneTypeORM.sort_order, SceneTypeORM.key)
    ).all()
    return {"data": [{"key": r[0], "label": r[1]} for r in rows]}


@router.get("/public/models")
def public_models(db: Session = Depends(get_db)):
    rows = db.execute(
        select(ModelRegistryORM).where(ModelRegistryORM.status.in_(_PUBLIC_STATUS))
    ).scalars().all()
    out = []
    for m in rows:
        extra = m.extra if isinstance(m.extra, dict) else {}
        out.append({
            "id": m.id,
            "name": m.name,
            "provider": m.provider,
            "short_desc": m.short_desc,
            "description": m.description,
            "readme": m.readme,
            "context_window": m.context_window,
            "category": m.category,
            "status": m.status,
            "speed": m.speed,
            "pricing_input": m.pricing_input,
            "pricing_output": m.pricing_output,
            "resolve_to_model_id": m.resolve_to_model_id,
            "is_virtual": m.category == "lts",
            "tags": extra.get("tags"),
            "badge": extra.get("badge"),
            "scene": extra.get("scene"),
            "scenes": extra.get("scenes"),
            "autoApprove": extra.get("autoApprove"),
            "arch": extra.get("arch"),
            "params": extra.get("params"),
            "activatedParams": extra.get("activatedParams"),
            "dimension": extra.get("dimension"),
            "addedAt": extra.get("addedAt"),
            "releaseDate": extra.get("releaseDate"),
            "engine_type": extra.get("engine_type") or "vllm",
        })
    return {"data": out}


@router.post("/apply")
async def submit_application(
    payload: ApplicationIn,
    request: Request,
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """登录用户提交 API Key 申请，需管理员审批通过后才会真正发放密钥。"""
    auth_id = claims.get("sub") or ""
    if not auth_id:
        raise HTTPException(status_code=401, detail="登录态无效")
    # 限流按登录用户计（IP 兜底），避免 NAT 后多人共享计数
    await _check_apply_rate(auth_id or _client_ip(request))
    try:
        project_name = assert_scenario_name_available(db, auth_id, payload.project_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # 场景分类：只在 scene_types 表内取值才生效；缺失/非法回退「explore」，
    # 即便 explore 也被删除，历史/异常值会在场景分布里归入「其他」桶，不阻断申请。
    scene_type = payload.scene_type or "explore"
    if db.get(SceneTypeORM, scene_type) is None:
        scene_type = "explore"
    a = ApplicationORM(
        name=project_name,
        auth_id=auth_id,
        project_name=project_name,
        # 部门一律取自登录态，不信任请求体（防伪造部门归属）
        department=claims.get("department") or "",
        project_desc=payload.project_desc,
        scene_type=scene_type,
        models=payload.models,
        reason=payload.reason,
    )
    db.add(a)
    db.commit()
    remaining = await _apply_remaining(auth_id or _client_ip(request))
    return {"id": a.id, "status": "pending", "rate_limit": remaining}


@router.get("/apply/rate")
async def apply_rate_info(request: Request, claims: dict = Depends(require_user)):
    """返回当前登录用户本小时的剩余可创建次数（供前端提示）。"""
    auth_id = claims.get("sub") or ""
    return await _apply_remaining(auth_id or _client_ip(request))


# ── 高并发升级申请 ────────────────────────────────────────────────────────────


def _upgrade_app_dict(a: UpgradeApplicationORM) -> dict:
    return {
        "id": a.id,
        "keyId": a.key_id,
        "keyName": a.key_name,
        "reason": a.reason,
        "targetTier": a.target_tier,
        "status": a.status,
        "note": a.note,
        "createdAt": iso_utc(a.created_at),
        "reviewedAt": iso_utc(a.reviewed_at),
    }


@router.post("/apply/upgrade")
async def submit_upgrade_application(
    payload: UpgradeApplyIn,
    request: Request,
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """登录用户对某个已激活密钥提交并发档位升级申请（高并发 / 超高并发），需管理员审批。"""
    auth_id = claims.get("sub") or ""
    if not auth_id:
        raise HTTPException(status_code=401, detail="登录态无效")
    # 限流按登录用户计（IP 兜底）
    await _check_upgrade_apply_rate(auth_id or _client_ip(request))
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HTTPException(status_code=422, detail="申请原因至少需要 10 字")
    if len(reason) > 500:
        raise HTTPException(status_code=422, detail="申请原因最多 500 字")
    target_tier = (payload.target_tier or "high").strip()
    if target_tier not in UPGRADE_TARGETS:
        raise HTTPException(status_code=422, detail="升级目标档位无效；超高并发须正式邮件申请，系统仅支持申请高并发")
    k = db.get(ApiKeyORM, payload.key_id)
    if k is None or k.deleted_at is not None or k.revoked or not k.key_hash:
        raise HTTPException(status_code=404, detail="密钥不存在或不可用")
    if k.auth_id != auth_id:
        raise HTTPException(status_code=403, detail="只能申请升级自己的密钥")
    ok, msg = can_upgrade_to(k, target_tier)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    pending_exists = db.execute(
        select(UpgradeApplicationORM).where(
            UpgradeApplicationORM.key_id == k.id,
            UpgradeApplicationORM.status == "pending",
        )
    ).scalar_one_or_none()
    if pending_exists is not None:
        raise HTTPException(status_code=400, detail="该密钥已有待审批的升级申请")
    a = UpgradeApplicationORM(
        auth_id=auth_id,
        name=claims.get("name") or "",
        department=claims.get("department") or "",
        key_id=k.id,
        key_name=k.name,
        project_name=k.project_name,
        reason=reason,
        target_tier=target_tier,
    )
    db.add(a)
    db.commit()
    return {
        "id": a.id,
        "keyId": k.id,
        "keyName": k.name,
        "targetTier": target_tier,
        "status": "pending",
        "createdAt": iso_utc(a.created_at),
    }


@router.get("/apply/upgrade")
def list_my_upgrade_applications(
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """当前登录用户的全部高并发升级申请（供 API Keys 页展示状态角标）。"""
    auth_id = claims.get("sub") or ""
    rows = db.execute(
        select(UpgradeApplicationORM)
        .where(UpgradeApplicationORM.auth_id == auth_id)
        .order_by(UpgradeApplicationORM.created_at.desc())
    ).scalars().all()
    return {"data": [_upgrade_app_dict(a) for a in rows]}


def _owned_upgrade_app(db: Session, app_id: str, auth_id: str) -> UpgradeApplicationORM:
    a = db.get(UpgradeApplicationORM, app_id)
    if a is None or a.auth_id != auth_id:
        raise HTTPException(status_code=404, detail="升级申请不存在")
    return a


@router.patch("/apply/upgrade/{app_id}")
def update_upgrade_application(
    app_id: str,
    payload: UpgradeUpdateIn,
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """修改本人待审批的升级申请（目标档位与原因）。"""
    auth_id = claims.get("sub") or ""
    if not auth_id:
        raise HTTPException(status_code=401, detail="登录态无效")
    a = _owned_upgrade_app(db, app_id, auth_id)
    if a.status != "pending":
        raise HTTPException(status_code=400, detail="仅待审批的申请可修改")
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HTTPException(status_code=422, detail="申请原因至少需要 10 字")
    if len(reason) > 500:
        raise HTTPException(status_code=422, detail="申请原因最多 500 字")
    target_tier = (payload.target_tier or "").strip()
    if target_tier not in UPGRADE_TARGETS:
        raise HTTPException(status_code=422, detail="升级目标档位无效；超高并发须正式邮件申请，系统仅支持申请高并发")
    if a.key_id is None:
        raise HTTPException(status_code=400, detail="对应密钥已删除，无法修改")
    k = db.get(ApiKeyORM, a.key_id)
    if k is None or k.deleted_at is not None or k.revoked:
        raise HTTPException(status_code=400, detail="对应密钥不可用")
    ok, msg = can_upgrade_to(k, target_tier)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    a.reason = reason
    a.target_tier = target_tier
    db.commit()
    return _upgrade_app_dict(a)


@router.delete("/apply/upgrade/{app_id}")
def withdraw_upgrade_application(
    app_id: str,
    claims: dict = Depends(require_user),
    db: Session = Depends(get_db),
):
    """撤回待审批申请，或清除已驳回记录（便于重新提交）。"""
    auth_id = claims.get("sub") or ""
    if not auth_id:
        raise HTTPException(status_code=401, detail="登录态无效")
    a = _owned_upgrade_app(db, app_id, auth_id)
    if a.status not in ("pending", "rejected"):
        raise HTTPException(status_code=400, detail="仅待审批或已驳回的申请可清除")
    db.delete(a)
    db.commit()
    return {"ok": True, "id": app_id}


@router.get("/public/notifications")
def notifications(db: Session = Depends(get_db)):
    rows = db.execute(
        select(NotificationORM).order_by(NotificationORM.created_at.desc()).limit(20)
    ).scalars().all()
    return {"data": [{"id": n.id, "type": n.type, "title": n.title, "body": n.body} for n in rows]}


@router.get("/public/models/{model_id}")
def model_detail(model_id: str, db: Session = Depends(get_db)):
    m = db.get(ModelRegistryORM, model_id)
    if m is None or m.status not in _PUBLIC_STATUS:
        raise HTTPException(status_code=404, detail="模型不存在")
    extra = m.extra if isinstance(m.extra, dict) else {}
    return {
        "id": m.id, "name": m.name, "provider": m.provider,
        "short_desc": m.short_desc, "description": m.description,
        "readme": m.readme, "context_window": m.context_window,
        "category": m.category, "status": m.status, "speed": m.speed,
        "pricing_input": m.pricing_input, "pricing_output": m.pricing_output,
        "resolve_to_model_id": m.resolve_to_model_id,
        "is_virtual": m.category == "lts",
        "tags": extra.get("tags"), "badge": extra.get("badge"),
        "scene": extra.get("scene"), "scenes": extra.get("scenes"),
        "autoApprove": extra.get("autoApprove"),
        "arch": extra.get("arch"), "params": extra.get("params"),
        "activatedParams": extra.get("activatedParams"),
        "dimension": extra.get("dimension"),
        "addedAt": extra.get("addedAt"), "releaseDate": extra.get("releaseDate"),
        "engine_type": extra.get("engine_type") or "vllm",
    }


# ── 文档反馈 ─────────────────────────────────────────────────────────────────
#: 每 IP 每小时最多提交次数。反馈是低频行为，限流只为挡住脚本刷库。
_FEEDBACK_RATE_PER_HOUR = 20


async def _check_feedback_rate(ip: str) -> None:
    """fail-open：Redis 异常一律放行，不因协调层抖动挡住正常反馈。"""
    bucket = int(time.time() // 3600)
    key = f"docfb:rate:{ip}:{bucket}"
    try:
        n = int(await redis.incr(key))
        if n == 1:
            await redis.expire(key, 3700)
        if n > _FEEDBACK_RATE_PER_HOUR:
            raise HTTPException(status_code=429, detail="提交过于频繁，请稍后再试")
    except HTTPException:
        raise
    except Exception:
        return


@router.post("/public/doc-feedback")
async def submit_doc_feedback(
    payload: dict = Body(...),
    request: Request = None,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=settings.USER_SESSION_COOKIE),
):
    """接口文档页的赞踩与意见。

    刻意不要求登录：文档对未登录用户也开放，强制实名会直接压掉反馈量。
    带了登录态就顺带记下 auth_id，方便需要时回访；解析失败也不拦——
    反馈本身比「是谁提的」重要得多。
    """
    vote = (payload.get("vote") or "").strip().lower()
    if vote not in ("up", "down"):
        raise HTTPException(status_code=400, detail="vote 只能是 up 或 down")

    await _check_feedback_rate(_client_ip(request))

    auth_id = None
    claims = optional_user_session(db, authorization, session_cookie)
    if claims:
        auth_id = claims.get("sub")

    comment = (payload.get("comment") or "").strip() or None
    row = DocFeedbackORM(
        section=(payload.get("section") or "").strip()[:200] or None,
        vote=vote,
        comment=comment[:2000] if comment else None,
        auth_id=auth_id,
        lang=(payload.get("lang") or "").strip()[:16] or None,
    )
    db.add(row)
    db.commit()
    return {"ok": True}
