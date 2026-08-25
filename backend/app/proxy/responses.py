"""POST /v1/responses — OpenAI Responses API 适配（支撑 Codex）。

Codex CLI 只会说 Responses API（顶层 input/instructions/output，而非 chat
completions 的 messages）。本端点此前是纯字节透传（复用 app/proxy/common.py
的原样透传逻辑），只有上游本身就是原生 Responses API 实现时才凑巧能工作。
而目前所有实际接入的上游在 import_format=openai 时只认 Chat Completions
（messages 字段），Codex 的 input 字段原样转发过去，上游拿不到 messages 直接
400——用户看到的 USER_MESSAGES_NOT_EMPTY 即是此例。

两条路径：
1. import_format=openai → Responses ⇄ Chat Completions 双向转换（本文件核心，
   非流式完整；流式按 OpenAI SSE 块逐步 emit 对应的 Responses 事件）。
2. import_format∈(anthropic, custom) → 维持原样字节透传（既有行为不变）：
   anthropic 上游同样不认 Responses 协议，透传对它必然也会出错，但目前没有
   real 部署用这个组合（见 catalog_seed），等有真实场景再补双向转换。
"""
from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.aioguard import guarded
from app.database import get_db
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import fallback, policy
from app.proxy.client import get_client
from app.proxy.common import (
    ResponsePreview,
    iter_with_keepalive,
    raw_attempt,
    record_transport_failure,
    relay_json,
    resolved_headers,
    stream_transport_log,
)
from app.session_stats import resolve_tool_calls_count
from app.proxy.db_bridge import prepare_proxy_request
from app.proxy.routing import select_endpoint
from app.proxy.token_estimate import estimate_prompt_tokens_async
from app.proxy.usage import estimate_cost, extract_response_text_any, extract_usage, finalize_stream_usage
from app.request_context import with_upstream_request_headers
from app.usage_writer import usage_writer

router = APIRouter()

# finish_reason → 顶层 status / incomplete_details.reason（未命中时 status 为 completed）
_FINISH_TO_STATUS = {"length": "incomplete", "content_filter": "incomplete"}
_INCOMPLETE_REASON = {"length": "max_output_tokens", "content_filter": "content_filter"}

# 消息 content part 里携带纯文本的类型：请求侧 input_text/text，回放的助手历史
# 用 output_text，被拒绝的历史用 refusal——四者取文本的逻辑一致，一并识别。
_TEXT_PART_TYPES = {"input_text", "output_text", "text", "refusal"}


def _arguments_json(value) -> str:
    if isinstance(value, str):
        return value or "{}"
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


# ── 转换：Responses 请求 → OpenAI chat 请求 ──────────────────────────────
def _content_parts(content) -> tuple[str, list[dict]]:
    """把 Responses message.content 拆成 (纯文本拼接, 非文本 part 如图片)。"""
    if isinstance(content, str):
        return content, []
    text_parts: list[str] = []
    extra: list[dict] = []
    for part in content if isinstance(content, list) else []:
        if not isinstance(part, dict):
            continue
        t = part.get("type")
        if t in _TEXT_PART_TYPES and isinstance(part.get("text"), str):
            text_parts.append(part["text"])
        elif t == "input_image":
            url = part.get("image_url")
            if isinstance(url, dict):
                url = url.get("url")
            if isinstance(url, str) and url:
                extra.append({"type": "image_url", "image_url": {"url": url}})
    return "".join(text_parts), extra


