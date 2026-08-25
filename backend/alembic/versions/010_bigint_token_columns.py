"""token 计数/额度列 Integer(int4) → BigInteger(int8)。

- usage_daily_summary 按 (day, key, model) 累计 token，无限档 Key 的夜间
  批量单日即可逼近 int4 上限（21.4 亿）；溢出会让 usage_writer 整批写入
  失败，该批计量全部丢失；
- api_keys.tpm_limit 同步放宽，否则超过 21.4 亿的 TPM 值无法配置
  （monthly_token_limit 不在此处理——011 会将该列整体删除）。
"""
from alembic import op
import sqlalchemy as sa


revision = "010_bigint_token_columns"
down_revision = "009_remove_queue_columns"
branch_labels = None
depends_on = None

_SUMMARY_COLS = ("prompt_tokens", "completion_tokens", "total_tokens", "cache_hit_tokens")
_KEY_COLS = ("tpm_limit",)


def upgrade() -> None:
    for col in _SUMMARY_COLS:
        op.alter_column(
            "usage_daily_summary", col,
            existing_type=sa.Integer(), type_=sa.BigInteger(),
            existing_nullable=False,
        )
    for col in _KEY_COLS:
        op.alter_column(
            "api_keys", col,
            existing_type=sa.Integer(), type_=sa.BigInteger(),
            existing_nullable=True,
        )


def downgrade() -> None:
    for col in _KEY_COLS:
        op.alter_column(
            "api_keys", col,
            existing_type=sa.BigInteger(), type_=sa.Integer(),
            existing_nullable=True,
        )
    for col in _SUMMARY_COLS:
        op.alter_column(
            "usage_daily_summary", col,
            existing_type=sa.BigInteger(), type_=sa.Integer(),
            existing_nullable=False,
        )
