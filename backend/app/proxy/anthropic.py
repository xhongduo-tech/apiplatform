"""POST /v1/messages — A社 Messages API 适配（支撑 CC）。

两条路径：
1. 上游为 anthropic 格式 → 直接透传（含 SSE），最贴合 CC 工具往返。
2. 上游为 openai 格式 → A社 ⇄ OpenAI 双向转换（非流式完整；流式文本逐块、
   工具调用累积后emit tool_use 块）。

网关不做并发准入与排队（2026-07-18 整体移除）：请求经限流校验后直达上游。
"""
from __future__ import annotations

import asyncio
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
    record_transport_failure,
    relay_json,
    resolved_headers,
    stream_transport_log,
)
from app.session_stats import resolve_tool_calls_count
from app.auth import normalize_client_auth
from app.proxy.db_bridge import prepare_proxy_request
from app.proxy.request_body import parse_json_object, read_json_object
from app.proxy.routing import select_endpoint
from app.proxy.token_estimate import (
    estimate_prompt_tokens,
    estimate_prompt_tokens_async,
    estimate_reservation_tokens_async,
)
from app.proxy.usage import estimate_cost, extract_response_text_any, extract_usage, finalize_stream_usage
from app.request_context import with_upstream_request_headers
from app.usage_writer import usage_writer

router = APIRouter()

_FINISH_MAP = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use", "content_filter": "end_turn"}


# ── 转换：A社 请求 → OpenAI chat 请求 ──────────────────────────────────
def _system_text(system) -> str | None:
    if system is None:
        return None
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return "".join(b.get("text", "") for b in system if isinstance(b, dict) and b.get("type") == "text")
    return None


def anthropic_to_openai(body: dict) -> dict:
    out: dict = {"model": body.get("model")}
    messages: list[dict] = []
    # 收集所有 system 内容（顶层 system 参数 + 混入 messages 的 role=system），
    # 统一合并为唯一一条置于消息列表首位——多数 vLLM chat template 只接受
    # system 出现在开头（否则 400 "System message must be the beginning"）。
    system_parts: list[str] = []
    sys = _system_text(body.get("system"))
    if sys:
        system_parts.append(sys)

    for msg in body.get("messages", []):
        role = msg.get("role")
        content = msg.get("content")
        if role == "system":
            text = content if isinstance(content, str) else _system_text(content)
            if text:
                system_parts.append(text)
            continue
        if isinstance(content, str):
            # 非标准角色（tool/function 等）钳制为 user：上游 chat template
            # 对未知角色直接 400，透传毫无收益
            messages.append({"role": role if role == "assistant" else "user",
                             "content": content})
            continue
        # content 是 block 数组
        parts: list[dict] = []
        tool_calls: list[dict] = []
        tool_results: list[dict] = []
        for block in content if isinstance(content, list) else []:
            bt = block.get("type")
            if bt == "text":
                parts.append({"type": "text", "text": block.get("text", "")})
            elif bt in ("thinking", "redacted_thinking"):
                continue  # 思考块不回传上游（OpenAI 协议无对应物，置 null 会 400）
            elif bt == "image":
                src = block.get("source", {})
                if src.get("type") == "base64":
                    url = f"data:{src.get('media_type','image/png')};base64,{src.get('data','')}"
                    parts.append({"type": "image_url", "image_url": {"url": url}})
                elif src.get("type") == "url" and src.get("url"):
                    parts.append({"type": "image_url", "image_url": {"url": src["url"]}})
            elif bt == "tool_use":
                tool_calls.append({
                    "id": block.get("id"), "type": "function",
                    "function": {"name": block.get("name"), "arguments": json.dumps(block.get("input", {}))},
                })
            elif bt == "tool_result":
                rc = block.get("content")
                if isinstance(rc, list):
                    rc = "".join(b.get("text", "") for b in rc if isinstance(b, dict))
                tool_results.append({"role": "tool", "tool_call_id": block.get("tool_use_id"),
                                     "content": rc if isinstance(rc, str) else json.dumps(rc)})

        if role == "assistant":
            m: dict = {"role": "assistant"}
            text = "".join(p["text"] for p in parts if p["type"] == "text")
            m["content"] = text or None
            if tool_calls:
                m["tool_calls"] = tool_calls
            if text or tool_calls:
                # 仅思考块的 assistant 回合直接丢弃：{"content": null} 且无
                # tool_calls 的消息不合 OpenAI 规范，多数上游 400
                messages.append(m)
        else:  # user
            prev = messages[-1] if messages else None
            if prev is not None and prev.get("role") == "assistant" and prev.get("tool_calls"):
                # tool 结果先于用户新文本：OpenAI 语义要求 role=tool 消息紧跟
                # 携带 tool_calls 的 assistant 消息之后
                messages.extend(tool_results)
            elif tool_results:
                # 孤立 tool_result（历史被截断，前面没有对应的 assistant
                # tool_calls）：降级为 user 文本，避免 role=tool 打头被上游 400
                parts = [{"type": "text",
                          "text": f"[工具结果] {t['content']}"} for t in tool_results] + parts
            non_text = any(p["type"] != "text" for p in parts)
            if parts:
                messages.append({"role": "user", "content": parts if non_text else
                                 "".join(p["text"] for p in parts)})

    if system_parts:
        messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})
    out["messages"] = messages
    for k in ("max_tokens", "temperature", "top_p", "stream"):
        if body.get(k) is not None:
            out[k] = body[k]
    if body.get("stop_sequences"):
        out["stop"] = body["stop_sequences"]
    if body.get("tools"):
        out["tools"] = [
            {"type": "function", "function": {
                "name": t.get("name"), "description": t.get("description", ""),
                "parameters": t.get("input_schema", {}),
            }} for t in body["tools"]
        ]
    tc = body.get("tool_choice")
    if isinstance(tc, dict):
        if tc.get("type") == "tool" and tc.get("name"):
            out["tool_choice"] = {"type": "function", "function": {"name": tc["name"]}}
        elif tc.get("type") == "any":
            out["tool_choice"] = "required"
        elif tc.get("type") == "none":
            out["tool_choice"] = "none"
        else:
            out["tool_choice"] = "auto"
    return out


