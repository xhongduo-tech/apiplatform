"""模型兜底单测：错误分类、熔断与恢复、请求级即时切换、流式安全边界。"""
from __future__ import annotations

import time

import httpx
import pytest

from app.models import ModelRegistryORM
from app.proxy import fallback


def _model(mid: str, **extra_fb) -> ModelRegistryORM:
    fb = {"enabled": True, "target_model_id": "backup", **extra_fb} if extra_fb or True else None
    return ModelRegistryORM(
        id=mid, name=mid, provider="", category="chat",
        base_url="http://up:8000", model_api_name=mid, import_format="openai",
        extra={"fallback": fb},
    )


@pytest.fixture(autouse=True)
def clean_circuit():
    fallback._open_until.clear()
    fallback._open_trips.clear()
    yield
    fallback._open_until.clear()
    fallback._open_trips.clear()


# ── 错误分类 ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("status", [500, 502, 503, 504, 401, 403, 404])
def test_node_failures_trigger_fallback(status):
    """A 类：换个模型能救活。上游 401/404 是平台配置故障——网关已做完鉴权。"""
    assert fallback.is_node_failure(status)
    assert fallback.counts_toward_circuit(status)


@pytest.mark.parametrize("status", [400, 413, 422, 429])
def test_client_errors_never_fallback(status):
    """B 类：请求本身的问题（含上下文超限 413 与过载 429）一律如实透传。"""
    assert not fallback.is_node_failure(status)
    # 也不进熔断统计：进分母会稀释失败率，进分子会因用户乱传参数误伤好模型
    assert not fallback.counts_toward_circuit(status)


def test_success_counts_but_does_not_fail():
    assert not fallback.is_node_failure(200)
    assert fallback.counts_toward_circuit(200)


def test_transport_errors_cover_connect_and_timeout():
    for exc in (httpx.ConnectError("x"), httpx.ReadTimeout("x"),
                httpx.ConnectTimeout("x"), httpx.RemoteProtocolError("x")):
        assert isinstance(exc, fallback.TRANSPORT_ERRORS)


# ── 配置解析 ─────────────────────────────────────────────────────────────────
def test_config_none_when_disabled():
    m = ModelRegistryORM(id="a", name="a", provider="",
                         extra={"fallback": {"enabled": False, "target_model_id": "b"}})
    assert fallback.get_config(m) is None


def test_config_none_without_target():
    m = ModelRegistryORM(id="a", name="a", provider="", extra={"fallback": {"enabled": True}})
    assert fallback.get_config(m) is None


def test_config_none_when_unconfigured():
    """未配兜底的模型完全不参与——不产生任何 Redis 流量。"""
    assert fallback.get_config(ModelRegistryORM(id="a", name="a", provider="")) is None


def test_circuit_disabled_by_default():
    """默认只做请求级即时切换，不启用自动熔断。"""
    cfg = fallback.get_config(_model("a"))
    assert cfg is not None
    assert cfg["circuit_enabled"] is False
    assert fallback.should_divert(_model("a"), cfg) is False


@pytest.mark.asyncio
async def test_circuit_disabled_skips_recording(monkeypatch):
    """circuit_enabled=False 时不打 Redis 点、不翻牌熔断。"""
    called = {"n": 0}

    class _Boom:
        def pipeline(self):
            called["n"] += 1
            raise AssertionError("不应访问 Redis")

    monkeypatch.setattr(fallback, "redis", _Boom())
    cfg = fallback.get_config(_model("a", circuit_enabled=False))
    await fallback.record_ok("a", cfg)
    await fallback.record_fail("a", cfg)
    assert called["n"] == 0


def test_circuit_enabled_respects_open_state():
    m = _model("a", circuit_enabled=True)
    cfg = fallback.get_config(m)
    fallback._open_until["a"] = time.time() + 60
    assert fallback.should_divert(m, cfg) is True
    cfg_off = fallback.get_config(_model("a", circuit_enabled=False))
    assert fallback.should_divert(m, cfg_off) is False


def test_config_clamps_bad_values():
    m = _model("a", trip_fails=0, window_s="oops", trip_rate=9.9, cooldown_s=99999,
               max_cooldown_s=600)
    cfg = fallback.get_config(m)
    assert cfg["trip_fails"] == 1           # 下限钳到 1
    assert cfg["window_s"] == fallback.DEFAULTS["window_s"]  # 非法值回落默认
    assert cfg["trip_rate"] == 1.0          # 上限钳到 1.0
    assert cfg["cooldown_s"] == 600         # 不得超过退避上限


