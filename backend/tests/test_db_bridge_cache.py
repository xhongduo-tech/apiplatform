"""热路径鉴权/模型解析缓存单测：命中零查库、TTL 过期重查、错误结果同样缓存。"""
import pytest
from fastapi import HTTPException

from app.config import settings
from app.proxy import db_bridge


@pytest.fixture(autouse=True)
def cache_env(monkeypatch):
    db_bridge._prep_cache.clear()
    monkeypatch.setattr(settings, "AUTH_CACHE_TTL_S", 3.0)
    clock = {"t": 1000.0}
    monkeypatch.setattr(db_bridge, "_now", lambda: clock["t"])
    yield clock
    db_bridge._prep_cache.clear()


@pytest.mark.asyncio
async def test_cache_hit_skips_db(monkeypatch, cache_env):
    calls = {"n": 0}

    def fake_prepare(auth, requested):
        calls["n"] += 1
        return ("key", "model", None, None)

    monkeypatch.setattr(db_bridge, "_prepare_sync", fake_prepare)
    r1 = await db_bridge.prepare_proxy_request("Bearer k", "m1")
    r2 = await db_bridge.prepare_proxy_request("Bearer k", "m1")
    assert r1 == r2 == ("key", "model", None, None, None)
    assert calls["n"] == 1  # 第二次命中缓存，不再查库


@pytest.mark.asyncio
async def test_cache_expires_after_ttl(monkeypatch, cache_env):
    calls = {"n": 0}

    def fake_prepare(auth, requested):
        calls["n"] += 1
        return ("key", "model", None, None)

    monkeypatch.setattr(db_bridge, "_prepare_sync", fake_prepare)
    await db_bridge.prepare_proxy_request("Bearer k", "m1")
    cache_env["t"] += 3.1  # 越过 TTL
    await db_bridge.prepare_proxy_request("Bearer k", "m1")
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_error_results_cached(monkeypatch, cache_env):
    calls = {"n": 0}

    def fake_prepare(auth, requested):
        calls["n"] += 1
        raise HTTPException(status_code=401, detail="bad key")

    monkeypatch.setattr(db_bridge, "_prepare_sync", fake_prepare)
    for _ in range(3):
        with pytest.raises(HTTPException) as e:
            await db_bridge.prepare_proxy_request("Bearer bad", "m1")
        assert e.value.status_code == 401
    assert calls["n"] == 1  # 无效 key 不打穿到 PG


@pytest.mark.asyncio
async def test_distinct_keys_not_shared(monkeypatch, cache_env):
    monkeypatch.setattr(
        db_bridge, "_prepare_sync", lambda auth, requested: (auth, requested, None, None)
    )
    r1 = await db_bridge.prepare_proxy_request("Bearer a", "m1")
    r2 = await db_bridge.prepare_proxy_request("Bearer b", "m1")
    assert r1[0] == "Bearer a" and r2[0] == "Bearer b"


@pytest.mark.asyncio
async def test_ttl_zero_disables_cache(monkeypatch, cache_env):
    monkeypatch.setattr(settings, "AUTH_CACHE_TTL_S", 0.0)
    calls = {"n": 0}

    def fake_prepare(auth, requested):
        calls["n"] += 1
        return ("key", "model", None, None)

    monkeypatch.setattr(db_bridge, "_prepare_sync", fake_prepare)
    await db_bridge.prepare_proxy_request("Bearer k", "m1")
    await db_bridge.prepare_proxy_request("Bearer k", "m1")
    assert calls["n"] == 2 and not db_bridge._prep_cache
