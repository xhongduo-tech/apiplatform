"""中继公共逻辑：单次非流式中继与原样字节透传（embeddings/rerank/responses 等复用）。

网关不做并发准入与排队（2026-07-18 整体移除）：请求经限流校验后直达推理
引擎，由引擎的 continuous batching 自行调度；引擎过载时的排队、拒绝或断连
如实透传给客户端，网关不代为兜底。

模型级兜底（2026-07-21）是唯一的例外，且只覆盖「节点故障」：连接失败、
超时、上游 5xx、上游 401/403/404。请求本身的错误（400/413/422、429 过载）
一律照旧透传，判定口径见 app/proxy/fallback.py 与 docs/fallback.md。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator
from typing import TypeVar

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session
from starlette.responses import Response

from app.aioguard import guarded
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import fallback, policy
from app.proxy.client import get_client
from app.proxy.db_bridge import prepare_proxy_request
from app.proxy.request_body import read_json_object
from app.proxy.routing import adapt_request, build_endpoint, select_endpoint
from app.proxy.token_estimate import estimate_prompt_tokens_async
from app.proxy.usage import (
    estimate_cost,
    extract_response_text_any,
    extract_usage,
    extract_usage_any,
    finalize_stream_usage,
)
from app.usage_writer import usage_writer
from app.session_stats import resolve_tool_calls_count

log = logging.getLogger("apiplatform.relay")

#: 日志响应预览的最大字符数（与前端「响应预览（前 500 字）」口径一致）
PREVIEW_LIMIT = 500

# Coding agent 请求可能在长推理或工具编排阶段几十秒没有正文。主动发 SSE 注释
# 心跳，避免客户端、反向代理或企业网络把一条仍在工作的流误判为空闲连接。
SSE_KEEPALIVE_SECONDS = 15.0

_T = TypeVar("_T")


async def iter_with_keepalive(
    source: AsyncIterable[_T], interval_s: float = SSE_KEEPALIVE_SECONDS,
) -> AsyncIterator[_T | None]:
    """迭代异步流；上游静默超过 ``interval_s`` 时产出 ``None``。

    保留同一个 pending ``anext`` 任务，心跳不会取消上游读取，因而也不会造成
    丢块或重复消费。调用方按目标协议把 ``None`` 编码成 ping/SSE comment。
    """
    iterator = source.__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(iterator.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=interval_s)
            if not done:
                yield None
                continue
            try:
                item = pending.result()
            except StopAsyncIteration:
                break
            pending = None
            yield item
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, StopAsyncIteration):
                pass


class ResponsePreview:
    """流式响应旁路采集：正文预览（排障）+ tool call 计数（Session 统计）。

    转发字节完全不受影响。正文攒满上限后停止采字；tool call 计数不受
    字数上限影响——否则长正文会把后续工具调用漏掉，分布图全落「0」档。
    """

    def __init__(self, limit: int = PREVIEW_LIMIT) -> None:
        self._limit = limit
        self._parts: list[str] = []
        self._len = 0
        self._tool_indices: set[int] = set()
        self._tool_ids: set[str] = set()
        self._tool_use_blocks = 0
        self._saw_tool_finish = False

    @property
    def done(self) -> bool:
        return self._len >= self._limit

    def _add(self, s: str) -> None:
        if not s or self.done:
            return
        self._parts.append(s)
        self._len += len(s)

    def _note_openai_tool_call(self, tc: dict) -> None:
        if "index" in tc and tc["index"] is not None:
            try:
                self._tool_indices.add(int(tc["index"]))
            except (TypeError, ValueError):
                pass
        tid = tc.get("id")
        if isinstance(tid, str) and tid:
            self._tool_ids.add(tid)

    def feed_openai_chunk(self, obj: dict) -> None:
        """OpenAI chat 流式块：采集正文 + 累计 tool_calls（按 index/id 去重）。"""
        if not isinstance(obj, dict):
            return
        for ch in obj.get("choices") or []:
            if not isinstance(ch, dict):
                continue
            if ch.get("finish_reason") == "tool_calls":
                self._saw_tool_finish = True
            delta = ch.get("delta") or {}
            for tc in delta.get("tool_calls") or []:
                if isinstance(tc, dict):
                    self._note_openai_tool_call(tc)
            # 少数上游把完整 tool_calls 放在非 delta 的 message 上
            msg = ch.get("message") or {}
            for tc in msg.get("tool_calls") or []:
                if isinstance(tc, dict):
                    self._note_openai_tool_call(tc)
            if self.done:
                continue
            content = delta.get("content")
            if isinstance(content, str):
                self._add(content)
            text = ch.get("text")
            if isinstance(text, str):
                self._add(text)

    def feed_anthropic_event(self, obj: dict) -> None:
        """A社 流式事件：采集 text_delta + tool_use content_block。"""
        if not isinstance(obj, dict):
            return
        t = obj.get("type")
        if t == "content_block_start":
            block = obj.get("content_block") or {}
            if isinstance(block, dict) and block.get("type") == "tool_use":
                self._tool_use_blocks += 1
                tid = block.get("id")
                if isinstance(tid, str) and tid:
                    self._tool_ids.add(tid)
            return
        if t == "content_block_delta" and not self.done:
            text = (obj.get("delta") or {}).get("text")
            if isinstance(text, str):
                self._add(text)

    def feed_openai_payload(self, payload: dict | None) -> None:
        """非流式完整响应：一次计入全部 tool_calls。"""
        if not isinstance(payload, dict):
            return
        for ch in payload.get("choices") or []:
            if not isinstance(ch, dict):
                continue
            if ch.get("finish_reason") == "tool_calls":
                self._saw_tool_finish = True
            msg = ch.get("message") or {}
            for tc in msg.get("tool_calls") or []:
                if isinstance(tc, dict):
                    self._note_openai_tool_call(tc)
        for item in payload.get("output") or []:
            if isinstance(item, dict) and item.get("type") in ("function_call", "tool_call"):
                self._tool_use_blocks += 1
                tid = item.get("call_id") or item.get("id")
                if isinstance(tid, str) and tid:
                    self._tool_ids.add(tid)
        for block in payload.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                self._tool_use_blocks += 1
                tid = block.get("id")
                if isinstance(tid, str) and tid:
                    self._tool_ids.add(tid)

    @property
    def tool_calls_count(self) -> int:
        n = max(len(self._tool_indices), len(self._tool_ids), self._tool_use_blocks)
        if n == 0 and self._saw_tool_finish:
            return 1
        return n

    @property
    def text(self) -> str | None:
        if not self._parts:
            return None
        return "".join(self._parts)[: self._limit]


def resolved_headers(resolved_id: str | None, fallback_from: str | None = None) -> dict:
    """X-Resolved-Model（虚拟模型对齐目标）+ X-Fallback-From（本次发生了兜底）。

    兜底后响应体里的 model 字段如实写兜底模型的真名，X-Fallback-From 说明
    原本请求的是谁——用户从日志就能自查"为什么这次效果不一样"。
    """
    h: dict = {}
    if resolved_id:
        h["X-Resolved-Model"] = resolved_id
    if fallback_from:
        h["X-Fallback-From"] = fallback_from
    return h


def stream_transport_log(exc: Exception) -> tuple[str, str]:
    """流已返回 200 后发生传输故障时，给内部日志一个最终结果码。

    HTTP 响应头一旦发给客户端就不能改写，但用量日志应表达整次调用的最终
    结果：读取/连接池超时记 504，其它上游断流或协议错误记 502。
    """
    if isinstance(exc, httpx.TimeoutException):
        return "504", f"上游流读取超时: {exc}"
    return "502", f"上游流传输中断: {exc}"


#: HTTP 规定不得携带响应体的状态码（1xx 由 httpx 内部消化，列出仅为兜底）。
_BODILESS_STATUS = frozenset({204, 205, 304})


def relay_json(status_code: int, payload, headers: dict) -> Response:
    """按上游状态码如实回包；无体状态码改回空体响应。

    上游偶发 204/304 时，若照抄状态码却仍挂一个 JSON body，starlette 会发出
    "有体的 204"——uvicorn 的 h11 认定协议冲突，直接掐断**整条客户端连接**：
    同一条 keep-alive 连接上已经发出、还在等待响应的后续请求就此石沉大海，
    客户端只看到连接被重置。经 nginx 上游连接池（keepalive 64）复用时，这种
    连接级掐断还会波及正好复用到该连接的其它调用方。

    这里只收敛"能不能带 body"，状态码本身照旧透传，符合网关的如实透传原则。
    """
    if status_code < 200 or status_code in _BODILESS_STATUS:
        return Response(status_code=status_code, headers=headers)
    return JSONResponse(status_code=status_code, content=payload, headers=headers)


async def record_transport_failure(
    exc: Exception,
    *,
    started: float,
    base_log: dict,
    api_key_id: str | None,
    reserved: int,
    model: ModelRegistryORM,
    cfg: dict,
    can_fallback: bool,
    extra_log: dict | None = None,
) -> None:
    """transport 层异常（连接失败/超时，未触达上游）的统一处理：记一条
    status_code=0 的用量日志、返还 TPM 预扣，并按兜底配置判定——可兜底时
    raise UpstreamFailure 触发换模型重试，否则原异常照旧向上抛。

    extra_log 供流式检查点补记空 usage/费用字段（与正常流式日志同列口径）。
    """
    latency = int((time.monotonic() - started) * 1000)
    usage_writer.enqueue({**base_log, "status_code": "0", "latency_ms": latency,
                          "total_duration_ms": latency, **(extra_log or {}),
                          "error_detail": str(exc)[:1000]})
    await policy.refund_tokens(api_key_id, reserved)  # 未触达上游，返还预扣
    if await fallback.after_upstream(model, cfg, None, can_fallback):
        raise fallback.UpstreamFailure(str(exc)) from exc
    raise exc


async def simple_relay(
    request: Request, db: Session, authorization: str | None, path_suffix: str
) -> JSONResponse:
    """单次非流式中继（embeddings / rerank / images / ocr 共用）。"""
    body = await read_json_object(request)
    prep = await prepare_proxy_request(authorization, body.get("model"))
    reserved = await policy.enforce_pre(prep.key, request, db, await estimate_prompt_tokens_async(body), model=prep.model)

    try:
        return await _simple_attempt(
            body, prep.key, prep.model, prep.resolved_id, path_suffix,
            reserved=reserved, fallback_from=prep.fallback_from,
            fallback_trigger=fallback.prep_fallback_trigger(prep.fallback_from, prep.fallback is not None),
            can_fallback=prep.fallback is not None,
        )
    except fallback.UpstreamFailure:
        pass
    # 兜底重试：首次尝试失败时预扣已返还，本次不再预扣。夜间准入的请求要把
    # NOT_METERED 继续带下去，否则重试这一程会被当成白天流量记进 TPM 桶。
    fb = prep.fallback
    return await _simple_attempt(
        body, prep.key, fb, fallback.retry_resolved_id(prep.resolved_id, fb), path_suffix,
        reserved=policy.retry_reserved(reserved), fallback_from=prep.model.id,
        fallback_trigger="retry", can_fallback=False,
    )


async def _simple_attempt(
    body: dict, key: ApiKeyORM, model: ModelRegistryORM, resolved_id: str | None,
    path_suffix: str, *, reserved: int, fallback_from: str | None,
    fallback_trigger: str | None, can_fallback: bool,
) -> JSONResponse:
    cfg = fallback.get_config(model)
    eff = select_endpoint(model)
    url, headers, _ep_idx = build_endpoint(model, path_suffix, eff)
    started = time.monotonic()
    base_log = fallback.enrich_usage_log(
        {"api_key_id": key.id, "model_id": model.id},
        fallback_from=fallback_from,
        fallback_trigger=fallback_trigger,
    )
    try:
        r = await get_client().post(url, headers=headers, json=adapt_request(body, model, eff))
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log, api_key_id=key.id,
            reserved=reserved, model=model, cfg=cfg, can_fallback=can_fallback)
    latency = int((time.monotonic() - started) * 1000)
    try:
        payload = r.json()
    except Exception:
        payload = None
        log.warning(
            "上游返回非 JSON [model=%s status=%s url=%s] body[:200]=%r",
            model.id, r.status_code, url, r.text[:200] if r.text else "",
        )
    u = extract_usage(payload)
    usage_estimated = False
    if r.status_code < 400:
        # 上游 2xx 却没回报 usage 时兜底估算，避免日志出现误导性的 0
        # （4xx/5xx 不兜底：那种 0 是真的没消耗）
        u, usage_estimated = finalize_stream_usage(
            u, body=body, streamed_text=extract_response_text_any(payload),
        )
    usage_writer.enqueue({
        **base_log,
        "status_code": str(r.status_code),
        "latency_ms": latency, "total_duration_ms": latency, **u,
        "usage_estimated": usage_estimated,
        "estimated_cost": estimate_cost(model, u["prompt_tokens"], u["completion_tokens"]),
        "error_detail": (r.text or "")[:1000] if r.status_code >= 400 else None,
    })
    if r.status_code >= 400 and not u.get("total_tokens"):
        await policy.refund_tokens(key.id, reserved)  # 上游拒绝，未消耗 token
    else:
        await policy.record_tokens(key.id, u.get("total_tokens"), reserved)
    if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
        raise fallback.UpstreamFailure(f"上游 {r.status_code}")
    return relay_json(r.status_code,
                      payload if payload is not None else {"error": "上游非 JSON"},
                      resolved_headers(resolved_id, fallback_from))


async def raw_attempt(
    body: dict, key: ApiKeyORM, model: ModelRegistryORM, resolved_id: str | None,
    path_suffix: str, stream: bool, *,
    reserved: int, fallback_from: str | None, can_fallback: bool,
):
    """原样字节透传（支持流式），单次尝试。供 responses.py 复用于 import_format
    ∈(anthropic, custom) 的 /v1/responses 请求——那两种上游同样不认识 Responses
    协议，网关不转换，如实按原样转发。"""
    cfg = fallback.get_config(model)
    eff = select_endpoint(model)  # 选一次端点：模型名与建连节点必须来自同一节点
    if eff["model_api_name"]:
        body = {**body, "model": eff["model_api_name"]}

    url, headers, _ep_idx = build_endpoint(model, path_suffix, eff)
    client = get_client()
    started = time.monotonic()
    base_log = fallback.enrich_usage_log(
        {"api_key_id": key.id, "model_id": model.id},
        fallback_from=fallback_from,
    )
    hdrs = resolved_headers(resolved_id, fallback_from)

    if stream:
        # 先建连查状态码，确认 2xx 才提交 StreamingResponse——这既是兜底切换的
        # 唯一安全点（尚未发出任何字节），也修掉了此前「上游 5xx 却回 200 +
        # 错误体」的问题：状态码在生成器启动那一刻就已锁死，来不及再改。
        req = client.build_request("POST", url, headers=headers, json=body)
        try:
            r = await client.send(req, stream=True)
        except fallback.TRANSPORT_ERRORS as exc:
            await record_transport_failure(
                exc, started=started, base_log=base_log, api_key_id=key.id,
                reserved=reserved, model=model, cfg=cfg, can_fallback=can_fallback)

        if r.status_code >= 400:
            body_bytes = await r.aread()
            await r.aclose()
            latency = int((time.monotonic() - started) * 1000)
            try:
                payload = json.loads(body_bytes)
            except Exception:
                payload = {"error": {"message": body_bytes.decode(errors="replace")[:500]}}
            usage_writer.enqueue({**base_log, "status_code": str(r.status_code),
                                  "latency_ms": latency, "total_duration_ms": latency,
                                  "error_detail": body_bytes.decode(errors="replace")[:1000]})
            await policy.refund_tokens(key.id, reserved)
            if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
                raise fallback.UpstreamFailure(f"上游 {r.status_code}")
            return relay_json(r.status_code, payload, hdrs)

        await fallback.after_upstream(model, cfg, r.status_code, can_fallback)

        async def gen():
            usage_seen: dict = {}
            buf = b""
            preview = ResponsePreview()
            # 兜底估算用的正文累积（OpenAI chat 的 delta.content / Responses 的 output_text）
            stream_parts: list[str] = []
            stream_chars = 0
            STREAM_CAP = 2_000_000
            log_status = str(r.status_code)
            transport_error: str | None = None
            try:
                async for chunk in iter_with_keepalive(r.aiter_raw()):
                    if chunk is None:
                        yield b": keep-alive\n\n"
                        continue
                    yield chunk
                    # 旁路解析 usage：逐行扫描 SSE，不改写转发字节。
                    # Responses API 的 usage 在 response.completed 事件的
                    # response.usage 里（input/output_tokens 命名）。
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        s = line.strip()
                        if not s.startswith(b"data:"):
                            continue
                        try:
                            obj = json.loads(s[5:].strip())
                        except Exception:
                            continue
                        if not isinstance(obj, dict):
                            continue
                        if b'"usage"' in s:
                            try:
                                u = extract_usage_any(obj)
                                if u.get("total_tokens"):
                                    usage_seen = u
                            except Exception:
                                pass
                        preview.feed_openai_chunk(obj)
                        if stream_chars < STREAM_CAP and b"content" in s:
                            frag = ""
                            resp = obj.get("response")
                            if isinstance(resp, dict) and isinstance(resp.get("output_text"), str):
                                frag = resp["output_text"]
                            else:
                                for ch in (obj.get("choices") or []):
                                    delta = (ch or {}).get("delta") or {}
                                    c = delta.get("content")
                                    if isinstance(c, str):
                                        frag = c
                            if frag:
                                stream_parts.append(frag)
                                stream_chars += len(frag)
                    if len(buf) > 262_144:
                        buf = b""  # 非 SSE 的无换行大块：放弃解析，只透传
            except fallback.TRANSPORT_ERRORS as exc:
                log_status, transport_error = stream_transport_log(exc)
                raise
            finally:
                # 取消安全：客户端断流时本 finally 运行在已取消的作用域内
                await guarded(r.aclose(), "upstream-close")
                latency = int((time.monotonic() - started) * 1000)
                usage, usage_estimated = finalize_stream_usage(
                    usage_seen, body=body, streamed_text="".join(stream_parts),
                )
                usage_writer.enqueue({
                    **base_log, "status_code": log_status, "latency_ms": latency,
                    "total_duration_ms": latency, **usage,
                    "usage_estimated": usage_estimated, "stream": True,
                    "estimated_cost": estimate_cost(
                        model, usage.get("prompt_tokens"), usage.get("completion_tokens")),
                    "response_preview": preview.text,
                    "error_detail": transport_error,
                    "tool_calls_count": resolve_tool_calls_count(body, preview.tool_calls_count),
                })
                await policy.record_tokens(key.id, usage.get("total_tokens"), reserved)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={**hdrs, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    try:
        r = await client.post(url, headers=headers, json=body)
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log, api_key_id=key.id,
            reserved=reserved, model=model, cfg=cfg, can_fallback=can_fallback)
    latency = int((time.monotonic() - started) * 1000)
    try:
        payload = r.json()
    except Exception:
        payload = None
    u = extract_usage_any(payload)
    usage_estimated = False
    tool_calls_count = 0
    if r.status_code < 400:
        u, usage_estimated = finalize_stream_usage(
            u, body=body, streamed_text=extract_response_text_any(payload),
        )
        proposed = 0
        if isinstance(payload, dict):
            tc_preview = ResponsePreview()
            tc_preview.feed_openai_payload(payload)
            proposed = tc_preview.tool_calls_count
        tool_calls_count = resolve_tool_calls_count(body, proposed)
    usage_writer.enqueue({**base_log, "status_code": str(r.status_code), "latency_ms": latency,
                          "total_duration_ms": latency, **u,
                          "usage_estimated": usage_estimated,
                          "estimated_cost": estimate_cost(model, u["prompt_tokens"], u["completion_tokens"]),
                          "error_detail": (r.text or "")[:1000] if r.status_code >= 400 else None,
                          "tool_calls_count": tool_calls_count})
    if r.status_code >= 400 and not u.get("total_tokens"):
        await policy.refund_tokens(key.id, reserved)
    else:
        await policy.record_tokens(key.id, u.get("total_tokens"), reserved)
    if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
        raise fallback.UpstreamFailure(f"上游 {r.status_code}")
    return relay_json(r.status_code,
                      payload if payload is not None else {"error": "上游非 JSON"},
                      hdrs)
