"""从上游响应提取 token 用量 + 成本估算（cache-ready：透传命中指标）。"""
from __future__ import annotations

import json

from app.models import ModelRegistryORM
from app.proxy.token_estimate import estimate_completion_tokens, estimate_prompt_tokens


def extract_usage(payload: dict | None) -> dict:
    """从 OpenAI 风格响应体提取 usage。返回标准化 dict。"""
    u = (payload or {}).get("usage") or {}
    details = u.get("prompt_tokens_details") or {}
    return {
        "prompt_tokens": u.get("prompt_tokens"),
        "completion_tokens": u.get("completion_tokens"),
        "total_tokens": u.get("total_tokens"),
        # DeepSeek/OpenAI 风格上下文缓存命中指标（本期仅透传，不自建缓存）
        "cache_hit_tokens": u.get("prompt_cache_hit_tokens") or details.get("cached_tokens"),
        "cache_miss_tokens": u.get("prompt_cache_miss_tokens"),
        "cache_write_tokens": u.get("prompt_cache_write_tokens"),
    }


def extract_usage_any(payload: dict | None) -> dict:
    """OpenAI chat 风格（prompt_tokens）与 Responses API 风格（input_tokens）
    通吃的 usage 提取；Responses 流式的 usage 藏在 response.completed 事件的
    response.usage 里，同样在此处理。"""
    p = payload or {}
    u = p.get("usage") or (p.get("response") or {}).get("usage") or {}
    if not isinstance(u, dict) or not u:
        return extract_usage(None)
    if "input_tokens" in u or "output_tokens" in u:
        details = u.get("input_tokens_details") or {}
        pt = u.get("input_tokens")
        ct = u.get("output_tokens")
        return {
            "prompt_tokens": pt,
            "completion_tokens": ct,
            "total_tokens": u.get("total_tokens") or (((pt or 0) + (ct or 0)) or None),
            "cache_hit_tokens": details.get("cached_tokens"),
            "cache_miss_tokens": None,
            "cache_write_tokens": None,
        }
    return extract_usage({"usage": u})


def extract_response_text_any(payload: dict | None) -> str:
    """非流式响应正文摘要，供 completion 侧兜底估算复用。

    OpenAI chat / 旧版 completions（choices[].message.content / choices[].text）、
    A社 messages（content blocks）、Responses API（output_text / output[].content）
    通吃——不同格式的顶层字段互不相交，同一 payload 只会命中其中一种，无需先判型。
    """
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    ot = payload.get("output_text")
    if isinstance(ot, str) and ot:
        parts.append(ot)
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        for c in item.get("content") or []:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                parts.append(c["text"])
    for block in payload.get("content") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif block.get("type") == "tool_use" and block.get("input") is not None:
            try:
                parts.append(json.dumps(block["input"], ensure_ascii=False))
            except Exception:
                pass
    for ch in payload.get("choices") or []:
        if not isinstance(ch, dict):
            continue
        msg = ch.get("message")
        if isinstance(msg, dict):
            c = msg.get("content")
            if isinstance(c, str):
                parts.append(c)
            for tc in msg.get("tool_calls") or []:
                frag = ((tc or {}).get("function") or {}).get("arguments")
                if isinstance(frag, str):
                    parts.append(frag)
        text = ch.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def estimate_cost(model: ModelRegistryORM, prompt_tokens: int | None, completion_tokens: int | None) -> float:
    """按模型刊例价估算费用（¥）。无管理员定价时回落业界参考价。"""
    from app.industry_pricing import estimate_tokens_cost

    return estimate_tokens_cost(prompt_tokens, completion_tokens, model=model, model_id=model.id)


def finalize_stream_usage(
    usage_seen: dict,
    *,
    body: dict,
    streamed_text: str,
) -> tuple[dict, bool]:
    """用量兜底合并，流式 / 非流式路径共用。

    上游回报了 usage（total_tokens 非空）→ 原样采用，usage_estimated=False；
    缺失时用请求体估算 prompt、用正文估算 completion，并标记 usage_estimated=True
    ——否则日志/统计里会出现误导性的 0。触发场景：
      · 流式：上游不支持 stream_options.include_usage、客户端在末块前断流
      · 非流式：上游 2xx 但响应体缺 usage 字段（自建 vLLM 偶发漏填等）
    ``streamed_text`` 对非流式调用同样适用——传入完整响应正文摘要即可
    （见 extract_response_text_any）。
    """
    seen = usage_seen or {}
    if seen.get("total_tokens"):
        return seen, False
    pt = seen.get("prompt_tokens")
    ct = seen.get("completion_tokens")
    estimated = False
    if pt is None:
        pt = estimate_prompt_tokens(body or {})
        estimated = True
    if ct is None:
        ct = estimate_completion_tokens(streamed_text or "")
        estimated = True
    if not estimated:
        return seen, False
    return {
        **seen,
        "prompt_tokens": pt,
        "completion_tokens": ct,
        "total_tokens": (pt or 0) + (ct or 0),
    }, True
