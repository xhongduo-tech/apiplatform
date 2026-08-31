"""全平台用量统计（admin 看板与 user 看板共用聚合逻辑）。"""
from __future__ import annotations

from datetime import date as date_type, timedelta

from sqlalchemy import extract, func, select
from sqlalchemy.dialects.postgresql import array as pg_array
from sqlalchemy.orm import Session

from app import platform_time
from app.models import ApiKeyORM, UsageContextBucketDailyORM, UsageDailySummaryORM, UsageLogORM, UsageRequestProfileORM
from app.session_stats import (
    CONTEXT_LENGTH_LABELS,
    TOOL_CALL_BUCKETS,
    build_tool_call_distribution,
    empty_context_buckets,
)

# 与 user._CONTEXT_BUCKETS 一致
_CONTEXT_BUCKETS: list[tuple[str, int | None]] = [
    ("<1k", 1_000),
    ("1k–2k", 2_000),
    ("2k–4k", 4_000),
    ("4k–8k", 8_000),
    ("8k–16k", 16_000),
    ("16k–32k", 32_000),
    ("32k–64k", 64_000),
    ("64k–128k", 128_000),
    ("128k–256k", 256_000),
    ("256k–512k", 512_000),
    ("512k–1m", 1_000_000),
    ("1m+", None),
]


def all_key_ids(db: Session) -> list[str]:
    return list(db.execute(select(ApiKeyORM.id)).scalars().all())


