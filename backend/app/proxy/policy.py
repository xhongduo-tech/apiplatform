"""单 key 配额策略：RPM/TPM 限流 + 夜间不限流窗口。

平台只有 RPM/TPM 两种限额（IP 白名单 / 可用时段已移除，改由 RPM/TPM 数值预设 +
夜间不限流窗口覆盖；月度配额已于 2026-07-19 整体移除）。

设计原则（面向「超高稳定性」）：
- 夜间不限流窗口（默认关闭；显式开启后为 19:00–次日 07:30，平台时区）内跳过 RPM/TPM 检查、
  预扣与事后校正/返还——完全不触碰限流桶，夜间批量任务放开跑；用量日志与
  token 统计（usage_writer）是另一条链路，不受窗口影响，照常全量记录；
- embedding / reranker 类模型只有在部署方显式开启兼容开关后才跳过 RPM/TPM；
  默认继续限流，避免未验证的独立资源池假设变成无限流量入口；
- 准入阶段 Redis 操作 **失败即拒绝（fail-closed）** 并返回可重试的 503，避免
  协调层故障静默扩大为无限流量；响应后的校正/返还是 best-effort；
- 限流用每分钟定窗计数（INCR + EXPIRE 原子 pipeline），跨网关副本共享；
- TPM 采用 **原子预扣 + 事后校正 + 失败返还**：先 INCRBY 再判定（消除
  GET→INCRBY 之间的 TOCTOU——旧实现里多个大请求同时读到空桶会全部放行），
  超限即回退本次预扣并 429；响应完成后按实际用量补差额；请求在产生上游
  消耗之前失败（排队 503 / 连接失败 / 上游 4xx）时由调用方 refund_tokens
  返还预扣。预留凭据携带准入分钟桶，跨分钟完成只校正原桶；单请求预算大于
  TPM 上限时直接拒绝，不存在空桶超额放行。
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app import platform_time
from app.config import settings
from app.models import ApiKeyORM, ModelRegistryORM
from app.redis_client import redis

#: enforce_pre 的返回值语义：>= 0 表示"本次计量生效，值为预扣的 token 数"；
#: NOT_METERED 表示"准入发生在夜间不限流窗口内，全程不碰 TPM 桶"。
#:
#: 为什么需要这个哨兵：记账的三步（预扣 / 校正 / 返还）横跨请求生命周期，而
#: 窗口边界随时可能在中间划过。若在**完成时刻**重新判窗口，会出现两种错账：
#:   · 18:59 准入（已预扣）→ 19:05 完成：校正与返还被跳过，预扣白挂在桶里；
#:   · 06:00 准入（夜间未预扣）→ 07:35 完成：把整夜的 token 一次性记进白天
#:     第一分钟的桶，足以让该 Key 当场 429。
#: 判据必须来自**准入时刻**，并原样传到完成时刻——这就是它被一路透传的原因。
NOT_METERED = -1


class TokenReservation(int):
    """与旧 ``int`` 调用链兼容、同时绑定准入分钟桶的 TPM 预留凭据。

    它刻意继承 ``int``：现有扩展若只比较、记录或原样透传预留数量不会被破坏；
    新版 record/refund 会读取 ``bucket``，从而不把跨分钟差额写进完成时刻的新桶。
    外部旧调用若仍传普通 int，则保守回落到调用时刻桶，仅用于兼容。
    """

    bucket: int | None

    def __new__(cls, amount: int, bucket: int | None = None):
        value = int.__new__(cls, int(amount))
        value.bucket = bucket
        return value


_ADJUST_COUNTER_NONNEGATIVE_LUA = """
local delta = tonumber(ARGV[1])
local create_if_missing = ARGV[2] == '1'
local ttl_seconds = tonumber(ARGV[3])
local current = redis.call('GET', KEYS[1])
if not current then
  if create_if_missing and delta > 0 then
    redis.call('SET', KEYS[1], delta, 'EX', ttl_seconds, 'NX')
    return tonumber(redis.call('GET', KEYS[1]) or '0')
  end
  return 0
