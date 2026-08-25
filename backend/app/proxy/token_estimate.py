"""请求 prompt 侧 token 估算（TPM 原子预扣 + count_tokens 端点共用）。

字符级估算、无需 tokenizer：网关不做任何基于估算的拒绝或路由决策，
估算只用于 TPM 预记账（完成后按上游回报的实际用量校正差额），
±15% 级别的误差完全可接受。

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

# 图片内容保守估算
_IMAGE_TOKENS = 1024
# 每条消息固定结构开销（role + delimiters）
_MSG_OVERHEAD = 4

# 视为图片、按固定 token 计的 content part 类型（OpenAI / A社 / Responses）
_IMAGE_PART_TYPES = {"image", "image_url", "input_image"}


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
    """递归估算任意 JSON 结构中的文本 token；图片 part 按固定值计。"""
    if node is None:
        return 0
    if isinstance(node, str):
        return _count_text_tokens(node)
    if isinstance(node, (int, float, bool)):
        return 1
    if isinstance(node, dict):
        if node.get("type") in _IMAGE_PART_TYPES:
            return _IMAGE_TOKENS
        return sum(_walk(v) for v in node.values())
    if isinstance(node, list):
        return sum(_walk(v) for v in node)
    return 0


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


# 大 body 阈值：超过才移出事件循环估算（避免每次请求都付线程池开销）
_ASYNC_OFFLOAD_BYTES = 50_000


async def estimate_prompt_tokens_async(body: dict) -> int:
    """异步估算（2026-08 审计修复）：小请求内联，超大请求体移出事件循环。

    单次全量递归遍历在超大请求体（如 45MB 代码提交）下可达数百毫秒，内联会
    卡死整个 worker 事件循环、连坐其上所有并发请求（含流式）。小请求走内联
    避免线程池开销；超阈值才丢线程池估算。
    """
    try:
        size = len(json.dumps(body, default=str))
    except Exception:
        size = 0
    if size < _ASYNC_OFFLOAD_BYTES:
        return estimate_prompt_tokens(body)
    return await asyncio.to_thread(estimate_prompt_tokens, body)
