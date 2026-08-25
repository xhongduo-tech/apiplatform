"""新增高并发升级申请表 upgrade_applications。

用户对某个已激活密钥提交「升级高并发」申请（附申请原因），管理员审批
通过后由后台把该密钥套用高并发预设档位。审批动作与密钥申请（applications，
审批时发新密钥）不同，故单独建表、单独审批流。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "023_high_concurrency_upgrade"
down_revision = "022_scene_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "upgrade_applications" not in inspector.get_table_names():
        op.create_table(
            "upgrade_applications",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("auth_id", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False, server_default=""),
            sa.Column("department", sa.String(), nullable=False, server_default=""),
            sa.Column(
                "key_id", sa.String(),
                sa.ForeignKey("api_keys.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("key_name", sa.String(), nullable=False, server_default=""),
            sa.Column("project_name", sa.String(), nullable=False, server_default=""),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("target_tier", sa.String(32), nullable=False, server_default="high"),
            sa.Column("status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("reviewed_at", sa.DateTime(), nullable=True),
            sa.Column("reviewer", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_upgrade_applications_auth_id", "upgrade_applications", ["auth_id"])
        op.create_index("ix_upgrade_applications_key_id", "upgrade_applications", ["key_id"])


def downgrade() -> None:
    pass
