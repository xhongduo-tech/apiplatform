"""POST /v1/chat/completions — 流式 / 非流式直连中继。

网关不做并发准入与排队（2026-07-18 整体移除）：请求经限流校验后直达推理
引擎，由引擎的 continuous batching 自行调度；过载表现（TTFT 变慢、引擎侧
排队、连接失败）如实透传给客户端。

模型级兜底（2026-07-21）：节点故障（连接失败/超时/上游 5xx/401/403/404）时
一次性切到 admin 配置的兜底模型。流式路径的切换点就是既有的「先建连查状态
码、2xx 才提交 StreamingResponse」检查点——过了这一点就开始出字，之后再断
流一律透传，绝不半途换模型。判定口径见 app/proxy/fallback.py。
"""
from __future__ import annotations

import json
import time

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.aioguard import guarded
from app.database import get_db
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import fallback
from app.proxy.client import get_client
from app.proxy.common import (
    ResponsePreview,
    record_transport_failure,
    relay_json,
    resolved_headers,
    stream_transport_log,
)
from app.session_stats import resolve_tool_calls_count
from app.proxy.db_bridge import prepare_proxy_request
from app.proxy import policy
from app.proxy.routing import adapt_request, build_endpoint, select_endpoint
from app.proxy.token_estimate import estimate_prompt_tokens_async
from app.proxy.usage import estimate_cost, extract_response_text_any, extract_usage, finalize_stream_usage
from app.usage_writer import usage_writer

router = APIRouter()


def _log(record: dict) -> None:
    usage_writer.enqueue(record)


def _prepare_stream_body(body: dict, model: ModelRegistryORM, eff: dict) -> tuple[dict, bool]:
    """流式上游请求体：vLLM 仅在 stream_options.include_usage 开启时于末块回报
    usage。客户端未主动要求时由网关注入（否则日志/统计的 token 恒为 0）；
    返回 (upstream_body, 是否由网关注入)——注入产生的纯 usage 块不回传客户端。
    """
    upstream_body = adapt_request(body, model, eff)
    client_wants_usage = bool(
        isinstance(body.get("stream_options"), dict)
        and body["stream_options"].get("include_usage")
    )
    inject = not client_wants_usage and eff["import_format"] == "openai"
    if inject:
        so = upstream_body.get("stream_options")
        upstream_body = {
            **upstream_body,
            "stream_options": {**(so if isinstance(so, dict) else {}), "include_usage": True},
        }
    return upstream_body, inject


async def relay_chat_like(
    body: dict,
    key: ApiKeyORM,
    model: ModelRegistryORM,
    resolved_id: str | None,
    stream: bool,
    *,
    upstream_suffix: str = "/chat/completions",
    stream_media_type: str = "text/event-stream",
    reserved_tokens: int = 0,
    request: Request | None = None,
    fallback_model: ModelRegistryORM | None = None,
    fallback_from: str | None = None,
) -> JSONResponse | StreamingResponse:
    """一次尝试；判定为节点故障且配了兜底时，换模型再来一次（只切一次）。"""
    circuit_trigger = fallback.prep_fallback_trigger(fallback_from, fallback_model is not None)
    try:
        return await _attempt(
            body, key, model, resolved_id, stream,
            upstream_suffix=upstream_suffix, stream_media_type=stream_media_type,
            reserved_tokens=reserved_tokens, fallback_from=fallback_from,
            fallback_trigger=circuit_trigger,
            can_fallback=fallback_model is not None,
        )
    except fallback.UpstreamFailure:
        pass
    # 兜底重试：首次尝试失败时预扣已返还，本次不再预扣。夜间准入的请求要把
    # NOT_METERED 继续带下去，否则重试这一程会被当成白天流量记进 TPM 桶。
    return await _attempt(
        body, key, fallback_model,
        fallback.retry_resolved_id(resolved_id, fallback_model), stream,
        upstream_suffix=upstream_suffix, stream_media_type=stream_media_type,
        reserved_tokens=policy.retry_reserved(reserved_tokens),
        fallback_from=model.id, fallback_trigger="retry", can_fallback=False,
    )


