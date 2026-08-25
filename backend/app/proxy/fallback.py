"""模型兜底：错误判定 + 请求级即时切换 + 熔断。

判定口径（完整说明见 docs/fallback.md）：

- A 类·节点故障 → 触发兜底：连接失败 / 超时 / 协议错、上游 5xx、上游
  401/403/404。网关已在自己这一层做完鉴权与模型解析，上游再回 401/404
  必然是该节点的密钥或 model_api_name 配错，对用户就是纯故障，换模型能救。
- B 类·请求本身 → 绝不兜底，如实透传：400/413/422（含上下文超限）、429。
  换个模型是同样的错，只会白烧一倍算力；429 透传另有既定原则（过载如实
  透传、饱和判定权归引擎，见 docs/scheduling.md）。

两层生效：

1. 请求级即时切换——仅在「尚未向客户端发出任何字节」时可切。所有流式路径
   都已是"先建连查状态码、确认 2xx 才提交 StreamingResponse"，那个检查点
   就是切换点。已经开始出字之后上游断流一律透传：半截答案再接另一个模型的
   输出不可接受。只切一次，不做链式兜底。
2. 熔断——窗口内 (失败数 ≥ trip_fails ∧ 失败率 ≥ trip_rate) 即熔断
   cooldown 秒，期间新请求直接从兜底模型出，完全不碰坏节点。

熔断如何恢复：熔断态是一个带 TTL 的标记，不需要任何人主动清除。冷却到期后
本地标记自然过期，下一个请求自己回到原模型——「半开探测」是免费得到的，
不需要探针机制或后台健康检查。回去之后若原模型已恢复则一切照旧；若仍坏，
该请求被第 1 层当场救走（用户无感）并重新熔断，冷却时长指数退避
（cooldown × 2^(n-1)，封顶 max_cooldown_s），避免彻底宕机的节点被反复试探。

跨 worker 一致性：失败计数与熔断标记在 Redis，熔断/恢复经 pub/sub 广播到各
worker 的内存副本——热路径只读内存，零额外往返。所有 Redis 操作 fail-open：
读不到就当没熔断，宁可多打一次坏节点，也绝不因协调层抖动把全平台流量误切
到兜底模型上（与 policy.py 限流同一判断）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx

from app.models import ModelRegistryORM
from app.redis_client import redis
from app.request_context import get_request_id

log = logging.getLogger("apiplatform.fallback")


class UpstreamFailure(Exception):
    """本次尝试判定为上游故障，且尚未向客户端发出任何字节 → 调用方应切兜底。"""


# ── 错误分类 ─────────────────────────────────────────────────────────────────
# 网关自身已完成鉴权/解析，上游仍回这几个码 ⇒ 该节点的密钥或 model_api_name
# 配错，属平台配置故障而非用户问题。
_NODE_FAULT_4XX = frozenset({401, 403, 404})

# 建连/读取阶段的传输层故障（httpx.TimeoutException 覆盖 Connect/Read/Pool 超时）
TRANSPORT_ERRORS = (
    httpx.ConnectError,
    httpx.TimeoutException,
    httpx.RemoteProtocolError,
    httpx.ReadError,
)


def is_node_failure(status: int) -> bool:
    """A 类：换个模型能救活。"""
    return status >= 500 or status in _NODE_FAULT_4XX


def counts_toward_circuit(status: int) -> bool:
    """B 类（400/413/422/429 等请求本身的错误）不进分子也不进分母。

    计入分母会稀释失败率、让熔断迟钝；计入分子则会因用户乱传参数误伤好模型。
    """
    return status < 400 or is_node_failure(status)


# ── 配置（model.extra.fallback，无需 alembic 迁移）────────────────────────────
DEFAULTS: dict = {
    "enabled": False,
    "target_model_id": None,
    "circuit_enabled": False,  # 高级：自动熔断；默认关，仅保留请求级即时切换
    "trip_fails": 5,        # 窗口内失败数阈值（仅 circuit_enabled 时生效）
    "trip_rate": 0.5,       # 窗口内失败率阈值（与失败数「且」关系）
    "window_s": 60,
    "cooldown_s": 120,
    "max_cooldown_s": 1800,  # 指数退避封顶
    "forced": False,        # 人工强制熔断：写库、不自动恢复（亦属高级策略）
}

_NUMERIC = ("trip_fails", "window_s", "cooldown_s", "max_cooldown_s")


def get_config(model: ModelRegistryORM) -> dict | None:
    """解析并钳制模型的兜底配置；未启用或未配目标时返回 None。

    返回 None 即代表"这个模型不参与兜底"——调用方据此完全跳过熔断打点，
    未配置兜底的模型不会产生任何 Redis 流量。
    """
    extra = model.extra if isinstance(model.extra, dict) else {}
    raw = extra.get("fallback")
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None
    if not raw.get("target_model_id"):
        return None
    cfg = {**DEFAULTS, **raw}
    for k in _NUMERIC:
        try:
            cfg[k] = max(1, int(cfg[k]))
        except (TypeError, ValueError):
            cfg[k] = DEFAULTS[k]
    try:
        cfg["trip_rate"] = min(1.0, max(0.0, float(cfg["trip_rate"])))
    except (TypeError, ValueError):
        cfg["trip_rate"] = DEFAULTS["trip_rate"]
    cfg["cooldown_s"] = min(cfg["cooldown_s"], cfg["max_cooldown_s"])
    cfg["circuit_enabled"] = bool(cfg.get("circuit_enabled"))
    cfg["forced"] = bool(cfg.get("forced"))
    return cfg


# ── 熔断状态（内存副本，热路径零往返）─────────────────────────────────────────
# model_id → 熔断截止时间（epoch 秒）。经 pub/sub 广播保持各 worker 一致；
# 到期无需清理动作，读取时顺手剔除即可。
_open_until: dict[str, float] = {}
_open_trips: dict[str, int] = {}


def circuit_open(model_id: str) -> bool:
    """纯内存读：是否处于熔断冷却期内。到期即自然恢复（半开由此免费得到）。"""
    until = _open_until.get(model_id)
    if until is None:
        return False
    if time.time() >= until:
        _open_until.pop(model_id, None)
        return False
    return True


def should_divert(model: ModelRegistryORM, cfg: dict | None) -> bool:
    """当前是否应绕开该模型直接走兜底（人工强制熔断 或 自动熔断冷却期内）。

    circuit_enabled=False 时不读自动熔断态——只做请求级即时切换，避免整链路
    被提前切到兜底模型。
    """
    if cfg is None:
        return False
    if bool(cfg.get("forced")):
        return True
    if not bool(cfg.get("circuit_enabled")):
        return False
    return circuit_open(model.id)


def circuit_state(model_id: str) -> dict | None:
    """admin 展示用：熔断剩余秒数与连续熔断次数；未熔断返回 None。"""
    if not circuit_open(model_id):
        return None
    return {
        "open": True,
        "remaining_s": max(0, int(_open_until[model_id] - time.time())),
        "trips": _open_trips.get(model_id, 1),
    }


def retry_resolved_id(resolved_id: str | None, target: ModelRegistryORM) -> str | None:
    """兜底后的 X-Resolved-Model：原请求指向虚拟模型时，改报实际生效的兜底模型。"""
    return target.id if resolved_id else None


def prep_fallback_trigger(fallback_from: str | None, has_fallback_target: bool) -> str | None:
    """circuit = 熔断被动切流（未碰原模型）；retry = 请求级即时切换。"""
    if fallback_from and not has_fallback_target:
        return "circuit"
    return None


def enrich_usage_log(
    base: dict,
    *,
    fallback_from: str | None,
    fallback_trigger: str | None = None,
) -> dict:
    """用量日志兜底归因字段。

    在尝试开始时快照 request_id：流式路径的 finally / 异步记账可能晚于
    中间件复位 ContextVar，不能再依赖 enqueue 时现读。
    """
    out = dict(base)
    if not out.get("request_id"):
        rid = get_request_id()
        if rid:
            out["request_id"] = rid
    if fallback_from:
        out["fallback_from"] = fallback_from
    if fallback_trigger:
        out["fallback_trigger"] = fallback_trigger
    elif fallback_from:
        trigger = prep_fallback_trigger(fallback_from, has_fallback_target=False)
        if trigger:
            out["fallback_trigger"] = trigger
    return out


# ── 失败/成功打点 ────────────────────────────────────────────────────────────
def _keys(model_id: str, cfg: dict) -> tuple[str, str]:
    bucket = int(time.time() // cfg["window_s"])
    return f"fb:fail:{model_id}:{bucket}", f"fb:total:{model_id}:{bucket}"


async def record_ok(model_id: str, cfg: dict | None) -> None:
    if cfg is None or not bool(cfg.get("circuit_enabled")):
        return
    _, tk = _keys(model_id, cfg)
    try:
        pipe = redis.pipeline()
        pipe.incr(tk)
        pipe.expire(tk, cfg["window_s"] * 2)
        await pipe.execute()
    except Exception:
        pass  # fail-open


async def record_fail(model_id: str, cfg: dict | None) -> None:
    if cfg is None or not bool(cfg.get("circuit_enabled")):
        return
    fk, tk = _keys(model_id, cfg)
    try:
        pipe = redis.pipeline()
        pipe.incr(fk)
        pipe.expire(fk, cfg["window_s"] * 2)
        pipe.incr(tk)
        pipe.expire(tk, cfg["window_s"] * 2)
        res = await pipe.execute()
        fails, total = int(res[0]), int(res[2])
    except Exception:
        return  # fail-open
    if fails >= cfg["trip_fails"] and fails >= total * cfg["trip_rate"]:
        await _trip(model_id, cfg)


async def _trip(model_id: str, cfg: dict) -> None:
    """翻牌熔断。SET NX 抢占：多 worker 同时触发时只有一个真正生效，
    其余回退自己那次退避计数，避免冷却时长因并发被虚假放大。"""
    if circuit_open(model_id):
        return
    trip_key = f"fb:trips:{model_id}"
    try:
        trips = int(await redis.incr(trip_key))
        cooldown = min(cfg["cooldown_s"] * (2 ** (trips - 1)), cfg["max_cooldown_s"])
        until = time.time() + cooldown
        won = await redis.set(
            f"fb:open:{model_id}",
            json.dumps({"until": until, "trips": trips}),
            ex=int(cooldown) + 1,
            nx=True,
        )
        if not won:
            await redis.decr(trip_key)  # 已有 worker 熔断过，本次不计退避
            return
        # 退避计数的存活期远长于冷却期：模型稳定一段时间后自然清零、退避重置
        await redis.expire(trip_key, int(cooldown) * 10)
    except Exception:
        return  # fail-open：熔断不了就退回到只有第 1 层即时切换
    _apply_open(model_id, until, trips)
    log.warning("模型 %s 触发兜底熔断：冷却 %ds（第 %d 次）", model_id, int(cooldown), trips)
    await _broadcast({"model": model_id, "until": until, "trips": trips})


def _apply_open(model_id: str, until: float, trips: int) -> None:
    _open_until[model_id] = until
    _open_trips[model_id] = trips


def _apply_close(model_id: str) -> None:
    _open_until.pop(model_id, None)
    _open_trips.pop(model_id, None)


async def force_close(model_id: str) -> None:
    """人工强制恢复：清熔断标记与退避计数并广播，立即回原模型。

    运维确认节点已修好、不想等冷却时用。人工强制熔断（cfg.forced）走库里的
    配置，不受此影响。
    """
    try:
        await redis.delete(f"fb:open:{model_id}", f"fb:trips:{model_id}")
    except Exception:
        pass
    _apply_close(model_id)
    log.info("模型 %s 熔断被人工强制恢复", model_id)
    await _broadcast({"model": model_id, "close": True})


# ── 跨 worker 广播（复用 db_bridge 同款 pub/sub 基建）──────────────────────────
_CHANNEL = "apiplatform:circuit"
_listener_task: asyncio.Task | None = None
_listener_loop: asyncio.AbstractEventLoop | None = None


async def _broadcast(payload: dict) -> None:
    try:
        await redis.publish(_CHANNEL, json.dumps(payload))
    except Exception:
        pass  # 广播失败：其余 worker 由各自的 Redis 读取或下次熔断兜底


def schedule_force_close(model_id: str) -> None:
    """供 admin 同步端点（跑在线程池里）调用：把强制恢复投递到事件循环。"""
    loop = _listener_loop
    if loop is None or loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(force_close(model_id), loop)
    except Exception:
        pass


async def _hydrate() -> None:
    """启动时补齐内存副本：worker 在冷却期中途重启也能立刻知道谁在熔断。"""
    try:
        async for key in redis.scan_iter(match="fb:open:*", count=100):
            model_id = str(key).split("fb:open:", 1)[-1]
            raw = await redis.get(key)
            if not raw:
                continue
            data = json.loads(raw)
            if float(data.get("until", 0)) > time.time():
                _apply_open(model_id, float(data["until"]), int(data.get("trips", 1)))
    except Exception as exc:
        log.warning("熔断状态回填失败（降级为无熔断，第 1 层仍生效）：%s", exc)


async def _listener() -> None:
    while True:
        pubsub = None
        try:
            pubsub = redis.pubsub()
            await pubsub.subscribe(_CHANNEL)
            await _hydrate()
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    data = json.loads(msg["data"])
                except Exception:
                    continue
                mid = data.get("model")
                if not mid:
                    continue
                if data.get("close"):
                    _apply_close(mid)
                else:
                    _apply_open(mid, float(data["until"]), int(data.get("trips", 1)))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("熔断状态订阅中断（%s），5s 后重连；期间本 worker 按各自内存副本运行", exc)
            await asyncio.sleep(5)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass


async def start_circuit_listener() -> None:
    global _listener_task, _listener_loop
    if _listener_task is None:
        _listener_loop = asyncio.get_running_loop()
        _listener_task = asyncio.create_task(_listener())


async def stop_circuit_listener() -> None:
    global _listener_task, _listener_loop
    if _listener_task is not None:
        _listener_task.cancel()
        try:
            await _listener_task
        except (asyncio.CancelledError, Exception):
            pass
        _listener_task = None
    _listener_loop = None


# ── 中继路径统一打点 ─────────────────────────────────────────────────────────
async def after_upstream(
    model: ModelRegistryORM, cfg: dict | None, status_code: int | None, can_fallback: bool
) -> bool:
    """上游首个响应头到手（或建连失败，status_code=None）时的唯一打点处。

    熔断统计只在这一刻取样：这既是请求级切换的唯一安全点，也避免把客户端
    主动断流、出字中途的异常误记成模型故障。返回 True 表示调用方应切兜底。
    """
    if status_code is None or is_node_failure(status_code):
        await record_fail(model.id, cfg)
        return can_fallback
    if not counts_toward_circuit(status_code):
        return False  # B 类：不打点、不切换，如实透传
    await record_ok(model.id, cfg)
    return False
