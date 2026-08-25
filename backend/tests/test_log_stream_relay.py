"""实时日志流跨 worker 广播：他实例消息落地、自己回声跳过、Redis 故障 fail-open。"""
from __future__ import annotations

import asyncio

import pytest

from app import log_stream
from app.log_stream import LogStreamHub

_ROW = {
    "id": 1,
    "request_id": "r1",
    "model_id": "deepseek-v4",
    "api_key_id": "k1",
    "status_code": "200",
    "created_at": "2026-08-05T00:00:00",
    "total_tokens": 7,
}


async def _next_record(hub: LogStreamHub):
    async for rec in hub.subscribe():
        return rec
    return None


async def _await_subscriber(hub: LogStreamHub) -> None:
    for _ in range(100):
        if hub.subscriber_count():
            return
        await asyncio.sleep(0)
    raise AssertionError("订阅者未注册")


@pytest.fixture
def hub(monkeypatch) -> LogStreamHub:
    """隔离模块级单例：每个用例一个干净的 hub，不查真库的 key_meta。"""
    h = LogStreamHub()
    monkeypatch.setattr(log_stream, "log_stream_hub", h)
    monkeypatch.setattr(log_stream, "_fetch_key_meta", lambda key_ids: {})
    return h


@pytest.mark.asyncio
async def test_remote_instance_message_reaches_local_subscriber(hub):
    """其他 worker 发布的日志批，经订阅协程分发给本 worker 的 SSE 订阅者。"""
    task = asyncio.create_task(_next_record(hub))
    await _await_subscriber(hub)

    await log_stream._handle_message({"src": "other-worker", "rows": [dict(_ROW)]})

    rec = await asyncio.wait_for(task, timeout=1)
    assert rec["id"] == 1
    assert rec["model_id"] == "deepseek-v4"
    assert rec["total_tokens"] == 7


@pytest.mark.asyncio
async def test_own_message_is_skipped(hub, monkeypatch):
    """自己 publish 的消息回流到本 worker 订阅协程时必须跳过（本地 flush 已分发）。"""
    calls: list = []
    monkeypatch.setattr(hub, "publish_batch", lambda rows, key_meta=None: calls.append(rows))

    await log_stream._handle_message({"src": log_stream._INSTANCE_ID, "rows": [dict(_ROW)]})

    assert calls == []


@pytest.mark.asyncio
async def test_redis_failure_does_not_break_local_push(hub, monkeypatch):
    """Redis publish 抛异常只影响跨 worker 广播；本地推送照常，异常不外溢。"""

    class _BrokenRedis:
        def __init__(self) -> None:
            self.calls = 0

        async def publish(self, channel, payload):
            self.calls += 1
            raise ConnectionError("redis down")

    broken = _BrokenRedis()
    monkeypatch.setattr(log_stream, "redis", broken)
    monkeypatch.setattr(log_stream, "_listener_loop", asyncio.get_running_loop())

    log_stream.broadcast_batch([dict(_ROW)])  # 不抛异常
    for _ in range(100):
        if broken.calls:
            break
        await asyncio.sleep(0)
    assert broken.calls == 1  # 尝试过广播，失败被静默

    task = asyncio.create_task(_next_record(hub))
    await _await_subscriber(hub)
    hub.publish_batch([dict(_ROW)], {})
    rec = await asyncio.wait_for(task, timeout=1)
    assert rec["id"] == 1
