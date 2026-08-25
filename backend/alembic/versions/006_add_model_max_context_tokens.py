"""model_registry 增加 max_context_tokens（网关层上下文超限预检用的精确上限）。

注意：文件名序号与 006_usage_daily_summary 重复是历史遗留——revision id
唯一，迁移链路为 005 → 006_usage_daily_summary → 本文件，勿按文件名推断顺序。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "006_add_model_max_context_tokens"
down_revision = "006_usage_daily_summary"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "model_registry" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("model_registry")}
    if "max_context_tokens" not in existing:
        op.add_column("model_registry", sa.Column("max_context_tokens", sa.Integer(), nullable=True))


def downgrade() -> None:
    pass
