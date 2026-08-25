"""抢先体验计划准入申请表。

模型侧一列不动：「抢先体验计划」复用 model_registry.status == "upcoming"
（原「即将上线」）这一既有取值，仅语义变为「授权用户可调用」。授权名单落在
本新表，每个账号 ID 一行（unique），驳回后可复用同一行重新提交。

幂等：表已存在则跳过，可在 partially-migrated 的库上安全复跑。
"""
from alembic import op
import sqlalchemy as sa


revision = "014_early_access_applications"
down_revision = "013_api_keys_constraint_swap"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "early_access_applications" in insp.get_table_names():
        return
    op.create_table(
        "early_access_applications",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("auth_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("department", sa.String(), nullable=False, server_default=""),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("agreement_version", sa.String(), nullable=False, server_default="v1"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewer", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index(
        "ix_early_access_applications_auth_id",
        "early_access_applications", ["auth_id"], unique=True,
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "early_access_applications" not in insp.get_table_names():
        return
    op.drop_index("ix_early_access_applications_auth_id", table_name="early_access_applications")
    op.drop_table("early_access_applications")
