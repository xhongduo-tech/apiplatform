"""认证端点限流：Redis 跨进程计数 + 始终启用的进程内故障兜底。"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

from fastapi import HTTPException, Request

from app.config import settings
from app.redis_client import redis


@dataclass
class _Window:
    count: int
    reset_at: float


class _LocalFixedWindowLimiter:
    """有界进程内固定窗口；协调层故障时仍能阻挡单点爆破。"""

    def __init__(self, max_keys: int = 20_000):
        self._max_keys = max_keys
        self._windows: OrderedDict[str, _Window] = OrderedDict()
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_s: int) -> int | None:
        now = time.monotonic()
        with self._lock:
            item = self._windows.get(key)
            if item is None or item.reset_at <= now:
                item = _Window(count=0, reset_at=now + window_s)
                self._windows[key] = item
            item.count += 1
            self._windows.move_to_end(key)
            while len(self._windows) > self._max_keys:
                self._windows.popitem(last=False)
            if item.count > limit:
                return max(1, int(item.reset_at - now))
        return None

    def clear(self) -> None:
        with self._lock:
            self._windows.clear()


_local = _LocalFixedWindowLimiter()
_REDIS_AUTH_TIMEOUT_S = 1.0

# 原子 INCR，并只在新窗口首次命中时设置过期，避免并发请求产生永久 Redis key。
_REDIS_WINDOW_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
"""


def _opaque(value: str) -> str:
    return hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        value.encode("utf-8", errors="replace"),
        hashlib.sha256,
    ).hexdigest()[:32]


def client_identity(request: Request) -> str:
    """仅在明确声明位于可信反代后方时采用反代传入的客户端地址。"""
    if settings.TRUST_PROXY_HEADERS:
        for header in ("x-real-ip", "x-forwarded-for"):
            raw = request.headers.get(header, "").split(",", 1)[0].strip()
            if raw:
                return raw[:128]
    return (request.client.host if request.client else "unknown")[:128]


def _raise_limited(retry_after: int) -> None:
    raise HTTPException(
        status_code=429,
        detail="尝试过于频繁，请稍后重试",
        headers={"Retry-After": str(max(1, retry_after))},
    )


async def enforce_auth_rate(
    request: Request,
    *,
    action: str,
    account: str,
    client_limit: int,
    account_limit: int,
    window_s: int,
) -> None:
    """同时限制客户端与账号；本地计数先执行，Redis 失败不会放行无限请求。"""
    client_key = f"auth:{action}:client:{_opaque(client_identity(request))}"
    account_key = f"auth:{action}:account:{_opaque(account.strip().casefold() or '<empty>')}"

    for key, limit in ((client_key, client_limit), (account_key, account_limit)):
        retry = _local.hit(key, limit, window_s)
        if retry is not None:
            _raise_limited(retry)

    try:
        pipe = redis.pipeline()
        pipe.eval(_REDIS_WINDOW_SCRIPT, 1, client_key, window_s)
        pipe.eval(_REDIS_WINDOW_SCRIPT, 1, account_key, window_s)
        client_result, account_result = await asyncio.wait_for(
            pipe.execute(), timeout=_REDIS_AUTH_TIMEOUT_S,
        )
        for result, limit in ((client_result, client_limit), (account_result, account_limit)):
            count = int(result[0])
            retry = max(1, int(result[1]) if int(result[1]) > 0 else window_s)
            if count > limit:
                _raise_limited(retry)
    except HTTPException:
        raise
    except Exception:
        # 本地计数已完成，协调层异常不会让认证端点失去保护。
        return


def reset_local_auth_rate_limits() -> None:
    """测试辅助；生产代码无需主动清空窗口。"""
    _local.clear()
