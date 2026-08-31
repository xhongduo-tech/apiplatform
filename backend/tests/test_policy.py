"""RPM/TPM 限流单测：预扣、校正、显式豁免与 Redis fail-closed。"""
from types import SimpleNamespace

import fakeredis.aioredis
import pytest
from fastapi import HTTPException

from app.config import settings
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import policy

_FIXED_NOW = 1_700_000_000.0
_BUCKET = int(_FIXED_NOW // 60)


@pytest.fixture(autouse=True)
def fake_env(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(policy, "redis", fake)
    # 固定时钟：避免测试跨分钟边界导致桶切换
    monkeypatch.setattr(policy, "time", SimpleNamespace(time=lambda: _FIXED_NOW))
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 0)  # 关闭 RPM 干扰
    monkeypatch.setattr(settings, "RATE_LIMIT_TPM", 10_000)
    # 固定为「白天」：限流测试不受夜间不限流窗口影响（否则夜里跑 CI 会假失败）
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", False)
    monkeypatch.setattr(settings, "RATE_LIMIT_MODEL_EXEMPTIONS_ENABLED", False)
    return fake


def _key():
    return ApiKeyORM(
        id="k1", name="t", auth_id="a", project_name="p",
        department="d", models=[],
    )


@pytest.mark.asyncio
async def test_tpm_reserve_blocks_concurrent_overshoot(fake_env):
    # 第一个请求预扣 6000；第二个 6000 会超过 10000 上限 → 429
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    assert reserved == 6_000
    with pytest.raises(HTTPException) as e:
        await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    assert e.value.status_code == 429


@pytest.mark.asyncio
async def test_tpm_empty_bucket_rejects_oversized_request(fake_env):
    # 单请求预算本身超过 TPM 时直接拒绝；空桶不再是超额放行后门。
    with pytest.raises(HTTPException) as exc:
        await policy.enforce_pre(_key(), None, None, est_tokens=50_000)
    assert exc.value.status_code == 429
    assert "单请求 token 预算" in exc.value.detail
    assert await fake_env.get(f"rl:tpm:k1:{_BUCKET}") is None
    assert await fake_env.get(f"rl:rpm:k1:{_BUCKET}") is None


@pytest.mark.asyncio
async def test_record_tokens_corrects_delta(fake_env):
    await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    # 实际用量 8000：补记差额 +2000
    await policy.record_tokens("k1", 8_000, reserved=6_000)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 8_000
    # 实际用量低于预扣：负差额退还
    await policy.record_tokens("k1", 1_000, reserved=3_000)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 6_000


@pytest.mark.asyncio
async def test_record_tokens_keeps_reservation_when_usage_unknown(fake_env):
    await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    # 流中断拿不到 usage：不校正，预扣值即记账
    await policy.record_tokens("k1", None, reserved=6_000)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 6_000


@pytest.mark.asyncio
async def test_rpm_limit(fake_env, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 2)
    await policy.enforce_pre(_key(), None, None)
    await policy.enforce_pre(_key(), None, None)
    with pytest.raises(HTTPException) as e:
        await policy.enforce_pre(_key(), None, None)
    assert e.value.status_code == 429
    # 计数键必须带 TTL（INCR+EXPIRE 同 pipeline，不留无 TTL 泄漏键）
    assert await fake_env.ttl(f"rl:rpm:k1:{_BUCKET}") > 0


@pytest.mark.asyncio
async def test_effective_rate_limits_semantics(monkeypatch):
    # None=平台默认；负数=无限(0)；正数=该值
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 600)
    monkeypatch.setattr(settings, "RATE_LIMIT_TPM", 6_000_000)
    k = _key()
    assert policy.effective_rate_limits(k) == (600, 6_000_000)   # 默认
    k.rpm_limit, k.tpm_limit = -1, -1
    assert policy.effective_rate_limits(k) == (0, 0)             # 无限
    k.rpm_limit, k.tpm_limit = 2000, 99
    assert policy.effective_rate_limits(k) == (2000, 99)         # 具体值


@pytest.mark.asyncio
async def test_unlimited_key_never_429(fake_env, monkeypatch):
    # rpm_limit=-1（无限）→ 无论多少请求都不 429
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 2)
    k = _key()
    k.rpm_limit = -1
    k.tpm_limit = -1
    for _ in range(20):
        await policy.enforce_pre(k, None, None, est_tokens=1_000_000)  # 远超平台默认也放行


