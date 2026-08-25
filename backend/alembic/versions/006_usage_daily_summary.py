"""Add usage_daily_summary permanent rollup + backfill from existing usage_logs.

usage_logs 明细按 USAGE_LOG_RETENTION_DAYS 定期清理（本次同步调短），但调用次数 /
Token 等统计需要永久保留、且不受 API Key 被删除影响，因此落入独立的按天汇总表。
此处一并把当前仍留存的 usage_logs 一次性回填进汇总表，避免旧数据在清理时丢失。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision = "006_usage_daily_summary"
down_revision = "005_add_key_rate_limits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.database import Base, engine
    from app import models  # noqa: F401
    Base.metadata.create_all(bind=engine)

    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names() or "usage_daily_summary" not in inspector.get_table_names():
        return
    op.execute("""
        INSERT INTO usage_daily_summary
            (day, api_key_id, model_id, calls, prompt_tokens, completion_tokens, total_tokens, cache_hit_tokens)
        SELECT
            date(created_at) AS day,
            api_key_id,
            model_id,
            COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens
        FROM usage_logs
        GROUP BY date(created_at), api_key_id, model_id
        ON CONFLICT (day, api_key_id, model_id) DO NOTHING
    """)


def downgrade() -> None:
    pass