async def _attempt(
    body: dict,
    key: ApiKeyORM,
    model: ModelRegistryORM,
    resolved_id: str | None,
    stream: bool,
    *,
    upstream_suffix: str,
    stream_media_type: str,
    reserved_tokens: int,
    fallback_from: str | None,
    fallback_trigger: str | None = None,
    can_fallback: bool = False,
) -> JSONResponse | StreamingResponse:
    started = time.monotonic()
    base_log = fallback.enrich_usage_log(
        {"api_key_id": key.id, "model_id": model.id},
        fallback_from=fallback_from,
        fallback_trigger=fallback_trigger,
    )
    cfg = fallback.get_config(model)
    # 轮询选一次端点，建连 / 鉴权 / 请求体改写共用同一节点（异构接入）
    eff = select_endpoint(model)
    url, headers, _ep_idx = build_endpoint(model, upstream_suffix, eff)
    client = get_client()

    if stream:
        upstream_body, suppress = _prepare_stream_body(body, model, eff)
        return await _stream(
            client, url, headers, upstream_body, model, resolved_id,
            base_log, started, media_type=stream_media_type,
            reserved_tokens=reserved_tokens, suppress_usage_chunk=suppress,
            cfg=cfg, can_fallback=can_fallback, fallback_from=fallback_from,
            body=body,
        )

    upstream_body = adapt_request(body, model, eff)
    try:
        r = await client.post(url, headers=headers, json=upstream_body)
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log, api_key_id=key.id,
            reserved=reserved_tokens, model=model, cfg=cfg, can_fallback=can_fallback)
    latency = int((time.monotonic() - started) * 1000)
    try:
        payload = r.json()
    except Exception:
        payload = None
    u = extract_usage(payload)
    usage_estimated = False
    tool_calls_count = 0
    if r.status_code < 400:
        # 非流式兜底：上游 2xx 却没回报 usage（响应体缺 usage 字段/非 JSON）时
        # 同流式路径一样按请求体 + 响应正文估算，避免日志出现误导性的 0。
        # 4xx/5xx 不兜底——那种 0 是真的没消耗，估算反而会伪造成本。
        u, usage_estimated = finalize_stream_usage(
            u, body=body, streamed_text=extract_response_text_any(payload),
        )
        proposed = 0
        if isinstance(payload, dict):
            preview_tc = ResponsePreview()
            preview_tc.feed_openai_payload(payload)
            proposed = preview_tc.tool_calls_count
        tool_calls_count = resolve_tool_calls_count(body, proposed)
    _log({
        **base_log,
        "status_code": str(r.status_code),
        "latency_ms": latency,
        "total_duration_ms": latency,
        **u,
        "usage_estimated": usage_estimated,
        "estimated_cost": estimate_cost(model, u["prompt_tokens"], u["completion_tokens"]),
        "response_preview": (r.text or "")[:500] or None,
        "tool_calls_count": tool_calls_count,
        "error_detail": (r.text or "")[:1000] if r.status_code >= 400 else None,
    })
    if r.status_code >= 400 and not u.get("total_tokens"):
        await policy.refund_tokens(key.id, reserved_tokens)  # 上游拒绝，未消耗 token
    else:
        await policy.record_tokens(key.id, u.get("total_tokens"), reserved_tokens)
    if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
        raise fallback.UpstreamFailure(f"上游 {r.status_code}")
    return relay_json(
        r.status_code,
        payload if payload is not None else {"error": "上游返回非 JSON"},
        resolved_headers(resolved_id, fallback_from),
    )


