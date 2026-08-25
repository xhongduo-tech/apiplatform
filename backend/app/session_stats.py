"""Session 级统计：tool call 分布、上下文长度分桶辅助。"""
from __future__ import annotations

import json
import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import UsageLogORM, UsageRequestProfileORM

# Session 口径与「上下文长度」一致：一次 API 请求 = 一次对话（session）。
# 不再按 Key 空闲间隔合并多轮请求。
#
# 成功工具调用次数（写入 usage_request_profile.tool_calls_count）：
#   从请求上文统计本回合已回填的 tool 结果，而非响应里「新发起」的 tool_calls。
#   历史流式 preview 无法回填；此后只依赖中继时对本函数的显式写入。

TOOL_CALL_BUCKETS: list[tuple[str, int, int | None]] = [
    ("0", 0, 0),
    ("1–5", 1, 5),
    ("6–10", 6, 10),
    ("11–25", 11, 25),
    ("26–50", 26, 50),
    ("51–100", 51, 100),
    ("100+", 101, None),
]


# 上下文长度分桶边界（与 user._CONTEXT_BUCKETS / width_bucket 一致）
_CONTEXT_BOUNDARIES = [
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000,
]

CONTEXT_LENGTH_LABELS = [
    "<1k", "1k–2k", "2k–4k", "4k–8k", "8k–16k", "16k–32k",
    "32k–64k", "64k–128k", "128k–256k", "256k–512k", "512k–1m", "1m+",
]


def context_bucket_index(prompt_tokens: int) -> int:
    """返回 0..11 分桶索引；无效输入返回 -1。"""
    if prompt_tokens <= 0:
        return -1
    for i, bound in enumerate(_CONTEXT_BOUNDARIES):
        if prompt_tokens < bound:
            return i
    return len(_CONTEXT_BOUNDARIES)


def empty_context_buckets() -> list[dict]:
    return [{"label": label, "count": 0, "share": 0.0, "cum_share": 0.0} for label in CONTEXT_LENGTH_LABELS]


def _assistant_has_tool_calls(msg: dict) -> bool:
    if msg.get("role") != "assistant":
        return False
    tcs = msg.get("tool_calls")
    if isinstance(tcs, list) and tcs:
        return True
    content = msg.get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("tool_use", "tool_calls"):
                return True
    return False


def _count_tool_results_after_assistant(messages: list) -> int:
    """本回合：最后一条带 tool_calls/tool_use 的 assistant 之后的成功回填条数。

    若其后已有新的 assistant 回复，说明那批 tool_result 已被上一轮消费，
    对当前请求不计（避免长对话里把历史成功重复算进每次后续请求）。
    """
    last_idx = -1
    for i, msg in enumerate(messages):
        if isinstance(msg, dict) and _assistant_has_tool_calls(msg):
            last_idx = i
    if last_idx < 0:
        return 0
    n = 0
    for msg in messages[last_idx + 1 :]:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "tool":
            n += 1
            continue
        if role == "user":
            content = msg.get("content")
            if isinstance(content, list):
                results = sum(
                    1
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "tool_result"
                )
                if results:
                    n += results
                    continue
            break
        if role == "assistant":
            return 0
        break
    return n


def _count_responses_turn_tool_outputs(items: list) -> int:
    """Responses API input：最后一轮 function_call 之后的 function_call_output 数。

    若其后已有 message（模型已消费这批 output），对当前请求计 0。
    """
    last_fc = -1
    for i, item in enumerate(items):
        if isinstance(item, dict) and item.get("type") in ("function_call", "tool_call"):
            last_fc = i
    if last_fc < 0:
        return 0
    n = 0
    for item in items[last_fc + 1 :]:
        if not isinstance(item, dict):
            continue
        t = item.get("type")
        if t in ("function_call_output", "tool_result"):
            n += 1
            continue
        if t == "message" or item.get("role") == "assistant":
            return 0
        if t in ("function_call", "tool_call") or item.get("role") == "user":
            break
    return n


def count_successful_tool_calls_in_body(body: dict | None) -> int:
    """从请求上文统计本回合「成功工具调用」次数。

    公式：定位最后一条携带 tool_calls / tool_use 的 assistant（或 Responses 的
    function_call），其后连续的 role=tool / tool_result / function_call_output
    条数。这些是客户端已执行并回填的结果，才算成功。
    """
    if not isinstance(body, dict):
        return 0
    messages = body.get("messages")
    if isinstance(messages, list):
        return _count_tool_results_after_assistant(messages)
    inp = body.get("input")
    if isinstance(inp, list):
        return _count_responses_turn_tool_outputs(inp)
    return 0