@pytest.mark.asyncio
async def test_per_key_limit_overrides_platform_default(fake_env, monkeypatch):
    # 平台默认 RPM=1，但该 Key 被管理员上调到 3 → 第 2、3 个请求仍放行
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 1)
    k = _key()
    k.rpm_limit = 3
    await policy.enforce_pre(k, None, None)
    await policy.enforce_pre(k, None, None)
    await policy.enforce_pre(k, None, None)
    with pytest.raises(HTTPException):
        await policy.enforce_pre(k, None, None)
    # TPM 覆盖：Key 上限 500 < 平台默认 10000 → 按 Key 值管控（也支持下调）
    k2 = _key()
    k2.id = "k2"
    k2.tpm_limit = 500
    await policy.enforce_pre(k2, None, None, est_tokens=400)  # 空桶内的合法预算正常预扣
    with pytest.raises(HTTPException):
        await policy.enforce_pre(k2, None, None, est_tokens=400)


@pytest.mark.asyncio
async def test_tpm_atomic_reserve_no_toctou(fake_env):
    # 原子预扣：桶内已有用量时，两个并发大请求不可能都通过
    # （旧实现 GET→INCRBY 之间的竞态会让两者都看到旧值）
    await policy.enforce_pre(_key(), None, None, est_tokens=100)  # 桶非空
    r1 = await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    assert r1 == 6_000
    with pytest.raises(HTTPException):
        await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    # 被拒请求的预扣必须已回退：6100 + 6000 会超限，但当前桶应仍是 6100
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 6_100


@pytest.mark.asyncio
async def test_refund_tokens_returns_reservation(fake_env):
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=5_000)
    await policy.refund_tokens("k1", reserved)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 0
    # 返还后预算恢复，后续请求可正常预扣
    assert await policy.enforce_pre(_key(), None, None, est_tokens=8_000) == 8_000


@pytest.mark.asyncio
async def test_refund_tokens_clamps_when_bucket_rotated(fake_env):
    # 兼容旧 int 凭据时，缺失桶也不得被创建成负数。
    await policy.refund_tokens("k1", 9_999)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}") or 0) == 0


@pytest.mark.asyncio
async def test_record_tokens_corrects_original_bucket_across_minute(
    fake_env, monkeypatch,
):
    clock = {"now": _FIXED_NOW}
    monkeypatch.setattr(policy, "time", SimpleNamespace(time=lambda: clock["now"]))
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    assert isinstance(reserved, policy.TokenReservation)
    assert reserved.bucket == _BUCKET

    clock["now"] += 60
    next_bucket = _BUCKET + 1
    await fake_env.set(f"rl:tpm:k1:{next_bucket}", 777, ex=70)
    await policy.record_tokens("k1", 8_000, reserved)

    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 8_000
    assert int(await fake_env.get(f"rl:tpm:k1:{next_bucket}")) == 777


@pytest.mark.asyncio
async def test_refund_only_original_bucket_across_minute(fake_env, monkeypatch):
    clock = {"now": _FIXED_NOW}
    monkeypatch.setattr(policy, "time", SimpleNamespace(time=lambda: clock["now"]))
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=5_000)

    clock["now"] += 60
    next_bucket = _BUCKET + 1
    await fake_env.set(f"rl:tpm:k1:{next_bucket}", 2_000, ex=70)
    await policy.refund_tokens("k1", reserved)

    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 0
    assert int(await fake_env.get(f"rl:tpm:k1:{next_bucket}")) == 2_000


@pytest.mark.asyncio
async def test_refund_missing_original_bucket_never_touches_new_bucket(
    fake_env, monkeypatch,
):
    clock = {"now": _FIXED_NOW}
    monkeypatch.setattr(policy, "time", SimpleNamespace(time=lambda: clock["now"]))
    reservation = policy.TokenReservation(5_000, _BUCKET)
    clock["now"] += 60
    await fake_env.set(f"rl:tpm:k1:{_BUCKET + 1}", 3_000, ex=70)

    await policy.refund_tokens("k1", reservation)

    assert await fake_env.get(f"rl:tpm:k1:{_BUCKET}") is None
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET + 1}")) == 3_000


