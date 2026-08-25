"""日志实时流广播中枢（进程内分发 + 跨 gunicorn worker 经 Redis 广播）。

usage_writer 每次把一批新日志 flush 到 DB 时：
- ``publish_batch`` 向本 worker 已订阅的 SSE 连接推送这批记录的精简版摘要；
- ``broadcast_batch`` 把原始日志批 publish 到 Redis 频道 ``apiplatform:logs``，
  由其余 worker 的订阅协程收到后补查 key_meta、走同样的本地分发——
  生产是 gunicorn 多 worker，SSE 客户端只连其中一个，不广播会丢掉约 3/4 日志。

设计取舍：
- 仅保留最近 60 秒的滑动窗口用于"连接时补漏"，客户端断连重连后不会错过刚落库的记录。
- 防回声：每条消息带发布者实例 id（uuid），订阅协程收到自己发布的那条直接跳过。
- Redis 故障 fail-open：publish / subscribe 任何异常只影响跨 worker 广播，
  退化为实时流仅覆盖本 worker，本地推送不中断。
- 不写 DB、不轮询，纯 asyncio.Queue 分发；key_meta 只在有订阅者一侧补查。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from typing import Any

from app.redis_client import redis

log = logging.getLogger("apiplatform.logstream")

_RECENT_WINDOW_SEC = 60
_MAX_SUBSCRIBERS = 50


class _Sub:
    __slots__ = ("queue", "filter_key", "filter_val")

    def __init__(self, filter_key: str | None, filter_val: str | None) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self.filter_key = filter_key
        self.filter_val = filter_val

    def accepts(self, record: dict[str, Any]) -> bool:
        if not self.filter_key or not self.filter_val:
            return True
        v = record.get(self.filter_key)
        if v is None:
            return False
        if self.filter_key == "auth_id":
            return str(v) == str(self.filter_val)
        if self.filter_key == "department":
            return str(v).lower() == str(self.filter_val).lower()
        return str(v) == str(self.filter_val)


class LogStreamHub:
    def __init__(self) -> None:
        self._subs: set[_Sub] = set()
        self._recent: deque[tuple[float, dict[str, Any]]] = deque()
        self._lock = asyncio.Lock()

    def publish_batch(self, rows: list[dict[str, Any]], key_meta: dict[str, dict[str, str]] | None = None) -> None:
        """把一批落库记录分发给本地 SSE 订阅者。

        调用方有两处：usage_writer 的 flush 线程（DB commit 后）与事件循环上的
        _handle_message。asyncio.Queue / deque 非线程安全，因此**线程侧的写入一律
        经 call_soon_threadsafe 调度回事件循环执行**，杜绝跨线程数据竞争。
        """
        if not rows:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not None:
            # 事件循环上调用（_handle_message 分发、单测）：直接执行，无需调度
            self._publish_on_loop(rows, key_meta or {})
            return
        # 线程侧调用（usage_writer 的 flush 线程）：调度回事件循环，杜绝跨线程竞争
        loop = _listener_loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._publish_on_loop, rows, key_meta or {})

    def _publish_on_loop(self, rows: list[dict[str, Any]], key_meta: dict[str, dict[str, str]]) -> None:
        """事件循环上执行的本地分发（publish_batch 的调度目标）。"""
        if not rows or not self._subs:
            return
        now = time.time()
        key_meta = key_meta or {}
        for raw in rows:
            key_id = raw.get("api_key_id") or ""
            meta = key_meta.get(key_id, {})
            slim = {
                "id": raw.get("id"),
                "request_id": raw.get("request_id"),
                "model_id": raw.get("model_id"),
                "key_name": meta.get("name") or (key_id[:8] if key_id else ""),
                "department": meta.get("department") or "",
                "auth_id": meta.get("auth_id") or "",
                "prompt_tokens": raw.get("prompt_tokens") or 0,
                "completion_tokens": raw.get("completion_tokens") or 0,
                "total_tokens": raw.get("total_tokens") or 0,
                "cache_hit_tokens": raw.get("cache_hit_tokens") or 0,
                "cache_miss_tokens": raw.get("cache_miss_tokens") or 0,
                "latency_ms": raw.get("latency_ms") or 0,
                "total_duration_ms": raw.get("total_duration_ms") or 0,
                "estimated_cost": float(raw.get("estimated_cost") or 0),
                "usage_estimated": bool(raw.get("usage_estimated")),
                "stream": bool(raw.get("stream")),
                "status_code": int(raw["status_code"]) if str(raw.get("status_code") or "").isdigit() else 0,
                "created_at": raw.get("created_at").isoformat() if raw.get("created_at") and hasattr(raw["created_at"], "isoformat") else str(raw.get("created_at") or ""),
                "error_detail": raw.get("error_detail") or "",
            }
            self._recent.append((now, slim))
            dropped: list[_Sub] = []
            for sub in list(self._subs):
                if not sub.accepts(slim):
                    continue
                try:
                    sub.queue.put_nowait(slim)
                except asyncio.QueueFull:
                    dropped.append(sub)
            for sub in dropped:
                self._subs.discard(sub)
        while self._recent and now - self._recent[0][0] > _RECENT_WINDOW_SEC:
            self._recent.popleft()

    async def subscribe(
        self,
        filter_key: str | None = None,
        filter_val: str | None = None,
        since_ts: float | None = None,
    ):
        """返回 async generator，yield 出日志记录 dict。调用方负责关闭（break）。"""
        if len(self._subs) >= _MAX_SUBSCRIBERS:
            return
        sub = _Sub(filter_key, filter_val)
        async with self._lock:
            self._subs.add(sub)
        backlog: list[dict[str, Any]] = []
        if since_ts is not None:
            for ts, rec in self._recent:
                if ts >= since_ts and sub.accepts(rec):
                    backlog.append(rec)
        try:
            for rec in backlog:
                yield rec
            while True:
                rec = await sub.queue.get()
                yield rec
        finally:
            async with self._lock:
                self._subs.discard(sub)

    def subscriber_count(self) -> int:
        return len(self._subs)


log_stream_hub = LogStreamHub()


# ── 跨 worker 广播（复用 db_bridge / fallback 同款 pub/sub 基建）────────────────
_CHANNEL = "apiplatform:logs"
_INSTANCE_ID = uuid.uuid4().hex  # 防回声：订阅协程凭它跳过自己发布的消息
_listener_task: asyncio.Task | None = None
_listener_loop: asyncio.AbstractEventLoop | None = None


def broadcast_batch(rows: list[dict[str, Any]]) -> None:
    """把原始落库批 publish 到 Redis（同步，可从 usage_writer 的 flush 线程调用）。

    不带 key_meta：接收方有本地订阅者时才补查，发布方零额外开销。
    fail-open：Redis 不可达只影响跨 worker 广播，本地推送不中断。
    """
    if not rows:
        return
    loop = _listener_loop
    if loop is None or loop.is_closed():
        return
    payload = json.dumps({"src": _INSTANCE_ID, "rows": rows}, ensure_ascii=False, default=str)
    try:
        asyncio.run_coroutine_threadsafe(_publish(payload), loop)
    except Exception:
        pass


async def _publish(payload: str) -> None:
    try:
        await redis.publish(_CHANNEL, payload)
    except Exception:
        pass  # 广播失败：退化为实时流仅覆盖本 worker


def _fetch_key_meta(key_ids: list[str]) -> dict[str, dict[str, str]]:
    """接收方补查 key 名称/部门/归属（与 usage_writer._broadcast 同一口径）。"""
    from app.database import SessionLocal
    from app.models import ApiKeyORM

    db = SessionLocal()
    try:
        meta: dict[str, dict[str, str]] = {}
        for k in db.query(ApiKeyORM).filter(ApiKeyORM.id.in_(key_ids)).all():
            meta[k.id] = {
                "name": k.name or k.project_name or k.id[:8],
                "department": k.department or "",
                "auth_id": k.auth_id or "",
            }
        return meta
    finally:
        db.close()


async def _handle_message(data: dict[str, Any]) -> None:
    """处理一条频道消息：跳过自己发布的回声，其余批次分发给本地订阅者。"""
    if data.get("src") == _INSTANCE_ID:
        return  # 自己发布的回声，本地 flush 时已分发过
    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        return
    if log_stream_hub.subscriber_count() == 0:
        return  # 本 worker 没有 SSE 订阅者，不补查不分发
    key_ids = sorted({r.get("api_key_id") for r in rows if r.get("api_key_id")})
    key_meta = await asyncio.to_thread(_fetch_key_meta, key_ids) if key_ids else {}
    log_stream_hub.publish_batch(rows, key_meta)


async def _listener() -> None:
    """订阅日志频道；连接异常时退避重连，期间实时流仅覆盖本 worker。"""
    while True:
        pubsub = None
        try:
            pubsub = redis.pubsub()
            await pubsub.subscribe(_CHANNEL)
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    data = json.loads(msg["data"])
                except Exception:
                    continue
                try:
                    await _handle_message(data)
                except Exception as exc:
                    log.warning("跨 worker 日志批分发失败：%s", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("日志流订阅中断（%s），5s 后重连；期间实时流仅覆盖本 worker", exc)
            await asyncio.sleep(5)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass


async def start_log_listener() -> None:
    global _listener_task, _listener_loop
    if _listener_task is None:
        _listener_loop = asyncio.get_running_loop()
        _listener_task = asyncio.create_task(_listener())


async def stop_log_listener() -> None:
    global _listener_task, _listener_loop
    if _listener_task is not None:
        _listener_task.cancel()
        try:
            await _listener_task
        except (asyncio.CancelledError, Exception):
            pass
        _listener_task = None
