"""async 代理路径中的同步 DB 桥接（每调用独立 Session + 线程池，避免阻塞事件循环）。

热路径缓存：validate_api_key + resolve_model 每中继请求都要各查一次 PG，
而 key/模型注册表分钟级才变化一次——PG 抖动会经由线程池（asyncio.to_thread
默认执行器，上限 min(32, CPU核数+4)，未显式设置）直接钳制全网关吞吐。(authorization, model) 维度的进程内 TTL 缓存
（AUTH_CACHE_TTL_S，默认 3s，0 关闭）让命中请求零 DB 往返；代价是
key 吊销 / 模型状态变更的生效延迟上限为一个 TTL，运营可接受。
校验失败（401/403/404/503）同样缓存，防止无效 key 打穿到 PG。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import NamedTuple

from fastapi import HTTPException

from app.auth import validate_api_key
from app.config import settings
from app.database import SessionLocal
from app.early_access import denied_detail, is_approved
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import fallback
from app.proxy.routing import (
    find_model_record, is_callable, is_early_access, key_allows_model,
    model_call_names, resolve_fallback_target, resolve_model,
)
from app.redis_client import redis

log = logging.getLogger("apiplatform.db_bridge")


class Prepared(NamedTuple):
    """中继入口的解析结果。

    model 是**本次实际要调用的**模型：熔断冷却期内它已经是兜底模型，
    此时 fallback_from 记原模型 id、fallback 置空（兜底不递归，只切一次）。
    正常情况下 model 为用户请求的模型、fallback 为备用目标（供请求级即时切换）。
    """
    key: ApiKeyORM
    model: ModelRegistryORM
    resolved_id: str | None
    fallback: ModelRegistryORM | None
    fallback_from: str | None


def _validate_key_sync(authorization: str | None) -> ApiKeyORM:
    db = SessionLocal()
    try:
        return validate_api_key(db, authorization)
    finally:
        db.close()


async def async_validate_api_key(authorization: str | None) -> ApiKeyORM:
    try:
        return await asyncio.to_thread(_validate_key_sync, authorization)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="内部错误") from exc


def _prepare_sync(
    authorization: str | None, requested: str | None,
) -> tuple[ApiKeyORM, ModelRegistryORM, str | None, ModelRegistryORM | None]:
    db = SessionLocal()
    try:
        key = validate_api_key(db, authorization)
        if not requested:
            raise HTTPException(status_code=400, detail="缺少 model 字段")
        record = find_model_record(db, requested)
        if record is None:
            raise HTTPException(status_code=404, detail=f"模型不存在: {requested}")
        # 抢先体验计划：模型本身可调用，但只对已获批的账号 ID开放。放在部署
        # 配置校验之前——未授权用户该看到「请先申请」，而不是平台内部的 503。
        # 审批结果变更时 admin 侧调 invalidate_prepare_cache()，否则由
        # AUTH_CACHE_TTL_S 兜底。
        if is_early_access(record) and not is_approved(db, key.auth_id):
            raise HTTPException(status_code=403, detail=denied_detail(requested))
        model, resolved_id = resolve_model(db, requested, record)
        if not is_callable(model):
            raise HTTPException(status_code=503, detail=f"模型当前不可用: {requested}（状态 {model.status}）")
        if not key_allows_model(key, model.id, requested, model_call_names(record)):
            raise HTTPException(status_code=403, detail="该 API key 无权调用此模型")
        # 兜底目标与 key/模型同一次查库解析，一并进缓存——热路径不增加任何
        # DB 往返。Key 的模型白名单不约束兜底目标：这是管理员在模型层面配置
        # 的平台级替代，替代的对立面是整个请求失败（计费按实际模型如实记录）。
        return key, model, resolved_id, resolve_fallback_target(db, model)
    finally:
        db.close()


# ── (authorization, model) → 校验/解析结果 的 TTL 缓存 ────────────────────────
# 值为 ("ok", (key, model, resolved_id)) 或 ("err", status_code, detail)。
# ORM 实例以 detached 状态缓存，代理路径只读其属性，不发起惰性加载。
# dict 的读写在 GIL 下原子，线程池并发访问无需加锁；miss 竞态最多导致
# 同一键重复查一次库，无正确性问题。
_prep_cache: dict[tuple[str, str], tuple[float, tuple]] = {}
_PREP_CACHE_MAX = 8192  # 防御上限：key×model 组合数远小于此，超出即整体清空


def _now() -> float:
    return time.monotonic()


def invalidate_prepare_cache() -> None:
    """清空鉴权/模型解析缓存并广播到全部 worker。

    可从线程池同步调用（admin 端点是 sync def）：本进程立即清空；同时经
    Redis pub/sub 通知其余 gunicorn worker 各自清空，让吊销密钥 / 修改
    限额 / 模型状态变更毫秒级全网关生效。广播 fail-open——Redis 异常时
    其余 worker 仍由 AUTH_CACHE_TTL_S（默认 3s）过期兜底，正确性不受影响。
    """
    _prep_cache.clear()
    loop = _listener_loop
    if loop is not None and not loop.is_closed():
        try:
            asyncio.run_coroutine_threadsafe(_publish_invalidate(), loop)
        except Exception:
            pass


# ── 缓存失效广播（Redis pub/sub，跨 gunicorn worker）──────────────────────────
_INVALIDATE_CHANNEL = "apiplatform:prep-cache-invalidate"
_listener_task: asyncio.Task | None = None
_listener_loop: asyncio.AbstractEventLoop | None = None


async def _publish_invalidate() -> None:
    try:
        await redis.publish(_INVALIDATE_CHANNEL, "1")
    except Exception:
        pass  # 广播失败：TTL 兜底


async def _invalidate_listener() -> None:
    """订阅失效频道；连接异常时退避重连，期间 TTL 兜底。"""
    while True:
        pubsub = None
        try:
            pubsub = redis.pubsub()
            await pubsub.subscribe(_INVALIDATE_CHANNEL)
            async for msg in pubsub.listen():
                if msg.get("type") == "message":
                    _prep_cache.clear()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("缓存失效订阅中断（%s），5s 后重连；期间由 TTL 兜底", exc)
            await asyncio.sleep(5)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass


async def start_invalidate_listener() -> None:
    global _listener_task, _listener_loop
    if _listener_task is None:
        _listener_loop = asyncio.get_running_loop()
        _listener_task = asyncio.create_task(_invalidate_listener())


async def stop_invalidate_listener() -> None:
    global _listener_task, _listener_loop
    if _listener_task is not None:
        _listener_task.cancel()
        try:
            await _listener_task
        except (asyncio.CancelledError, Exception):
            pass
        _listener_task = None
    _listener_loop = None


def _prepare_and_fill(authorization: str | None, requested: str | None) -> tuple:
    """线程池内执行：查库并写缓存。"""
    try:
        result: tuple = ("ok", _prepare_sync(authorization, requested))
    except HTTPException as exc:
        result = ("err", exc.status_code, str(exc.detail))
    if len(_prep_cache) >= _PREP_CACHE_MAX:
        _prep_cache.clear()
    _prep_cache[(authorization or "", requested or "")] = (
        _now() + settings.AUTH_CACHE_TTL_S, result,
    )
    return result


def _unwrap(result: tuple) -> tuple[ApiKeyORM, ModelRegistryORM, str | None, ModelRegistryORM | None]:
    if result[0] == "err":
        raise HTTPException(status_code=result[1], detail=result[2])
    return result[1]


def _apply_circuit(
    key: ApiKeyORM, model: ModelRegistryORM, resolved_id: str | None,
    fb: ModelRegistryORM | None,
) -> Prepared:
    """熔断冷却期内（或人工强制熔断时）直接改从兜底模型出，完全不碰坏节点。

    判定是纯内存读（fallback._open_until 由 pub/sub 维护），不引入任何往返；
    因此故意放在缓存之外——熔断状态毫秒级变化，不能被 AUTH_CACHE_TTL_S 拖住。
    """
    if fb is None:
        return Prepared(key, model, resolved_id, None, None)
    if fallback.should_divert(model, fallback.get_config(model)):
        return Prepared(key, fb, fallback.retry_resolved_id(resolved_id, fb), None, model.id)
    return Prepared(key, model, resolved_id, fb, None)


async def prepare_proxy_request(
    authorization: str | None, requested: str | None,
) -> Prepared:
    if settings.AUTH_CACHE_TTL_S > 0:
        # 命中：纯事件循环内返回，不占线程池、不触 PG
        hit = _prep_cache.get((authorization or "", requested or ""))
        if hit is not None and _now() < hit[0]:
            return _apply_circuit(*_unwrap(hit[1]))
    try:
        if settings.AUTH_CACHE_TTL_S <= 0:
            return _apply_circuit(
                *await asyncio.to_thread(_prepare_sync, authorization, requested)
            )
        result = await asyncio.to_thread(_prepare_and_fill, authorization, requested)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="内部错误") from exc
    return _apply_circuit(*_unwrap(result))


