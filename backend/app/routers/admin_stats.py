"""管理后台统计与调用记录（对齐 llm_platform admin_stats）。"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.csv_export import csv_download
from app.platform_stats_baseline import get_initial_calls, get_initial_cost, get_initial_tokens
from app.platform_time import now_local, sql_tz_param
from app.database import get_db
from app.models import ApiKeyORM, ApplicationORM, ModelRegistryORM, SceneTypeORM, UsageLogORM, UserORM
from app.infra_fleet import build_fleet
from app.stats_breakdown import query_summary_breakdown
from app.platform_usage_stats import (
    build_context_length,
    build_models_dist,
    build_projects_dist,
    build_scenes_dist,
    build_summary,
    build_timeseries,
    build_tool_calls,
    parse_anchor_date,
)
from app.heatmap_stats import build_cumulative_heatmap, build_month_heatmap, build_week_heatmap

router = APIRouter(prefix="/admin", tags=["admin-stats"])


# 日及以上粒度走 usage_daily_summary（day 列即平台时区日期）；跨时区换算只在
# 与 now() 比较时需要，统一用 sql_tz_param() 注入 :tz。见 app/platform_time.py。


@router.get("/stats/daily")
def admin_stats_daily(days: int = 30, db: Session = Depends(get_db), _=Depends(require_admin)):
    # 与 overview 同口径：走永久汇总表，usage_logs 清理后趋势图不失真
    days = max(1, min(days, 365))
    rows = db.execute(text("""
        SELECT to_char(day, 'YYYY-MM-DD') AS day,
               SUM(calls) AS calls,
               SUM(total_tokens) AS tokens
        FROM usage_daily_summary
        WHERE day >= date((now() AT TIME ZONE :tz)) - CAST(:interval AS INTERVAL)
        GROUP BY day
        ORDER BY day
    """), {"interval": f"{days} days", **sql_tz_param()}).fetchall()
    return [{"day": r[0], "calls": r[1], "tokens": r[2] or 0} for r in rows]


@router.get("/stats/monthly")
def admin_stats_monthly(year: Optional[int] = None, db: Session = Depends(get_db), _=Depends(require_admin)):
    year = year or now_local().year
    rows = db.execute(text("""
        SELECT to_char(day, 'MM') AS month,
               SUM(calls) AS calls,
               SUM(total_tokens) AS tokens
        FROM usage_daily_summary
        WHERE to_char(day, 'YYYY') = :year
        GROUP BY month
        ORDER BY month
    """), {"year": str(year)}).fetchall()
    return [{"month": int(r[0]), "calls": r[1], "tokens": r[2] or 0} for r in rows]


@router.get("/stats/by_model")
def admin_stats_by_model(days: int = 30, db: Session = Depends(get_db), _=Depends(require_admin)):
    days = max(1, min(days, 180))
    return build_models_dist(db, days=days)


@router.get("/stats/by_project")
def admin_stats_by_project(days: int = 30, db: Session = Depends(get_db), _=Depends(require_admin)):
    days = max(1, min(days, 180))
    return build_projects_dist(db, days=days)


@router.get("/stats/by_scene")
def admin_stats_by_scene(days: int = 30, db: Session = Depends(get_db), _=Depends(require_admin)):
    days = max(1, min(days, 180))
    return build_scenes_dist(db, days=days)


@router.get("/stats/by_user")
def admin_stats_by_user(days: int = 30, db: Session = Depends(get_db), _=Depends(require_admin)):
    """按账号 ID聚合调用量；姓名/部门以 users 表（真实用户）为准，
    api_keys.name 是 Key（项目）名，不能当用户名展示。未注册账号回退到 Key 名。"""
    days = max(1, min(days, 365))
    # 2026-08 修复：改走永久汇总表 usage_daily_summary——usage_logs 按 90 天保留期
    # 清理，此前 by_user 查 90 天以上窗口会静默失真/变空，与模型/项目/场景维度不一致。
    rows = db.execute(text("""
        SELECT k.auth_id,
               SUM(s.calls) AS calls,
               SUM(COALESCE(s.total_tokens, 0)) AS tokens
        FROM usage_daily_summary s
        JOIN api_keys k ON s.api_key_id = k.id
        WHERE s.day >= date((now() AT TIME ZONE :tz)) - CAST(:interval AS INTERVAL)
        GROUP BY k.auth_id
        ORDER BY calls DESC
        LIMIT 30
    """), {"interval": f"{days} days", **sql_tz_param()}).fetchall()
    auth_ids = [r[0] for r in rows if r[0]]
    user_map = {}
    key_name_map = {}
    if auth_ids:
        user_map = {
            u.auth_id: (u.name, u.department or "")
            for u in db.query(UserORM).filter(UserORM.auth_id.in_(auth_ids)).all()
        }
        # 回退用：同一 auth_id 下任一把 Key 的名称/部门
        for k in db.query(ApiKeyORM).filter(ApiKeyORM.auth_id.in_(auth_ids)).all():
            key_name_map.setdefault(k.auth_id, (k.name or "", k.department or ""))
    result = []
    for r in rows:
        name, dept = user_map.get(r[0]) or key_name_map.get(r[0]) or ("", "")
        result.append({"auth_id": r[0], "name": name, "department": dept, "calls": r[1], "tokens": r[2] or 0})
    return result


@router.get("/stats/breakdown")
def admin_stats_breakdown(
    dimension: str = Query(...),
    days: int = 30,
    search: Optional[str] = None,
    sort_field: str = "calls",
    sort_dir: str = "desc",
    limit: int = 50,
    offset: int = 0,
    filter_dimension: Optional[str] = None,
    filter_value: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """「查看全部」抽屉：永久汇总表口径，支持 model/scene 等维度交叉筛选。"""
    from app.stats_breakdown import _SUMMARY_DIMENSIONS

    if dimension not in _SUMMARY_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的维度: {dimension}")
    days = max(1, min(days, 365))
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    result = query_summary_breakdown(
        db, dimension=dimension, days=days, search=search,
        sort_field=sort_field, sort_dir=sort_dir, limit=limit, offset=offset,
        filter_dimension=filter_dimension, filter_value=filter_value,
    )

    if dimension == "user":
        auth_ids = [r["label"] for r in result["rows"] if r["label"]]
        user_map = {}
        key_name_map = {}
        if auth_ids:
            user_map = {
                u.auth_id: (u.name, u.department or "")
                for u in db.query(UserORM).filter(UserORM.auth_id.in_(auth_ids)).all()
            }
            for k in db.query(ApiKeyORM).filter(ApiKeyORM.auth_id.in_(auth_ids)).all():
                key_name_map.setdefault(k.auth_id, (k.name or "", k.department or ""))
        for row in result["rows"]:
            name, dept = user_map.get(row["label"]) or key_name_map.get(row["label"]) or ("", "")
            row["display_label"] = name or row["label"]
            row["department"] = dept
    elif dimension == "model":
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


@router.get("/stats/overview")
def admin_stats_overview(db: Session = Depends(get_db), _=Depends(require_admin)):
    # 日及以上粒度一律走永久汇总表 usage_daily_summary（写入时原子递增，实时性不损失），
    # 与公开接口 /public/platform-status 口径一致；usage_logs 明细会被定期清理，
    # 直接从明细 COUNT 的"累计/本月"会随清理逐渐失真。分钟级实时段仍走明细表。
    row = db.execute(text("""
        SELECT
            COALESCE(SUM(calls) FILTER (WHERE day = date((now() AT TIME ZONE :tz))), 0) AS today_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE day = date((now() AT TIME ZONE :tz))), 0) AS today_tokens,
            COALESCE(SUM(calls) FILTER (WHERE to_char(day, 'YYYY-MM') = to_char((now() AT TIME ZONE :tz), 'YYYY-MM')), 0) AS month_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE to_char(day, 'YYYY-MM') = to_char((now() AT TIME ZONE :tz), 'YYYY-MM')), 0) AS month_tokens,
            COALESCE(SUM(calls) FILTER (WHERE to_char(day, 'YYYY') = to_char((now() AT TIME ZONE :tz), 'YYYY')), 0) AS year_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE to_char(day, 'YYYY') = to_char((now() AT TIME ZONE :tz), 'YYYY')), 0) AS year_tokens,
            COALESCE(SUM(calls), 0) AS total_calls,
            COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM usage_daily_summary
    """), sql_tz_param()).fetchone()

    realtime_row = db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '5 minutes') AS r5_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= now() - INTERVAL '5 minutes'), 0) AS r5_tokens,
            COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '1 hour') AS r1h_calls,
            COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= now() - INTERVAL '1 hour'), 0) AS r1h_tokens
        FROM usage_logs
    """)).fetchone()

    model_5min_rows = db.execute(text("""
        SELECT model_id, COUNT(*) AS cnt,
               SUM(COALESCE(total_tokens, 0)) AS tok,
               SUM(COALESCE(prompt_tokens, 0)) AS prompt_tok,
               SUM(COALESCE(cache_hit_tokens, 0)) AS cache_hit
        FROM usage_logs
        WHERE created_at >= now() - INTERVAL '5 minutes'
        GROUP BY model_id
        ORDER BY cnt DESC
        LIMIT 10
    """)).fetchall()
    model_5min = [{
        "modelId": r[0],
        "calls": int(r[1]),
        "tokens": int(r[2] or 0),
        "cache_hit_rate": round((r[4] / r[3] * 100) if r[3] else 0, 1),
    } for r in model_5min_rows]

    cache_row = db.execute(text("""
        SELECT COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(cache_hit_tokens), 0)
        FROM usage_daily_summary
    """)).fetchone()
    global_cache_hit_rate = round((cache_row[1] / cache_row[0] * 100) if cache_row[0] else 0, 1)

    # Token 成本估算：日汇总 ×（管理员定价优先，否则业界刊例兜底），单位 ¥
    from app.industry_pricing import estimate_tokens_cost

    cost_rows = db.execute(text("""
        SELECT s.model_id,
               COALESCE(SUM(s.prompt_tokens), 0),
               COALESCE(SUM(s.completion_tokens), 0)
        FROM usage_daily_summary s
        GROUP BY s.model_id
    """)).fetchall()
    pricing_by_id = {
        m.id: m for m in db.query(ModelRegistryORM).all()
    }
    live_estimated_token_cost = 0.0
    for model_id, prompt_tok, completion_tok in cost_rows:
        live_estimated_token_cost += estimate_tokens_cost(
            int(prompt_tok or 0),
            int(completion_tok or 0),
            model=pricing_by_id.get(model_id),
            model_id=model_id,
        )
    initial_cost = get_initial_cost(db)
    estimated_token_cost = round(live_estimated_token_cost + initial_cost, 4)

    active_keys = db.query(ApiKeyORM).filter(
        ApiKeyORM.revoked.is_(False), ApiKeyORM.deleted_at.is_(None),
    ).count()
    online_models = db.query(ModelRegistryORM).filter(ModelRegistryORM.status == "online").count()
    pending_apps = db.query(ApplicationORM).filter(ApplicationORM.status == "pending").count()

    live_total_calls = int(row[6] or 0)
    live_total_tokens = int(row[7] or 0)
    initial_calls = get_initial_calls(db)
    initial_tokens = get_initial_tokens(db)

    return {
        "today": {"calls": int(row[0] or 0), "tokens": int(row[1] or 0)},
        "month": {"calls": int(row[2] or 0), "tokens": int(row[3] or 0)},
        "year": {"calls": int(row[4] or 0), "tokens": int(row[5] or 0)},
        "total": {"calls": live_total_calls, "tokens": live_total_tokens},
        "cumulative": {
            "calls": live_total_calls + initial_calls,
            "tokens": live_total_tokens + initial_tokens,
            "live_calls": live_total_calls,
            "live_tokens": live_total_tokens,
            "initial_calls": initial_calls,
            "initial_tokens": initial_tokens,
            "initial_cost": round(initial_cost, 4),
            "live_estimated_token_cost": round(live_estimated_token_cost, 4),
        },
        "cache_hit_rate": global_cache_hit_rate,
        "estimated_token_cost": estimated_token_cost,
        "recent_5min": {"calls": int(realtime_row[0] or 0), "tokens": int(realtime_row[1] or 0), "byModel": model_5min},
        "recent_1h": {"calls": int(realtime_row[2] or 0), "tokens": int(realtime_row[3] or 0)},
        "active_keys": active_keys,
        "online_models": online_models,
        "pending_apps": pending_apps,
    }