end
local next_value = tonumber(current) + delta
if next_value < 0 then
  next_value = 0
end
local ttl = redis.call('TTL', KEYS[1])
redis.call('SET', KEYS[1], next_value, 'KEEPTTL')
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ttl_seconds)
end
return next_value
"""


def _minute_bucket() -> int:
    return int(time.time() // 60)


def _reservation_parts(reserved: int) -> tuple[int, int | None]:
    return max(0, int(reserved)), getattr(reserved, "bucket", None)


async def _adjust_counter_nonnegative(
    redis_key: str, delta: int, *, create_if_missing: bool = False,
) -> int:
    """Atomically adjust a Redis counter without ever exposing a negative value."""
    return int(await redis.eval(
        _ADJUST_COUNTER_NONNEGATIVE_LUA,
        1,
        redis_key,
        int(delta),
        "1" if create_if_missing else "0",
        70,
    ))


def _platform_now() -> datetime:
    """平台时区的当前时间。容器系统时区是 UTC，时段类判定必须显式换算。

    与统计口径共用 app.platform_time 的时区解析，避免两处各判一次而漂移。
    """
    return platform_time.now_local()


def _parse_hhmm(spec: str) -> tuple[int, int] | None:
    try:
        h, m = str(spec).strip().split(":", 1)
        hour, minute = int(h), int(m)
    except (ValueError, TypeError):
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour, minute


def in_night_window(now: datetime | None = None) -> bool:
    """夜间不限流窗口判定（含两端点，支持跨午夜）。配置非法时视为窗口关闭。"""
    if not settings.NIGHT_UNLIMITED_ENABLED:
        return False
    start = _parse_hhmm(settings.NIGHT_UNLIMITED_START)
    end = _parse_hhmm(settings.NIGHT_UNLIMITED_END)
    if start is None or end is None or start == end:
        return False
    t = now if now is not None else _platform_now()
    cur = t.hour * 60 + t.minute
    s = start[0] * 60 + start[1]
    e = end[0] * 60 + end[1]
    if s < e:
        return s <= cur <= e
    return cur >= s or cur <= e  # 跨午夜


#: 可选豁免类别。默认不开启；仅供已验证独立资源池的部署显式兼容。
RATE_LIMIT_EXEMPT_CATEGORIES = frozenset({"embedding", "reranker"})


def effective_rate_limits(key: ApiKeyORM) -> tuple[int, int]:
    """解析单 Key 生效的 (rpm_limit, tpm_limit)。返回值语义与限流检查一致：
    > 0 = 该上限；== 0 = 无限（检查跳过）。

    Key 字段语义：None=用平台默认；负数(-1)=无限；> 0=该值。
    """
    def _one(val: int | None, default: int) -> int:
        if val is None:
            return default
        if val < 0:
            return 0        # 无限：策略层 limit==0 即跳过检查
        return val
    return (_one(key.rpm_limit, settings.RATE_LIMIT_RPM),
            _one(key.tpm_limit, settings.RATE_LIMIT_TPM))


async def enforce_pre(
    key: ApiKeyORM, request: Request, db: Session, est_tokens: int = 0,
    model: ModelRegistryORM | None = None,
) -> int:
    """请求准入前的策略校验。违规抛 HTTPException；Redis 异常返回 503。

    est_tokens：本次请求的 prompt + 最大输出预算估算，用于 TPM 预扣。
    model：本次实际调用的模型，用于判断是否属于 RATE_LIMIT_EXEMPT_CATEGORIES
    （embedding/reranker）；不传（如 count_tokens 这类不针对具体模型的端点）
    则按普通逻辑走 RPM/TPM。
    返回实际预扣的 token 数（夜间窗口 / 豁免类别返回 NOT_METERED），调用方须
    原样保存并在完成后传给 record_tokens / refund_tokens——它同时是"预扣了
    多少"和"本次到底计不计量"的凭据。
    """
    # 1) RPM / TPM 定窗限流（Redis 故障 fail-closed）：单 Key 覆盖优先，否则平台默认；
    #    limit==0 表示无限（该 Key 被设为超高并发），检查自动跳过。
    #    夜间不限流窗口内整体跳过（含 TPM 预扣），批量任务放开跑。
    if in_night_window():
        return NOT_METERED
    if (
        settings.RATE_LIMIT_MODEL_EXEMPTIONS_ENABLED
        and model is not None
        and model.category in RATE_LIMIT_EXEMPT_CATEGORIES
    ):
        return NOT_METERED
    rpm_limit, tpm_limit = effective_rate_limits(key)
    bucket = _minute_bucket()
    est = max(0, int(est_tokens))
    reserved = TokenReservation(0, bucket)
    rpm_incremented = False
    if tpm_limit > 0 and est > tpm_limit:
        retry = 60 - int(time.time() % 60)
        raise HTTPException(
            status_code=429,
            detail=(
                f"单请求 token 预算（{est}）超过该 Key 的 TPM 上限"
                f"（{tpm_limit} tokens/分钟），请缩短输入或降低最大输出。"
            ),
            headers={"Retry-After": str(max(1, retry))},
        )
    try:
        # 总超时覆盖 RPM、TPM 预扣及拒绝回滚；连接/单命令超时之外再加一层
        # 请求级上界，Sentinel 切换或半开连接不能无限占住 ASGI worker。
        async with asyncio.timeout(settings.RATE_LIMIT_ADMISSION_TIMEOUT_S):
            # INCR 与 EXPIRE 走同一 pipeline：避免 EXPIRE 单独失败留下无 TTL 的泄漏键
            rk = f"rl:rpm:{key.id}:{bucket}"
            pipe = redis.pipeline()
            pipe.incr(rk)
            pipe.expire(rk, 70)
            n = int((await pipe.execute())[0])
            rpm_incremented = True
            if rpm_limit > 0 and n > rpm_limit:
                retry = 60 - int(time.time() % 60)
                raise HTTPException(
                    status_code=429,
                    detail=f"请求频率超限（{rpm_limit} 次/分钟），请约 {retry} 秒后重试。",
                    headers={"Retry-After": str(max(1, retry))},
                )
            if tpm_limit > 0:
                tk = f"rl:tpm:{key.id}:{bucket}"
                # 原子预扣：先 INCRBY 再判定，占位与检查一步完成——并发请求各自
                # 看到包含对方预扣的计数，不存在"同时读到空桶全部放行"的竞态。
                pipe = redis.pipeline()
                pipe.incrby(tk, est)
                pipe.expire(tk, 70)
                n = int((await pipe.execute())[0])
                before = n - est
                if before >= tpm_limit or n > tpm_limit:
                    if est > 0:
                        await _adjust_counter_nonnegative(tk, -est)
                    # TPM 被拒的请求不额外消耗 RPM；两个回滚均原子钳制到 0。
                    await _adjust_counter_nonnegative(rk, -1)
                    retry = 60 - int(time.time() % 60)
                    raise HTTPException(
                        status_code=429,
                        detail=f"token 速率超限（{tpm_limit} tokens/分钟），请约 {retry} 秒后重试。",
                        headers={"Retry-After": str(max(1, retry))},
                    )
                reserved = TokenReservation(est, bucket)
    except HTTPException:
        raise
    except Exception as exc:
        if rpm_incremented:
            # RPM 已确认成功而后续 TPM/Sentinel 操作失败时，本次请求并未获准，
            # 不应污染 RPM 桶。回滚自身仍必须有短总超时，Redis 卡死时不能掩盖
            # 原始的 fail-closed 503。
            try:
                rollback_timeout = max(
                    0.01,
                    min(
                        settings.REDIS_SOCKET_TIMEOUT_S,
                        settings.RATE_LIMIT_ADMISSION_TIMEOUT_S,
                    ),
                )
                await asyncio.wait_for(
                    _adjust_counter_nonnegative(rk, -1),
                    timeout=rollback_timeout,
                )
            except Exception:
                pass
        # 限流协调层是准入安全边界；不可用时显式拒绝并提示客户端退避，不能
        # 把 Redis 故障静默转换成无限流量。保留原异常作为 cause 便于日志追踪。
        raise HTTPException(
            status_code=503,
            detail="限流服务暂时不可用，请稍后重试。",
            headers={"Retry-After": "5"},
        ) from exc
    return reserved


def retry_reserved(reserved: int) -> int:
    """兜底重试这一程的记账凭据。

    重试不再预扣（首程失败时已返还），所以正常情况下是 0；但夜间准入的请求
    必须把 NOT_METERED 带下去，否则重试会被当成白天流量记进 TPM 桶。
    """
    if reserved == NOT_METERED:
        return NOT_METERED
    return TokenReservation(0, getattr(reserved, "bucket", None))


async def record_tokens(
    key_id: str, total_tokens: int | None, reserved: int = 0
) -> None:
    """响应完成后按实际用量校正本分钟 TPM 计数（best-effort + 取消安全）。

    差额 = 实际 total_tokens - 预扣值，始终记回准入时刻的分钟桶。
    未拿到实际用量（流中断等）时不做校正——预扣值即作为记账，宁可略多计。
    流式响应被客户端断开时本函数在已取消的作用域内被调用，guarded 保证
    校正仍在后台完成。
    """
    # 夜间准入的请求全程不碰限流桶——依据是准入时刻的 NOT_METERED，而不是
    # 此刻再判一次窗口：夜里跑到天亮的批量任务，完成时窗口已经关了。
    # （用量统计走 usage_writer，与此无关，照常记录。）
    if reserved == NOT_METERED:
        return
    if not total_tokens or total_tokens <= 0:
        return
    amount, bucket = _reservation_parts(reserved)
    delta = int(total_tokens) - amount
    if delta == 0:
        return
    from app.aioguard import guarded
    await guarded(
        _record_tokens_impl(
            key_id,
            delta,
            bucket=bucket,
            create_if_missing=amount == 0,
        ),
        "tpm-correct",
    )


async def _record_tokens_impl(
    key_id: str,
    delta: int,
    *,
    bucket: int | None,
    create_if_missing: bool,
) -> None:
    target_bucket = _minute_bucket() if bucket is None else bucket
    try:
        tk = f"rl:tpm:{key_id}:{target_bucket}"
        await _adjust_counter_nonnegative(
            tk,
            delta,
            create_if_missing=create_if_missing,
        )
    except Exception:
        pass


async def refund_tokens(key_id: str, reserved: int) -> None:
    """请求在产生上游消耗之前失败（排队 503 / 上游连接失败 / 上游 4xx 且无
    usage）时归还 TPM 预扣，避免失败请求白白吃掉本分钟预算。

    best-effort + 取消安全。只操作凭据绑定的准入桶；该桶已过期时为 no-op，
    绝不创建或扣减完成时刻的新桶。
    """
    # reserved <= 0 一并覆盖了「夜间准入（NOT_METERED）」与「没预扣」两种情况：
    # 都没有可返还的量。这里**不能**再判一次当前是否在夜间窗口——白天预扣、
    # 入夜后才失败的请求同样需要返还。
    if not reserved or reserved <= 0:
        return
    from app.aioguard import guarded
    amount, bucket = _reservation_parts(reserved)
    await guarded(_refund_impl(key_id, amount, bucket=bucket), "tpm-refund")


async def _refund_impl(key_id: str, n: int, *, bucket: int | None) -> None:
    target_bucket = _minute_bucket() if bucket is None else bucket
    tk = f"rl:tpm:{key_id}:{target_bucket}"
    try:
        await _adjust_counter_nonnegative(tk, -n)
    except Exception:
        pass