def responses_to_openai(body: dict) -> dict:
    out: dict = {"model": body.get("model")}
    messages: list[dict] = []
    # instructions + input 里混入的 system/developer 条目统一合并置顶，
    # 理由同 A社 转换：多数上游 chat template 只认开头的单条 system。
    system_parts: list[str] = []
    instructions = body.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        system_parts.append(instructions)

    raw_input = body.get("input")
    if isinstance(raw_input, str):
        items = [{"type": "message", "role": "user", "content": raw_input}]
    elif isinstance(raw_input, list):
        items = raw_input
    else:
        items = []

    # function_call 在 Responses 里是与 message 平级的独立 item（不像 A社
    # tool_use 嵌在一条 assistant message 里），并列的多个调用需要合并回同一条
    # OpenAI assistant 消息才合法；遇到非 function_call 条目再统一落盘。
    pending_calls: list[dict] = []

    def flush_calls() -> None:
        if not pending_calls:
            return
        messages.append({
            "role": "assistant", "content": None,
            "tool_calls": [
                {"id": c["call_id"], "type": "function",
                 "function": {"name": c["name"], "arguments": c["arguments"]}}
                for c in pending_calls
            ],
        })
        pending_calls.clear()

    for item in items:
        if not isinstance(item, dict):
            continue
        itype = item.get("type") or "message"
        if itype == "function_call":
            pending_calls.append({
                "call_id": item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:16]}",
                "name": item.get("name"),
                "arguments": _arguments_json(item.get("arguments")),
            })
            continue
        if itype == "function_call_output":
            flush_calls()
            output = item.get("output")
            if not isinstance(output, str):
                text, _ = _content_parts(output)
                output = text or json.dumps(output, ensure_ascii=False)
            messages.append({"role": "tool", "tool_call_id": item.get("call_id"), "content": output})
            continue
        if itype == "reasoning":
            continue  # 无 chat completions 对应物，同 A社 thinking 块的处理方式
        if itype != "message":
            continue  # mcp_call / shell_call 等工具专用 item：无通用对应物，跳过
        role = item.get("role")
        text, extra_parts = _content_parts(item.get("content"))
        if role in ("system", "developer"):
            if text:
                system_parts.append(text)
            continue
        flush_calls()
        if role == "assistant":
            if text:
                messages.append({"role": "assistant", "content": text})
            continue
        # user（含未知角色兜底为 user）
        if extra_parts:
            content = ([{"type": "text", "text": text}] if text else []) + extra_parts
            messages.append({"role": "user", "content": content})
        elif text:
            messages.append({"role": "user", "content": text})
    flush_calls()

    if system_parts:
        messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})
    out["messages"] = messages

    for k in ("temperature", "top_p", "stream", "parallel_tool_calls"):
        if body.get(k) is not None:
            out[k] = body[k]
    if body.get("max_output_tokens") is not None:
        out["max_tokens"] = body["max_output_tokens"]

    fns = []
    for t in body.get("tools") or []:
        if isinstance(t, dict) and t.get("type") == "function":
            # Responses 当前规范为平铺 name/parameters；同时兼容早期 SDK 和平台
            # 旧文档使用过的 {type:function,function:{...}} 形状。
            spec = t.get("function") if isinstance(t.get("function"), dict) else t
            fn = {
                "name": spec.get("name"), "description": spec.get("description") or "",
                "parameters": spec.get("parameters") or {},
            }
            if spec.get("strict") is not None:
                fn["strict"] = spec["strict"]
            fns.append({"type": "function", "function": fn})
    if fns:
        out["tools"] = fns

    tc = body.get("tool_choice")
    if isinstance(tc, str):
        out["tool_choice"] = tc
    elif isinstance(tc, dict) and tc.get("type") == "function" and tc.get("name"):
        out["tool_choice"] = {"type": "function", "function": {"name": tc["name"]}}
    return out


# ── 转换：OpenAI 响应 → Responses 响应（非流式）───────────────────────────
def _responses_usage(u: dict) -> dict:
    """内部规整化 usage → Responses usage 形状，含缓存明细。

    此前这里手写 usage.get("prompt_tokens_details")，只认 OpenAI 原生嵌套字段，
    漏掉 DeepSeek 等用 prompt_cache_hit_tokens 平铺字段上报缓存命中的情况，
    cache_write_tokens 更是硬编码 0——统一改走 extract_usage()，两种命名都认，
    且 cache_write_tokens 跟 cache_hit_tokens 一样如实转发。
    """
    pt = u.get("prompt_tokens") or 0
    ct = u.get("completion_tokens") or 0
    return {
        "input_tokens": pt,
        "input_tokens_details": {
            "cached_tokens": u.get("cache_hit_tokens") or 0,
            "cache_write_tokens": u.get("cache_write_tokens") or 0,
        },
        "output_tokens": ct,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": u.get("total_tokens") or (pt + ct),
    }


