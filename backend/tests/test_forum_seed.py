"""forum_seed 幂等与内容完整性。"""
from __future__ import annotations

from sqlalchemy import func, select

from app.database import SessionLocal
from app.forum_seed import seed_forum_faq, _FAQ_POSTS, _SEED_MARKER_POST_ID
from app.models import ForumPostORM, ForumReactionORM, ForumReplyORM


def _cleanup_seed(db) -> None:
    db.query(ForumReactionORM).filter(ForumReactionORM.id.like("seed-forum-%")).delete()
    db.query(ForumReplyORM).filter(ForumReplyORM.id.like("seed-forum-reply-%")).delete()
    db.query(ForumPostORM).filter(ForumPostORM.id.like("seed-forum-%")).delete()
    db.commit()


def test_seed_forum_faq_idempotent(requires_db):
    db = SessionLocal()
    try:
        seed_forum_faq(db)
        db.commit()

        seed_forum_faq(db)
        db.commit()

        post_count = db.scalar(
            select(func.count()).select_from(ForumPostORM).where(ForumPostORM.id.like("seed-forum-%"))
        )
        assert post_count == len(_FAQ_POSTS)

        reply_count = db.scalar(
            select(func.count()).select_from(ForumReplyORM).where(ForumReplyORM.id.like("seed-forum-reply-%"))
        )
        expected_replies = sum(len(p.replies) for p in _FAQ_POSTS)
        assert reply_count == expected_replies

        like_count = db.scalar(
            select(func.count())
            .select_from(ForumReactionORM)
            .where(
                ForumReactionORM.id.like("seed-forum-like-%"),
                ForumReactionORM.reaction_type == ForumReactionORM.LIKE,
            )
        )
        follow_count = db.scalar(
            select(func.count())
            .select_from(ForumReactionORM)
            .where(
                ForumReactionORM.id.like("seed-forum-follow-%"),
                ForumReactionORM.reaction_type == ForumReactionORM.FOLLOW,
            )
        )
        assert like_count == sum(p.like_count for p in _FAQ_POSTS)
        assert follow_count == sum(p.follow_count for p in _FAQ_POSTS)

        posts = db.scalars(
            select(ForumPostORM).where(ForumPostORM.id.like("seed-forum-%"))
        ).all()
        for post in posts:
            assert post.author_name == "匿名用户"
            assert post.resolved is True
            replies = db.scalars(
                select(ForumReplyORM).where(ForumReplyORM.post_id == post.id)
            ).all()
            assert len(replies) >= 2
            assert any(r.is_admin for r in replies)
    finally:
        _cleanup_seed(db)
        db.close()


def test_seed_forum_faq_upgrade_from_v1(requires_db):
    """v1 仅一条官方回复时，再次 seed 应补全多轮回复与互动。"""
    db = SessionLocal()
    try:
        from datetime import datetime

        # 模拟 v1：只有帖子和一条官方回复
        db.add(
            ForumPostORM(
                id="seed-forum-001",
                author_auth_id="seed-forum-anon-01",
                author_name="匿名用户",
                title="API Key 怎么申请？审批要多久？",
                content="v1 question",
                resolved=True,
                view_count=100,
                created_at=datetime(2026, 7, 1, 10, 0, 0),
            )
        )
        db.add(
            ForumReplyORM(
                id="seed-forum-reply-001",
                post_id="seed-forum-001",
                author_auth_id="platform-admin",
                author_name="平台管理员",
                is_admin=True,
                content="v1 answer",
                created_at=datetime(2026, 7, 1, 12, 0, 0),
            )
        )
        db.commit()

        seed_forum_faq(db)
        db.commit()

        replies = db.scalars(
            select(ForumReplyORM).where(ForumReplyORM.post_id == "seed-forum-001")
        ).all()
        assert len(replies) == 4  # v1 保留 + 3 条新增

        likes = db.scalar(
            select(func.count())
            .select_from(ForumReactionORM)
            .where(
                ForumReactionORM.post_id == "seed-forum-001",
                ForumReactionORM.reaction_type == ForumReactionORM.LIKE,
            )
        )
        assert likes == 23
    finally:
        _cleanup_seed(db)
        db.close()


def test_seed_forum_faq_marker(requires_db):
    db = SessionLocal()
    try:
        seed_forum_faq(db)
        db.commit()
        marker = db.get(ForumPostORM, _SEED_MARKER_POST_ID)
        assert marker is not None
        assert marker.resolved is True
    finally:
        _cleanup_seed(db)
        db.close()


def test_forum_seed_is_neutral_synthetic_content():
    text = "\n".join(
        part
        for post in _FAQ_POSTS
        for part in (post.title, post.content, *(reply.content for reply in post.replies))
    )
    assert "sk-platform-" in text
    assert "platform-sota" in text
    assert "platform-flash" in text
    assert "demo-reasoning-model" in text
    assert "部署方自行制定" in text