@router.get("/infra/fleet")
def admin_infra_fleet(db: Session = Depends(get_db), _=Depends(require_admin)):
    """登记算力摘要；空库才返回明确标记的 synthetic demo fixture。"""
    return build_fleet(db)


def _admin_log_conds(
    model_id: str | None,
    date_from: str | None,
    date_to: str | None,
    key_name: str | None,
    status_code: str | None,
    request_id: str | None,
    token_min: str | None,
    token_max: str | None,
    ttft_min: str | None,
    ttft_max: str | None,
    duration_min: str | None,
    duration_max: str | None,
    cache_filter: str | None,
    department: str | None,
    db: Session,
):
    conds = []

    def _parse_int(s):
        try:
            return int(s)
        except (ValueError, TypeError):
            return None

    def _parse_dt(s: str) -> datetime | None:
        """日期参数须解析为 datetime 再与 timestamp 列比较——直接传字符串在
        Postgres 下会报 operator does not exist: timestamp >= character varying。"""
        try:
            return datetime.fromisoformat(s.replace("T", " "))
        except (ValueError, TypeError):
            return None

    if request_id:
        conds.append(UsageLogORM.request_id.ilike(f"%{request_id.strip()}%"))
    if model_id:
        for m in [x.strip() for x in model_id.split(",") if x.strip()]:
            conds.append(UsageLogORM.model_id.contains(m))
    if date_from:
        df = _parse_dt(date_from)
        if df is not None:
            conds.append(UsageLogORM.created_at >= df)
    if date_to:
        dt = _parse_dt(date_to)
        if dt is not None:
            if len(date_to.strip()) <= 10:
                dt = dt.replace(hour=23, minute=59, second=59)
            conds.append(UsageLogORM.created_at <= dt)
    if status_code:
        if status_code.endswith("xx"):
            conds.append(UsageLogORM.status_code.like(f"{status_code[0]}__"))
        elif status_code == "429":
            conds.append(UsageLogORM.status_code == "429")
        else:
            conds.append(UsageLogORM.status_code == status_code)
    if key_name:
        names = [x.strip() for x in key_name.split(",") if x.strip()]
        if names:
            key_q = db.query(ApiKeyORM.id).filter(ApiKeyORM.name.in_(names))
            conds.append(UsageLogORM.api_key_id.in_(key_q.subquery()))
    if department:
        depts = [x.strip() for x in department.split(",") if x.strip()]
        if depts:
            dept_keys = db.query(ApiKeyORM.id).filter(or_(*[ApiKeyORM.department.ilike(f"%{d}%") for d in depts]))
            conds.append(UsageLogORM.api_key_id.in_(dept_keys.subquery()))
    tv_min = _parse_int(token_min)
    tv_max = _parse_int(token_max)
    if tv_min is not None:
        conds.append(UsageLogORM.total_tokens >= tv_min)
    if tv_max is not None:
        conds.append(UsageLogORM.total_tokens <= tv_max)
    tt_min = _parse_int(ttft_min)
    tt_max = _parse_int(ttft_max)
    if tt_min is not None:
        conds.append(UsageLogORM.latency_ms >= tt_min)
    if tt_max is not None:
        conds.append(UsageLogORM.latency_ms <= tt_max)
    du_min = _parse_int(duration_min)
    du_max = _parse_int(duration_max)
    if du_min is not None:
        conds.append(UsageLogORM.total_duration_ms >= du_min)
    if du_max is not None:
        conds.append(UsageLogORM.total_duration_ms <= du_max)
    if cache_filter == "hit":
        conds.append(UsageLogORM.cache_hit_tokens > 0)
    elif cache_filter == "miss":
        conds.append((UsageLogORM.cache_hit_tokens == 0) | UsageLogORM.cache_hit_tokens.is_(None))
        conds.append(UsageLogORM.cache_miss_tokens > 0)
    return conds


