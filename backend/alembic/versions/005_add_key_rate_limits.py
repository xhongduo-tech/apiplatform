"""api_keys 增加单 Key RPM/TPM 覆盖列（None = 平台默认）。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "005_add_key_rate_limits"
down_revision = "004_remove_tier_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "api_keys" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("api_keys")}
    if "rpm_limit" not in existing:
        op.add_column("api_keys", sa.Column("rpm_limit", sa.Integer(), nullable=True))
    if "tpm_limit" not in existing:
        op.add_column("api_keys", sa.Column("tpm_limit", sa.Integer(), nullable=True))


def downgrade() -> None:
    pass