def resolve_tool_calls_count(body: dict | None, response_proposed: int = 0) -> int:
    """写入 profile 的 tool call 次数。

    优先统计请求上文里本回合已回填的 tool 结果（多轮 Agent 的 follow-up 请求）；
    若上文尚无回填（模型刚发起 tool_calls、尚未执行），则回落到本响应里的
    tool_calls / tool_use 数量。这样分布图不会把「模型发起工具调用」的回合误计为 0。
    """
    body_count = count_successful_tool_calls_in_body(body)
    if body_count > 0:
        return body_count
    return max(0, int(response_proposed or 0))


def count_tool_calls_in_preview(preview: str | None) -> int:
    """从 response_preview（截断响应体或流式正文摘要）估算单次请求的 tool call 数。"""
    if not preview:
        return 0
    text = preview.strip()
    if not text:
        return 0
    if text.startswith("{"):
        try:
            return _count_tool_calls_in_payload(json.loads(text))
        except Exception:
            pass
    # 截断 JSON / 流式摘要：启发式计数（流式预览历史上只有正文，常估为 0）
    if '"tool_calls"' in text or '"tool_call"' in text:
        ids = len(re.findall(r'"id"\s*:\s*"call[_-]?\w*', text))
        fns = len(re.findall(r'"function"\s*:\s*\{', text))
        idxs = len(re.findall(r'"index"\s*:\s*\d+', text))
        return max(ids, fns, idxs, 1)
    if '"tool_use"' in text or '"function_call"' in text:
        return max(
            1,
            len(re.findall(r'"type"\s*:\s*"tool_use"', text)),
            len(re.findall(r'"type"\s*:\s*"function_call"', text)),
            text.count('"tool_use"'),
            text.count('"function_call"'),
        )
    if '"finish_reason"' in text and "tool_calls" in text:
        return 1
    return 0


def _count_tool_calls_in_payload(obj: dict) -> int:
    n = 0
    for ch in obj.get("choices") or []:
        if not isinstance(ch, dict):
            continue
        msg = ch.get("message") or {}
        tcs = msg.get("tool_calls") or []
        if isinstance(tcs, list) and tcs:
            n += len(tcs)
        elif ch.get("finish_reason") == "tool_calls":
            n = max(n, 1)
    for item in obj.get("output") or []:
        if isinstance(item, dict) and item.get("type") in ("function_call", "tool_call"):
            n += 1
    for block in obj.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            n += 1
    return n


def _bucket_tool_calls(n: int) -> str:
    for label, lo, hi in TOOL_CALL_BUCKETS:
        if hi is None:
            if n >= lo:
                return label
        elif lo <= n <= hi:
            return label
    return TOOL_CALL_BUCKETS[-1][0]


def _counts_from_tool_totals(totals: list[int]) -> dict:
    """一次对话（一次请求）的 tool_calls_count 列表 → 分桶结果。"""
    total = len(totals)
    if total == 0:
        return {
            "buckets": [
                {"label": label, "count": 0, "share": 0.0}
                for label, _, _ in TOOL_CALL_BUCKETS
            ],
            "total_sessions": 0,
        }
    counts = {label: 0 for label, _, _ in TOOL_CALL_BUCKETS}
    for n in totals:
        counts[_bucket_tool_calls(n)] += 1
    return {
        "buckets": [
            {
                "label": label,
                "count": counts[label],
                "share": round(counts[label] / total * 100, 1),
            }
            for label, _, _ in TOOL_CALL_BUCKETS
        ],
        "total_sessions": total,
    }


def _load_log_preview_tool_counts(
    db: Session,
    *,
    key_ids: list[str],
    since_utc: datetime,
) -> list[int]:
    log_rows = db.execute(
        select(UsageLogORM.response_preview)
        .where(
            UsageLogORM.api_key_id.in_(key_ids),
            UsageLogORM.created_at >= since_utc,
        )
    ).all()
    return [count_tool_calls_in_preview(r[0]) for r in log_rows]


def build_tool_call_distribution(
    db: Session,
    *,
    key_ids: list[str],
    since_utc: datetime,
) -> dict:
    """按「一次对话 = 一次请求」分桶，口径对齐上下文长度（各次请求独立计入）。"""
    rows = db.execute(
        select(UsageRequestProfileORM.tool_calls_count)
        .where(
            UsageRequestProfileORM.api_key_id.in_(key_ids),
            UsageRequestProfileORM.created_at >= since_utc,
        )
    ).all()
    totals = [int(r[0] or 0) for r in rows]

    # 历史流式路径 tool_calls_count 可能全 0；回落 logs 的 preview 启发式（非流式 JSON 或可命中）
    if not totals:
        totals = _load_log_preview_tool_counts(db, key_ids=key_ids, since_utc=since_utc)
    elif sum(totals) == 0:
        from_logs = _load_log_preview_tool_counts(db, key_ids=key_ids, since_utc=since_utc)
        if sum(from_logs) > 0:
            totals = from_logs

    return _counts_from_tool_totals(totals)
