"""prompt 计数与生成请求 prompt + 最大输出 TPM 预扣单测。"""
import pytest

from app.config import settings
from app.proxy import token_estimate
from app.proxy.token_estimate import (
    estimate_max_output_tokens,
    estimate_prompt_tokens,
    estimate_prompt_tokens_async,
    estimate_reservation_tokens,
    estimate_reservation_tokens_async,
)


def test_estimate_counts_tools_and_tool_calls():
    base = {"messages": [{"role": "user", "content": "hi"}]}
    with_tools = {
        **base,
        "tools": [{"type": "function", "function": {
            "name": "search", "description": "web search " * 200,
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        }}],
    }
    assert estimate_prompt_tokens(with_tools) > estimate_prompt_tokens(base) + 100

    with_tc = {"messages": [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "tool_calls": [{"type": "function", "function": {
            "name": "search", "arguments": '{"q": "' + "长查询" * 500 + '"}'}}]},
        {"role": "tool", "content": "result " * 300},
    ]}
    assert estimate_prompt_tokens(with_tc) > 1000


def test_estimate_anthropic_format():
    body = {
        "system": [{"type": "text", "text": "系统提示" * 100}],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "问题" * 100},
            {"type": "image", "source": {"type": "base64", "data": "x" * 100000}},
        ]}],
        "max_tokens": 4096,
    }
    est = estimate_prompt_tokens(body)
    # 图片按固定 1024 计，不能被 base64 长度撑爆
    assert 1024 < est < 3000


def test_estimate_completions_prompt_and_responses_input():
    assert estimate_prompt_tokens({"prompt": "补全" * 500}) >= 1000
    assert estimate_prompt_tokens({"input": "输入" * 500, "instructions": "指令" * 100}) >= 1200


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("max_tokens", 101),
        ("max_completion_tokens", 102),
        ("max_output_tokens", 103),
        ("max_new_tokens", 104),
        ("max_tokens_to_sample", 105),
    ],
)
def test_all_generation_output_limit_aliases_are_reserved(field, value):
    assert estimate_max_output_tokens({field: value}) == value


def test_conflicting_output_aliases_cannot_select_smaller_reservation():
    body = {"max_tokens": 1, "max_completion_tokens": 20_000}
    assert estimate_max_output_tokens(body) == 20_000


def test_multiple_candidates_multiply_output_budget():
    assert estimate_max_output_tokens({"max_tokens": 1000, "n": 3}) == 3000
    assert estimate_max_output_tokens({"max_tokens": 1000, "n": 2, "best_of": 5}) == 5000


def test_missing_or_invalid_output_limit_uses_safe_default(monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_DEFAULT_MAX_OUTPUT_TOKENS", 4096)
    assert estimate_max_output_tokens({}) == 4096
    assert estimate_max_output_tokens({"max_tokens": 0}) == 4096
    assert estimate_max_output_tokens({"max_tokens": False}) == 4096
    assert estimate_max_output_tokens({"max_tokens": "8192"}) == 8192


def test_huge_numeric_string_saturates_instead_of_crashing_or_using_default():
    huge = "9" * 100_000
    assert estimate_max_output_tokens({"max_tokens": huge}) == 2**63 - 1


def test_huge_candidate_multiplier_saturates_each_input_without_bigint_parsing():
    huge = "9" * 100_000
    # Multiplication remains a small, bounded Python integer operation because
    # each attacker-controlled operand is saturated before it is combined.
    assert estimate_max_output_tokens({"max_tokens": huge, "n": huge}) == (2**63 - 1) ** 2


def test_reservation_covers_prompt_and_max_output():
    body = {"prompt": "补全" * 500, "max_tokens": 2000}
    assert estimate_reservation_tokens(body) == estimate_prompt_tokens(body) + 2000


def test_deep_json_content_does_not_exhaust_python_recursion_limit():
    nested: object = "deep content"
    for _ in range(5_000):
        nested = [nested]
    assert estimate_prompt_tokens({"input": nested}) > 0


@pytest.mark.asyncio
async def test_async_estimators_always_leave_the_event_loop(monkeypatch):
    calls = []

    async def fake_to_thread(function, *args):
        calls.append(function)
        return function(*args)

    monkeypatch.setattr(token_estimate.asyncio, "to_thread", fake_to_thread)
    body = {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 8}

    assert await estimate_prompt_tokens_async(body) == estimate_prompt_tokens(body)
    assert await estimate_reservation_tokens_async(body) == estimate_reservation_tokens(body)
    assert calls == [estimate_prompt_tokens, estimate_reservation_tokens]
