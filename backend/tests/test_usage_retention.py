"""用量明细保留任务的批量删除回归测试。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy.dialects import postgresql
from sqlalchemy import select

from app.database import SessionLocal
from app.models import UsageRequestProfileORM
from app.usage_retention import _PURGE_BATCH, _batch_delete, _batch_delete_statement


def test_batch_delete_statement_uses_limited_primary_key_subquery():
    cutoff = datetime(2026, 1, 1)
    sql = str(
        _batch_delete_statement(UsageRequestProfileORM, cutoff).compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )

    assert sql.startswith("DELETE FROM usage_request_profile")
    assert "SELECT usage_request_profile.id" in sql
    assert f"LIMIT {_PURGE_BATCH}" in sql
    assert "DELETE FROM usage_request_profile LIMIT" not in sql


def test_batch_delete_removes_only_expired_rows_in_postgres(requires_db):
    marker = uuid4().hex
    expired_id = f"retention-old-{marker}"
    fresh_id = f"retention-new-{marker}"
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    with SessionLocal() as db:
        db.add_all([
            UsageRequestProfileORM(
                id=expired_id,
                api_key_id="retention-test",
                created_at=now - timedelta(days=10),
                prompt_tokens=1,
                tool_calls_count=0,
            ),
            UsageRequestProfileORM(
                id=fresh_id,
                api_key_id="retention-test",
                created_at=now,
                prompt_tokens=1,
                tool_calls_count=0,
            ),
        ])
        db.commit()

        try:
            assert _batch_delete(db, UsageRequestProfileORM, now - timedelta(days=1)) == 1
            remaining = set(
                db.execute(
                    select(UsageRequestProfileORM.id).where(
                        UsageRequestProfileORM.id.in_([expired_id, fresh_id])
                    )
                ).scalars()
            )
            assert remaining == {fresh_id}
        finally:
            db.query(UsageRequestProfileORM).filter(
                UsageRequestProfileORM.id.in_([expired_id, fresh_id])
            ).delete(synchronize_session=False)
            db.commit()
