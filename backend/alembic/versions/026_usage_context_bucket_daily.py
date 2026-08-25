"""上下文长度分桶日汇总（永久保留，不受 usage_logs 清理影响）。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision = "026_usage_context_bucket_daily"
down_revision = "025_usage_stats_rollups"
branch_labels = None
depends_on = None

# 与 user._CONTEXT_BUCKETS / width_bucket 边界一致
_BOUNDARIES = "ARRAY[1000,2000,4000,8000,16000,32000,64000,128000,256000,512000,1000000]"


def upgrade() -> None:
    from app.database import Base, engine
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names():
        return

    from app import platform_time

    tz = platform_time.sql_tz_name()
    op.execute(f"""
        INSERT INTO usage_context_bucket_daily (day, api_key_id, bucket, count)
        SELECT
            (created_at AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::date AS day,
            api_key_id,
            width_bucket(prompt_tokens, {_BOUNDARIES})::int - 1 AS bucket,
            COUNT(*)::int AS count
        FROM usage_logs
        WHERE prompt_tokens IS NOT NULL AND prompt_tokens > 0
        GROUP BY 1, 2, 3
        ON CONFLICT (day, api_key_id, bucket) DO UPDATE
            SET count = usage_context_bucket_daily.count + EXCLUDED.count
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS usage_context_bucket_daily")
