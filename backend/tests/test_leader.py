"""多 worker 抢锁（leader.acquire_once）+ 缓存失效广播（pub/sub）单测。"""
from __future__ import annotations

import asyncio

import fakeredis.aioredis
import pytest

from app import leader
from app.proxy import db_bridge


@pytest.fixture
def fake(monkeypatch):
    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(leader, "redis", r)
    monkeypatch.setattr(db_bridge, "redis", r)
    return r


# ── 抢锁 ─────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_acquire_once_only_first_wins(fake):
    # 同一任务键：第一个 worker 抢到，其余全部让位
    assert await leader.acquire_once("ops_report:2026-07-20", 3600) is True
    assert await leader.acquire_once("ops_report:2026-07-20", 3600) is False
    assert await leader.acquire_once("ops_report:2026-07-20", 3600) is False
    # 不同周期键互不影响
    assert await leader.acquire_once("ops_report:2026-07-21", 3600) is True
    # 锁带 TTL，不会永久残留
    assert await fake.ttl("lock:ops_report:2026-07-20") > 0


@pytest.mark.asyncio
async def test_acquire_once_fail_open(monkeypatch):
    class Boom:
        async def set(self, *a, **k):
            raise ConnectionError("redis down")

    monkeypatch.setattr(leader, "redis", Boom())
    # Redis 异常：放行（各 worker 都跑，由任务幂等性兜底）
    assert await leader.acquire_once("any", 60) is True


# ── 缓存失效广播 ──────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_invalidate_broadcast_clears_cache_via_pubsub(fake):
    await db_bridge.start_invalidate_listener()
    try:
        # 等订阅注册完成（pub/sub 不回放订阅前的消息）
        for _ in range(100):
            if await fake.pubsub_channels():
                break
            await asyncio.sleep(0.01)
        db_bridge._prep_cache[("auth", "model")] = (9e18, ("err", 401, "x"))
        # 模拟另一个 worker 发出的失效广播
        await fake.publish(db_bridge._INVALIDATE_CHANNEL, "1")
        for _ in range(50):  # 最多等 0.5s
            await asyncio.sleep(0.01)
            if not db_bridge._prep_cache:
                break
        assert not db_bridge._prep_cache
    finally:
        await db_bridge.stop_invalidate_listener()


@pytest.mark.asyncio
async def test_invalidate_local_clear_without_listener(fake):
    # 未启动监听（如单测/脚本环境）：本进程清空仍即时生效，不抛异常
    db_bridge._prep_cache[("a", "b")] = (9e18, ("err", 401, "x"))
    db_bridge.invalidate_prepare_cache()
    assert not db_bridge._prep_cache
