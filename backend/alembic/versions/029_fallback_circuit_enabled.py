"""fallback_policy 增加 circuit_enabled：熔断为可选高级策略，默认关闭。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "029_fallback_circuit_enabled"
down_revision = "028_fallback_policy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "fallback_policy" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("fallback_policy")}
    if "circuit_enabled" in cols:
        return
    op.add_column(
        "fallback_policy",
        sa.Column("circuit_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "fallback_policy" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("fallback_policy")}
    if "circuit_enabled" not in cols:
        return
    op.drop_column("fallback_policy", "circuit_enabled")
