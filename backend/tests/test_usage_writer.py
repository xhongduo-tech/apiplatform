"""usage_writer 批写可靠性：重试、failover 落盘、恢复回灌。"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select

import app.usage_writer as uw
from app import platform_time
from app.database import SessionLocal
from app.models import (
    ApiKeyORM,
    UsageContextBucketDailyORM,
    UsageDailySummaryORM,
    UsageHourlySummaryORM,
    UsageLogORM,
    UsageRequestProfileORM,
)


@pytest.fixture(autouse=True)
def _restore_failover_path(monkeypatch):
    original = uw._FAILOVER_FILE
    monkeypatch.setattr(uw.time, "sleep", lambda _seconds: None)
    yield
    uw._FAILOVER_FILE = original


def _use_tmp_failover(tmp_path: Path) -> Path:
    f = tmp_path / "usage_failover.jsonl"
    uw._FAILOVER_FILE = f
    if f.exists():
        f.unlink()
    return f


def test_flush_retry_succeeds(tmp_path):
    """瞬时故障：重试后成功，返回 True 且按退避重试。"""
    _use_tmp_failover(tmp_path)
    w = uw.UsageWriter()
    calls = {"n": 0}

    def flaky(batch):
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("simulated db down")

    w._flush = flaky
    assert w._flush_with_retry([{"request_id": "r1"}]) is True
    assert calls["n"] == uw._MAX_FLUSH_RETRIES


def test_flush_retry_exhausts(tmp_path):
    """持续故障：重试耗尽返回 False（交由调用方落 failover）。"""
    _use_tmp_failover(tmp_path)
    w = uw.UsageWriter()
    calls = {"n": 0}

    def always_fail(batch):
        calls["n"] += 1
        raise RuntimeError("still down")

    w._flush = always_fail
    assert w._flush_with_retry([{"request_id": "r2"}]) is False
    assert calls["n"] == uw._MAX_FLUSH_RETRIES


def test_failover_persist_and_recover(tmp_path):
    """落盘后恢复成功 → 文件清空；恢复失败 → 文件保留待下次。"""
    f = _use_tmp_failover(tmp_path)
    w = uw.UsageWriter()
    rec = {"request_id": "r-fail", "api_key_id": "k", "model_id": "m"}
    w._flush = lambda batch: None  # 成功
    assert w._persist_failover([rec]) is True
    assert f.exists() and f.stat().st_size > 0
    w._recover_failover()
    assert not f.exists()  # 成功回灌后文件移除
    assert json.loads(f.with_name(f.name + ".meta").read_text())["count"] == 0

    # 恢复失败 → 文件保留
    def down(batch):
        raise RuntimeError("db down")

    w._flush = down
    assert w._persist_failover([rec]) is True
    w._recover_failover()
    assert f.exists()
    assert f.stat().st_size > 0
    assert json.loads(f.with_name(f.name + ".meta").read_text())["count"] == 1


def test_failover_persist_error_counts_dropped(tmp_path):
    """failover 落盘本身失败才算 dropped（账真正丢失）。"""
    _use_tmp_failover(tmp_path)
    # 指向不可写目录
    uw._FAILOVER_FILE = Path("/nonexistent-dir-xyz/usage_failover.jsonl")
    w = uw.UsageWriter()
    assert w._persist_failover([{"request_id": "r"}]) is False


def test_prepare_record_assigns_stable_event_id_and_timestamp():
    original = {"request_id": "r-stable"}
    first = uw._prepare_record(original)
    replay = uw._prepare_record(first)

    assert first["id"]
    assert replay["id"] == first["id"]
    assert replay["created_at"] == first["created_at"]
    assert "id" not in original  # 调用方对象不被隐式改写


def test_prepare_record_redacts_content_by_default(monkeypatch):
    monkeypatch.setattr(uw.settings, "USAGE_CONTENT_LOGGING_ENABLED", False)
    prepared = uw._prepare_record({
        "status_code": "503",
        "response_preview": '{"choices":[{"message":{"tool_calls":[{"id":"call_1"}]}}],"secret":"用户正文"}',
        "error_detail": "upstream said secret-token and echoed user prompt",
    })

    assert "response_preview" not in prepared
    assert prepared["error_detail"] == "upstream_server_error"
    assert prepared["tool_calls_count"] == 1
    assert "secret-token" not in json.dumps(prepared, default=str)
    assert "用户正文" not in json.dumps(prepared, default=str)


def test_prepare_record_keeps_bounded_content_when_explicitly_enabled(monkeypatch):
    monkeypatch.setattr(uw.settings, "USAGE_CONTENT_LOGGING_ENABLED", True)
    prepared = uw._prepare_record({
        "response_preview": "p" * 700,
        "error_detail": "e" * 1200,
    })

    assert prepared["response_preview"] == "p" * 500
    assert prepared["error_detail"] == "e" * 1000


def test_queue_full_spills_to_failover_before_counting_drop(tmp_path):
    path = _use_tmp_failover(tmp_path)
    writer = uw.UsageWriter()
    writer._queue = asyncio.Queue(maxsize=1)
    writer._queue.put_nowait({"id": "already-queued"})

    writer.enqueue({"request_id": "overflow-event", "api_key_id": "k", "model_id": "m"})

    assert writer.dropped == 0
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["id"]
    assert rows[0]["request_id"] == "overflow-event"


@pytest.mark.asyncio
async def test_stop_naturally_drains_consumer_queue(tmp_path):
    _use_tmp_failover(tmp_path)
    writer = uw.UsageWriter()
    flushed: list[dict] = []
    writer._recover_failover = lambda: None  # type: ignore[method-assign]
    writer._flush_with_retry = lambda batch: flushed.extend(batch) or True  # type: ignore[method-assign]

    await writer.start()
    writer.enqueue({"request_id": "shutdown-drain", "api_key_id": "k", "model_id": "m"})
    await writer.stop()

    assert [record["request_id"] for record in flushed] == ["shutdown-drain"]
    assert writer._task is None


def test_concurrent_workers_append_complete_json_lines(tmp_path):
    path = _use_tmp_failover(tmp_path)

    def append(worker: int) -> None:
        writer = uw.UsageWriter()
        for index in range(40):
            assert writer._persist_failover([{
                "id": f"{worker}-{index}",
                "created_at": datetime(2026, 1, 1),
                "request_id": f"r-{worker}-{index}",
            }])

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(append, range(4)))

    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(rows) == 160
    assert len({row["id"] for row in rows}) == 160
    assert json.loads(path.with_name(path.name + ".meta").read_text())["count"] == 160


def test_recover_quarantines_corrupt_line_and_atomically_removes_wal(tmp_path):
    path = _use_tmp_failover(tmp_path)
    good = uw._prepare_record({"request_id": "good", "api_key_id": "k", "model_id": "m"})
    path.write_text(json.dumps(good, default=str) + "\n{partial-json\n")
    writer = uw.UsageWriter()
    flushed: list[dict] = []
    writer._flush = lambda batch: flushed.extend(batch)  # type: ignore[method-assign]

    writer._recover_failover()

    assert [row["id"] for row in flushed] == [good["id"]]
    assert not path.exists()
    corrupt = path.with_name(path.name + ".corrupt")
    assert corrupt.exists()
    assert "partial-json" in corrupt.read_text()


def test_rollup_uses_each_event_created_at(monkeypatch):
    monkeypatch.setattr(platform_time, "to_local_naive", lambda value: value)
    writer = uw.UsageWriter()

    class FakeDb:
        statements = []

        def execute(self, statement):
            self.statements.append(statement)

    db = FakeDb()
    writer._rollup(db, [
        {"api_key_id": "k", "model_id": "m", "created_at": datetime(2026, 1, 1, 23, 59)},
        {"api_key_id": "k", "model_id": "m", "created_at": datetime(2026, 1, 2, 0, 1)},
    ])

    params = db.statements[0].compile().params
    days = {value for key, value in params.items() if key.startswith("day_m")}
    assert days == {datetime(2026, 1, 1).date(), datetime(2026, 1, 2).date()}


def test_duplicate_replay_is_idempotent_in_postgres(requires_db, monkeypatch):
    monkeypatch.setattr(uw.settings, "USAGE_CONTENT_LOGGING_ENABLED", False)
    marker = uuid4().hex
    key_id = f"usage-writer-key-{marker}"
    event_id = f"usage-writer-event-{marker}"
    created_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5)
    local = platform_time.to_local_naive(created_at)
    record = {
        "id": event_id,
        "request_id": f"request-{marker}",
        "api_key_id": key_id,
        "model_id": "usage-writer-test-model",
        "prompt_tokens": 512,
        "completion_tokens": 8,
        "total_tokens": 520,
        "cache_hit_tokens": 3,
        "status_code": "503",
        "response_preview": "private user response",
        "error_detail": "private upstream error body",
        "created_at": created_at,
    }

    with SessionLocal() as db:
        db.add(ApiKeyORM(
            id=key_id,
            name="usage writer test",
            auth_id=f"auth-{marker}",
            project_name="test",
            department="test",
            scene_type="explore",
            models=[],
            revoked=True,
        ))
        db.commit()

    writer = uw.UsageWriter()
    try:
        assert writer._flush([record, dict(record)]) == 1
        assert writer._flush([dict(record)]) == 0

        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(UsageLogORM).where(UsageLogORM.id == event_id)) == 1
            stored_log = db.get(UsageLogORM, event_id)
            assert stored_log.response_preview is None
            assert stored_log.error_detail == "upstream_server_error"
            daily = db.get(UsageDailySummaryORM, (local.date(), key_id, record["model_id"]))
            hourly = db.get(UsageHourlySummaryORM, (local.date(), local.hour, key_id))
            profile = db.get(UsageRequestProfileORM, event_id)
            assert daily is not None and daily.calls == 1 and daily.total_tokens == 520
            assert hourly is not None and hourly.calls == 1
            assert profile is not None
    finally:
        with SessionLocal() as db:
            db.execute(delete(UsageRequestProfileORM).where(UsageRequestProfileORM.id == event_id))
            db.execute(delete(UsageContextBucketDailyORM).where(UsageContextBucketDailyORM.api_key_id == key_id))
            db.execute(delete(UsageHourlySummaryORM).where(UsageHourlySummaryORM.api_key_id == key_id))
            db.execute(delete(UsageDailySummaryORM).where(UsageDailySummaryORM.api_key_id == key_id))
            db.execute(delete(UsageLogORM).where(UsageLogORM.id == event_id))
            db.execute(delete(ApiKeyORM).where(ApiKeyORM.id == key_id))
            db.commit()
