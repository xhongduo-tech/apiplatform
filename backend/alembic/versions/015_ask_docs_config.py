"""Ask Docs 智能问答 LLM 配置表。

管理员在管理后台填入大模型接入信息后,Ask Docs 功能从纯关键词匹配切换为
LLM 驱动的文档问答。未配置/未启用时前端退化为现有静态搜索,不丢功能。

幂等:表已存在则跳过,可在 partially-migrated 的库上安全复跑。
"""
from alembic import op
import sqlalchemy as sa


revision = "015_ask_docs_config"
down_revision = "014_early_access_applications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "ask_docs_config" in insp.get_table_names():
        return
    op.create_table(
        "ask_docs_config",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("provider", sa.String(), nullable=False, server_default="openai"),
        sa.Column("model", sa.String(), nullable=False, server_default="gpt-4o"),
        sa.Column("api_base", sa.String(), nullable=True),
        sa.Column("api_key", sa.String(), nullable=True),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("max_tokens", sa.Integer(), nullable=False, server_default="4096"),
        sa.Column("temperature", sa.Float(), nullable=False, server_default="0.3"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "ask_docs_config" not in insp.get_table_names():
        return
    op.drop_table("ask_docs_config")
