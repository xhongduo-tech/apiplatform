"""首页等平台展示用累计统计（实时用量 + 可配置历史基线）。"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.platform_stats_baseline import get_initial_calls, get_initial_tokens


def build_platform_stats(
    live_calls: int,
    live_tokens: int,
    active_keys: int,
    db: Session | None = None,
) -> dict:
    """合并实时库内统计与环境变量 / 管理后台配置的 historical 基线。"""
    initial_calls = get_initial_calls(db) if db is not None else get_initial_calls()
    initial_tokens = get_initial_tokens(db) if db is not None else get_initial_tokens()
    return {
        "total_calls": live_calls + initial_calls,
        "total_tokens": live_tokens + initial_tokens,
        "active_keys": active_keys,
        "live_calls": live_calls,
        "live_tokens": live_tokens,
        "initial_calls": initial_calls,
        "initial_tokens": initial_tokens,
    }


def query_platform_stats(db: Session) -> dict:
    from app.models import ApiKeyORM, UsageDailySummaryORM

    # 源自永久汇总表而非 usage_logs：明细按 USAGE_LOG_RETENTION_DAYS 定期清理，
    # 若仍从 usage_logs 直接 COUNT/SUM，首页"累计"会随清理逐渐失真。
    live_calls = int(db.execute(select(func.coalesce(func.sum(UsageDailySummaryORM.calls), 0))).scalar() or 0)
    live_tokens = int(
        db.execute(select(func.coalesce(func.sum(UsageDailySummaryORM.total_tokens), 0))).scalar() or 0
    )
    active_keys = int(
        db.execute(
            select(func.count()).select_from(ApiKeyORM).where(
                ApiKeyORM.revoked.is_(False),
                ApiKeyORM.deleted_at.is_(None),
            )
        ).scalar() or 0
    )
    return build_platform_stats(live_calls, live_tokens, active_keys, db)