def _admin_log_order(sort_field: str | None, sort_dir: str | None):
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


def _admin_usage_key_map(db: Session, rows: list[UsageLogORM]) -> dict:
    key_ids = {row.api_key_id for row in rows}
    if not key_ids:
        return {}
    keys = db.query(ApiKeyORM).filter(ApiKeyORM.id.in_(key_ids)).all()
    return {
        key.id: {
            "name": key.name or key.id[:8],
            "department": key.department or "",
            "auth_id": key.auth_id or "",
        }
        for key in keys
    }


def _admin_usage_record(row: UsageLogORM, key_map: dict) -> dict:
    code = row.status_code or "200"
    key = key_map.get(row.api_key_id, {})
    return {
        "id": row.id,
        "request_id": row.request_id,
        "model_id": row.model_id,
        "api_key_id": row.api_key_id,
        "key_name": key.get("name", row.api_key_id),
        "department": key.get("department", ""),
        "auth_id": key.get("auth_id", ""),
        "prompt_tokens": row.prompt_tokens or 0,
        "completion_tokens": row.completion_tokens or 0,
        "total_tokens": row.total_tokens or 0,
        "cache_hit_tokens": row.cache_hit_tokens or 0,
        "cache_miss_tokens": row.cache_miss_tokens or 0,
        "cache_write_tokens": row.cache_write_tokens or 0,
        "latency_ms": row.latency_ms or 0,
        "total_duration_ms": row.total_duration_ms or 0,
        "estimated_cost": float(row.estimated_cost) if row.estimated_cost is not None else 0.0,
        "usage_estimated": bool(row.usage_estimated),
        "stream": bool(row.stream),
        "status_code": int(code) if code.isdigit() else 0,
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "error_detail": row.error_detail or "",
        "response_preview": row.response_preview or "",
    }


