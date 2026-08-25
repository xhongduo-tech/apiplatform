"""目录 seed 标记表：只登记「历史上插过」，让 seed 永久放行管理员的删除/改名。

背景：seed_catalog_models() 原先只看 model_registry 里当前有没有某个 id，
管理员删除或改名过的模型，id 变回"缺失"后会在下次启动被悄悄插回去——
2026-07 发生过一次（qwen3.6-35b-flash 改名为 qwen3.6-35b-reasoner 后，
旧 id 在下次重启复活成一条多余的行）。

这张表登记的是"曾经插入过"而不是"现在还在"，删除/改名之后这里的记录
不会被清掉，从而让 seed 之后永久放行管理员对这个 id 的处置。

回填：把当前 CATALOG_MODELS 里、且已经存在于 model_registry 的 id 标记为
"历史上插过"——这是唯一合理的初始状态：这些行显然是之前的 seed 或迁移
落地的，不该被当成"全新目录模型"再插一遍，也不该被当成"被删除过"而永远
无法自动引入（它们本来就在）。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "018_catalog_seeded_ids"
down_revision = "017_schema_hardening"
branch_labels = None
depends_on = None


def _insp():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return name in _insp().get_table_names()


def upgrade() -> None:
    if not _has_table("catalog_seeded_ids"):
        op.create_table(
            "catalog_seeded_ids",
            sa.Column("model_id", sa.String(), primary_key=True),
            sa.Column("seeded_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )

    from app.catalog_seed import CATALOG_MODELS

    bind = op.get_bind()
    existing_ids = {
        row[0] for row in bind.execute(sa.text("SELECT id FROM model_registry"))
    }
    already_marked = {
        row[0] for row in bind.execute(sa.text("SELECT model_id FROM catalog_seeded_ids"))
    }
    catalog_table = sa.table(
        "catalog_seeded_ids", sa.column("model_id", sa.String())
    )
    for spec in CATALOG_MODELS:
        model_id = spec["id"]
        if model_id in existing_ids and model_id not in already_marked:
            bind.execute(catalog_table.insert().values(model_id=model_id))


def downgrade() -> None:
    if _has_table("catalog_seeded_ids"):
        op.drop_table("catalog_seeded_ids")
