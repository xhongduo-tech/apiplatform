"""新增 scene_types 表并写入默认场景分类。

场景分类从硬编码常量改为管理员可维护的实体（可新增/修改/删除）。
api_keys.scene_type 引用本表 key；场景分布、申请表单都从本表读取。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "022_scene_types"
down_revision = "021_application_scene_type"
branch_labels = None
depends_on = None

_DEFAULT_SCENE_TYPES = [
    ("key", "重点业务", 1),
    ("labor_contest", "专项活动", 2),
    ("innovation", "创新实验", 3),
    ("explore", "概念验证", 4),
    ("dept_explore", "团队试用", 5),
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "scene_types" not in inspector.get_table_names():
        op.create_table(
            "scene_types",
            sa.Column("key", sa.String(32), primary_key=True),
            sa.Column("label", sa.String(100), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
    # 2026-08 修复：全新库上迁移 001 用当前 models 的 create_all() 已把 scene_types
    # 建成空表，原「表不存在才插数据」的守卫恒为假、默认场景被静默跳过。改为：
    # 无论表是否刚由本迁移创建，都以 ON CONFLICT DO NOTHING 补齐缺失的默认 key，
    # 幂等且不覆盖管理员已新增/改名的场景。
    stmt = sa.text(
        "INSERT INTO scene_types (key, label, sort_order) VALUES (:k, :l, :o) "
        "ON CONFLICT (key) DO NOTHING"
    )
    for key, label, order in _DEFAULT_SCENE_TYPES:
        op.execute(stmt.bindparams(k=key, l=label, o=order))


def downgrade() -> None:
    pass
