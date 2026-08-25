"""运营巡检 / 报告引擎。

扫描 usage_logs，按模型 / 项目 / 状态 / 时段多维聚合，与上一周期环比，
识别异常（错误率、调用量突变、峰值时段、资源集中、时延偏高），产出结构化指标
与 Markdown 摘要，并幂等落库为 OpsReportORM。

支持日报、周报、月报、季报、年报与累计报告。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, cast, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.types import Date

from app import platform_time
from app.config import settings
from app.models import ApiKeyORM, ModelRegistryORM, OpsReportORM, UsageLogORM

log = logging.getLogger("apiplatform.ops_report")

_TOP_N = 20
REPORT_KINDS = ("daily", "weekly", "monthly", "quarterly", "yearly", "cumulative", "manual")


# ── 时区口径 ──────────────────────────────────────────────────────────────────
# 报告窗口（start / end）与所有标签一律是**平台本地**墙上时间（naive）：日报的
# "昨天"、月报的"上月 1 号"、"高峰时段 14:00" 都必须是运营看得懂的本地日历，
# 而不是 UTC。usage_logs.created_at 存的是 UTC naive，因此：
#   · 比较窗口 → 经 _window() 把本地边界转成 UTC 再比；
#   · 按小时/天分桶 → 用 platform_time.local_ts() 把列换算到本地再截取。
# 只有 generated_at 这类"事件发生时刻"仍记 UTC，与其它表的时间列保持一致。


def _now() -> datetime:
    """当前的平台本地墙上时间（naive）——窗口计算的基准。"""
    return platform_time.now_local()


def _utc_now() -> datetime:
    """UTC naive，用于 generated_at 等存储型时间戳。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _window(start: datetime, end: datetime) -> tuple:
    """把本地窗口 [start, end) 翻译成对 created_at（UTC naive）的过滤条件。"""
    return (
        UsageLogORM.created_at >= platform_time.to_utc_naive(start),
        UsageLogORM.created_at < platform_time.to_utc_naive(end),
    )


def _local_created():
    """created_at 换算到平台时区的墙上时间，供按小时/天分桶。"""
    return platform_time.local_ts(UsageLogORM.created_at)


def _pct(numer: float, denom: float) -> float:
    return round(numer / denom * 100, 1) if denom else 0.0


def _delta_pct(cur: float, prev: float) -> float | None:
    """环比变化百分比；上一周期为 0 时无法计算，返回 None。"""
    if not prev:
        return None
    return round((cur - prev) / prev * 100, 1)


# ── 单时间窗汇总 ──────────────────────────────────────────────────────────────
def _window_totals(db: Session, start: datetime, end: datetime) -> dict:
    success_expr = func.coalesce(
        func.sum(case((UsageLogORM.status_code.like("2%"), 1), else_=0)), 0
    )
    row = db.execute(
        select(
            func.count(),
            success_expr,
            func.coalesce(func.sum(UsageLogORM.prompt_tokens), 0),
            func.coalesce(func.sum(UsageLogORM.completion_tokens), 0),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0),
            func.coalesce(func.sum(UsageLogORM.estimated_cost), 0.0),
            func.avg(UsageLogORM.latency_ms),
            func.max(UsageLogORM.latency_ms),
        ).where(*_window(start, end))
    ).one()
    requests = int(row[0] or 0)
    success = int(row[1] or 0)
    errors = max(requests - success, 0)
    return {
        "requests": requests,
        "success": success,
        "errors": errors,
        "error_rate": round(errors / requests * 100, 2) if requests else 0.0,
        "prompt_tokens": int(row[2] or 0),
        "completion_tokens": int(row[3] or 0),
        "total_tokens": int(row[4] or 0),
        "cost": round(float(row[5] or 0.0), 4),
        "avg_latency_ms": int(row[6]) if row[6] is not None else None,
        "max_latency_ms": int(row[7]) if row[7] is not None else None,
    }


