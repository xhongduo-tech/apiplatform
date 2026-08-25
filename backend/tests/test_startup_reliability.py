"""多 worker 冷启动、迁移锁、连接预算和探针语义。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading
import time

import pytest

from app import database
from app.config import settings


def test_database_connection_budget_accepts_safe_defaults(monkeypatch):
    class Result:
        def scalar_one(self):
            return "200"

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, _statement):
            return Result()

    class Engine:
        def connect(self):
            return Connection()

    monkeypatch.setattr(database, "engine", Engine())
    monkeypatch.setattr(settings, "DB_POOL_SIZE", 8)
    monkeypatch.setattr(settings, "DB_MAX_OVERFLOW", 4)
    monkeypatch.setattr(settings, "GUNICORN_WORKERS", 4)
    monkeypatch.setattr(settings, "DB_APP_INSTANCES", 1)
    monkeypatch.setattr(settings, "DB_CONNECTION_RESERVE", 32)

    database.validate_connection_budget()


def test_database_connection_budget_rejects_oversubscription(monkeypatch):
    class Result:
        def scalar_one(self):
            return "100"

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, _statement):
            return Result()

    class Engine:
        def connect(self):
            return Connection()

    monkeypatch.setattr(database, "engine", Engine())
    monkeypatch.setattr(settings, "DB_POOL_SIZE", 20)
    monkeypatch.setattr(settings, "DB_MAX_OVERFLOW", 20)
    monkeypatch.setattr(settings, "GUNICORN_WORKERS", 4)
    monkeypatch.setattr(settings, "DB_APP_INSTANCES", 1)
    monkeypatch.setattr(settings, "DB_CONNECTION_RESERVE", 16)

    with pytest.raises(RuntimeError, match="超过 PostgreSQL 上限"):
        database.validate_connection_budget()


def test_migration_upgrade_holds_and_releases_advisory_lock(monkeypatch):
    from app import migration_lock

    calls: list[tuple] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            calls.append(("close",))

        def execute(self, sql, params):
            calls.append((sql, params))

    monkeypatch.setattr(
        migration_lock.psycopg,
        "connect",
        lambda url, autocommit: calls.append(("connect", url, autocommit)) or Connection(),
    )
    monkeypatch.setattr(
        migration_lock.command,
        "upgrade",
        lambda _config, target: calls.append(("upgrade", target)),
    )

    migration_lock.upgrade_head(
        database_url="postgresql+psycopg://u:p@db/test",
        config_path="alembic.ini",
    )

    lock_index = next(i for i, call in enumerate(calls) if "pg_advisory_lock" in str(call[0]))
    upgrade_index = calls.index(("upgrade", "head"))
    unlock_index = next(i for i, call in enumerate(calls) if "pg_advisory_unlock" in str(call[0]))
    assert lock_index < upgrade_index < unlock_index


def test_seed_transactions_are_serialized_in_postgres(requires_db, monkeypatch):
    """两个模拟 worker 同时冷启动时，种子临界区最大并发必须为 1。"""
    from app import main

    state = {"active": 0, "maximum": 0}
    state_lock = threading.Lock()

    def guarded_seed(_db):
        with state_lock:
            state["active"] += 1
            state["maximum"] = max(state["maximum"], state["active"])
        time.sleep(0.1)
        with state_lock:
            state["active"] -= 1

    monkeypatch.setattr(main, "seed_catalog_models", guarded_seed)
    monkeypatch.setattr(main, "seed_scene_types", lambda _db: None)
    monkeypatch.setattr(main, "seed_forum_faq", lambda _db: None)
    monkeypatch.setattr(settings, "DEMO_DATA_ENABLED", False)

    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(lambda _index: main._seed_catalog(), range(2)))

    assert state["maximum"] == 1


@pytest.mark.asyncio
async def test_lifespan_checks_dependencies_before_starting_tasks(monkeypatch):
    from app import main

    calls: list[str] = []
    monkeypatch.setattr(main, "_validate_runtime_config", lambda: calls.append("config"))
    monkeypatch.setattr(main, "_startup_db_work", lambda: calls.append("database"))

    async def ping():
        calls.append("redis")
        return True

    monkeypatch.setattr(main.redis, "ping", ping)
    monkeypatch.setattr(main.redis, "aclose", _named_async(calls, "close-redis"))
    monkeypatch.setattr(main.usage_writer, "start", _named_async(calls, "start-writer"))
    monkeypatch.setattr(main.usage_writer, "stop", _named_async(calls, "stop-writer"))
    monkeypatch.setattr(main.ops_scheduler, "start", _named_async(calls, "start-ops"))
    monkeypatch.setattr(main.ops_scheduler, "stop", _named_async(calls, "stop-ops"))
    monkeypatch.setattr(main.usage_retention, "start", _named_async(calls, "start-retention"))
    monkeypatch.setattr(main.usage_retention, "stop", _named_async(calls, "stop-retention"))
    monkeypatch.setattr(main, "start_invalidate_listener", _named_async(calls, "start-cache"))
    monkeypatch.setattr(main, "stop_invalidate_listener", _named_async(calls, "stop-cache"))
    monkeypatch.setattr(main, "start_circuit_listener", _named_async(calls, "start-circuit"))
    monkeypatch.setattr(main, "stop_circuit_listener", _named_async(calls, "stop-circuit"))
    monkeypatch.setattr(main, "start_log_listener", _named_async(calls, "start-log"))
    monkeypatch.setattr(main, "stop_log_listener", _named_async(calls, "stop-log"))
    monkeypatch.setattr(main, "close_client", _named_async(calls, "close-http"))
    monkeypatch.setattr(main.engine, "dispose", lambda: calls.append("close-db"))

    async with main.lifespan(main.app):
        assert main.app.state.ready is True
        calls.append("serving")

    assert calls.index("database") < calls.index("redis") < calls.index("start-writer")
    assert calls.index("stop-writer") < calls.index("close-db")
    assert main.app.state.ready is False


def _named_async(calls: list[str], name: str):
    async def action(*_args, **_kwargs):
        calls.append(name)

    return action
