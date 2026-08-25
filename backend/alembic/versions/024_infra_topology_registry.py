"""新增算力拓扑资源与关系登记表。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "024_infra_topology_registry"
down_revision = "023_high_concurrency_upgrade"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = inspector.get_table_names()

    if "infra_resources" not in tables:
        op.create_table(
            "infra_resources",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("subtitle", sa.String(), nullable=False, server_default=""),
            sa.Column("pool", sa.String(), nullable=True),
            sa.Column("extra", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_infra_resources_kind", "infra_resources", ["kind"])
        op.create_index("ix_infra_resource_kind_name", "infra_resources", ["kind", "name"])

    if "infra_topology_links" not in tables:
        op.create_table(
            "infra_topology_links",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("source_id", sa.String(), nullable=False),
            sa.Column("target_id", sa.String(), nullable=False),
            sa.Column("relation", sa.String(), nullable=False, server_default="serves"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_infra_topology_links_source_id", "infra_topology_links", ["source_id"])
        op.create_index("ix_infra_topology_links_target_id", "infra_topology_links", ["target_id"])
        op.create_index(
            "ix_infra_topology_source_target",
            "infra_topology_links",
            ["source_id", "target_id"],
            unique=True,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = inspector.get_table_names()
    if "infra_topology_links" in tables:
        op.drop_table("infra_topology_links")
    if "infra_resources" in tables:
        op.drop_table("infra_resources")
