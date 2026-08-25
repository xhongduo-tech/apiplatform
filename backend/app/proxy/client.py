"""共享 httpx 异步客户端（连接池）。

连接池上限须显著大于全平台峰值并发，否则 HTTP 层争抢连接会导致跨模型
连坐。默认 10_000，可通过 HTTPX_MAX_CONNECTIONS 环境变量覆盖。
"""
from __future__ import annotations

import httpx

from app.config import settings

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            # 忽略系统 HTTP(S)_PROXY：上游是内网推理节点，走代理必然 502/超时
            trust_env=False,
            verify=settings.UPSTREAM_TLS_VERIFY,
            timeout=httpx.Timeout(
                connect=settings.UPSTREAM_CONNECT_TIMEOUT_S,
                read=settings.UPSTREAM_READ_TIMEOUT_S,
                write=settings.UPSTREAM_READ_TIMEOUT_S,
                pool=settings.UPSTREAM_CONNECT_TIMEOUT_S,
            ),
            limits=httpx.Limits(
                max_connections=settings.HTTPX_MAX_CONNECTIONS,
                max_keepalive_connections=settings.HTTPX_MAX_KEEPALIVE,
                keepalive_expiry=30,
            ),
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
