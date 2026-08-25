"""usage_logs 增加 request_id 列（全链路请求追踪）。

响应头 X-Request-Id 与本列同值：用户报障时报此 ID，可在明细与访问日志中
精确定位那一次调用。带索引支持按 ID 直查。
"""
from alembic import op
import sqlalchemy as sa


revision = "012_add_request_id"
down_revision = "011_drop_monthly_token_limit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "request_id" not in {c["name"] for c in insp.get_columns("usage_logs")}:
        op.add_column("usage_logs", sa.Column("request_id", sa.String(), nullable=True))
        op.create_index("ix_usage_logs_request_id", "usage_logs", ["request_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "request_id" in {c["name"] for c in insp.get_columns("usage_logs")}:
        op.drop_index("ix_usage_logs_request_id", table_name="usage_logs")
        op.drop_column("usage_logs", "request_id")
