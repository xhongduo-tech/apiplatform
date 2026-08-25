"""请求上下文：request-id 贯穿全链路。

RequestContextMiddleware（纯 ASGI 实现，不用 BaseHTTPMiddleware——后者会
包裹响应流，对 SSE 热路径有额外开销与取消语义干扰）：

- 每个 HTTP 请求生成 12 位十六进制 request-id；上游代理/客户端已带合法
  X-Request-Id 时原样沿用（便于与 nginx 访问日志对齐）；同时另生成一个不接受
  客户端覆盖的 128 位 upstream-request-id，防止并发请求因复用同一追踪 ID 被
  有状态上游误判为同一会话；
- 存入 contextvar：中继深处的计量与日志代码零传参即可读取（asyncio 任务
  与 to_thread 均自动继承上下文）；
- 响应头回传 X-Request-Id：用户反馈问题时报此 ID，即可在访问日志与
  usage_logs 中精确定位那一次调用；
- 请求结束 finally 复位 ContextVar，避免同 worker 任务复用时读到上一次的值。
"""
from __future__ import annotations

import re
import uuid
from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("apiplatform_request_id", default=None)
_request_path: ContextVar[str | None] = ContextVar("apiplatform_request_path", default=None)
_upstream_request_id: ContextVar[str | None] = ContextVar(
    "apiplatform_upstream_request_id", default=None,
)

# 允许沿用的入站 ID 形态：常见代理生成的 uuid / hex / 短横线分隔，防注入日志
_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{4,64}$")

_REQUEST_ID_HEADER = b"x-request-id"


def new_request_id() -> str:
    return uuid.uuid4().hex[:12]


def get_request_id() -> str | None:
    return _request_id.get()


def get_request_path() -> str | None:
    return _request_path.get()


def get_upstream_request_id() -> str | None:
    """本次 HTTP 调用的内部唯一 ID；不受客户端 X-Request-Id 控制。"""
    return _upstream_request_id.get()


def with_upstream_request_headers(headers: dict[str, str]) -> dict[str, str]:
    """复制并附加上游隔离/追踪头，不原地修改模型配置中的共享字典。

    X-Request-Id 必须覆盖 custom_headers 里的同名值：custom_headers 是模型级
    静态配置，若原样复用会让所有并发调用拥有同一个上游请求 ID。外部可见的
    request-id 单独放在 X-Platform-Trace-Id，便于和平台日志关联。
    """
    managed = {"x-request-id", "x-platform-request-id", "x-platform-trace-id"}
    out = {k: v for k, v in headers.items() if str(k).lower() not in managed}
    upstream_rid = get_upstream_request_id()
    if upstream_rid:
        out["X-Request-Id"] = upstream_rid
        out["X-Platform-Request-Id"] = upstream_rid
    trace_id = get_request_id()
    if trace_id:
        out["X-Platform-Trace-Id"] = trace_id
    return out


class RequestContextMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        rid: str | None = None
        for k, v in scope.get("headers") or ():
            if k == _REQUEST_ID_HEADER:
                cand = v.decode("latin-1").strip()
                if _ID_RE.match(cand):
                    rid = cand
                break
        rid = rid or new_request_id()
        rid_token = _request_id.set(rid)
        path_token = _request_path.set(scope.get("path"))
        upstream_rid_token = _upstream_request_id.set(uuid.uuid4().hex)

        async def send_with_id(message):
            if message["type"] == "http.response.start":
                # 必须新建列表：ASGI 里这个 headers 就是 Response 实例自己的
                # raw_headers，原地 append 等于改写响应对象本身；同一个 Response
                # 若被复用（异常处理器、缓存住的响应），头会一次次累积。
                # 同时替换而非追加已有的 x-request-id，避免出现两个同名头。
                headers = [
                    (k, v) for k, v in (message.get("headers") or ())
                    if k.lower() != _REQUEST_ID_HEADER
                ]
                headers.append((b"x-request-id", rid.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            # 请求结束后复位，避免同 worker 任务复用时读到上一次的 id/path
            _request_id.reset(rid_token)
            _request_path.reset(path_token)
            _upstream_request_id.reset(upstream_rid_token)
