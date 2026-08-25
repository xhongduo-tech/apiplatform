"""usage_writer 同步写入的永久 rollup（小时热力 + Session 画像 + 上下文分桶）。"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app import platform_time
from app.models import (
    UsageContextBucketDailyORM,
    UsageHourlySummaryORM,
    UsageRequestProfileORM,
    _uuid,
)
from app.session_stats import context_bucket_index, count_tool_calls_in_preview


def rollup_stats(db: Session, batch: list[dict]) -> None:
    """在 usage_logs 批写同一事务内递增永久汇总表。"""
    if not batch:
        return

    hourly: dict[tuple[object, int, str], int] = {}
    ctx_buckets: dict[tuple[object, str, int], int] = {}
    profiles: list[dict] = []

    for r in batch:
        key_id = r.get("api_key_id")
        if not key_id:
            continue
        log_id = r.get("id") or _uuid()
        r["id"] = log_id
        created_at = _coerce_created_at(r.get("created_at"))
        local_created_at = platform_time.to_local_naive(created_at)
        day = local_created_at.date()
        hour = local_created_at.hour
        hourly[(day, hour, key_id)] = hourly.get((day, hour, key_id), 0) + 1

        pt = r.get("prompt_tokens")
        if isinstance(pt, int) and pt > 0:
            bkt = context_bucket_index(pt)
            if bkt >= 0:
                ctx_buckets[(day, key_id, bkt)] = ctx_buckets.get((day, key_id, bkt), 0) + 1

        profiles.append({
            "id": log_id,
            "api_key_id": key_id,
            "created_at": created_at,
            "prompt_tokens": pt,
            # 中继路径显式计数优先；历史/缺字段时回落 response_preview 启发式
            "tool_calls_count": int(
                r["tool_calls_count"]
                if r.get("tool_calls_count") is not None
                else count_tool_calls_in_preview(r.get("response_preview"))
            ),
        })

    if hourly:
        stmt = pg_insert(UsageHourlySummaryORM).values([
            {"day": day, "hour": hour, "api_key_id": key_id, "calls": cnt}
            for (day, hour, key_id), cnt in hourly.items()
        ])
        stmt = stmt.on_conflict_do_update(
            index_elements=["day", "hour", "api_key_id"],
            set_={"calls": UsageHourlySummaryORM.calls + stmt.excluded.calls},
        )
        db.execute(stmt)

    if ctx_buckets:
        stmt = pg_insert(UsageContextBucketDailyORM).values([
            {"day": day, "api_key_id": key_id, "bucket": bkt, "count": cnt}
            for (day, key_id, bkt), cnt in ctx_buckets.items()
        ])
        stmt = stmt.on_conflict_do_update(
            index_elements=["day", "api_key_id", "bucket"],
            set_={"count": UsageContextBucketDailyORM.count + stmt.excluded.count},
        )
        db.execute(stmt)

    if profiles:
        stmt = pg_insert(UsageRequestProfileORM).values(profiles)
        db.execute(stmt.on_conflict_do_nothing(index_elements=[UsageRequestProfileORM.id]))


def _coerce_created_at(value) -> datetime:
    """rollup 可能被迁移脚本直接调用，故在这里也接受 ISO-8601 字符串。"""
    if value is None:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    if isinstance(value, str):
        value = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if not isinstance(value, datetime):
        raise ValueError("created_at 必须是 datetime 或 ISO-8601 字符串")
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value