def _admin_usage_csv_row(row: UsageLogORM, key_map: dict) -> list:
    key = key_map.get(row.api_key_id, {})
    return [
        row.created_at.strftime("%Y-%m-%d %H:%M:%S") if row.created_at else "",
        row.model_id or "",
        key.get("name", row.api_key_id),
        key.get("department", ""),
        row.request_id or "",
        row.prompt_tokens or 0,
        row.completion_tokens or 0,
        row.total_tokens or 0,
        row.cache_hit_tokens or 0,
        row.cache_miss_tokens or 0,
        row.latency_ms or 0,
        row.total_duration_ms or 0,
        round(float(row.estimated_cost), 6) if row.estimated_cost is not None else 0,
        row.status_code or "",
        "是" if row.stream else "否",
        "是" if row.usage_estimated else "否",
        (row.error_detail or "").replace("\n", " ").replace("\r", " "),
    ]


def _export_admin_usage(db: Session, conds: list, order_col, export_limit: int):
    rows = db.execute(
        select(UsageLogORM).where(*conds).order_by(order_col).limit(min(max(export_limit, 1), 50000))
    ).scalars().all()
    key_map = _admin_usage_key_map(db, rows)
    return csv_download(
        [
            "时间", "模型", "API Key", "部门", "Request ID",
            "Prompt Tokens", "Completion Tokens", "总Token",
            "缓存命中Token", "缓存未命中Token",
            "TTFT(ms)", "整体耗时(ms)", "预估费用",
            "状态码", "流式", "Token为估算值", "错误信息",
        ],
        [_admin_usage_csv_row(row, key_map) for row in rows],
        f"admin-usage-{now_local().strftime('%Y-%m-%d')}.csv",
    )


