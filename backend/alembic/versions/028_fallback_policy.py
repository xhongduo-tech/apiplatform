"""平台级兜底策略（统一配置，单行 upsert）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "028_fallback_policy"
down_revision = "027_usage_logs_fallback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "fallback_policy" in inspector.get_table_names():
        return
    op.create_table(
        "fallback_policy",
        sa.Column("id", sa.String(), primary_key=True, server_default="default"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("target_model_id", sa.String(), nullable=True),
        sa.Column("source_model_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("trip_fails", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("trip_rate", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("window_s", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("cooldown_s", sa.Integer(), nullable=False, server_default="120"),
        sa.Column("max_cooldown_s", sa.Integer(), nullable=False, server_default="1800"),
        sa.Column("forced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "fallback_policy" not in inspector.get_table_names():
        return
    op.drop_table("fallback_policy")
