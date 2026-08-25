"""Session 画像 / 热力图永久 rollup：usage_hourly_summary + usage_request_profile。

usage_logs 仅保留 USAGE_LOG_RETENTION_DAYS（默认 90 天），趋势图走 usage_daily_summary，
但 Session 分布与周热力图此前仍读 usage_logs，清理后只剩空图。写入明细时同步落
永久 slim 表，并从现存 usage_logs 一次性回填。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision = "025_usage_stats_rollups"
down_revision = "024_infra_topology_registry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.database import Base, engine
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names():
        return

    # 小时热力：按平台本地时区聚合（与 heatmap_stats / usage_writer 口径一致）
    from app import platform_time
    from app.session_stats import count_tool_calls_in_preview

    tz = platform_time.sql_tz_name()
    op.execute(f"""
        INSERT INTO usage_hourly_summary (day, hour, api_key_id, calls)
        SELECT
            (created_at AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::date AS day,
            EXTRACT(hour FROM created_at AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::int AS hour,
            api_key_id,
            COUNT(*)::int AS calls
        FROM usage_logs
        GROUP BY 1, 2, 3
        ON CONFLICT (day, hour, api_key_id) DO UPDATE
            SET calls = usage_hourly_summary.calls + EXCLUDED.calls
    """)

    # request profile：prompt + tool_calls，供 Session 分布
    from sqlalchemy import text
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        rows = db.execute(text("""
            SELECT id, api_key_id, created_at, prompt_tokens, response_preview
            FROM usage_logs
        """)).all()
        if rows:
            from app.models import UsageRequestProfileORM

            profiles = []
            for r in rows:
                profiles.append({
                    "id": r.id,
                    "api_key_id": r.api_key_id,
                    "created_at": r.created_at,
                    "prompt_tokens": r.prompt_tokens,
                    "tool_calls_count": count_tool_calls_in_preview(r.response_preview),
                })
            db.bulk_insert_mappings(UsageRequestProfileORM, profiles)
            db.commit()
    finally:
        db.close()


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS usage_context_bucket_daily")
    op.execute("DROP TABLE IF EXISTS usage_request_profile")
    op.execute("DROP TABLE IF EXISTS usage_hourly_summary")
