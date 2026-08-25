"""usage_logs 增加兜底归因字段（fallback_from / fallback_trigger）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "027_usage_logs_fallback"
down_revision = "026_usage_context_bucket_daily"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("usage_logs")}
    if "fallback_from" not in cols:
        op.add_column("usage_logs", sa.Column("fallback_from", sa.String(), nullable=True))
        op.create_index("ix_usage_fallback_from_created", "usage_logs", ["fallback_from", "created_at"])
    if "fallback_trigger" not in cols:
        op.add_column("usage_logs", sa.Column("fallback_trigger", sa.String(), nullable=True))
        op.create_index("ix_usage_fallback_trigger_created", "usage_logs", ["fallback_trigger", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("usage_logs")}
    if "fallback_trigger" in cols:
        op.drop_index("ix_usage_fallback_trigger_created", table_name="usage_logs")
        op.drop_column("usage_logs", "fallback_trigger")
    if "fallback_from" in cols:
        op.drop_index("ix_usage_fallback_from_created", table_name="usage_logs")
        op.drop_column("usage_logs", "fallback_from")
