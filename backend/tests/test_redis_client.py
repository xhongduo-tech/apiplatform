"""Redis direct/Sentinel clients must carry bounded connection and command timeouts."""
from __future__ import annotations

from app.config import settings
from app import redis_client


def test_direct_redis_applies_explicit_socket_timeouts(monkeypatch):
    captured = {}
    marker = object()

    def fake_from_url(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return marker

    monkeypatch.setattr(settings, "REDIS_SENTINEL_NODES", "")
    monkeypatch.setattr(settings, "REDIS_CONNECT_TIMEOUT_S", 1.25)
    monkeypatch.setattr(settings, "REDIS_SOCKET_TIMEOUT_S", 2.5)
    monkeypatch.setattr(redis_client.aioredis, "from_url", fake_from_url)

    assert redis_client._make_redis() is marker
    assert captured["socket_connect_timeout"] == 1.25
    assert captured["socket_timeout"] == 2.5


def test_sentinel_and_discovered_master_apply_explicit_timeouts(monkeypatch):
    import redis.asyncio.sentinel as sentinel_module

    captured = {}
    marker = object()

    class FakeSentinel:
        def __init__(self, nodes, **kwargs):
            captured["nodes"] = nodes
            captured["sentinel"] = kwargs

        def master_for(self, name, **kwargs):
            captured["master_name"] = name
            captured["master"] = kwargs
            return marker

    monkeypatch.setattr(settings, "REDIS_SENTINEL_NODES", "s1:26379,s2:26380")
    monkeypatch.setattr(settings, "REDIS_SENTINEL_MASTER", "gateway-master")
    monkeypatch.setattr(settings, "REDIS_SENTINEL_PASSWORD", "sentinel-secret")
    monkeypatch.setattr(settings, "REDIS_PASSWORD", "redis-secret")
    monkeypatch.setattr(settings, "REDIS_CONNECT_TIMEOUT_S", 1.5)
    monkeypatch.setattr(settings, "REDIS_SOCKET_TIMEOUT_S", 2.75)
    monkeypatch.setattr(sentinel_module, "Sentinel", FakeSentinel)

    assert redis_client._make_redis() is marker
    assert captured["nodes"] == [("s1", 26379), ("s2", 26380)]
    assert captured["sentinel"]["socket_connect_timeout"] == 1.5
    assert captured["sentinel"]["socket_timeout"] == 2.75
    assert captured["sentinel"]["sentinel_kwargs"] == {
        "password": "sentinel-secret",
        "socket_connect_timeout": 1.5,
        "socket_timeout": 2.75,
    }
    assert captured["master_name"] == "gateway-master"
    assert captured["master"]["password"] == "redis-secret"
    assert captured["master"]["socket_connect_timeout"] == 1.5
    assert captured["master"]["socket_timeout"] == 2.75
