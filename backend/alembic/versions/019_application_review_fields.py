"""applications 表补齐审批留痕字段：note / reviewed_at / reviewer。

用户申请 Key 改为需管理员审批（不再由 /apply 即时发放），这三列对齐
early_access_applications 的审批字段设计，供 approve/reject 落审批备注、
时间、操作人，并让用户侧能看到驳回理由。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "019_application_review_fields"
down_revision = "018_catalog_seeded_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "applications" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("applications")}
    if "note" not in existing:
        op.add_column("applications", sa.Column("note", sa.Text(), nullable=True))
    if "reviewed_at" not in existing:
        op.add_column("applications", sa.Column("reviewed_at", sa.DateTime(), nullable=True))
    if "reviewer" not in existing:
        op.add_column("applications", sa.Column("reviewer", sa.String(), nullable=True))


def downgrade() -> None:
    pass