# ── 熔断状态与恢复 ───────────────────────────────────────────────────────────
def test_circuit_expires_on_its_own():
    """熔断态是带 TTL 的标记，到期自然消失——「半开」由此免费得到。"""
    fallback._apply_open("m1", time.time() + 0.05, 1)
    assert fallback.circuit_open("m1")
    time.sleep(0.06)
    assert not fallback.circuit_open("m1")
    assert "m1" not in fallback._open_until  # 读取时顺手剔除，无需清理任务


def test_circuit_state_reports_remaining_and_trips():
    fallback._apply_open("m1", time.time() + 30, 3)
    st = fallback.circuit_state("m1")
    assert st["open"] and st["trips"] == 3
    assert 25 <= st["remaining_s"] <= 30
    assert fallback.circuit_state("other") is None


def test_forced_diverts_without_circuit():
    """人工强制熔断走库里的配置，不依赖 Redis、不会自动恢复。"""
    m = _model("a", forced=True)
    assert fallback.should_divert(m, fallback.get_config(m))


def test_should_divert_false_without_config():
    m = ModelRegistryORM(id="a", name="a", provider="")
    assert not fallback.should_divert(m, None)


def test_retry_resolved_id_only_for_virtual_requests():
    target = ModelRegistryORM(id="backup", name="b", provider="")
    # 原请求指向虚拟模型 → 改报实际生效的兜底模型
    assert fallback.retry_resolved_id("deepseek-v4", target) == "backup"
    # 原请求直接点名实模型 → 本就没有 X-Resolved-Model
    assert fallback.retry_resolved_id(None, target) is None


# ── 打点：after_upstream 是唯一取样点 ─────────────────────────────────────────
@pytest.mark.asyncio
async def test_after_upstream_signals_fallback_on_node_failure(monkeypatch):
    seen = []
    monkeypatch.setattr(fallback, "record_fail", lambda mid, cfg: _noop(seen, "fail"))
    monkeypatch.setattr(fallback, "record_ok", lambda mid, cfg: _noop(seen, "ok"))
    m = _model("a")
    cfg = fallback.get_config(m)

    assert await fallback.after_upstream(m, cfg, 503, can_fallback=True) is True
    assert await fallback.after_upstream(m, cfg, None, can_fallback=True) is True  # 建连失败
    assert seen == ["fail", "fail"]


@pytest.mark.asyncio
async def test_after_upstream_no_fallback_target_still_records(monkeypatch):
    """没配兜底目标时不切换，但故障照样计入熔断统计。"""
    seen = []
    monkeypatch.setattr(fallback, "record_fail", lambda mid, cfg: _noop(seen, "fail"))
    m = _model("a")
    assert await fallback.after_upstream(m, fallback.get_config(m), 500, can_fallback=False) is False
    assert seen == ["fail"]


@pytest.mark.asyncio
async def test_after_upstream_skips_client_errors(monkeypatch):
    seen = []
    monkeypatch.setattr(fallback, "record_fail", lambda mid, cfg: _noop(seen, "fail"))
    monkeypatch.setattr(fallback, "record_ok", lambda mid, cfg: _noop(seen, "ok"))
    m = _model("a")
    cfg = fallback.get_config(m)
    for status in (400, 413, 422, 429):
        assert await fallback.after_upstream(m, cfg, status, can_fallback=True) is False
    assert seen == []  # B 类既不进分子也不进分母


async def _noop(sink: list, tag: str) -> None:
    sink.append(tag)


# ── 熔断触发：双阈值 + 指数退避 ───────────────────────────────────────────────
class _FakeRedis:
    """够用的 Redis 替身：pipeline/incr/decr/set(nx)/expire/delete/publish。"""

    def __init__(self):
        self.store: dict[str, int | str] = {}
        self.published: list = []

    def pipeline(self):
        return _FakePipe(self)

    async def incr(self, k):
        self.store[k] = int(self.store.get(k, 0)) + 1
        return self.store[k]

    async def decr(self, k):
        self.store[k] = int(self.store.get(k, 0)) - 1
        return self.store[k]

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.store:
            return None
        self.store[k] = v
        return True

    async def expire(self, k, ttl):
        return True

    async def delete(self, *keys):
        for k in keys:
            self.store.pop(k, None)

    async def publish(self, ch, payload):
        self.published.append((ch, payload))


class _FakePipe:
    def __init__(self, r):
        self.r, self.ops = r, []

    def incr(self, k):
        self.ops.append(("incr", k))

    def expire(self, k, ttl):
        self.ops.append(("expire", k))

    async def execute(self):
        out = []
        for op, k in self.ops:
            out.append(await self.r.incr(k) if op == "incr" else True)
        return out


