"""请求 token 估算（TPM 原子预扣 + count_tokens 端点共用）。

字符级 prompt 估算无需 tokenizer；生成型入口的 TPM 预扣在此基础上加上客户端
声明的最大输出预算。未声明最大输出时使用运行时配置的保守默认值。估算只用于
TPM 准入与预记账，完成后仍按上游回报的实际用量校正差额。

估算覆盖全部请求格式与字段：
  · OpenAI chat：messages（含多模态 parts、assistant tool_calls、tool 结果）、
    tools / tool_choice 定义
  · A社 messages：system、content blocks（text / image / tool_use /
    tool_result）、tools 定义
  · 旧版 completions：prompt（str 或 list）
  · Responses API：instructions、input（str 或 items）、tools
  · rerank：query、documents
"""
from __future__ import annotations

import asyncio
import json
import math
import re
from typing import Any

from app.config import settings

# 图片内容保守估算
_IMAGE_TOKENS = 1024
# 每条消息固定结构开销（role + delimiters）
_MSG_OVERHEAD = 4

# 视为图片、按固定 token 计的 content part 类型（OpenAI / A社 / Responses）
_IMAGE_PART_TYPES = {"image", "image_url", "input_image"}

# 各兼容协议的输出上限名称。取所有已出现字段的最大值，避免同时提交一个很小的
# 旧字段和一个很大的新字段来影响不同上游、却只按较小值预扣。
_MAX_OUTPUT_FIELDS = (
    "max_completion_tokens",  # OpenAI Chat 新字段
    "max_output_tokens",      # OpenAI Responses
    "max_tokens",             # Chat / Completions / Anthropic Messages
    "max_new_tokens",         # 常见自托管推理兼容字段
    "max_tokens_to_sample",   # 旧 Anthropic 兼容字段
)

# 任何超过实际模型可能支持范围的客户端预算都只需保持“必然超过 TPM”的
# 语义。使用固定饱和值可避免超长十进制字符串触发 Python 的大整数转换保护，
# 同时不能把恶意超大值回落成较小的默认预算而形成准入绕过。
_MAX_PARSED_BUDGET = 2**63 - 1


# 预编译 CJK 匹配：估算在事件循环内同步执行，超大 prompt（数百 KB）下
# 逐字符 Python 循环会阻塞事件循环，regex findall 走 C 实现快一个数量级。
_CJK_RE = re.compile(r"[一-鿿]")


def _count_text_tokens(text: str) -> int:
    """字符级估算（无需 tokenizer）：中文 1 char ≈ 1 token，其他 3.5 chars ≈ 1 token。"""
    if not text:
        return 0
    if text.startswith("data:") and len(text) > 256:
        return _IMAGE_TOKENS  # 内联 base64 图片，按图片计而非按字符计
    chinese = len(_CJK_RE.findall(text))
    others = len(text) - chinese
    return chinese + math.ceil(others / 3.5)


def estimate_completion_tokens(text: str) -> int:
    """估算流式响应正文的 completion 侧 token（字符级，与 prompt 侧同一口径）。

    仅在上游未回报 usage 时兜底使用；返回 0 表示确实没有可计数的正文。
    """
    return _count_text_tokens(text or "")


def _walk(node: Any) -> int:
    """迭代估算任意 JSON 结构；深层嵌套不能耗尽 Python 调用栈。"""
    total = 0
    stack = [node]
    while stack:
        current = stack.pop()
        if current is None:
            continue
        if isinstance(current, str):
            total += _count_text_tokens(current)
        elif isinstance(current, (int, float, bool)):
            total += 1
        elif isinstance(current, dict):
            if current.get("type") in _IMAGE_PART_TYPES:
                total += _IMAGE_TOKENS
            else:
                stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return total


def _tools_tokens(tools: Any, tool_choice: Any) -> int:
    """工具定义按 JSON 全文计——schema 的键与结构在上游同样消耗 token，
    agent 场景下动辄上万 token，是长上下文的主要来源之一，不可忽略。"""
    total = 0
    if tools:
        try:
            total += _count_text_tokens(json.dumps(tools, ensure_ascii=False))
        except Exception:
            total += _walk(tools)
    if tool_choice and not isinstance(tool_choice, str):
        total += _walk(tool_choice)
    return total


def estimate_prompt_tokens(body: dict[str, Any]) -> int:
    """估算请求的 prompt 侧 token 总量，自动识别请求格式。"""
    total = 0

    # OpenAI chat / A社 messages
    messages = body.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            total += _MSG_OVERHEAD
            total += _walk(msg.get("content"))
            total += _walk(msg.get("tool_calls"))       # assistant 工具调用参数
            total += _count_text_tokens(str(msg.get("name") or ""))

    # A社 system（str 或 blocks）
    total += _walk(body.get("system"))

    # 旧版 completions
    total += _walk(body.get("prompt"))

    # Responses API
    total += _walk(body.get("input"))
    total += _walk(body.get("instructions"))

    # rerank
    total += _walk(body.get("query"))
    total += _walk(body.get("documents"))

    # 工具定义
    total += _tools_tokens(body.get("tools"), body.get("tool_choice"))

    return total


def _positive_int(value: Any) -> int | None:
    """保守解析 JSON 整数；非法/非正值不能成为把输出预算降到 0 的绕过。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return min(value, _MAX_PARSED_BUDGET) if value > 0 else None
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized.isdigit():
            return None
        normalized = normalized.lstrip("0") or "0"
        if len(normalized) > 19:
            return _MAX_PARSED_BUDGET
        parsed = int(normalized)
        return min(parsed, _MAX_PARSED_BUDGET) if parsed > 0 else None
    return None


def estimate_max_output_tokens(body: dict[str, Any]) -> int:
    """返回本请求最多可能生成的 token 数（含多候选放大）。

    ``n`` 是返回候选数；legacy Completions 的 ``best_of`` 还会在服务端生成未
    返回的候选，其 token 同样可能计费，因此取二者最大值。任何非法上限值都
    回落到安全默认，而不是按 0 处理。
    """
    candidates = [
        parsed
        for name in _MAX_OUTPUT_FIELDS
        if (parsed := _positive_int(body.get(name))) is not None
    ]
    per_candidate = max(candidates, default=settings.RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS)
    multiplier = max(
        _positive_int(body.get("n")) or 1,
        _positive_int(body.get("best_of")) or 1,
    )
    return per_candidate * multiplier


def estimate_reservation_tokens(body: dict[str, Any]) -> int:
    """生成型请求的 TPM 预扣预算：prompt + 有界最大输出。"""
    return estimate_prompt_tokens(body) + estimate_max_output_tokens(body)


async def estimate_prompt_tokens_async(body: dict) -> int:
    """在线程池估算，任意体积的请求都不在事件循环做全量遍历。

    不能先在事件循环中序列化请求来判断大小：这个预判本身对超大请求就可能耗时
    数百毫秒。统一付出一次线程调度成本，换取 worker 并发延迟的明确上界。
    """
    return await asyncio.to_thread(estimate_prompt_tokens, body)


async def estimate_reservation_tokens_async(body: dict) -> int:
    """异步计算生成型请求的 prompt + 最大输出预扣预算。"""
    return await asyncio.to_thread(estimate_reservation_tokens, body)
