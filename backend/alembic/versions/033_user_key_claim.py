"""把审批密钥的唯一一次明文交付对象改为申请用户。

管理员审批不再收到明文。新审批记录在用户首次访问 API Keys 页时领取；历史上
已经产生过调用的密钥视为已交付，避免轮换正在使用的凭据。历史未使用的审批密钥
允许申请人首次领取时安全轮换一次，修复此前明文只展示给管理员的问题。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "033_user_key_claim"
down_revision = "032_platform_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in inspect(bind).get_columns("api_keys")}
    if "user_claimed_at" not in columns:
        op.add_column("api_keys", sa.Column("user_claimed_at", sa.DateTime(), nullable=True))

    # 永久日汇总或尚未归档的明细有记录，都说明密钥已经真正投入使用，绝不能
    # 自动轮换。两边都查，兼容异步汇总尚未落下的短窗口。
    tables = set(inspect(bind).get_table_names())
    usage_checks: list[str] = []
    if "usage_daily_summary" in tables:
        usage_checks.append("EXISTS (SELECT 1 FROM usage_daily_summary s WHERE s.api_key_id = k.id)")
    if "usage_logs" in tables:
        usage_checks.append("EXISTS (SELECT 1 FROM usage_logs l WHERE l.api_key_id = k.id)")
    if usage_checks:
        op.execute(sa.text("""
            UPDATE api_keys k
               SET user_claimed_at = k.granted_at
             WHERE k.application_id IS NOT NULL
               AND k.user_claimed_at IS NULL
               AND (
        """ + " OR ".join(usage_checks) + ")"))


def downgrade() -> None:
    columns = {c["name"] for c in inspect(op.get_bind()).get_columns("api_keys")}
    if "user_claimed_at" in columns:
        op.drop_column("api_keys", "user_claimed_at")
