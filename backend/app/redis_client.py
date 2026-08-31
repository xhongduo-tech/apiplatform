"""Redis 异步连接（限流计数；单实例多 worker 间经 Redis 共享计数）。

网关的并发准入与排队已于 2026-07 整体移除。Redis 承载 RPM/TPM 定窗限流
计数以及若干跨 worker 协调状态；中继限流准入 fail-closed，辅助缓存与熔断状态
按各自模块的降级策略处理。支持 Sentinel 高可用接入。
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
    跟随新 master 重连），否则直连 REDIS_URL。切换瞬间的中继限流命令失败
    会返回可重试的 503，避免在协调状态未知时放开准入。"""
    if settings.REDIS_SENTINEL_NODES:
        from redis.asyncio.sentinel import Sentinel

        sentinel = Sentinel(
            _parse_sentinel_nodes(settings.REDIS_SENTINEL_NODES),
            socket_connect_timeout=settings.REDIS_CONNECT_TIMEOUT_S,
            socket_timeout=settings.REDIS_SOCKET_TIMEOUT_S,
            sentinel_kwargs={
                "password": settings.REDIS_SENTINEL_PASSWORD or None,
                "socket_connect_timeout": settings.REDIS_CONNECT_TIMEOUT_S,
                "socket_timeout": settings.REDIS_SOCKET_TIMEOUT_S,
            },
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
            socket_connect_timeout=settings.REDIS_CONNECT_TIMEOUT_S,
            socket_timeout=settings.REDIS_SOCKET_TIMEOUT_S,
        )
    return aioredis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=settings.REDIS_CONNECT_TIMEOUT_S,
        socket_timeout=settings.REDIS_SOCKET_TIMEOUT_S,
    )


redis: aioredis.Redis = _make_redis()
