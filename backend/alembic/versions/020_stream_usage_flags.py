"""usage_logs 补用量来源标记：usage_estimated / stream。

流式调用在网关侧做用量兜底后（上游未回报 usage 时按正文估算并标记），
需要这两列让前端能区分「上游实测」与「网关估算」，并在日志里标注流式调用；
日汇总聚合时估算值同样计入，统计口径与明细一致。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "020_stream_usage_flags"
down_revision = "019_application_review_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("usage_logs")}
    if "usage_estimated" not in existing:
        op.add_column(
            "usage_logs",
            sa.Column("usage_estimated", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if "stream" not in existing:
        op.add_column(
            "usage_logs",
            sa.Column("stream", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "usage_logs" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("usage_logs")}
    if "stream" in existing:
        op.drop_column("usage_logs", "stream")
    if "usage_estimated" in existing:
        op.drop_column("usage_logs", "usage_estimated")