def build_summary(db: Session, *, year: int) -> dict:
    _month_expr = extract("month", UsageDailySummaryORM.day)
    rows = db.execute(
        select(
            _month_expr.label("m"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .where(extract("year", UsageDailySummaryORM.day) == year)
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
    ).one()
    return {
        "year": year,
        "monthly": monthly,
        "total_calls": sum(m["calls"] for m in monthly),
        "total_tokens": sum(m["tokens"] for m in monthly),
        "all_time_calls": int(all_row[0]),
        "all_time_tokens": int(all_row[1]),
    }


def build_timeseries(db: Session, *, days: int) -> dict:
    since_day = platform_time.today_local() - timedelta(days=days - 1)
    rows = db.execute(
        select(
            UsageDailySummaryORM.day.label("d"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.cache_hit_tokens), 0).label("hit"),
            func.coalesce(func.sum(UsageDailySummaryORM.prompt_tokens), 0).label("prompt"),
            func.coalesce(func.sum(UsageDailySummaryORM.completion_tokens), 0).label("output"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("total"),
        )
        .where(UsageDailySummaryORM.day >= since_day)
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


def build_models_dist(db: Session, *, days: int) -> list[dict]:
    since_day = platform_time.today_local() - timedelta(days=days - 1)
    rows = db.execute(
        select(
            UsageDailySummaryORM.model_id.label("model_id"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .where(UsageDailySummaryORM.day >= since_day)
        .group_by(UsageDailySummaryORM.model_id)
        .order_by(func.sum(UsageDailySummaryORM.calls).desc())
    ).all()
    return [{"model_id": r.model_id, "calls": int(r.calls), "tokens": int(r.tokens)} for r in rows]


def build_projects_dist(db: Session, *, days: int) -> list[dict]:
    since_day = platform_time.today_local() - timedelta(days=days - 1)
    rows = db.execute(
        select(
            ApiKeyORM.project_name.label("project"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .join(UsageDailySummaryORM, UsageDailySummaryORM.api_key_id == ApiKeyORM.id)
        .where(UsageDailySummaryORM.day >= since_day)
        .group_by(ApiKeyORM.project_name)
        .order_by(func.sum(UsageDailySummaryORM.calls).desc())
    ).all()
    return [
        {"project": r.project or "（未命名项目）", "calls": int(r.calls), "tokens": int(r.tokens)}
        for r in rows
    ]


def build_scenes_dist(db: Session, *, days: int, key_ids: list[str] | None = None) -> list[dict]:
    """按真实业务场景（api_keys.project_name）聚合，按调用量降序。

    看板「场景分布」展示的是具体项目/场景名 Top N，而非 scene_types 五类分类；
    公开状态页仍按 scene_type 聚合（见 public.platform_status）。
    """
    since_day = platform_time.today_local() - timedelta(days=days - 1)
    query = (
        select(
            ApiKeyORM.project_name.label("scene"),
            func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("calls"),
            func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0).label("tokens"),
        )
        .join(UsageDailySummaryORM, UsageDailySummaryORM.api_key_id == ApiKeyORM.id)
        .where(UsageDailySummaryORM.day >= since_day)
    )
    if key_ids is not None:
        query = query.where(UsageDailySummaryORM.api_key_id.in_(key_ids))
    rows = db.execute(
        query.group_by(ApiKeyORM.project_name).order_by(func.sum(UsageDailySummaryORM.calls).desc())
    ).all()
    return [
        {
            "scene": r.scene or "unnamed",
            "label": r.scene or "（未命名项目）",
            "calls": int(r.calls),
            "tokens": int(r.tokens),
        }
        for r in rows
    ]


def build_context_length(db: Session, *, key_ids: list[str] | None, days: int) -> dict:
    if key_ids is not None and not key_ids:
        return {
            "buckets": empty_context_buckets(), "total": 0, "avg": 0,
            "p50": 0, "p90": 0, "p99": 0, "max": 0, "min": 0, "days": days,
        }

    since_day = platform_time.today_local() - timedelta(days=days - 1)
    since_utc = platform_time.to_utc_naive(platform_time.now_local() - timedelta(days=days))
    boundaries = [b for _, b in _CONTEXT_BUCKETS if b is not None]

    bkt_map: dict[int, int] = {}
    bucket_query = select(
        UsageContextBucketDailyORM.bucket,
        func.coalesce(func.sum(UsageContextBucketDailyORM.count), 0).label("cnt"),
    ).where(UsageContextBucketDailyORM.day >= since_day)
    if key_ids is not None:
        bucket_query = bucket_query.where(UsageContextBucketDailyORM.api_key_id.in_(key_ids))
    bucket_rows = db.execute(
        bucket_query.group_by(UsageContextBucketDailyORM.bucket)
    ).all()
    for r in bucket_rows:
        bkt_map[int(r.bucket)] = int(r.cnt)
    total = sum(bkt_map.values())

    stats_row = None
    for src in (UsageRequestProfileORM, UsageLogORM):
        conds = [src.created_at >= since_utc, src.prompt_tokens > 0]
        if key_ids is not None:
            conds.insert(0, src.api_key_id.in_(key_ids))
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
                # width_bucket 返回 1-based，-1 对齐运行时 context_bucket_index 的 0-based 桶
                bucket_expr = func.width_bucket(src.prompt_tokens, pg_array(boundaries)) - 1
                fb_rows = db.execute(
                    select(bucket_expr.label("bkt"), func.count().label("cnt"))
                    .where(*conds)
                    .group_by("bkt")
                ).all()
                bkt_map = {int(r.bkt): int(r.cnt) for r in fb_rows if r.bkt is not None}
                total = sum(bkt_map.values())
            break

    if total == 0:
        return {
            "buckets": empty_context_buckets(), "total": 0, "avg": 0,
            "p50": 0, "p90": 0, "p99": 0, "max": 0, "min": 0, "days": days,
        }

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

    return {
        "buckets": bucket_counts,
        "total": total,
        "avg": int(float(stats_row.avg or 0)) if stats_row else 0,
        "p50": _r(stats_row.p50) if stats_row else 0,
        "p90": _r(stats_row.p90) if stats_row else 0,
        "p99": _r(stats_row.p99) if stats_row else 0,
        "max": int(stats_row.mx or 0) if stats_row else 0,
        "min": int(stats_row.mn or 0) if stats_row else 0,
        "days": days,
    }


def build_tool_calls(db: Session, *, key_ids: list[str] | None, days: int) -> dict:
    if key_ids is not None and not key_ids:
        return {
            "buckets": [{"label": label, "count": 0, "share": 0.0} for label, _, _ in TOOL_CALL_BUCKETS],
            "total_sessions": 0,
            "days": days,
        }
    since_utc = platform_time.to_utc_naive(platform_time.now_local() - timedelta(days=days))
    result = build_tool_call_distribution(db, key_ids=key_ids, since_utc=since_utc)
    result["days"] = days
    return result


def parse_anchor_date(date_str: str | None) -> date_type:
    if date_str:
        try:
            return date_type.fromisoformat(date_str)
        except ValueError:
            pass
    return platform_time.today_local()
