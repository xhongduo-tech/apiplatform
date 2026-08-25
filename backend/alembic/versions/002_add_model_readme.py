"""Add readme column to model_registry (idempotent)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "002_add_model_readme"
down_revision = "001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "model_registry" not in insp.get_table_names():
        return
    existing = {c["name"] for c in insp.get_columns("model_registry")}
    if "readme" not in existing:
        op.add_column("model_registry", sa.Column("readme", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "model_registry" in insp.get_table_names() and "readme" in {c["name"] for c in insp.get_columns("model_registry")}:
        op.drop_column("model_registry", "readme")