@pytest.fixture
def fake_redis(monkeypatch):
    r = _FakeRedis()
    monkeypatch.setattr(fallback, "redis", r)
    return r


@pytest.mark.asyncio
async def test_trip_requires_both_thresholds(fake_redis):
    """失败数够但失败率不够 → 不熔断。高流量模型的零星故障不该误伤。"""
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 3, "trip_rate": 0.5, "window_s": 60, "cooldown_s": 120, "max_cooldown_s": 1800}
    for _ in range(20):
        await fallback.record_ok("m1", cfg)
    for _ in range(3):
        await fallback.record_fail("m1", cfg)
    assert not fallback.circuit_open("m1")  # 3/23 ≈ 13%，远低于 50%

    for _ in range(20):
        await fallback.record_fail("m1", cfg)
    assert fallback.circuit_open("m1")


@pytest.mark.asyncio
async def test_trip_broadcasts_to_other_workers(fake_redis):
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 2, "trip_rate": 0.5, "window_s": 60, "cooldown_s": 60, "max_cooldown_s": 1800}
    for _ in range(2):
        await fallback.record_fail("m1", cfg)
    assert fallback.circuit_open("m1")
    assert fake_redis.published and fake_redis.published[0][0] == "apiplatform:circuit"


@pytest.mark.asyncio
async def test_cooldown_backs_off_exponentially(fake_redis):
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 1, "trip_rate": 0.0, "window_s": 60, "cooldown_s": 100, "max_cooldown_s": 1000}
    await fallback._trip("m1", cfg)
    first = fallback._open_until["m1"] - time.time()
    assert 95 <= first <= 100

    # 冷却结束后原模型仍坏 → 再次熔断，时长翻倍
    fallback._apply_close("m1")
    fake_redis.store.pop("fb:open:m1")
    await fallback._trip("m1", cfg)
    second = fallback._open_until["m1"] - time.time()
    assert 195 <= second <= 200
    assert fallback._open_trips["m1"] == 2


@pytest.mark.asyncio
async def test_cooldown_capped_at_max(fake_redis):
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 1, "trip_rate": 0.0, "window_s": 60, "cooldown_s": 100, "max_cooldown_s": 300}
    for _ in range(6):
        fallback._apply_close("m1")
        fake_redis.store.pop("fb:open:m1", None)
        await fallback._trip("m1", cfg)
    assert fallback._open_until["m1"] - time.time() <= 300


@pytest.mark.asyncio
async def test_concurrent_trip_does_not_inflate_backoff(fake_redis):
    """多 worker 同时翻牌：SET NX 只让一个生效，其余回退自己的退避计数。"""
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 1, "trip_rate": 0.0, "window_s": 60, "cooldown_s": 100, "max_cooldown_s": 1000}
    await fallback._trip("m1", cfg)
    fallback._apply_close("m1")   # 模拟另一个 worker：内存副本还不知道已熔断
    await fallback._trip("m1", cfg)
    assert int(fake_redis.store["fb:trips:m1"]) == 1  # 未被重复累加


@pytest.mark.asyncio
async def test_force_close_clears_state_and_backoff(fake_redis):
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 1, "trip_rate": 0.0, "window_s": 60, "cooldown_s": 600, "max_cooldown_s": 1800}
    await fallback._trip("m1", cfg)
    assert fallback.circuit_open("m1")

    await fallback.force_close("m1")
    assert not fallback.circuit_open("m1")
    assert "fb:open:m1" not in fake_redis.store
    assert "fb:trips:m1" not in fake_redis.store  # 退避重置，下次从最短冷却起
    assert fake_redis.published[-1][1] == '{"model": "m1", "close": true}'


# ── fail-open：Redis 异常绝不放大成业务错误 ───────────────────────────────────
@pytest.mark.asyncio
async def test_redis_down_does_not_trip(monkeypatch):
    class _Broken:
        def pipeline(self):
            raise RuntimeError("redis down")

    monkeypatch.setattr(fallback, "redis", _Broken())
    cfg = {**fallback.DEFAULTS, "circuit_enabled": True, "target_model_id": "b",
           "trip_fails": 1, "trip_rate": 0.0}
    await fallback.record_fail("m1", cfg)   # 不得抛
    await fallback.record_ok("m1", cfg)
    # 熔断不了就退回到只有第 1 层即时切换，绝不因协调层抖动误切全平台流量
    assert not fallback.circuit_open("m1")
