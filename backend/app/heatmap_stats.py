"""调用热力图聚合：周（日×时）、月/累计（时段×日）。"""
from __future__ import annotations

from calendar import monthrange
from datetime import date as date_type, datetime, timedelta

from sqlalchemy import Date, cast, extract, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import UsageDailySummaryORM, UsageLogORM, UsageHourlySummaryORM
from app import platform_time

# 7 行时段带（与周视图 7 行等高，便于前端保持模块高度）
HOUR_BANDS: list[tuple[int, int]] = [
    (0, 2),
    (3, 5),
    (6, 8),
    (9, 11),
    (12, 14),
    (15, 17),
    (18, 23),
]


def hour_to_band(hour: int) -> int:
    for i, (lo, hi) in enumerate(HOUR_BANDS):
        if lo <= hour <= hi:
            return i
    return len(HOUR_BANDS) - 1


def _month_bounds(anchor: date_type) -> tuple[date_type, date_type]:
    last = monthrange(anchor.year, anchor.month)[1]
    return anchor.replace(day=1), anchor.replace(day=last)


def _date_span(start: date_type, end: date_type) -> list[date_type]:
    out: list[date_type] = []
    d = start
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out


def _pg_wd_to_mon0(dow_pg: int) -> int:
    return (dow_pg - 1) % 7


def build_week_heatmap(
    db: Session,
    *,
    anchor: date_type,
    key_ids: list[str] | None,
) -> dict:
    """7 行（周一~周日）× 24 列（小时），优先 usage_hourly_summary，回落 usage_logs。"""
    week_start = anchor - timedelta(days=anchor.weekday())
    week_end = week_start + timedelta(days=6)
    matrix = [[0] * 24 for _ in range(7)]
    total = 0

    if key_ids is not None and not key_ids:
        dates = [(week_start + timedelta(days=i)).isoformat() for i in range(7)]
        return {
            "mode": "week",
            "matrix": matrix,
            "dates": dates,
            "max": 0,
            "total": 0,
            "range_start": week_start.isoformat(),
            "range_end": week_end.isoformat(),
            "week_start": week_start.isoformat(),
            "week_end": week_end.isoformat(),
            "x_axis": "hour",
            "timezone": settings.PLATFORM_TIMEZONE,
        }

    # ── 永久小时汇总 ──
    q = (
        select(
            UsageHourlySummaryORM.day,
            UsageHourlySummaryORM.hour,
            func.sum(UsageHourlySummaryORM.calls).label("c"),
        )
        .where(
            UsageHourlySummaryORM.day >= week_start,
            UsageHourlySummaryORM.day <= week_end,
        )
        .group_by(UsageHourlySummaryORM.day, UsageHourlySummaryORM.hour)
    )
    if key_ids is not None:
        q = q.where(UsageHourlySummaryORM.api_key_id.in_(key_ids))
    for r in db.execute(q).all():
        d = r.day if isinstance(r.day, date_type) else date_type.fromisoformat(str(r.day))
        wd = d.weekday()
        hr = int(r.hour)
        c = int(r.c)
        matrix[wd][hr] += c
        total += c

    # ── 回落：汇总表未覆盖时读 usage_logs（兼容迁移前 / 回填缺口）──
    if total == 0 and (key_ids or key_ids is None):
        start_utc = platform_time.to_utc_naive(datetime.combine(week_start, datetime.min.time()))
        end_utc = platform_time.to_utc_naive(datetime.combine(week_end + timedelta(days=1), datetime.min.time()))
        local_col = platform_time.local_ts(UsageLogORM.created_at)
        qlog = select(
            extract("dow", local_col).label("wd"),
            extract("hour", local_col).label("hr"),
            func.count().label("c"),
        ).where(UsageLogORM.created_at >= start_utc, UsageLogORM.created_at < end_utc)
        if key_ids is not None:
            qlog = qlog.where(UsageLogORM.api_key_id.in_(key_ids))
        qlog = qlog.group_by("wd", "hr")
        for r in db.execute(qlog).all():
            wd = _pg_wd_to_mon0(int(r.wd))
            hr = int(r.hr)
            c = int(r.c)
            matrix[wd][hr] = c
            total += c

    mx = max((matrix[w][h] for w in range(7) for h in range(24)), default=0)
    dates = [(week_start + timedelta(days=i)).isoformat() for i in range(7)]
    return {
        "mode": "week",
        "matrix": matrix,
        "dates": dates,
        "max": mx,
        "total": total,
        "range_start": week_start.isoformat(),
        "range_end": week_end.isoformat(),
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "x_axis": "hour",
        "timezone": settings.PLATFORM_TIMEZONE,
    }