@pytest.mark.asyncio
async def test_concurrent_refunds_atomically_clamp_at_zero(fake_env):
    await fake_env.set(f"rl:tpm:k1:{_BUCKET}", 100, ex=70)
    reservation = policy.TokenReservation(100, _BUCKET)
    import asyncio

    await asyncio.gather(
        policy.refund_tokens("k1", reservation),
        policy.refund_tokens("k1", reservation),
    )
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 0


# ── 夜间不限流窗口 ────────────────────────────────────────────────────────────
def _dt(hh: int, mm: int):
    from datetime import datetime

    return datetime(2026, 7, 20, hh, mm)


def test_in_night_window_cross_midnight(monkeypatch):
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_START", "19:00")
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_END", "07:30")
    assert policy.in_night_window(_dt(19, 0))       # 起点（含）
    assert policy.in_night_window(_dt(23, 59))
    assert policy.in_night_window(_dt(3, 0))
    assert policy.in_night_window(_dt(7, 30))       # 终点（含）
    assert not policy.in_night_window(_dt(7, 31))   # 刚过终点
    assert not policy.in_night_window(_dt(12, 0))
    assert not policy.in_night_window(_dt(18, 59))  # 起点前一分钟


def test_in_night_window_disabled_or_invalid(monkeypatch):
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", False)
    assert not policy.in_night_window(_dt(3, 0))
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_START", "not-a-time")
    assert not policy.in_night_window(_dt(3, 0))    # 配置非法 → 视为关闭


# ── embedding / reranker 豁免 RPM/TPM（跑在独立 GPU 池，不占聊天类算力预算）──
def _model(category: str) -> ModelRegistryORM:
    return ModelRegistryORM(id="m", name="m", category=category)


@pytest.mark.asyncio
async def test_embedding_model_exemption_requires_explicit_opt_in(fake_env, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 1)
    monkeypatch.setattr(settings, "RATE_LIMIT_MODEL_EXEMPTIONS_ENABLED", True)
    for _ in range(5):
        got = await policy.enforce_pre(
            _key(), None, None, est_tokens=1_000_000, model=_model("embedding"),
        )
        assert got == policy.NOT_METERED


@pytest.mark.asyncio
async def test_reranker_model_exemption_requires_explicit_opt_in(fake_env, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 1)
    monkeypatch.setattr(settings, "RATE_LIMIT_MODEL_EXEMPTIONS_ENABLED", True)
    for _ in range(5):
        got = await policy.enforce_pre(
            _key(), None, None, est_tokens=1_000_000, model=_model("reranker"),
        )
        assert got == policy.NOT_METERED


@pytest.mark.asyncio
async def test_chat_model_still_rate_limited(fake_env, monkeypatch):
    # 豁免只针对 embedding/reranker，chat 类模型（含未传 model）照旧受限
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 1)
    await policy.enforce_pre(_key(), None, None, model=_model("chat"))
    with pytest.raises(HTTPException):
        await policy.enforce_pre(_key(), None, None, model=_model("chat"))


@pytest.mark.asyncio
@pytest.mark.parametrize("category", ["embedding", "reranker"])
async def test_model_exemptions_are_disabled_by_default(fake_env, monkeypatch, category):
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 1)
    await policy.enforce_pre(_key(), None, None, model=_model(category))
    with pytest.raises(HTTPException) as exc:
        await policy.enforce_pre(_key(), None, None, model=_model(category))
    assert exc.value.status_code == 429


@pytest.mark.asyncio
async def test_night_window_skips_rpm_tpm(fake_env, monkeypatch):
    # 夜间窗口内：RPM=1 也不 429，且无 TPM 预扣（返回 NOT_METERED）
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 1)
    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(23, 0))
    for _ in range(5):
        got = await policy.enforce_pre(_key(), None, None, est_tokens=1_000_000)
        assert got == policy.NOT_METERED


# ── 跨窗口边界的记账（判据取准入时刻，不是完成时刻）──────────────────────────
@pytest.mark.asyncio
async def test_night_admitted_request_never_touches_bucket_after_dawn(fake_env, monkeypatch):
    """06:00 夜间准入 → 07:35 天亮后完成：整夜的 token 不得砸进白天第一分钟的桶。"""
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(6, 0))
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=1_000)
    assert reserved == policy.NOT_METERED

    # 时间走到窗口之外再完成
    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(7, 35))
    assert not policy.in_night_window()
    await policy.record_tokens("k1", 900_000, reserved=reserved)
    assert await fake_env.get(f"rl:tpm:k1:{_BUCKET}") is None