def openai_to_responses(oai: dict, model_name: str, request_body: dict, usage: dict | None = None) -> dict:
    """usage 不传时从 oai["usage"] 现取（纯函数场景，如单测）；调用方若已经过
    finalize_stream_usage 兜底估算，应把那份传进来，理由同 anthropic.py 的
    openai_to_anthropic：避免内部日志按估算记账、回给客户端的却是 0。"""
    choice = (oai.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    finish = choice.get("finish_reason")
    output: list[dict] = []
    text = msg.get("content")
    if isinstance(text, str) and text:
        output.append({
            "id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "status": "completed",
            "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}],
        })
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        output.append({
            "id": f"fc_{uuid.uuid4().hex[:24]}", "type": "function_call", "status": "completed",
            "call_id": tc.get("id") or f"call_{uuid.uuid4().hex[:16]}",
            "name": fn.get("name"), "arguments": _arguments_json(fn.get("arguments")),
        })

    return {
        "id": oai.get("id") or f"resp_{uuid.uuid4().hex[:24]}",
        "object": "response",
        "created_at": oai.get("created") or int(time.time()),
        "status": _FINISH_TO_STATUS.get(finish, "completed"),
        "error": None,
        "incomplete_details": (
            {"reason": _INCOMPLETE_REASON[finish]} if finish in _INCOMPLETE_REASON else None
        ),
        "instructions": request_body.get("instructions"),
        "model": model_name,
        "output": output,
        "output_text": text if isinstance(text, str) else "",
        "parallel_tool_calls": bool(request_body.get("parallel_tool_calls", True)),
        "temperature": request_body.get("temperature"),
        "top_p": request_body.get("top_p"),
        "tool_choice": request_body.get("tool_choice") or "auto",
        "tools": request_body.get("tools") or [],
        "truncation": request_body.get("truncation") or "disabled",
        "usage": _responses_usage(usage if usage is not None else extract_usage(oai)),
    }


def _rsse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


# ── 端点 ─────────────────────────────────────────────────────────────────────
@router.post("/responses")
async def responses(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    body = await request.json()
    prep = await prepare_proxy_request(authorization, body.get("model"))
    reserved = await policy.enforce_pre(prep.key, request, db, await estimate_prompt_tokens_async(body), model=prep.model)

    try:
        return await _attempt(
            body, prep.key, prep.model, prep.resolved_id,
            reserved=reserved, fallback_from=prep.fallback_from,
            fallback_trigger=fallback.prep_fallback_trigger(prep.fallback_from, prep.fallback is not None),
            can_fallback=prep.fallback is not None,
        )
    except fallback.UpstreamFailure:
        pass
    # 兜底重试：首次尝试失败时预扣已返还，本次不再预扣。夜间准入的请求要把
    # NOT_METERED 继续带下去，否则重试这一程会被当成白天流量记进 TPM 桶。
    fb = prep.fallback
    return await _attempt(
        body, prep.key, fb, fallback.retry_resolved_id(prep.resolved_id, fb),
        reserved=policy.retry_reserved(reserved), fallback_from=prep.model.id,
        fallback_trigger="retry", can_fallback=False,
    )


async def _attempt(
    body: dict, key: ApiKeyORM, model: ModelRegistryORM, resolved_id: str | None,
    *, reserved: int, fallback_from: str | None,
    fallback_trigger: str | None = None, can_fallback: bool = False,
):
    stream = bool(body.get("stream"))
    cfg = fallback.get_config(model)
    eff = select_endpoint(model)  # 选一次端点，本次尝试全程共用（异构接入）

    if eff["import_format"] != "openai":
        # anthropic/custom 上游同样不认识 Responses 协议：维持原样透传（不转换），
        # 与此前行为一致——只是把决策点从「恒透传」改成「按接入格式判断」。
        return await raw_attempt(
            body, key, model, resolved_id, "/responses", stream,
            reserved=reserved, fallback_from=fallback_from, can_fallback=can_fallback,
        )

    oai_body = responses_to_openai(body)
    if eff["model_api_name"]:
        oai_body["model"] = eff["model_api_name"]
    url = f"{eff['base_url']}/chat/completions"
    up_headers = {"Content-Type": "application/json"}
    if eff["api_key"]:
        up_headers["Authorization"] = f"Bearer {eff['api_key']}"
    if eff["custom_headers"]:
        up_headers.update(eff["custom_headers"])
    up_headers = with_upstream_request_headers(up_headers)

    client = get_client()
    started = time.monotonic()
    base_log = fallback.enrich_usage_log(
        {"api_key_id": key.id, "model_id": model.id},
        fallback_from=fallback_from,
        fallback_trigger=fallback_trigger,
    )
    hdrs = resolved_headers(resolved_id, fallback_from)

    if stream:
        return await _stream_convert(
            client, url, up_headers, oai_body, model, hdrs, base_log, started, body,
            reserved_tokens=reserved, cfg=cfg, can_fallback=can_fallback, fallback_from=fallback_from,
        )

    oai_body["stream"] = False
    try:
        r = await client.post(url, headers=up_headers, json=oai_body)
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log, api_key_id=key.id,
            reserved=reserved, model=model, cfg=cfg, can_fallback=can_fallback)
    latency = int((time.monotonic() - started) * 1000)
    try:
        payload = r.json()
    except Exception:
        payload = {}
    u = extract_usage(payload)
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
                          "response_preview": (r.text or "")[:500] or None,
                          "tool_calls_count": tool_calls_count})
    if r.status_code >= 400 and not u.get("total_tokens"):
        await policy.refund_tokens(key.id, reserved)  # 上游拒绝，未消耗
    else:
        await policy.record_tokens(key.id, u.get("total_tokens"), reserved)
    if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
        raise fallback.UpstreamFailure(f"上游 {r.status_code}")
    # 上游报错时直接透传原始 body，不转换成 Responses 格式（保留错误信息）
    if r.status_code >= 400:
        return relay_json(r.status_code, payload or {"error": "上游错误"}, hdrs)
    resp = openai_to_responses(payload, model.id if fallback_from else body.get("model"), body, u)
    return relay_json(r.status_code, resp, hdrs)


