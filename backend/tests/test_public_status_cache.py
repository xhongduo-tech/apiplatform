"""匿名平台状态聚合的缓存、超时与降级限流。"""
from __future__ import annotations

import pytest
from starlette.requests import Request

from app.config import settings
from app.routers import public


class FakePipeline:
    def __init__(self, owner):
        self.owner = owner

    def incr(self, _key):
        return self

    def expire(self, _key, _ttl):
        return self

    async def execute(self):
        self.owner.count += 1
        return [self.owner.count, True]


class FakeRedis:
    count = 0
    values: dict[str, str] = {}

    def pipeline(self):
        return FakePipeline(self)

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, **_kwargs):
        self.values[key] = value


@pytest.fixture(autouse=True)
def clear_status_state(monkeypatch):
    with public._STATUS_CACHE_LOCK:
        public._STATUS_CACHE.clear()
    with public._STATUS_LOCAL_RATE_LOCK:
        public._STATUS_LOCAL_RATE.clear()
    fake_redis = FakeRedis()
    fake_redis.count = 0
    fake_redis.values = {}
    monkeypatch.setattr(public, "redis", fake_redis)
    monkeypatch.setattr(settings, "PUBLIC_STATUS_CACHE_TTL_S", 10)
    monkeypatch.setattr(settings, "PUBLIC_STATUS_RATE_PER_MINUTE", 120)


def _request(ip: str = "127.0.0.1") -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": (ip, 1234)})


def test_spoofed_forwarded_ip_is_ignored_without_trusted_proxy(monkeypatch):
    monkeypatch.setattr(settings, "TRUST_PROXY_HEADERS", False)
    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(b"x-real-ip", b"198.51.100.8")],
        "client": ("192.0.2.7", 1234),
    })
    assert public._client_ip(request) == "192.0.2.7"


def test_every_expensive_public_status_route_has_rate_dependency():
    guarded_paths = {
        "/public/platform-status/breakdown",
        "/public/platform-status/tool-calls",
        "/public/platform-status/context-length",
        "/public/platform-status/heatmap",
    }
    guarded = {
        route.path
        for route in public.router.routes
        if route.path in guarded_paths
        and any(
            dependency.call is public._public_status_rate_dependency
            for dependency in route.dependant.dependencies
        )
    }
    assert guarded == guarded_paths


@pytest.mark.asyncio
async def test_platform_status_reuses_process_cache(monkeypatch):
    calls = {"count": 0}

    def query(cache_key, trend_days, dist_days):
        calls["count"] += 1
        result = {"trend_days": trend_days, "dist_days": dist_days, "value": 1}
        public._status_cache_set(cache_key, result)
        return result

    monkeypatch.setattr(public, "_query_platform_status_cached", query)
    first = await public.platform_status(_request(), trend_days=14, dist_days=30)
    second = await public.platform_status(_request(), trend_days=14, dist_days=30)

    assert first == second
    assert calls["count"] == 1


def test_query_sets_transaction_local_statement_timeout(monkeypatch):
    executed: list[tuple] = []

    class Db:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, statement, params):
            executed.append((str(statement), params))

    monkeypatch.setattr(public, "SessionLocal", lambda: Db())
    monkeypatch.setattr(settings, "PUBLIC_STATUS_QUERY_TIMEOUT_MS", 1234)
    monkeypatch.setattr(
        public,
        "_build_platform_status",
        lambda trend_days, dist_days, db: {"trend_days": trend_days, "dist_days": dist_days},
    )

    result = public._query_platform_status_cached("unique-timeout-key", 7, 14)

    assert result == {"trend_days": 7, "dist_days": 14}
    assert "statement_timeout" in executed[0][0]
    assert executed[0][1] == {"timeout": "1234ms"}


@pytest.mark.asyncio
async def test_rate_limit_falls_back_to_process_counter(monkeypatch):
    class BrokenRedis:
        def pipeline(self):
            raise RuntimeError("redis down")

    monkeypatch.setattr(public, "redis", BrokenRedis())
    monkeypatch.setattr(settings, "PUBLIC_STATUS_RATE_PER_MINUTE", 2)
    request = _request("192.0.2.10")

    await public._check_public_status_rate(request)
    await public._check_public_status_rate(request)
    with pytest.raises(Exception) as exc:
        await public._check_public_status_rate(request)
    assert getattr(exc.value, "status_code", None) == 429
