"""移除排队/并发准入相关列（网关排队机制已于 2026-07-18 整体移除）。

- model_registry.max_concurrent：网关并发上限，随准入控制一并废弃；
- usage_logs.queue_wait_ms：网关排队等待毫秒数，不再产生。
"""
from alembic import op
import sqlalchemy as sa


revision = "009_remove_queue_columns"
down_revision = "008_remove_max_context_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "max_concurrent" in {c["name"] for c in insp.get_columns("model_registry")}:
        op.drop_column("model_registry", "max_concurrent")
    if "queue_wait_ms" in {c["name"] for c in insp.get_columns("usage_logs")}:
        op.drop_column("usage_logs", "queue_wait_ms")


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "max_concurrent" not in {c["name"] for c in insp.get_columns("model_registry")}:
        op.add_column("model_registry", sa.Column("max_concurrent", sa.Integer(), nullable=True))
    if "queue_wait_ms" not in {c["name"] for c in insp.get_columns("usage_logs")}:
        op.add_column("usage_logs", sa.Column("queue_wait_ms", sa.Integer(), nullable=True))