def _build_day_band_heatmap(
    db: Session,
    *,
    span_start: date_type,
    span_end: date_type,
    key_ids: list[str] | None,
    mode: str,
) -> dict:
    """7 行（时段带）× N 列（自然日）。明细窗口内走 usage_logs 按小时分桶；
    更早日期走 usage_daily_summary，整日落在中段行（仅日汇总）。"""
    dates = _date_span(span_start, span_end)
    n = len(dates)
    matrix = [[0] * n for _ in range(len(HOUR_BANDS))]
    daily_only: list[int] = []
    total = 0

    today = platform_time.today_local()
    log_cutoff = today - timedelta(days=max(settings.USAGE_LOG_RETENTION_DAYS, 0))
    day_index = {d: i for i, d in enumerate(dates)}

    # ── usage_hourly_summary + usage_logs 回落：按 (日, 小时) 聚合到时段带 ──
    log_start = max(span_start, log_cutoff)
    if log_start <= span_end and (key_ids or key_ids is None):
        hq = (
            select(
                UsageHourlySummaryORM.day,
                UsageHourlySummaryORM.hour,
                func.sum(UsageHourlySummaryORM.calls).label("c"),
            )
            .where(
                UsageHourlySummaryORM.day >= log_start,
                UsageHourlySummaryORM.day <= span_end,
            )
            .group_by(UsageHourlySummaryORM.day, UsageHourlySummaryORM.hour)
        )
        if key_ids is not None:
            if not key_ids:
                hq = None
            else:
                hq = hq.where(UsageHourlySummaryORM.api_key_id.in_(key_ids))
        hourly_total = 0
        if hq is not None:
            for r in db.execute(hq).all():
                d = r.day if isinstance(r.day, date_type) else date_type.fromisoformat(str(r.day))
                idx = day_index.get(d)
                if idx is None:
                    continue
                band = hour_to_band(int(r.hour))
                c = int(r.c)
                matrix[band][idx] += c
                total += c
                hourly_total += c

        # 汇总表为空时回落 usage_logs
        if hourly_total == 0:
            start_utc = platform_time.to_utc_naive(datetime.combine(log_start, datetime.min.time()))
            end_utc = platform_time.to_utc_naive(
                datetime.combine(span_end + timedelta(days=1), datetime.min.time())
            )
            local_col = platform_time.local_ts(UsageLogORM.created_at)
            day_expr = cast(local_col, Date)
            hr_expr = extract("hour", local_col)
            q = select(
                day_expr.label("d"),
                hr_expr.label("hr"),
                func.count().label("c"),
            ).where(UsageLogORM.created_at >= start_utc, UsageLogORM.created_at < end_utc)
            if key_ids is not None:
                if not key_ids:
                    pass
                else:
                    q = q.where(UsageLogORM.api_key_id.in_(key_ids))
            if key_ids is None or key_ids:
                q = q.group_by(day_expr, hr_expr)
                for r in db.execute(q).all():
                    d = r.d if isinstance(r.d, date_type) else date_type.fromisoformat(str(r.d))
                    idx = day_index.get(d)
                    if idx is None:
                        continue
                    band = hour_to_band(int(r.hr))
                    c = int(r.c)
                    matrix[band][idx] += c
                    total += c

    # ── usage_daily_summary：仅覆盖 log 窗口之前的日期 ──
    summary_end = min(span_end, log_cutoff - timedelta(days=1))
    if summary_end >= span_start and (key_ids or key_ids is None):
        q = (
            select(
                UsageDailySummaryORM.day.label("d"),
                func.coalesce(func.sum(UsageDailySummaryORM.calls), 0).label("c"),
            )
            .where(UsageDailySummaryORM.day >= span_start, UsageDailySummaryORM.day <= summary_end)
        )
        if key_ids is not None:
            if not key_ids:
                q = None
            else:
                q = q.where(UsageDailySummaryORM.api_key_id.in_(key_ids))
        if q is not None:
            q = q.group_by(UsageDailySummaryORM.day)
            mid_band = len(HOUR_BANDS) // 2
            for r in db.execute(q).all():
                d = r.d if isinstance(r.d, date_type) else date_type.fromisoformat(str(r.d))
                idx = day_index.get(d)
                if idx is None:
                    continue
                c = int(r.c)
                if c <= 0:
                    continue
                matrix[mid_band][idx] += c
                total += c
                if idx not in daily_only:
                    daily_only.append(idx)

    mx = max((matrix[r][c] for r in range(len(HOUR_BANDS)) for c in range(n)), default=0)
    return {
        "mode": mode,
        "matrix": matrix,
        "dates": [d.isoformat() for d in dates],
        "max": mx,
        "total": total,
        "range_start": span_start.isoformat(),
        "range_end": span_end.isoformat(),
        "week_start": None,
        "week_end": None,
        "x_axis": "day",
        "daily_only_cols": sorted(daily_only),
        "timezone": settings.PLATFORM_TIMEZONE,
    }


def build_month_heatmap(
    db: Session,
    *,
    anchor: date_type,
    key_ids: list[str] | None,
) -> dict:
    span_start, span_end = _month_bounds(anchor)
    return _build_day_band_heatmap(
        db, span_start=span_start, span_end=span_end, key_ids=key_ids, mode="month",
    )


def build_cumulative_heatmap(
    db: Session,
    *,
    key_ids: list[str] | None,
    max_days: int = 365,
) -> dict:
    """累计：从首条日汇总（或明细）到今天的全部自然日，列过多时截断为最近 max_days 天。"""
    today = platform_time.today_local()
    min_day: date_type | None = None

    if key_ids is not None:
        if not key_ids:
            return _build_day_band_heatmap(
                db, span_start=today, span_end=today, key_ids=key_ids, mode="cumulative",
            )
        min_day = db.execute(
            select(func.min(UsageDailySummaryORM.day)).where(
                UsageDailySummaryORM.api_key_id.in_(key_ids),
            )
        ).scalar()
    else:
        min_day = db.execute(select(func.min(UsageDailySummaryORM.day))).scalar()

    if min_day is None:
        min_day = today - timedelta(days=max(settings.USAGE_LOG_RETENTION_DAYS, 0))
    elif not isinstance(min_day, date_type):
        min_day = date_type.fromisoformat(str(min_day))

    span_start = min_day
    span_end = today
    if (span_end - span_start).days + 1 > max_days:
        span_start = span_end - timedelta(days=max_days - 1)

    return _build_day_band_heatmap(
        db, span_start=span_start, span_end=span_end, key_ids=key_ids, mode="cumulative",
    )