@router.post("/chat/completions")
async def chat_completions(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    body = await request.json()
    prep = await prepare_proxy_request(authorization, body.get("model"))
    # TPM 预扣：按 prompt 估算预记账，完成后由 record_tokens 校正差额
    reserved = await policy.enforce_pre(prep.key, request, db, await estimate_prompt_tokens_async(body), model=prep.model)
    return await relay_chat_like(
        body, prep.key, prep.model, prep.resolved_id, bool(body.get("stream")),
        upstream_suffix="/chat/completions",
        reserved_tokens=reserved,
        request=request,
        fallback_model=prep.fallback,
        fallback_from=prep.fallback_from,
    )


async def _pump(r, model, base_log, started, reserved_tokens, suppress_usage_chunk, body: dict):
    """上游 SSE → 客户端字节流转发；结束时（含客户端断开）统一记账。

    转发保持**原有分帧**：逐行原样回放，空行（SSE 的事件分隔符）照原样送出。
    早先的写法丢掉空行、给每行补 "\\n\\n"，等于把每一行都当成一个独立事件——
    上游若发 `event: X` + `data: {...}` 这样的多行事件，就会被拆成两个残缺
    事件。只有网关自己注入的那个纯 usage 事件需要整体丢弃，连同它后面的分隔
    空行一起吃掉，否则客户端会收到一个多余的空事件。

    用量兜底：usage 优先取上游末块回报值；拿不到（上游不支持 include_usage、
    客户端在末块前断流等）时用旁路累积的正文估算 completion、请求体估算
    prompt，并打 usage_estimated 标记，避免日志/统计出现误导性的 0。
    """
    usage_seen: dict = {}
    preview = ResponsePreview()
    # 兜底估算用的正文累积：content / reasoning_content / 工具参数一并计入
    stream_parts: list[str] = []
    stream_chars = 0
    STREAM_CAP = 2_000_000  # 上限后停止累积，防止异常大流拖累内存/CPU
    first_chunk_at: float | None = None
    drop_separator = False   # 上一行是被丢弃的事件 → 它的分隔空行也要一起丢
    log_status = str(r.status_code)
    transport_error: str | None = None
    try:
        async for line in r.aiter_lines():
            if not line:
                if drop_separator:
                    drop_separator = False
                    continue
                yield b"\n"
                continue
            if first_chunk_at is None:
                first_chunk_at = time.monotonic()
            drop = False
            # 旁路解析：usage 计量全程需要；正文累积只在内容块出现时解析；
            # 响应预览攒满上限后即停止解析
            if line.startswith("data:") and (
                '"usage"' in line or '"content"' in line
                or '"arguments"' in line or not preview.done
            ):
                try:
                    obj = json.loads(line[5:].strip())
                except Exception:
                    obj = None
                if isinstance(obj, dict):
                    if '"usage"' in line and obj.get("usage"):
                        usage_seen = extract_usage(obj)
                        # 网关注入 include_usage 产生的纯 usage 块：
                        # 客户端未要求时不回传（choices 空数组会绊倒部分 SDK）
                        if suppress_usage_chunk and not obj.get("choices"):
                            drop = True
                    preview.feed_openai_chunk(obj)
                    if stream_chars < STREAM_CAP:
                        for ch in obj.get("choices") or []:
                            if not isinstance(ch, dict):
                                continue
                            delta = ch.get("delta") or {}
                            for key in ("content", "reasoning_content"):
                                frag = delta.get(key)
                                if isinstance(frag, str) and frag:
                                    stream_parts.append(frag)
                                    stream_chars += len(frag)
                            # 旧版 /v1/completions 流式块没有 delta 包装，正文直接在
                            # choices[].text——不补这行，该端点的 completion 估算恒为 0
                            text = ch.get("text")
                            if isinstance(text, str) and text:
                                stream_parts.append(text)
                                stream_chars += len(text)
                            for tc in delta.get("tool_calls") or []:
                                frag = ((tc or {}).get("function") or {}).get("arguments")
                                if isinstance(frag, str) and frag:
                                    stream_parts.append(frag)
                                    stream_chars += len(frag)
            if drop:
                drop_separator = True
                continue
            yield (line + "\n").encode("utf-8")
    except fallback.TRANSPORT_ERRORS as exc:
        log_status, transport_error = stream_transport_log(exc)
        raise
    finally:
        # 取消安全（P0）：客户端断流时本 finally 运行在已取消的作用域内，
        # 每个裸 await 都会再次被取消。_log 是同步入队；aclose /
        # record_tokens 均经 guarded 保证后台完成。
        await guarded(r.aclose(), "upstream-close")
        total_ms = int((time.monotonic() - started) * 1000)
        ttft_ms = (
            int((first_chunk_at - started) * 1000) if first_chunk_at is not None else total_ms
        )
        usage, usage_estimated = finalize_stream_usage(
            usage_seen, body=body, streamed_text="".join(stream_parts),
        )
        _log({
            **base_log,
            "status_code": log_status,
            "latency_ms": ttft_ms,
            "total_duration_ms": total_ms,
            **usage,
            "usage_estimated": usage_estimated,
            "stream": True,
            "estimated_cost": estimate_cost(model, usage.get("prompt_tokens"), usage.get("completion_tokens")),
            "response_preview": preview.text,
            "error_detail": transport_error,
            "tool_calls_count": resolve_tool_calls_count(body, preview.tool_calls_count),
        })
        await policy.record_tokens(
            base_log["api_key_id"], usage.get("total_tokens"), reserved_tokens
        )


async def _stream(
    client, url, headers, upstream_body, model, resolved_id, base_log, started,
    media_type: str = "text/event-stream",
    reserved_tokens: int = 0,
    suppress_usage_chunk: bool = False,
    cfg: dict | None = None,
    can_fallback: bool = False,
    fallback_from: str | None = None,
    body: dict | None = None,
) -> JSONResponse | StreamingResponse:
    """先建连接检查上游状态，确认 2xx 后再创建 StreamingResponse。

    上游返回 4xx/5xx 时直接返回 JSONResponse（带真实状态码），
    让客户端（如 opencode）能识别错误并停止重试，而不是收到 HTTP 200 + 空 SSE 流。

    这个检查点同时是兜底切换的唯一安全点：此时尚未向客户端发出任何字节，
    换模型重来对用户完全无感；一旦返回 StreamingResponse 就开始出字，之后
    上游再出问题只能如实透传。
    """
    req = client.build_request("POST", url, headers=headers, json=upstream_body)
    try:
        r = await client.send(req, stream=True)
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log,
            api_key_id=base_log["api_key_id"], reserved=reserved_tokens,
            model=model, cfg=cfg, can_fallback=can_fallback,
            extra_log={"prompt_tokens": None, "completion_tokens": None,
                       "total_tokens": None, "estimated_cost": None, "stream": True})

    if r.status_code >= 400:
        # 上游报错：读取完整 body 后以真实状态码返回 JSONResponse，
        # 客户端拿到 4xx 后会停止重试，不再产生"空问答循环"。
        body_bytes = await r.aread()
        await r.aclose()
        latency = int((time.monotonic() - started) * 1000)
        try:
            payload = json.loads(body_bytes)
        except Exception:
            payload = {"error": {"message": body_bytes.decode(errors="replace")[:500]}}
        _log({**base_log, "status_code": str(r.status_code), "latency_ms": latency,
              "total_duration_ms": latency, "prompt_tokens": None, "completion_tokens": None,
              "total_tokens": None, "estimated_cost": None, "stream": True,
              "error_detail": body_bytes.decode(errors="replace")[:1000]})
        await policy.refund_tokens(base_log["api_key_id"], reserved_tokens)
        if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
            raise fallback.UpstreamFailure(f"上游 {r.status_code}")
        return relay_json(
            r.status_code, payload, resolved_headers(resolved_id, fallback_from)
        )

    await fallback.after_upstream(model, cfg, r.status_code, can_fallback)
    return StreamingResponse(
        _pump(r, model, base_log, started, reserved_tokens, suppress_usage_chunk, body or {}),
        media_type=media_type,
        headers={**resolved_headers(resolved_id, fallback_from),
                 "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