# ── 转换：OpenAI 响应 → A社 响应（非流式）────────────────────────────
def _anthropic_usage(u: dict) -> dict:
    """内部规整化 usage（prompt/completion/cache_hit/cache_write）→ A社 usage 形状。

    cache_read_input_tokens / cache_creation_input_tokens 是 A社 客户端（含 CC）
    计算带缓存折扣成本的依据；此前转换只搬了 input/output_tokens，上游即使报了
    缓存命中（DeepSeek 的 prompt_cache_hit_tokens、OpenAI 的
    prompt_tokens_details.cached_tokens）也被吞掉——CC 看到的缓存成本永远是 0。
    上游未报缓存字段时留空（None→不写入该 key），不伪造成 0：那意味着「已确认
    无缓存」，而实际是「不知道」。
    """
    out = {"input_tokens": u.get("prompt_tokens") or 0, "output_tokens": u.get("completion_tokens") or 0}
    if u.get("cache_hit_tokens") is not None:
        out["cache_read_input_tokens"] = u["cache_hit_tokens"]
    if u.get("cache_write_tokens") is not None:
        out["cache_creation_input_tokens"] = u["cache_write_tokens"]
    return out


def openai_to_anthropic(oai: dict, model_name: str, usage: dict | None = None) -> dict:
    """usage 不传时从 oai["usage"] 现取（纯函数场景，如单测）；调用方若已经过
    finalize_stream_usage 兜底估算，应把那份传进来——否则上游偶发漏报 usage 时，
    内部日志按估算记账，回给客户端的 usage 却是 0，两边对不上。"""
    choice = (oai.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content: list[dict] = []
    if msg.get("content"):
        content.append({"type": "text", "text": msg["content"]})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        content.append({"type": "tool_use", "id": tc.get("id") or f"toolu_{uuid.uuid4().hex[:16]}",
                        "name": fn.get("name"), "input": args})
    return {
        "id": oai.get("id") or f"msg_{uuid.uuid4().hex[:20]}",
        "type": "message", "role": "assistant", "model": model_name,
        "content": content or [{"type": "text", "text": ""}],
        "stop_reason": _FINISH_MAP.get(choice.get("finish_reason"), "end_turn"),
        "stop_sequence": None,
        "usage": _anthropic_usage(usage if usage is not None else extract_usage(oai)),
    }


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def _anthropic_forward_headers(request: Request, anthropic_version: str | None) -> dict[str, str]:
    """保留 Claude Code 使用的开放 ``anthropic-*`` 请求头集合。

    Beta 功能要求请求体字段和 ``anthropic-beta`` 头成对出现；只转发 version 会
    让正常的 Claude Code 请求在上游变成 400。认证头不在此处转发，上游仍使用
    模型接入配置里的凭证。
    """
    forwarded: dict[str, str] = {}
    headers = getattr(request, "headers", None)
    if headers is not None:
        for name, value in headers.items():
            lower = name.lower()
            if lower.startswith("anthropic-"):
                forwarded[lower] = value
    forwarded.setdefault("anthropic-version", anthropic_version or "2023-06-01")
    return forwarded


def _append_query(url: str, query_string: str) -> str:
    if not query_string:
        return url
    return f"{url}{'&' if '?' in url else '?'}{query_string}"


# ── 端点 ─────────────────────────────────────────────────────────────────────
def _count_from_raw(raw: bytes) -> int:
    """在线程池里完成 JSON 解析 + token 估算。

    两步都是纯 CPU 且与请求体等大：nginx 放行到 50MB，实测 45MB 的 body 单次
    估算就要 ~550ms。留在事件循环里做，一个请求就能让整个 worker 停摆半秒；
    放进线程池后只占一个线程，其余请求照常收发。
    """
    return max(1, estimate_prompt_tokens(parse_json_object(raw)))


@router.post("/messages/count_tokens")
async def count_tokens(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
):
    """A社 count_tokens 兼容端点（CC 启动即调用）。

    自掌控 vLLM 上游没有对应接口，返回网关的字符级估算（与 TPM 预扣同一
    套算法）——对上下文管理场景精度足够，且零上游开销。

    虽然不打上游，仍走一遍 enforce_pre：Key 状态、模型权限与 RPM 校验和其它
    端点同口径，避免这里成为绕过策略的口子。est_tokens 传 0——本端点不消耗
    上游 token，不该占用调用方的 TPM 预算。
    """
    from app.proxy.db_bridge import async_validate_api_key

    raw = await request.body()
    client_auth = normalize_client_auth(authorization, x_api_key)
    key = await async_validate_api_key(client_auth)
    await policy.enforce_pre(key, request, db, 0)
    return {"input_tokens": await asyncio.to_thread(_count_from_raw, raw)}


@router.post("/messages")
async def messages(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
    anthropic_version: str | None = Header(default=None),
):
    body = await read_json_object(request)
    forward_headers = _anthropic_forward_headers(request, anthropic_version)
    request_url = getattr(request, "url", None)
    query_string = getattr(request_url, "query", "") or ""
    client_auth = normalize_client_auth(authorization, x_api_key)
    prep = await prepare_proxy_request(client_auth, body.get("model"))
    # TPM 预扣：A社 格式（system/content blocks/tools）同样计入估算
    reserved = await policy.enforce_pre(
        prep.key, request, db, await estimate_reservation_tokens_async(body), model=prep.model,
    )

    try:
        return await _attempt(
            body, prep.key, prep.model, prep.resolved_id, anthropic_version,
            reserved=reserved, fallback_from=prep.fallback_from,
            fallback_trigger=fallback.prep_fallback_trigger(prep.fallback_from, prep.fallback is not None),
            can_fallback=prep.fallback is not None, forward_headers=forward_headers,
            query_string=query_string,
        )
    except fallback.UpstreamFailure:
        pass
    # 兜底重试：首次尝试失败时预扣已返还，本次不再预扣。夜间准入的请求要把
    # NOT_METERED 继续带下去，否则重试这一程会被当成白天流量记进 TPM 桶。
    fb = prep.fallback
    return await _attempt(
        body, prep.key, fb, fallback.retry_resolved_id(prep.resolved_id, fb), anthropic_version,
        reserved=policy.retry_reserved(reserved), fallback_from=prep.model.id,
        fallback_trigger="retry", can_fallback=False, forward_headers=forward_headers,
        query_string=query_string,
    )


async def _attempt(
    body: dict,
    key: ApiKeyORM,
    model: ModelRegistryORM,
    resolved_id: str | None,
    anthropic_version: str | None,
    *,
    reserved: int,
    fallback_from: str | None,
    fallback_trigger: str | None = None,
    can_fallback: bool = False,
    forward_headers: dict[str, str] | None = None,
    query_string: str = "",
):
    stream = bool(body.get("stream"))
    cfg = fallback.get_config(model)

    eff = select_endpoint(model)  # 选一次端点，两条路径共用（异构接入）
    base, ep_idx = eff["base_url"], eff["ep_idx"]
    client = get_client()
    started = time.monotonic()
    base_log = fallback.enrich_usage_log(
        {"api_key_id": key.id, "model_id": model.id},
        fallback_from=fallback_from,
        fallback_trigger=fallback_trigger,
    )
    hdrs = resolved_headers(resolved_id, fallback_from)

    # ── 路径 1：anthropic 格式上游 → 透传 ──
    if eff["import_format"] in ("custom", "anthropic"):
        url = base if eff["import_format"] == "custom" else f"{base}/v1/messages"
        url = _append_query(url, query_string)
        up_headers = {"Content-Type": "application/json"}
        if eff["api_key"]:
            up_headers["x-api-key"] = eff["api_key"]
        if eff["custom_headers"]:
            up_headers.update(eff["custom_headers"])
        up_headers.update(
            forward_headers or {"anthropic-version": anthropic_version or "2023-06-01"}
        )
        up_headers = with_upstream_request_headers(up_headers)
        send_body = dict(body)
        if eff["model_api_name"]:
            send_body["model"] = eff["model_api_name"]

        if stream:
            # 先建连接检查状态，确认 2xx 才提交 StreamingResponse。
            req = client.build_request("POST", url, headers=up_headers, json=send_body)
            try:
                upstream_r = await client.send(req, stream=True)
            except fallback.TRANSPORT_ERRORS as exc:
                await record_transport_failure(
                    exc, started=started, base_log=base_log, api_key_id=key.id,
                    reserved=reserved, model=model, cfg=cfg, can_fallback=can_fallback)

            if upstream_r.status_code >= 400:
                body_bytes = await upstream_r.aread()
                await upstream_r.aclose()
                latency = int((time.monotonic() - started) * 1000)
                try:
                    payload = json.loads(body_bytes)
                except Exception:
                    payload = {"error": {"message": body_bytes.decode(errors="replace")[:500]}}
                usage_writer.enqueue({**base_log, "status_code": str(upstream_r.status_code),
                                      "latency_ms": latency, "total_duration_ms": latency,
                                      "prompt_tokens": None, "completion_tokens": None, "total_tokens": None,
                                      "error_detail": body_bytes.decode(errors="replace")[:1000]})
                await policy.refund_tokens(key.id, reserved)  # 上游拒绝，未消耗
                if await fallback.after_upstream(model, cfg, upstream_r.status_code, can_fallback):
                    raise fallback.UpstreamFailure(f"上游 {upstream_r.status_code}")
                return relay_json(upstream_r.status_code, payload, hdrs)

            await fallback.after_upstream(model, cfg, upstream_r.status_code, can_fallback)

            async def passthrough_anth():
                input_tokens = 0
                output_tokens = 0
                preview = ResponsePreview()
                # 兜底估算用的正文累积（content_block_delta 的 text_delta）
                stream_parts: list[str] = []
                stream_chars = 0
                STREAM_CAP = 2_000_000
                log_status = "200"
                transport_error: str | None = None
                try:
                    async for line in iter_with_keepalive(upstream_r.aiter_lines()):
                        if line is None:
                            yield _sse("ping", {"type": "ping"})
                            continue
                        if line.startswith("data:"):
                            try:
                                obj = json.loads(line[5:].strip())
                                t = obj.get("type")
                                if t == "message_start":
                                    input_tokens = ((obj.get("message") or {}).get("usage") or {}).get("input_tokens", 0)
                                elif t == "message_delta":
                                    output_tokens = (obj.get("usage") or {}).get("output_tokens", 0)
                                elif t == "content_block_delta" and stream_chars < STREAM_CAP:
                                    delta = obj.get("delta") or {}
                                    if delta.get("type") == "text_delta" and delta.get("text"):
                                        stream_parts.append(delta["text"])
                                        stream_chars += len(delta["text"])
                                preview.feed_anthropic_event(obj)
                            except Exception:
                                pass
                        yield (line + "\n").encode("utf-8")
                except fallback.TRANSPORT_ERRORS as exc:
                    log_status, transport_error = stream_transport_log(exc)
                    raise
                finally:
                    # 取消安全（P0）：断流时 finally 里的 await 会再次被取消
                    await guarded(upstream_r.aclose(), "upstream-close")
                    latency = int((time.monotonic() - started) * 1000)
                    usage, usage_estimated = finalize_stream_usage(
                        {
                            "prompt_tokens": input_tokens or None,
                            "completion_tokens": output_tokens or None,
                            "total_tokens": (input_tokens + output_tokens) or None,
                        },
                        body=send_body, streamed_text="".join(stream_parts),
                    )
                    usage_writer.enqueue({**base_log, "status_code": log_status, "latency_ms": latency,
                                          "total_duration_ms": latency, **usage,
                                          "usage_estimated": usage_estimated, "stream": True,
                                          "response_preview": preview.text,
                                          "error_detail": transport_error,
                                          "tool_calls_count": resolve_tool_calls_count(
                                              body, preview.tool_calls_count)})
                    await policy.record_tokens(key.id, usage.get("total_tokens"), reserved)

            return StreamingResponse(passthrough_anth(), media_type="text/event-stream",
                                     headers={**hdrs, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

        try:
            r = await client.post(url, headers=up_headers, json=send_body)
        except fallback.TRANSPORT_ERRORS as exc:
            await record_transport_failure(
                exc, started=started, base_log=base_log, api_key_id=key.id,
                reserved=reserved, model=model, cfg=cfg, can_fallback=can_fallback)
        latency = int((time.monotonic() - started) * 1000)
        try:
            payload = r.json()
        except Exception:
            payload = None
        if payload is None:
            usage_writer.enqueue({**base_log, "status_code": str(r.status_code),
                                  "latency_ms": latency, "total_duration_ms": latency,
                                  "error_detail": (r.text or "")[:1000]})
            # 上游返回非 JSON（如网关 502 HTML）：与其他路径同语义——
            # 4xx/5xx 视为未消耗，返还 TPM 预扣；2xx 则保留预扣作记账
            if r.status_code >= 400:
                await policy.refund_tokens(key.id, reserved)
            if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
                raise fallback.UpstreamFailure(f"上游 {r.status_code} 非 JSON")
            return relay_json(r.status_code, {"error": "上游非 JSON"}, hdrs)
        u = (payload.get("usage") or {}) if isinstance(payload, dict) else {}
        total = (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
        usage = {
            "prompt_tokens": u.get("input_tokens"),
            "completion_tokens": u.get("output_tokens"),
            "total_tokens": total or None,
        }
        usage_estimated = False
        tool_calls_count = 0
        if r.status_code < 400:
            # 上游 2xx 却没回报 usage 时兜底估算，避免日志出现误导性的 0
            # （4xx/5xx 不兜底：那种 0 是真的没消耗）
            usage, usage_estimated = finalize_stream_usage(
                usage, body=body, streamed_text=extract_response_text_any(payload),
            )
            proposed = 0
            if isinstance(payload, dict):
                tc_preview = ResponsePreview()
                tc_preview.feed_openai_payload(payload)
                proposed = tc_preview.tool_calls_count
            tool_calls_count = resolve_tool_calls_count(body, proposed)
        usage_writer.enqueue({**base_log, "status_code": str(r.status_code), "latency_ms": latency,
                              "total_duration_ms": latency,
                              **usage,
                              "usage_estimated": usage_estimated,
                              "estimated_cost": estimate_cost(model, usage.get("prompt_tokens"), usage.get("completion_tokens")),
                              "error_detail": (r.text or "")[:1000] if r.status_code >= 400 else None,
                              "response_preview": (r.text or "")[:500] or None,
                              "tool_calls_count": tool_calls_count})
        total = usage.get("total_tokens") or 0
        if r.status_code >= 400 and not total:
            await policy.refund_tokens(key.id, reserved)  # 上游拒绝，未消耗
        else:
            await policy.record_tokens(key.id, total or None, reserved)
        if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
            raise fallback.UpstreamFailure(f"上游 {r.status_code}")
        return relay_json(r.status_code, payload, hdrs)

    # ── 路径 2：openai 格式上游 → 转换 ──
    oai_body = anthropic_to_openai(body)
    if eff["model_api_name"]:
        oai_body["model"] = eff["model_api_name"]
    url = base if eff["import_format"] == "custom" else f"{base}/chat/completions"
    up_headers = {"Content-Type": "application/json"}
    if eff["api_key"]:
        up_headers["Authorization"] = f"Bearer {eff['api_key']}"
    if eff["custom_headers"]:
        up_headers.update(eff["custom_headers"])
    up_headers = with_upstream_request_headers(up_headers)

    if stream:
        return await _stream_convert(
            client, url, up_headers, oai_body, model, hdrs, base_log, started, ep_idx, reserved,
            cfg=cfg, can_fallback=can_fallback,
            fallback_from=fallback_from, requested_model=body.get("model"),
            request_body=body,
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
        # 上游 2xx 却没回报 usage 时兜底估算，避免日志出现误导性的 0
        # （4xx/5xx 不兜底：那种 0 是真的没消耗）
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
    # 上游报错时直接透传原始 body，不转换成 A社 格式（保留错误信息）
    if r.status_code >= 400:
        return relay_json(r.status_code, payload or {"error": "上游错误"}, hdrs)
    # 正常回显用户请求的模型名（LTS 别名也应原样回显）；发生兜底时如实改写为
    # 实际出结果的模型，与 X-Fallback-From 头相互印证，不对用户伪装
    anth = openai_to_anthropic(payload, model.id if fallback_from else body.get("model"), u)
    return relay_json(r.status_code, anth, hdrs)


async def _stream_convert(
    client, url, up_headers, oai_body, model, hdrs, base_log, started,
    ep_idx: int = 0,
    reserved_tokens: int = 0,
    cfg: dict | None = None,
    can_fallback: bool = False,
    fallback_from: str | None = None,
    requested_model: str | None = None,
    request_body: dict | None = None,
) -> JSONResponse | StreamingResponse:
    """先建连检查上游状态，确认 2xx 才返回 StreamingResponse（OpenAI→A社 SSE 转换）。
    上游 4xx/5xx 时以真实状态码返回 JSONResponse，防止客户端无限重试空流。

    这个检查点同时是兜底切换的安全点：尚未发出任何字节，换模型对用户无感。
    """
    # 回显模型名规则须与非流式路径一致（见上方"正常回显用户请求的模型名"注释）：
    # 没发生兜底时回显用户请求的别名（虚拟/LTS 模型也不该在流式路径里泄漏
    # 实际服务模型），发生兜底时才如实改写。此前这里恒用 model.id，导致同一个
    # 虚拟模型请求流式和非流式看到的 message.model 不一致。
    echo_model = model.id if fallback_from else (requested_model or model.id)
    # vLLM 仅在 stream_options.include_usage 开启时于末块回报 usage——
    # 不注入则本路径（A社 客户端 + OpenAI 上游）的 token 计量恒为 0。
    # 纯 usage 块只被网关旁路消费，转换层不会把它发给客户端，无需抑制。
    oai_body = {**oai_body, "stream": True,
                "stream_options": {**(oai_body.get("stream_options") or {}), "include_usage": True}}
    req = client.build_request("POST", url, headers=up_headers, json=oai_body)
    try:
        r = await client.send(req, stream=True)
    except fallback.TRANSPORT_ERRORS as exc:
        await record_transport_failure(
            exc, started=started, base_log=base_log,
            api_key_id=base_log["api_key_id"], reserved=reserved_tokens,
            model=model, cfg=cfg, can_fallback=can_fallback,
            extra_log={"prompt_tokens": None, "completion_tokens": None,
                       "total_tokens": None, "estimated_cost": None})

    if r.status_code >= 400:
        body_bytes = await r.aread()
        await r.aclose()
        latency = int((time.monotonic() - started) * 1000)
        try:
            payload = json.loads(body_bytes)
        except Exception:
            payload = {"error": {"message": body_bytes.decode(errors="replace")[:500]}}
        usage_writer.enqueue({**base_log, "status_code": str(r.status_code), "latency_ms": latency,
                              "total_duration_ms": latency, "prompt_tokens": None,
                              "completion_tokens": None, "total_tokens": None, "estimated_cost": None,
                              "error_detail": body_bytes.decode(errors="replace")[:1000]})
        await policy.refund_tokens(base_log["api_key_id"], reserved_tokens)
        if await fallback.after_upstream(model, cfg, r.status_code, can_fallback):
            raise fallback.UpstreamFailure(f"上游 {r.status_code}")
        return relay_json(r.status_code, payload, hdrs)

    await fallback.after_upstream(model, cfg, r.status_code, can_fallback)

    # 上游正常：转换 OpenAI SSE → A社 SSE
    msg_id = f"msg_{uuid.uuid4().hex[:20]}"

    async def gen():
        text_started = False
        text_index = 0
        tool_blocks: dict[int, dict] = {}
        next_index = 0
        finish = "stop"
        usage_seen: dict = {}
        stream_error: dict | None = None
        transport_error: str | None = None
        log_status = str(r.status_code)
        preview = ResponsePreview()
        # 兜底估算用的正文累积（content + 工具参数）
        stream_parts: list[str] = []
        stream_chars = 0
        STREAM_CAP = 2_000_000
        try:
            # 真实 A社 上游在流开始前已经算好 input_tokens；桥接的 OpenAI 上游只在
            # 流末尾（include_usage）才报 usage，这里用请求侧估算垫上——好过硬编码
            # 0（CC 靠 message_start.usage.input_tokens 做早期上下文/成本展示，
            # 恒为 0 会一直误导）。message_delta 收到上游真实用量后会覆盖更准的值。
            yield _sse("message_start", {"type": "message_start", "message": {
                "id": msg_id, "type": "message", "role": "assistant", "model": echo_model,
                "content": [], "stop_reason": None,
                "usage": {"input_tokens": await estimate_prompt_tokens_async(oai_body), "output_tokens": 0}}})
            async for line in iter_with_keepalive(r.aiter_lines()):
                if line is None:
                    yield _sse("ping", {"type": "ping"})
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
                    # 建连成功后上游仍可能在 SSE 中途报错。不能把它吞掉再伪造
                    # message_stop，否则 Claude Code 会把空回复当成功并停止重试。
                    stream_error = obj["error"]
                    yield _sse("error", {"type": "error", "error": stream_error})
                    return
                if obj.get("usage"):
                    usage_seen = extract_usage(obj)
                preview.feed_openai_chunk(obj)
                ch = (obj.get("choices") or [{}])[0]
                delta = ch.get("delta") or {}
                if ch.get("finish_reason"):
                    finish = ch["finish_reason"]
                if delta.get("content"):
                    if stream_chars < STREAM_CAP:
                        stream_parts.append(delta["content"])
                        stream_chars += len(delta["content"])
                    if not text_started:
                        yield _sse("content_block_start", {"type": "content_block_start", "index": next_index,
                                   "content_block": {"type": "text", "text": ""}})
                        text_started = True
                        text_index = next_index
                        next_index += 1
                    yield _sse("content_block_delta", {"type": "content_block_delta", "index": text_index,
                               "delta": {"type": "text_delta", "text": delta["content"]}})
                for tc in delta.get("tool_calls") or []:
                    i = tc.get("index", 0)
                    blk = tool_blocks.get(i)
                    if blk is None:
                        blk = {"id": tc.get("id") or f"toolu_{uuid.uuid4().hex[:16]}",
                               "name": (tc.get("function") or {}).get("name", ""), "buf": "",
                               "anth_index": next_index, "started": False}
                        tool_blocks[i] = blk
                        next_index += 1
                    else:
                        if tc.get("id"):
                            blk["id"] = tc["id"]
                        later_name = (tc.get("function") or {}).get("name")
                        if later_name:
                            blk["name"] = later_name
                    frag = (tc.get("function") or {}).get("arguments")
                    # 部分上游首分片只有 index/id，工具名在后续分片。等拿到工具名
                    # （或参数已开始）再发 start，避免 Claude Code 收到空 name。
                    if not blk["started"] and (blk["name"] or frag):
                        yield _sse("content_block_start", {
                            "type": "content_block_start", "index": blk["anth_index"],
                            "content_block": {"type": "tool_use", "id": blk["id"],
                                              "name": blk["name"], "input": {}},
                        })
                        blk["started"] = True
                    if frag:
                        blk["buf"] += frag
                        if stream_chars < STREAM_CAP:
                            stream_parts.append(frag)
                            stream_chars += len(frag)
                        yield _sse("content_block_delta", {"type": "content_block_delta", "index": blk["anth_index"],
                                   "delta": {"type": "input_json_delta", "partial_json": frag}})
            if text_started:
                yield _sse("content_block_stop", {"type": "content_block_stop", "index": text_index})
            for blk in tool_blocks.values():
                if not blk["started"]:
                    yield _sse("content_block_start", {
                        "type": "content_block_start", "index": blk["anth_index"],
                        "content_block": {"type": "tool_use", "id": blk["id"],
                                          "name": blk["name"], "input": {}},
                    })
                yield _sse("content_block_stop", {"type": "content_block_stop", "index": blk["anth_index"]})
            # 同 finally 里的兜底估算逻辑（那份是给内部日志用的，这里独立算一次
            # 是给客户端看的）：上游报了 usage 就用真实值，没报就按请求体 + 已产出
            # 正文估算，避免 CC 在流结束时看到一个骗人的 0。
            final_usage, _ = finalize_stream_usage(
                usage_seen, body=oai_body, streamed_text="".join(stream_parts),
            )
            yield _sse("message_delta", {"type": "message_delta",
                       "delta": {"stop_reason": _FINISH_MAP.get(finish, "end_turn"), "stop_sequence": None},
                       "usage": _anthropic_usage(final_usage)})
            yield _sse("message_stop", {"type": "message_stop"})
        except fallback.TRANSPORT_ERRORS as exc:
            log_status, transport_error = stream_transport_log(exc)
            raise
        finally:
            # 取消安全（P0）：断流时 finally 里的 await 会再次被取消
            await guarded(r.aclose(), "upstream-close")
            latency = int((time.monotonic() - started) * 1000)
            usage, usage_estimated = finalize_stream_usage(
                usage_seen, body=oai_body, streamed_text="".join(stream_parts),
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
            await policy.record_tokens(
                base_log.get("api_key_id"), usage.get("total_tokens"), reserved_tokens
            )

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={**hdrs, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