@pytest.mark.asyncio
async def test_day_admitted_request_still_refunds_after_dusk(fake_env, monkeypatch):
    """18:59 白天预扣 → 19:05 入夜后失败：返还照做，预扣不能白挂在桶里。"""
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(18, 59))
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    assert reserved == 6_000
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 6_000

    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(19, 5))
    assert policy.in_night_window()
    await policy.refund_tokens("k1", reserved)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 0


@pytest.mark.asyncio
async def test_day_admitted_request_still_corrects_after_dusk(fake_env, monkeypatch):
    """同上，但请求成功：差额校正也必须照做。"""
    monkeypatch.setattr(settings, "NIGHT_UNLIMITED_ENABLED", True)
    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(18, 59))
    reserved = await policy.enforce_pre(_key(), None, None, est_tokens=6_000)

    monkeypatch.setattr(policy, "_platform_now", lambda: _dt(19, 5))
    await policy.record_tokens("k1", 8_000, reserved=reserved)
    assert int(await fake_env.get(f"rl:tpm:k1:{_BUCKET}")) == 8_000


def test_retry_reserved_preserves_night_marker():
    # 兜底重试：白天重试不预扣（0），夜间准入的标记必须原样带下去
    assert policy.retry_reserved(6_000) == 0
    assert policy.retry_reserved(0) == 0
    assert policy.retry_reserved(policy.NOT_METERED) == policy.NOT_METERED


@pytest.mark.asyncio
async def test_admission_fails_closed_on_redis_error(fake_env, monkeypatch):
    class Boom:
        def pipeline(self):
            raise ConnectionError("redis down")

        def __getattr__(self, _):
            raise ConnectionError("redis down")

    monkeypatch.setattr(policy, "redis", Boom())
    with pytest.raises(HTTPException) as exc:
        await policy.enforce_pre(_key(), None, None, est_tokens=6_000)
    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "5"}
    # 响应后的校正仍是 best-effort；它不能把已产生的正常响应改成失败。
    await policy.record_tokens("k1", 8_000, reserved=0)


@pytest.mark.asyncio
async def test_tpm_failure_rolls_back_confirmed_rpm_increment(fake_env, monkeypatch):
    class FailingSecondPipeline:
        def __init__(self, owner, inner):
            self.owner = owner
            self.inner = inner

        def __getattr__(self, name):
            attr = getattr(self.inner, name)
            if not callable(attr):
                return attr

            def call(*args, **kwargs):
                attr(*args, **kwargs)
                return self

            return call

        async def execute(self):
            self.owner.executions += 1
            if self.owner.executions == 2:
                raise ConnectionError("TPM pipeline failed")
            return await self.inner.execute()

    class FailingTpmRedis:
        def __init__(self, inner):
            self.inner = inner
            self.executions = 0

        def pipeline(self):
            return FailingSecondPipeline(self, self.inner.pipeline())

        async def eval(self, *args):
            return await self.inner.eval(*args)

    monkeypatch.setattr(policy, "redis", FailingTpmRedis(fake_env))
    with pytest.raises(HTTPException) as exc:
        await policy.enforce_pre(_key(), None, None, est_tokens=100)
    assert exc.value.status_code == 503
    assert int(await fake_env.get(f"rl:rpm:k1:{_BUCKET}")) == 0


@pytest.mark.asyncio
async def test_admission_hanging_redis_has_total_timeout(fake_env, monkeypatch):
    import asyncio

    class HangingPipeline:
        def incr(self, *_args):
            return self

        def expire(self, *_args):
            return self

        async def execute(self):
            await asyncio.Event().wait()

    class HangingRedis:
        def pipeline(self):
            return HangingPipeline()

    monkeypatch.setattr(policy, "redis", HangingRedis())
    monkeypatch.setattr(settings, "RATE_LIMIT_ADMISSION_TIMEOUT_S", 0.01)
    with pytest.raises(HTTPException) as exc:
        await asyncio.wait_for(
            policy.enforce_pre(_key(), None, None, est_tokens=100),
            timeout=0.5,
        )
    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "5"}