def _by_model(db: Session, start: datetime, end: datetime) -> list[dict]:
    success_expr = func.coalesce(
        func.sum(case((UsageLogORM.status_code.like("2%"), 1), else_=0)), 0
    )
    rows = db.execute(
        select(
            UsageLogORM.model_id,
            func.count().label("requests"),
            success_expr.label("success"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
            func.coalesce(func.sum(UsageLogORM.estimated_cost), 0.0).label("cost"),
        )
        .where(*_window(start, end))
        .group_by(UsageLogORM.model_id)
        .order_by(func.count().desc())
        .limit(_TOP_N)
    ).all()
    out = []
    for r in rows:
        reqs = int(r.requests or 0)
        errs = max(reqs - int(r.success or 0), 0)
        out.append({
            "model_id": r.model_id,
            "requests": reqs,
            "errors": errs,
            "error_rate": round(errs / reqs * 100, 2) if reqs else 0.0,
            "tokens": int(r.tokens or 0),
            "cost": round(float(r.cost or 0.0), 4),
        })
    total_req = sum(x["requests"] for x in out) or 1
    total_tok = sum(x["tokens"] for x in out) or 1
    for x in out:
        x["share_pct"] = round(x["requests"] / total_req * 100, 1)
        x["token_share_pct"] = round(x["tokens"] / total_tok * 100, 1)
    return out


def _by_project(db: Session, start: datetime, end: datetime) -> list[dict]:
    rows = db.execute(
        select(
            func.coalesce(ApiKeyORM.project_name, "（未知项目）").label("project"),
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
            func.coalesce(func.sum(UsageLogORM.estimated_cost), 0.0).label("cost"),
        )
        .select_from(UsageLogORM)
        .join(ApiKeyORM, ApiKeyORM.id == UsageLogORM.api_key_id, isouter=True)
        .where(*_window(start, end))
        .group_by("project")
        .order_by(func.coalesce(func.sum(UsageLogORM.total_tokens), 0).desc())
        .limit(_TOP_N)
    ).all()
    return [
        {"project": r.project, "requests": int(r.requests or 0),
         "tokens": int(r.tokens or 0), "cost": round(float(r.cost or 0.0), 4)}
        for r in rows
    ]


def _by_department(db: Session, start: datetime, end: datetime) -> list[dict]:
    rows = db.execute(
        select(
            func.coalesce(ApiKeyORM.department, "（未知部门）").label("department"),
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
            func.coalesce(func.sum(UsageLogORM.estimated_cost), 0.0).label("cost"),
        )
        .select_from(UsageLogORM)
        .join(ApiKeyORM, ApiKeyORM.id == UsageLogORM.api_key_id, isouter=True)
        .where(*_window(start, end))
        .group_by(ApiKeyORM.department)
        .order_by(func.count().desc())
        .limit(_TOP_N)
    ).all()
    out = [
        {"department": r.department, "requests": int(r.requests or 0),
         "tokens": int(r.tokens or 0), "cost": round(float(r.cost or 0.0), 4)}
        for r in rows
    ]
    total_tok = sum(x["tokens"] for x in out) or 1
    for x in out:
        x["token_share_pct"] = round(x["tokens"] / total_tok * 100, 1)
    return out


_CATEGORY_LABELS = {
    "chat": "对话模型", "flagship": "旗舰模型", "vision": "视觉理解",
    "embedding": "向量化", "reranker": "重排序", "ocr": "OCR", "lts": "LTS 接口",
    "image_gen": "图像生成", "other": "其他",
}


def _category_breakdown(db: Session, start: datetime, end: datetime) -> list[dict]:
    rows = db.execute(
        select(
            func.coalesce(ModelRegistryORM.category, "other").label("category"),
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
        )
        .select_from(UsageLogORM)
        .join(ModelRegistryORM, ModelRegistryORM.id == UsageLogORM.model_id, isouter=True)
        .where(*_window(start, end))
        .group_by(ModelRegistryORM.category)
        .order_by(func.count().desc())
    ).all()
    out = [
        {
            "category": r.category or "other",
            "label": _CATEGORY_LABELS.get(r.category or "other", r.category or "其他"),
            "requests": int(r.requests or 0),
            "tokens": int(r.tokens or 0),
        }
        for r in rows
    ]
    total_req = sum(x["requests"] for x in out) or 1
    for x in out:
        x["share_pct"] = round(x["requests"] / total_req * 100, 1)
    return out


def _by_status(db: Session, start: datetime, end: datetime) -> list[dict]:
    rows = db.execute(
        select(
            func.coalesce(UsageLogORM.status_code, "unknown").label("status"),
            func.count().label("count"),
        )
        .where(*_window(start, end))
        .group_by("status")
        .order_by(func.count().desc())
    ).all()
    return [{"status_code": r.status, "count": int(r.count or 0)} for r in rows]


def _by_hour(db: Session, start: datetime, end: datetime) -> list[dict]:
    hour = func.extract("hour", _local_created())
    rows = db.execute(
        select(
            hour.label("h"),
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
        )
        .where(*_window(start, end))
        .group_by("h")
        .order_by("h")
    ).all()
    bucket = {int(r.h): {"requests": int(r.requests or 0), "tokens": int(r.tokens or 0)} for r in rows}
    return [
        {"label": f"{h:02d}:00", "hour": h, "requests": bucket.get(h, {}).get("requests", 0),
         "tokens": bucket.get(h, {}).get("tokens", 0)}
        for h in range(24)
    ]


def _by_day(db: Session, start: datetime, end: datetime) -> list[dict]:
    day_col = cast(_local_created(), Date)
    rows = db.execute(
        select(
            day_col.label("d"),
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
        )
        .where(*_window(start, end))
        .group_by(day_col)
        .order_by(day_col)
    ).all()
    bucket = {
        r.d.isoformat() if hasattr(r.d, "isoformat") else str(r.d): {
            "requests": int(r.requests or 0),
            "tokens": int(r.tokens or 0),
        }
        for r in rows
    }
    out: list[dict] = []
    cur = start.replace(hour=0, minute=0, second=0, microsecond=0)
    end_day = end.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur < end_day:
        key = cur.date().isoformat()
        vals = bucket.get(key, {"requests": 0, "tokens": 0})
        out.append({
            "label": f"{cur.month}/{cur.day}",
            "date": key,
            "requests": vals["requests"],
            "tokens": vals["tokens"],
        })
        cur += timedelta(days=1)
    return out


def _by_month(db: Session, start: datetime, end: datetime) -> list[dict]:
    month = func.date_trunc("month", UsageLogORM.created_at)
    rows = db.execute(
        select(
            month.label("m"),
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
        )
        .where(*_window(start, end))
        .group_by(month)
        .order_by(month)
    ).all()
    bucket: dict[str, dict] = {}
    for r in rows:
        m = r.m
        if hasattr(m, "strftime"):
            key = m.strftime("%Y-%m")
        else:
            key = str(m)[:7]
        bucket[key] = {"requests": int(r.requests or 0), "tokens": int(r.tokens or 0)}

    out: list[dict] = []
    y, m = start.year, start.month
    end_y, end_m = end.year, end.month
    while (y, m) < (end_y, end_m):
        key = f"{y:04d}-{m:02d}"
        vals = bucket.get(key, {"requests": 0, "tokens": 0})
        out.append({"label": f"{y}.{m:02d}", "month": key, **vals})
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _saturation_by_model(db: Session, start: datetime, end: datetime) -> list[dict]:
    """容量饱和体检：按模型×小时聚合时延中位数。

    网关不做并发准入（2026-07 移除），推理引擎过载在网关侧唯一可见的征兆
    是 TTFT 膨胀（流式请求的 latency_ms 即 TTFT）：引擎内排队积压是陡增的，
    分时稀释是渐进的。高峰小时中位数相对低谷小时中位数的膨胀比即引擎
    饱和的结果信号。判定阈值见 _detect_anomalies。
    """
    hour = func.extract("hour", _local_created())
    rows = db.execute(
        select(
            UsageLogORM.model_id,
            hour.label("h"),
            func.count().label("requests"),
            func.percentile_cont(0.5).within_group(UsageLogORM.latency_ms.asc()).label("p50"),
        )
        .where(
            *_window(start, end),
            UsageLogORM.latency_ms.is_not(None),
        )
        .group_by(UsageLogORM.model_id, "h")
    ).all()

    per_model: dict[str, list] = {}
    for r in rows:
        per_model.setdefault(r.model_id, []).append(r)

    out: list[dict] = []
    for model_id, hrs in per_model.items():
        requests = sum(int(r.requests or 0) for r in hrs)
        entry = {
            "model_id": model_id,
            "requests": requests,
            "baseline_ms": None,
            "peak_ms": None,
            "peak_hour": None,
            "inflation": None,
        }
        # 膨胀比需要至少两个样本充足的小时桶（低谷 + 高峰），避免小样本误判
        qualified = [
            r for r in hrs
            if int(r.requests or 0) >= settings.OPS_MODEL_MIN_REQUESTS and r.p50
        ]
        if len(qualified) >= 2:
            base = min(qualified, key=lambda r: float(r.p50))
            peak = max(qualified, key=lambda r: float(r.p50))
            if float(base.p50) > 0:
                entry.update(
                    baseline_ms=int(base.p50),
                    peak_ms=int(peak.p50),
                    peak_hour=int(peak.h),
                    inflation=round(float(peak.p50) / float(base.p50), 1),
                )
        out.append(entry)
    out.sort(key=lambda x: x["requests"], reverse=True)
    return out[:_TOP_N]


def _series_granularity(start: datetime, end: datetime) -> str:
    days = max(1, (end - start).days)
    if days <= 2:
        return "hour"
    if days <= 92:
        return "day"
    return "month"


def _build_series(db: Session, start: datetime, end: datetime) -> tuple[str, list[dict]]:
    gran = _series_granularity(start, end)
    if gran == "hour":
        return gran, _by_hour(db, start, end)
    if gran == "day":
        return gran, _by_day(db, start, end)
    return gran, _by_month(db, start, end)


def _earliest_log(db: Session) -> datetime:
    row = db.execute(select(func.min(UsageLogORM.created_at))).scalar()
    if row is None:
        return datetime(2024, 1, 1)
    return _day_start(platform_time.to_local_naive(row))


def _day_start(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def period_for_kind(kind: str, anchor: datetime | None = None) -> tuple[datetime, datetime]:
    """返回半开区间 [start, end) 的起止时间（本地日历日，naive）。"""
    today = _day_start(anchor or _now())
    if kind == "daily":
        start = today - timedelta(days=1)
        return start, start + timedelta(days=1)
    if kind == "weekly":
        this_monday = today - timedelta(days=today.weekday())
        return this_monday - timedelta(days=7), this_monday
    if kind == "monthly":
        first_this = today.replace(day=1)
        last_month_end = first_this
        if first_this.month == 1:
            start = datetime(first_this.year - 1, 12, 1)
        else:
            start = datetime(first_this.year, first_this.month - 1, 1)
        return start, last_month_end
    if kind == "quarterly":
        q = (today.month - 1) // 3
        if q == 0:
            return datetime(today.year - 1, 10, 1), datetime(today.year, 1, 1)
        sm = (q - 1) * 3 + 1
        return datetime(today.year, sm, 1), datetime(today.year, q * 3 + 1, 1)
    if kind == "yearly":
        return datetime(today.year - 1, 1, 1), datetime(today.year, 1, 1)
    if kind == "cumulative":
        raise ValueError("cumulative 需传入 db 以确定起始时间")
    raise ValueError(f"未知报告类型: {kind}")


def period_for_cumulative(db: Session, anchor: datetime | None = None) -> tuple[datetime, datetime]:
    end = _day_start(anchor or _now())
    return _earliest_log(db), end


# ── 指标编排 ──────────────────────────────────────────────────────────────────
def _compute_metrics(db: Session, start: datetime, end: datetime, *, kind: str = "daily") -> dict:
    totals = _window_totals(db, start, end)
    prev_len = end - start

    if kind == "cumulative":
        recent_end = end
        recent_start = max(start, end - timedelta(days=30))
        recent_totals = _window_totals(db, recent_start, recent_end)
        prev_totals = _window_totals(db, recent_start - timedelta(days=30), recent_start)
        compare = {
            "requests_prev": prev_totals["requests"],
            "requests_delta_pct": _delta_pct(recent_totals["requests"], prev_totals["requests"]),
            "tokens_prev": prev_totals["total_tokens"],
            "tokens_delta_pct": _delta_pct(recent_totals["total_tokens"], prev_totals["total_tokens"]),
            "cost_prev": prev_totals["cost"],
            "cost_delta_pct": _delta_pct(recent_totals["cost"], prev_totals["cost"]),
            "error_rate_prev": prev_totals["error_rate"],
            "compare_note": "近 30 日较前一 30 日",
        }
    else:
        prev_totals = _window_totals(db, start - prev_len, start)
        compare = {
            "requests_prev": prev_totals["requests"],
            "requests_delta_pct": _delta_pct(totals["requests"], prev_totals["requests"]),
            "tokens_prev": prev_totals["total_tokens"],
            "tokens_delta_pct": _delta_pct(totals["total_tokens"], prev_totals["total_tokens"]),
            "cost_prev": prev_totals["cost"],
            "cost_delta_pct": _delta_pct(totals["cost"], prev_totals["cost"]),
            "error_rate_prev": prev_totals["error_rate"],
        }

    by_hour = _by_hour(db, start, end)
    peak = max(by_hour, key=lambda x: x["requests"]) if by_hour else {"hour": 0, "requests": 0, "label": "00:00"}
    gran, series = _build_series(db, start, end)

    return {
        "totals": totals,
        "compare": compare,
        "by_model": _by_model(db, start, end),
        "by_project": _by_project(db, start, end),
        "by_department": _by_department(db, start, end),
        "category_breakdown": _category_breakdown(db, start, end),
        "by_status": _by_status(db, start, end),
        "saturation": _saturation_by_model(db, start, end),
        "by_hour": by_hour,
        "series": series,
        "series_granularity": gran,
        "peak_hour": peak,
        "period_days": max(1, (end - start).days),
    }


# ── 异常识别 ──────────────────────────────────────────────────────────────────
def _detect_anomalies(metrics: dict) -> list[dict]:
    anomalies: list[dict] = []
    totals = metrics["totals"]
    compare = metrics["compare"]
    reqs = totals["requests"]

    def add(level: str, code: str, message: str) -> None:
        anomalies.append({"level": level, "code": code, "message": message})

    if reqs == 0:
        add("info", "no_traffic", "巡检周期内无任何调用记录。")
        return anomalies

    # 1) 整体错误率
    er = totals["error_rate"]
    if er >= settings.OPS_ERROR_RATE_CRITICAL:
        add("critical", "error_rate", f"整体错误率 {er}%，已超过严重阈值 {settings.OPS_ERROR_RATE_CRITICAL}%。")
    elif er >= settings.OPS_ERROR_RATE_WARN:
        add("warning", "error_rate", f"整体错误率 {er}%，高于预警阈值 {settings.OPS_ERROR_RATE_WARN}%。")

    # 2) 调用量环比突变
    rd = compare["requests_delta_pct"]
    if rd is not None:
        if rd >= settings.OPS_SURGE_PCT:
            add("info", "request_surge", f"调用量环比上升 {rd}%（上周期 {compare['requests_prev']} → 本周期 {reqs}）。")
        elif rd <= -settings.OPS_DROP_PCT:
            add("warning", "request_drop", f"调用量环比下降 {abs(rd)}%（上周期 {compare['requests_prev']} → 本周期 {reqs}），请确认是否异常。")

    # 3) Token 用量突增（资源占用变化）
    td = compare["tokens_delta_pct"]
    if td is not None and td >= settings.OPS_SURGE_PCT:
        add("info", "token_surge", f"Token 消耗环比上升 {td}%，注意算力规划。")

    # 4) 单模型错误率偏高
    for m in metrics["by_model"]:
        if m["requests"] >= settings.OPS_MODEL_MIN_REQUESTS and m["error_rate"] >= settings.OPS_MODEL_ERROR_RATE_WARN:
            add("warning", "model_error_rate",
                f"模型 {m['model_id']} 错误率 {m['error_rate']}%（{m['errors']}/{m['requests']}），建议排查上游。")

    # 5) 峰值时段集中
    peak = metrics["peak_hour"]
    if peak["requests"]:
        share = _pct(peak["requests"], reqs)
        if share >= settings.OPS_PEAK_SHARE_PCT:
            slot = peak.get("label") or f"{peak.get('hour', 0):02d}:00"
            add("info", "peak_hour", f"调用集中在 {slot} 时段，占周期内 {share}%，建议错峰或扩容。")

    # 6) 资源占用集中（单项目 token 占比过高）
    projects = metrics["by_project"]
    total_tokens = totals["total_tokens"]
    if projects and total_tokens:
        top = projects[0]
        share = _pct(top["tokens"], total_tokens)
        if share >= settings.OPS_PROJECT_SHARE_PCT:
            add("info", "project_concentration", f"项目「{top['project']}」占用 {share}% 的 Token 消耗，资源高度集中。")

    # 7) 平均时延偏高
    avg_lat = totals["avg_latency_ms"]
    if avg_lat is not None and avg_lat >= settings.OPS_LATENCY_WARN_MS:
        add("warning", "high_latency", f"平均时延 {avg_lat}ms，高于预警阈值 {settings.OPS_LATENCY_WARN_MS}ms。")

    # 8) 容量饱和体检：网关不做并发准入，TTFT 膨胀比是引擎过载的唯一可见信号。
    #    高峰时延中位数显著高于低谷 → 引擎在高峰期饱和、请求积压在引擎内部队列。
    for s in metrics.get("saturation") or []:
        if s["inflation"] is not None and s["inflation"] >= settings.OPS_SATURATION_INFLATION_WARN:
            add("warning", "saturation_suspect",
                f"模型 {s['model_id']} 高峰时段（{s['peak_hour']:02d}:00）时延中位数 {s['peak_ms']}ms，"
                f"为低谷 {s['baseline_ms']}ms 的 {s['inflation']} 倍——推理引擎高峰期饱和，"
                f"请求积压在引擎内部队列。建议扩节点、下调引擎 max_num_seqs（vLLM）/ "
                f"max_running_requests（SGLang）以收紧引擎准入，或引导高峰大户错峰/夜间批量。")

    return anomalies


def _overall_health(anomalies: list[dict]) -> str:
    levels = {a["level"] for a in anomalies}
    if "critical" in levels:
        return "critical"
    if "warning" in levels:
        return "warning"
    return "ok"


def _health_score(anomalies: list[dict]) -> int:
    score = 100
    for a in anomalies:
        if a["level"] == "critical":
            score -= 28
        elif a["level"] == "warning":
            score -= 14
        else:
            score -= 4
    return max(0, min(100, score))


def _build_insights(metrics: dict, anomalies: list[dict], kind: str) -> dict:
    """生成面向管理层的执行摘要、洞察与建议（规则引擎，数据均来自聚合指标）。"""
    totals = metrics["totals"]
    compare = metrics["compare"]
    models = metrics.get("by_model") or []
    projects = metrics.get("by_project") or []
    departments = metrics.get("by_department") or []
    categories = metrics.get("category_breakdown") or []
    peak = metrics.get("peak_hour") or {}

    insights: list[str] = []
    recommendations: list[str] = []

    kind_cn = {
        "daily": "日报", "weekly": "周报", "monthly": "月报",
        "quarterly": "季报", "yearly": "年报", "cumulative": "累计报告",
    }.get(kind, "运营报告")

    if totals["requests"] == 0:
        insights.append(f"本{kind_cn}周期内平台无任何 API 调用记录，请确认网关、密钥与上游模型接入是否正常。")
        recommendations.append("检查活跃 API Key 数量及模型在线状态，确认业务侧是否已切换至新网关地址。")
    else:
        avg_tok = round(totals["total_tokens"] / totals["requests"]) if totals["requests"] else 0
        insights.append(
            f"本周期共处理 {totals['requests']:,} 次 API 调用，消耗 {totals['total_tokens']:,} Token"
            f"（均次 {avg_tok:,} Token），预估费用 ¥{totals['cost']:.4f}，整体错误率 {totals['error_rate']}%。"
        )
        rd = compare.get("requests_delta_pct")
        if rd is not None:
            note = compare.get("compare_note") or "较上一周期"
            insights.append(f"调用量{note}环比 {_fmt_delta(rd)}（{compare.get('requests_prev', 0):,} → {totals['requests']:,}）。")

    if models and totals["requests"]:
        top = models[0]
        insights.append(
            f"调用量最高的模型为 **{top['model_id']}**，占全平台 {top.get('share_pct', 0)}%"
            f"（{top['requests']:,} 次，错误率 {top['error_rate']}%）。"
        )

    if categories:
        top_cat = categories[0]
        insights.append(
            f"按模型类别计，**{top_cat['label']}** 占调用量 {top_cat.get('share_pct', 0)}%，"
            f"共 {top_cat['requests']:,} 次。"
        )

    if projects and totals["total_tokens"]:
        top_p = projects[0]
        tok_share = round(top_p["tokens"] / totals["total_tokens"] * 100, 1)
        insights.append(f"Token 消耗最高的项目为「{top_p['project']}」，占 {tok_share}%。")

    if departments:
        top_d = departments[0]
        insights.append(f"调用最活跃的部门为「{top_d['department']}」（{top_d['requests']:,} 次）。")

    if peak.get("requests") and totals["requests"]:
        share = _pct(peak["requests"], totals["requests"])
        slot = peak.get("label") or f"{peak.get('hour', 0):02d}:00"
        if share >= 25:
            insights.append(f"流量峰值出现在 {slot}，占周期内 {share}%。")

    if totals.get("avg_latency_ms") is not None:
        insights.append(
            f"平均响应时延 {totals['avg_latency_ms']}ms，峰值 {totals.get('max_latency_ms')}ms。"
        )

    for a in anomalies:
        if a["level"] in ("critical", "warning"):
            recommendations.append(a["message"])

    if not recommendations:
        recommendations.append("当前核心指标处于正常区间，建议维持现有容量规划，并定期关注模型升级与密钥轮换。")
    if totals["requests"] > 0 and totals["error_rate"] < 1:
        recommendations.append("错误率处于低位，可将更多资源用于新模型试点与高优先级项目扩容。")

    return {
        "health_score": _health_score(anomalies),
        "executive_summary": insights,
        "recommendations": recommendations[:6],
    }


# ── 摘要渲染 ──────────────────────────────────────────────────────────────────
def _fmt_delta(d: float | None) -> str:
    if d is None:
        return "—"
    sign = "+" if d >= 0 else ""
    return f"{sign}{d}%"


def _render_summary(label: str, metrics: dict, health: str, anomalies: list[dict]) -> str:
    t = metrics["totals"]
    c = metrics["compare"]
    health_cn = {"ok": "正常", "warning": "需关注", "critical": "严重"}.get(health, health)
    lines = [
        f"# {label}",
        "",
        f"**整体健康度：{health_cn}**（评分 {metrics.get('health_score', '—')}/100）",
        "",
        "## 执行摘要",
    ]
    for item in metrics.get("executive_summary") or []:
        lines.append(f"- {item.replace('**', '')}")

    lines += [
        "",
        "## 概览",
        f"- 调用总数：{t['requests']}（环比 {_fmt_delta(c['requests_delta_pct'])}"
        + (f"，{c['compare_note']}" if c.get("compare_note") else "")
        + "）",
        f"- 成功 / 失败：{t['success']} / {t['errors']}，错误率 {t['error_rate']}%",
        f"- Token 消耗：{t['total_tokens']:,}（环比 {_fmt_delta(c['tokens_delta_pct'])}）",
        f"- 预估费用：¥{t['cost']:.4f}（环比 {_fmt_delta(c['cost_delta_pct'])}）",
    ]
    if t["avg_latency_ms"] is not None:
        lines.append(f"- 平均 / 峰值时延：{t['avg_latency_ms']}ms / {t['max_latency_ms']}ms")

    lines += ["", "## 异常摘要"]
    if anomalies:
        icon = {"critical": "🔴", "warning": "🟠", "info": "🔵"}
        for a in anomalies:
            lines.append(f"- {icon.get(a['level'], '•')} {a['message']}")
    else:
        lines.append("- 未发现异常，各项指标处于正常范围。")

    top_models = metrics["by_model"][:5]
    if top_models:
        lines += ["", "## Top 模型（按调用量）"]
        for m in top_models:
            lines.append(f"- {m['model_id']}：{m['requests']} 次，{m['tokens']:,} token，错误率 {m['error_rate']}%")

    top_projects = metrics["by_project"][:5]
    if top_projects:
        lines += ["", "## Top 项目（按 Token）"]
        for p in top_projects:
            lines.append(f"- {p['project']}：{p['requests']} 次，{p['tokens']:,} token")

    recs = metrics.get("recommendations") or []
    if recs:
        lines += ["", "## 运营建议"]
        for r in recs:
            lines.append(f"- {r}")

    return "\n".join(lines)


# ── 对外入口 ──────────────────────────────────────────────────────────────────
def generate_report(
    db: Session,
    period_start: datetime,
    period_end: datetime,
    kind: str = "daily",
    *,
    label: str | None = None,
    force: bool = False,
) -> OpsReportORM:
    """对 [period_start, period_end) 生成（或刷新）一份运营报告。

    幂等：同 (kind, period_start) 已存在且 force=False 时直接返回旧报告。
    """
    existing = db.execute(
        select(OpsReportORM).where(
            OpsReportORM.kind == kind, OpsReportORM.period_start == period_start
        )
    ).scalar_one_or_none()
    if existing is not None and not force:
        return existing

    if label is None:
        label = _default_label(kind, period_start, period_end)

    metrics = _compute_metrics(db, period_start, period_end, kind=kind)
    anomalies = _detect_anomalies(metrics)
    metrics["anomalies"] = anomalies
    metrics.update(_build_insights(metrics, anomalies, kind))
    health = _overall_health(anomalies)
    summary_md = _render_summary(label, metrics, health, anomalies)

    if existing is not None:
        existing.period_end = period_end
        existing.label = label
        existing.health = health
        existing.summary_md = summary_md
        existing.metrics = metrics
        existing.generated_at = _utc_now()
        report = existing
    else:
        report = OpsReportORM(
            kind=kind, period_start=period_start, period_end=period_end,
            label=label, health=health, summary_md=summary_md, metrics=metrics,
            generated_at=_utc_now(),
        )
        db.add(report)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.execute(
            select(OpsReportORM).where(
                OpsReportORM.kind == kind, OpsReportORM.period_start == period_start
            )
        ).scalar_one_or_none()
        if existing is None:
            raise
        return existing
    db.refresh(report)
    log.info("运营报告已生成：%s（health=%s, requests=%d）",
             label, health, metrics["totals"]["requests"])
    return report


def _default_label(kind: str, start: datetime, end: datetime) -> str:
    end_inclusive = end - timedelta(days=1) if (end - start).days >= 1 else end
    if kind == "daily":
        return f"{start:%Y-%m-%d} 日报"
    if kind == "weekly":
        return f"{start:%Y-%m-%d} ~ {end_inclusive:%Y-%m-%d} 周报"
    if kind == "monthly":
        return f"{start:%Y年%m月} 月报"
    if kind == "quarterly":
        q = (start.month - 1) // 3 + 1
        return f"{start.year} 年第{q}季度 季报"
    if kind == "yearly":
        return f"{start.year} 年报"
    if kind == "cumulative":
        return f"{start:%Y-%m-%d} ~ {end_inclusive:%Y-%m-%d} 累计报告"
    return f"{start:%Y-%m-%d %H:%M} ~ {end:%Y-%m-%d %H:%M} 巡检"


def generate_period_report(
    db: Session,
    kind: str,
    anchor: datetime | None = None,
    *,
    force: bool = False,
) -> OpsReportORM:
    """按报告类型生成上一完整周期（累计报告为全量至 anchor 日）。"""
    if kind not in REPORT_KINDS or kind == "manual":
        raise ValueError(f"不支持的报告类型: {kind}")
    if kind == "cumulative":
        start, end = period_for_cumulative(db, anchor)
    else:
        start, end = period_for_kind(kind, anchor)
    return generate_report(db, start, end, kind=kind, force=force)


def generate_daily_report(db: Session, day: datetime | None = None, *, force: bool = False) -> OpsReportORM:
    """生成某一自然日（默认昨日）的日报。day 取其 00:00 为窗口起点。"""
    target = day or (_now() - timedelta(days=1))
    start = target.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return generate_report(db, start, end, kind="daily", force=force)