def _admin_usage_stats(db: Session, conds: list, total: int) -> dict:
    empty = {
        "total": total, "success_count": 0, "success_rate": 0.0,
        "avg_latency_ms": None, "p95_latency_ms": None,
        "avg_duration_ms": None, "p95_duration_ms": None,
        "cache_hit_tokens": 0, "cache_miss_tokens": 0, "cache_hit_rate": None,
    }
    if total <= 0:
        return empty
    success = db.execute(
        select(func.count()).select_from(UsageLogORM).where(*conds, UsageLogORM.status_code.like("2%"))
    ).scalar() or 0
    latency = db.execute(
        select(
            func.avg(UsageLogORM.latency_ms),
            func.percentile_cont(0.95).within_group(UsageLogORM.latency_ms),
        ).where(*conds, UsageLogORM.latency_ms.isnot(None), UsageLogORM.latency_ms > 0)
    ).one()
    duration = db.execute(
        select(
            func.avg(UsageLogORM.total_duration_ms),
            func.percentile_cont(0.95).within_group(UsageLogORM.total_duration_ms),
        ).where(*conds, UsageLogORM.total_duration_ms.isnot(None), UsageLogORM.total_duration_ms > 0)
    ).one()
    cache_hit, cache_miss = db.execute(
        select(
            func.coalesce(func.sum(UsageLogORM.cache_hit_tokens), 0),
            func.coalesce(func.sum(UsageLogORM.cache_miss_tokens), 0),
        ).where(*conds)
    ).one()
    cache_hit, cache_miss = int(cache_hit or 0), int(cache_miss or 0)
    cache_total = cache_hit + cache_miss
    total_cost = db.execute(
        select(func.coalesce(func.sum(UsageLogORM.estimated_cost), 0)).where(*conds)
    ).scalar() or 0
    return {
        "total": total, "success_count": success,
        "success_rate": round(success / total * 100, 1),
        "avg_latency_ms": round(latency[0]) if latency[0] is not None else None,
        "p95_latency_ms": round(latency[1]) if latency[1] is not None else None,
        "avg_duration_ms": round(duration[0]) if duration[0] is not None else None,
        "p95_duration_ms": round(duration[1]) if duration[1] is not None else None,
        "cache_hit_tokens": cache_hit, "cache_miss_tokens": cache_miss,
        "cache_hit_rate": round(cache_hit / cache_total * 100, 1) if cache_total else None,
        "total_cost": round(float(total_cost), 6),
    }


