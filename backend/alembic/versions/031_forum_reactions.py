"""合并 forum_likes / forum_follows 为通用 forum_reactions（按 reaction_type 区分）。

两张旧表结构完全相同（post_id + user_auth_id + created_at + 唯一约束），
只是语义标签不同；合并后以后再加"收藏""举报"这类同构互动，加一个新
reaction_type 即可，不必再建表。

幂等 + 兼容存量数据：若旧表存在则先把数据搬过去再删表；全新库上旧表本就
不会被创建（forum_likes/forum_follows 的 ORM 类已从 models.py 移除），
这里只需确保 forum_reactions 存在。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "031_forum_reactions"
down_revision = "030_backfill_upgrade_apps"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())

    if "forum_reactions" not in tables:
        op.create_table(
            "forum_reactions",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "post_id", sa.String(),
                sa.ForeignKey("forum_posts.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("user_auth_id", sa.String(), nullable=False),
            sa.Column("reaction_type", sa.String(16), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_forum_reactions_post_id", "forum_reactions", ["post_id"])
        op.create_index("ix_forum_reactions_user_auth_id", "forum_reactions", ["user_auth_id"])
        op.create_index("ix_forum_reactions_reaction_type", "forum_reactions", ["reaction_type"])
        op.create_index(
            "ix_forum_reaction_post_user_type", "forum_reactions",
            ["post_id", "user_auth_id", "reaction_type"], unique=True,
        )

    if "forum_likes" in tables:
        op.execute(sa.text(
            "INSERT INTO forum_reactions (id, post_id, user_auth_id, reaction_type, created_at) "
            "SELECT id, post_id, user_auth_id, 'like', created_at FROM forum_likes "
            "ON CONFLICT DO NOTHING"
        ))
        op.drop_table("forum_likes")

    if "forum_follows" in tables:
        op.execute(sa.text(
            "INSERT INTO forum_reactions (id, post_id, user_auth_id, reaction_type, created_at) "
            "SELECT id, post_id, user_auth_id, 'follow', created_at FROM forum_follows "
            "ON CONFLICT DO NOTHING"
        ))
        op.drop_table("forum_follows")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if "forum_reactions" not in tables:
        return

    if "forum_likes" not in tables:
        op.create_table(
            "forum_likes",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "post_id", sa.String(),
                sa.ForeignKey("forum_posts.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("user_auth_id", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_forum_likes_post_id", "forum_likes", ["post_id"])
        op.create_index("ix_forum_likes_user_auth_id", "forum_likes", ["user_auth_id"])
        op.create_index(
            "ix_forum_like_post_user", "forum_likes", ["post_id", "user_auth_id"], unique=True,
        )
    if "forum_follows" not in tables:
        op.create_table(
            "forum_follows",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "post_id", sa.String(),
                sa.ForeignKey("forum_posts.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("user_auth_id", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_forum_follows_post_id", "forum_follows", ["post_id"])
        op.create_index("ix_forum_follows_user_auth_id", "forum_follows", ["user_auth_id"])
        op.create_index(
            "ix_forum_follow_post_user", "forum_follows", ["post_id", "user_auth_id"], unique=True,
        )

    op.execute(sa.text(
        "INSERT INTO forum_likes (id, post_id, user_auth_id, created_at) "
        "SELECT id, post_id, user_auth_id, created_at FROM forum_reactions "
        "WHERE reaction_type = 'like'"
    ))
    op.execute(sa.text(
        "INSERT INTO forum_follows (id, post_id, user_auth_id, created_at) "
        "SELECT id, post_id, user_auth_id, created_at FROM forum_reactions "
        "WHERE reaction_type = 'follow'"
    ))
    op.drop_table("forum_reactions")