async def _stream_convert(
    client, url, up_headers, oai_body, model, hdrs, base_log, started, request_body: dict,
    reserved_tokens: int = 0,
    cfg: dict | None = None,
    can_fallback: bool = False,
    fallback_from: str | None = None,
) -> JSONResponse | StreamingResponse:
    """先建连检查上游状态，确认 2xx 才返回 StreamingResponse（OpenAI→Responses SSE 转换）。

    安全点与兜底切换时机同 A社 转换路径：尚未发出任何字节前换模型，客户端无感。
    """
    # 回显模型名规则须与非流式路径一致：没发生兜底时回显用户请求的别名（虚拟/
    # LTS 模型不该在流式路径里泄漏实际服务模型），发生兜底时才如实改写。
    echo_model = model.id if fallback_from else (request_body.get("model") or model.id)
    oai_body = {**oai_body, "stream": True,
                "stream_options": {**(oai_body.get("stream_options") or {}), "include_usage": True}}
    req = client.build_request("POST", url, headers=up_headers, json=oai_body)
    try:
        r = await client.send(req, stream=True)
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log,
            api_key_id=base_log["api_key_id"], reserved=reserved_tokens,
            model=model, cfg=cfg, can_fallback=can_fallback)

    if r.status_code >= 400:
        body_bytes = await r.aread()
        await r.aclose()
        latency = int((time.monotonic() - started) * 1000)
        try:
            payload = json.loads(body_bytes)
        except Exception:
            payload = {"error": {"message": body_bytes.decode(errors="replace")[:500]}}
        usage_writer.enqueue({**base_log, "status_code": str(r.status_code), "latency_ms": latency,
                              "total_duration_ms": latency,
                              "error_detail": body_bytes.decode(errors="replace")[:1000]})
        await policy.refund_tokens(base_log["api_key_id"], reserved_tokens)
        if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
            raise fallback.UpstreamFailure(f"上游 {r.status_code}")
        return relay_json(r.status_code, payload, hdrs)

    await fallback.after_upstream(model, cfg, r.status_code, can_fallback)

    resp_id = f"resp_{uuid.uuid4().hex[:24]}"
    created_at = int(time.time())

    def skeleton(status: str, output: list) -> dict:
        return {
            "id": resp_id, "object": "response", "created_at": created_at, "status": status,
            "error": None, "incomplete_details": None,
            "instructions": request_body.get("instructions"),
            "model": echo_model, "output": output,
            "parallel_tool_calls": bool(request_body.get("parallel_tool_calls", True)),
            "temperature": request_body.get("temperature"),
            "top_p": request_body.get("top_p"),
            "tool_choice": request_body.get("tool_choice") or "auto",
            "tools": request_body.get("tools") or [],
            "truncation": request_body.get("truncation") or "disabled",
        }

    async def gen():
        seq = 0

        def nseq() -> int:
            nonlocal seq
            seq += 1
            return seq

        next_output_index = 0
        text_item_id: str | None = None
        text_output_index = 0
        text_buf: list[str] = []
        tool_blocks: dict[int, dict] = {}  # openai tool_call.index → {call_id,name,buf,item_id,output_index}
        finish: str | None = None
        usage_seen: dict = {}
        stream_error: dict | None = None
        transport_error: str | None = None
        log_status = str(r.status_code)
        preview = ResponsePreview()
        stream_parts: list[str] = []
        stream_chars = 0
        STREAM_CAP = 2_000_000

        try:
            yield _rsse("response.created", {"type": "response.created",
                        "response": skeleton("in_progress", []), "sequence_number": nseq()})
            yield _rsse("response.in_progress", {"type": "response.in_progress",
                        "response": skeleton("in_progress", []), "sequence_number": nseq()})
            async for line in iter_with_keepalive(r.aiter_lines()):
                if line is None:
                    # Responses SSE 没有专用 ping 事件；SSE comment 对所有客户端
                    # 透明，同时能刷新中间代理的空闲计时器。
                    yield b": keep-alive\n\n"
                    continue
                s = line.strip()
                if not s.startswith("data:"):
                    continue
                data = s[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                if isinstance(obj.get("error"), dict):
                    stream_error = obj["error"]
                    failed = skeleton("failed", [])
                    failed["error"] = stream_error
                    yield _rsse("response.failed", {
                        "type": "response.failed", "response": failed,
                        "sequence_number": nseq(),
                    })
                    return
                if obj.get("usage"):
                    usage_seen = extract_usage(obj)
                preview.feed_openai_chunk(obj)
                ch = (obj.get("choices") or [{}])[0]
                delta = ch.get("delta") or {}
                if ch.get("finish_reason"):
                    finish = ch["finish_reason"]

                if delta.get("content"):
                    frag = delta["content"]
                    if stream_chars < STREAM_CAP:
                        stream_parts.append(frag)
                        stream_chars += len(frag)
                    if text_item_id is None:
                        text_item_id = f"msg_{uuid.uuid4().hex[:24]}"
                        text_output_index = next_output_index
                        next_output_index += 1
                        yield _rsse("response.output_item.added", {
                            "type": "response.output_item.added", "output_index": text_output_index,
                            "item": {"id": text_item_id, "type": "message", "status": "in_progress",
                                     "role": "assistant", "content": []},
                            "sequence_number": nseq()})
                        yield _rsse("response.content_part.added", {
                            "type": "response.content_part.added", "item_id": text_item_id,
                            "output_index": text_output_index, "content_index": 0,
                            "part": {"type": "output_text", "text": "", "annotations": []},
                            "sequence_number": nseq()})
                    text_buf.append(frag)
                    yield _rsse("response.output_text.delta", {
                        "type": "response.output_text.delta", "item_id": text_item_id,
                        "output_index": text_output_index, "content_index": 0, "delta": frag,
                        "sequence_number": nseq()})

                for tc in delta.get("tool_calls") or []:
                    i = tc.get("index", 0)
                    blk = tool_blocks.get(i)
                    if blk is None:
                        blk = {"call_id": tc.get("id") or f"call_{uuid.uuid4().hex[:16]}",
                               "name": (tc.get("function") or {}).get("name", ""), "buf": "",
                               "item_id": f"fc_{uuid.uuid4().hex[:24]}", "output_index": next_output_index}
                        next_output_index += 1
                        tool_blocks[i] = blk
                        yield _rsse("response.output_item.added", {
                            "type": "response.output_item.added", "output_index": blk["output_index"],
                            "item": {"id": blk["item_id"], "type": "function_call", "status": "in_progress",
                                     "call_id": blk["call_id"], "name": blk["name"], "arguments": ""},
                            "sequence_number": nseq()})
                    else:
                        if tc.get("id"):
                            blk["call_id"] = tc["id"]
                        later_name = (tc.get("function") or {}).get("name")
                        if later_name:
                            blk["name"] = later_name
                    frag2 = (tc.get("function") or {}).get("arguments")
                    if frag2:
                        blk["buf"] += frag2
                        if stream_chars < STREAM_CAP:
                            stream_parts.append(frag2)
                            stream_chars += len(frag2)
                        yield _rsse("response.function_call_arguments.delta", {
                            "type": "response.function_call_arguments.delta",
                            "item_id": blk["item_id"], "output_index": blk["output_index"],
                            "delta": frag2, "sequence_number": nseq()})

            full_text = "".join(text_buf)
            # 按 output_index 还原顺序：工具调用有可能先于正文文本到达
            # （模型先想清楚要调用什么工具），output 数组要如实反映这个顺序。
            items_by_index: dict[int, dict] = {}
            if text_item_id is not None:
                yield _rsse("response.output_text.done", {
                    "type": "response.output_text.done", "item_id": text_item_id,
                    "output_index": text_output_index, "content_index": 0, "text": full_text,
                    "sequence_number": nseq()})
                yield _rsse("response.content_part.done", {
                    "type": "response.content_part.done", "item_id": text_item_id,
                    "output_index": text_output_index, "content_index": 0,
                    "part": {"type": "output_text", "text": full_text, "annotations": []},
                    "sequence_number": nseq()})
                msg_item = {"id": text_item_id, "type": "message", "status": "completed",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": full_text, "annotations": []}]}
                yield _rsse("response.output_item.done", {
                    "type": "response.output_item.done", "output_index": text_output_index,
                    "item": msg_item, "sequence_number": nseq()})
                items_by_index[text_output_index] = msg_item
            for blk in tool_blocks.values():
                args = blk["buf"] or "{}"
                yield _rsse("response.function_call_arguments.done", {
                    "type": "response.function_call_arguments.done", "item_id": blk["item_id"],
                    "output_index": blk["output_index"], "name": blk["name"],
                    "arguments": args, "sequence_number": nseq()})
                fc_item = {"id": blk["item_id"], "type": "function_call", "status": "completed",
                           "call_id": blk["call_id"], "name": blk["name"], "arguments": args}
                yield _rsse("response.output_item.done", {
                    "type": "response.output_item.done", "output_index": blk["output_index"],
                    "item": fc_item, "sequence_number": nseq()})
                items_by_index[blk["output_index"]] = fc_item
            final_output = [items_by_index[i] for i in sorted(items_by_index)]

            usage, _usage_estimated = finalize_stream_usage(
                usage_seen, body=request_body, streamed_text="".join(stream_parts),
            )
            final_resp = skeleton(_FINISH_TO_STATUS.get(finish, "completed"), final_output)
            final_resp["output_text"] = full_text
            final_resp["incomplete_details"] = (
                {"reason": _INCOMPLETE_REASON[finish]} if finish in _INCOMPLETE_REASON else None)
            final_resp["usage"] = _responses_usage(usage)
            yield _rsse("response.completed", {"type": "response.completed", "response": final_resp,
                        "sequence_number": nseq()})
        except fallback.TRANSPORT_ERRORS as exc:
            log_status, transport_error = stream_transport_log(exc)
            raise
        finally:
            # 取消安全（P0）：断流时 finally 里的 await 会再次被取消
            await guarded(r.aclose(), "upstream-close")
            latency = int((time.monotonic() - started) * 1000)
            usage, usage_estimated = finalize_stream_usage(
                usage_seen, body=request_body, streamed_text="".join(stream_parts),
            )
            usage_writer.enqueue({**base_log, "status_code": log_status, "latency_ms": latency,
                                  "total_duration_ms": latency, **usage,
                                  "usage_estimated": usage_estimated, "stream": True,
                                  "estimated_cost": estimate_cost(model, usage.get("prompt_tokens"),
                                                                  usage.get("completion_tokens")),
                                  "response_preview": preview.text,
                                  "error_detail": (
                                      json.dumps(stream_error, ensure_ascii=False)[:1000]
                                      if stream_error else transport_error
                                  ),
                                  "tool_calls_count": resolve_tool_calls_count(
                                      request_body,
                                      max(preview.tool_calls_count, len(tool_blocks)),
                                  )})
            await policy.record_tokens(base_log.get("api_key_id"), usage.get("total_tokens"), reserved_tokens)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={**hdrs, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
