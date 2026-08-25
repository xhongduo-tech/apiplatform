"""api_keys / applications 补业务场景分类 scene_type。

场景分布（status 页 donut + 统计 breakdown 的 scene 维度）改为按业务场景分类
区分，不再按模型类型（model_registry.category）。用户在申请 Key 时选择归属，
存量数据统一默认归入「探索场景」（explore）。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "021_application_scene_type"
down_revision = "020_stream_usage_flags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    for table in ("applications", "api_keys"):
        if table not in inspector.get_table_names():
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "scene_type" not in existing:
            op.add_column(
                table,
                sa.Column("scene_type", sa.String(32), nullable=False, server_default="explore"),
            )


def downgrade() -> None:
    pass
