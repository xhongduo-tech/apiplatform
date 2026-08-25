"""存量高并发密钥补录为已通过升级申请（统一字段结构）。

此前部分密钥由管理员直接调档至高并发，未落 upgrade_applications，
导致「高并发升级」后台「全部 / 已批准」筛选项看不到这些密钥。
本迁移按统一的已通过申请字段结构补齐：auth_id/name/department/
key_id/key_name/project_name/reason/target_tier/status/reviewer。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision = "030_backfill_upgrade_apps"
down_revision = "029_fallback_circuit_enabled"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if "api_keys" not in tables or "upgrade_applications" not in tables:
        return

    from sqlalchemy.orm import Session

    from app.upgrade_flow import backfill_elevated_upgrade_apps

    # 挂到当前 alembic 连接，与迁移事务同命运
    db = Session(bind=bind)
    try:
        n = backfill_elevated_upgrade_apps(db)
        db.flush()
        print(f"backfill_elevated_upgrade_apps: created/approved {n} rows")
    finally:
        db.close()


def downgrade() -> None:
    # 补录数据不自动回滚（避免误删真实审批记录）；如需清理可按 note 手工删除
    pass
