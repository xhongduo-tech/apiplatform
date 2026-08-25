"""删除 api_keys.monthly_token_limit（月度配额已于 2026-07-19 整体移除）。

平台限额收敛为单 Key RPM/TPM 两种；月度 token 上限的策略检查、admin
配置入口、CSV 导入映射均已同步删除。历史库中该列若有残值，删除仅意味着
对应 Key 不再受月度限制，不影响密钥有效性与用户登录。
"""
from alembic import op
import sqlalchemy as sa


revision = "011_drop_monthly_token_limit"
down_revision = "010_bigint_token_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "monthly_token_limit" in {c["name"] for c in insp.get_columns("api_keys")}:
        op.drop_column("api_keys", "monthly_token_limit")


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "monthly_token_limit" not in {c["name"] for c in insp.get_columns("api_keys")}:
        op.add_column("api_keys", sa.Column("monthly_token_limit", sa.BigInteger(), nullable=True))
