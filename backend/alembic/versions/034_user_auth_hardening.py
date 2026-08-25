"""Add server-side user session invalidation fields.

Revision ID: 034_user_auth_hardening
Revises: 033_user_key_claim
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "034_user_auth_hardening"
down_revision = "033_user_key_claim"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c["name"] for c in inspect(op.get_bind()).get_columns("users")}
    if "token_version" not in columns:
        op.add_column(
            "users",
            sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        )
    if "is_active" not in columns:
        op.add_column(
            "users",
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        )


def downgrade() -> None:
    columns = {c["name"] for c in inspect(op.get_bind()).get_columns("users")}
    if "is_active" in columns:
        op.drop_column("users", "is_active")
    if "token_version" in columns:
        op.drop_column("users", "token_version")
