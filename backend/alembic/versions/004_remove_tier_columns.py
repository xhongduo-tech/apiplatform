"""移除梯度算力方案相关列（qps_tier / concurrency_cap / priority_weight /
standard_floor / usage_logs.tier）。全平台统一限速与单队列调度后不再需要。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision = "004_remove_tier_columns"
down_revision = "003_forum_social"
branch_labels = None
depends_on = None

_DROPS = {
    "api_keys": ("qps_tier", "concurrency_cap", "priority_weight"),
    "model_registry": ("standard_floor",),
    "usage_logs": ("tier",),
}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for table, columns in _DROPS.items():
        if table not in inspector.get_table_names():
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        for col in columns:
            if col in existing:
                op.drop_column(table, col)


def downgrade() -> None:
    pass