def _admin_usage_facets(db: Session, conds: list) -> dict:
    models = db.execute(
        select(UsageLogORM.model_id).where(*conds).distinct().limit(1000)
    ).scalars().all()
    departments = db.execute(
        select(ApiKeyORM.department).join(UsageLogORM, UsageLogORM.api_key_id == ApiKeyORM.id)
        .where(*conds).distinct().limit(200)
    ).scalars().all()
    key_names = db.execute(
        select(ApiKeyORM.name).join(UsageLogORM, UsageLogORM.api_key_id == ApiKeyORM.id)
        .where(*conds).distinct().limit(500)
    ).scalars().all()
    return {
        "unique_models": sorted({value for value in models if value}),
        "unique_departments": sorted({value for value in departments if value}),
        "unique_key_names": sorted({value for value in key_names if value}),
    }


def _admin_usage_maxima(db: Session) -> dict:
    return {
        "max_ttft_ms": int(db.execute(select(func.max(UsageLogORM.latency_ms))).scalar() or 0),
        "max_duration_ms": int(db.execute(select(func.max(UsageLogORM.total_duration_ms))).scalar() or 0),
        "max_total_tokens": int(db.execute(select(func.max(UsageLogORM.total_tokens))).scalar() or 0),
    }


@router.get("/usage")
def list_usage(
    limit: int = 200,
    offset: int = 0,
    model_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    key_name: Optional[str] = None,
    status_code: Optional[str] = None,
    request_id: Optional[str] = None,
    token_min: Optional[str] = None,
    token_max: Optional[str] = None,
    ttft_min: Optional[str] = None,
    ttft_max: Optional[str] = None,
    duration_min: Optional[str] = None,
    duration_max: Optional[str] = None,
    cache_filter: Optional[str] = None,
    sort_field: Optional[str] = None,
    sort_dir: Optional[str] = None,
    department: Optional[str] = None,
    export: Optional[str] = None,
    export_limit: int = 10000,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    conds = _admin_log_conds(
        model_id, date_from, date_to, key_name, status_code, request_id,
        token_min, token_max, ttft_min, ttft_max, duration_min, duration_max,
        cache_filter, department, db,
    )

    order_col = _admin_log_order(sort_field, sort_dir)

    if export == "csv":
        return _export_admin_usage(db, conds, order_col, export_limit)

    total_q = select(func.count()).select_from(UsageLogORM)
    if conds:
        total_q = total_q.where(*conds)
    total = db.execute(total_q).scalar() or 0

    rows = db.execute(
        select(UsageLogORM).where(*conds).order_by(order_col).offset(offset).limit(min(limit, 200))
    ).scalars().all()
    key_map = _admin_usage_key_map(db, rows)
    stats = _admin_usage_stats(db, conds, total)

    return {
        "total": total,
        "records": [_admin_usage_record(row, key_map) for row in rows],
        "stats": stats,
        **_admin_usage_facets(db, conds),
        **_admin_usage_maxima(db),
    }


# ── Usage 看板同源接口（全平台聚合，永久汇总表 + rollup）────────────────────────

@router.get("/stats/summary")
def admin_stats_summary(
    year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """看板年度/累计 KPI。累计口径与首页一致：日汇总 + 历史基线。"""
    y = year or now_local().year
    summary = build_summary(db, year=y)
    initial_calls = get_initial_calls(db)
    initial_tokens = get_initial_tokens(db)
    summary["live_all_time_calls"] = summary["all_time_calls"]
    summary["live_all_time_tokens"] = summary["all_time_tokens"]
    summary["initial_calls"] = initial_calls
    summary["initial_tokens"] = initial_tokens
    summary["all_time_calls"] = summary["all_time_calls"] + initial_calls
    summary["all_time_tokens"] = summary["all_time_tokens"] + initial_tokens
    return summary


@router.get("/stats/timeseries")
def admin_stats_timeseries(
    days: int = Query(default=30, ge=1, le=180),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    return build_timeseries(db, days=days)


@router.get("/stats/health")
def admin_stats_health(
    days: int = Query(default=30, ge=1, le=180),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """看板「调用健康度」轻量接口：只算成功率与延迟，不扫日志列表。

    旧路径复用 GET /admin/usage（含 percentile ×2、distinct、分页），在明细量大
    且与其它看板请求并发时容易超时；前端失败被静默吞掉后 KPI 一直显示「—」。
    """
    from app import platform_time

    since_utc = platform_time.to_utc_naive(platform_time.now_local() - timedelta(days=days))
    row = db.execute(
        text("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status_code LIKE '2%') AS success,
                AVG(latency_ms) FILTER (WHERE latency_ms > 0) AS avg_latency,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                    FILTER (WHERE latency_ms > 0) AS p95_latency,
                AVG(total_duration_ms) FILTER (WHERE total_duration_ms > 0) AS avg_duration,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms)
                    FILTER (WHERE total_duration_ms > 0) AS p95_duration,
                COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit,
                COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss
            FROM usage_logs
            WHERE created_at >= :since
        """),
        {"since": since_utc},
    ).one()
    total = int(row[0] or 0)
    success = int(row[1] or 0)
    cache_hit = int(row[6] or 0)
    cache_miss = int(row[7] or 0)
    cache_total = cache_hit + cache_miss
    return {
        "total": total,
        "success_count": success,
        "success_rate": round(success / total * 100, 1) if total else 0.0,
        "avg_latency_ms": round(row[2]) if row[2] is not None else None,
        "p95_latency_ms": round(row[3]) if row[3] is not None else None,
        "avg_duration_ms": round(row[4]) if row[4] is not None else None,
        "p95_duration_ms": round(row[5]) if row[5] is not None else None,
        "cache_hit_tokens": cache_hit,
        "cache_miss_tokens": cache_miss,
        "cache_hit_rate": round(cache_hit / cache_total * 100, 1) if cache_total > 0 else None,
        "days": days,
    }


@router.get("/stats/tool-calls")
def admin_stats_tool_calls(
    days: int = Query(default=30, ge=1, le=180),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    return build_tool_calls(db, key_ids=None, days=days)


@router.get("/stats/context-length")
def admin_stats_context_length(
    days: int = Query(default=30, ge=1, le=180),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    return build_context_length(db, key_ids=None, days=days)


@router.get("/stats/heatmap/week")
def admin_stats_heatmap_week(
    mode: str = Query(default="week"),
    date: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """全平台调用热力图，契约与 /user/stats/heatmap/week 一致。"""
    if mode not in ("week", "month", "cumulative"):
        raise HTTPException(status_code=400, detail="mode 须为 week、month 或 cumulative")
    anchor = parse_anchor_date(date)
    if mode == "cumulative":
        return build_cumulative_heatmap(db, key_ids=None)
    if mode == "month":
        return build_month_heatmap(db, anchor=anchor, key_ids=None)
    return build_week_heatmap(db, anchor=anchor, key_ids=None)


@router.get("/usage/stream")
async def admin_usage_stream(
    since: float | None = Query(default=None),
    _=Depends(require_admin),
):
    """管理员端 SSE 实时日志流（全量；无部门筛选，便于大屏/排障）。"""
    import asyncio as _asyncio
    import json as _json
    from fastapi.responses import StreamingResponse
    from app.log_stream import log_stream_hub

    async def _gen():
        try:
            yield ": connected\n\n"
            async for rec in log_stream_hub.subscribe(since_ts=since):
                yield f"data: {_json.dumps(rec, ensure_ascii=False)}\n\n"
        except _asyncio.CancelledError:
            return

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
