"""Redis 异步连接（限流计数；单实例多 worker 间经 Redis 共享计数）。

网关的并发准入与排队已于 2026-07 整体移除，Redis 现仅承载 RPM/TPM 定窗
限流计数（policy.py，全部 fail-open）。支持 Sentinel 高可用接入。
"""
from __future__ import annotations

import logging

import redis.asyncio as aioredis

from app.config import settings

log = logging.getLogger("apiplatform.redis")


def _parse_sentinel_nodes(raw: str) -> list[tuple[str, int]]:
    nodes: list[tuple[str, int]] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        host, _, port = item.partition(":")
        nodes.append((host, int(port or 26379)))
    return nodes


def _make_redis() -> aioredis.Redis:
    """REDIS_SENTINEL_NODES 配置时经 Sentinel 发现 master（故障切换后自动
    跟随新 master 重连），否则直连 REDIS_URL。切换瞬间的命令失败由限流层
    的 fail-open 吸收，不放大为业务错误。"""
    if settings.REDIS_SENTINEL_NODES:
        from redis.asyncio.sentinel import Sentinel

        sentinel = Sentinel(
            _parse_sentinel_nodes(settings.REDIS_SENTINEL_NODES),
            socket_timeout=2.0,
            sentinel_kwargs={"password": settings.REDIS_SENTINEL_PASSWORD or None},
        )
        log.info(
            "Redis 经 Sentinel 接入: nodes=%s master=%s",
            settings.REDIS_SENTINEL_NODES, settings.REDIS_SENTINEL_MASTER,
        )
        return sentinel.master_for(
            settings.REDIS_SENTINEL_MASTER,
            db=settings.REDIS_DB,
            password=settings.REDIS_PASSWORD or None,
            encoding="utf-8",
            decode_responses=True,
        )
    return aioredis.from_url(settings.REDIS_URL, encoding="utf-8", decode_responses=True)


redis: aioredis.Redis = _make_redis()
