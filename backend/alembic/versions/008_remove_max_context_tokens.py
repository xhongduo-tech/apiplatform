"""移除 model_registry.max_context_tokens（上下文超限预检已整体移除，超限交由上游模型报错）。"""
from alembic import op
import sqlalchemy as sa


revision = "008_remove_max_context_tokens"
down_revision = "007_night_batch_registrations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("model_registry")}
    if "max_context_tokens" in existing:
        op.drop_column("model_registry", "max_context_tokens")


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("model_registry")}
    if "max_context_tokens" not in existing:
        op.add_column("model_registry", sa.Column("max_context_tokens", sa.Integer(), nullable=True))
