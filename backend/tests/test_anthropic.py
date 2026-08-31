"""A社 ⇄ OpenAI 转换单测（纯函数，无网络）。"""
import json

import pytest
from fastapi import HTTPException

from app.proxy.anthropic import _count_from_raw, anthropic_to_openai, openai_to_anthropic


def test_count_tokens_raw_parser_requires_a_json_object():
    assert _count_from_raw(b'{"messages": [{"role": "user", "content": "hello"}]}') > 0

    for raw in (b"[]", b"null", b'"text"'):
        with pytest.raises(HTTPException) as exc_info:
            _count_from_raw(raw)
        assert exc_info.value.status_code == 422


def test_count_tokens_raw_parser_rejects_malformed_and_excessive_nesting():
    with pytest.raises(HTTPException) as exc_info:
        _count_from_raw(b"{")
    assert exc_info.value.status_code == 400

    deeply_nested = (
        b'{"input":' + (b"[" * 5_000) + b'"deep"' + (b"]" * 5_000) + b"}"
    )
    try:
        # Some Python JSON decoders accept this depth; the estimator is
        # deliberately iterative and remains safe in that case.
        assert _count_from_raw(deeply_nested) > 0
    except HTTPException as exc:
        # Other supported decoders enforce their recursion bound. That is a
        # stable client error, never an uncaught 500.
        assert exc.status_code == 400


@pytest.mark.parametrize(
    "raw",
    (
        b'{"messages": [], "value": NaN}',
        b'{"messages": [], "value": 1e9999}',
        b'{"messages": [], "value": "\\ud800"}',
    ),
)
def test_count_tokens_rejects_non_interoperable_json_values(raw: bytes) -> None:
    with pytest.raises(HTTPException) as exc_info:
        _count_from_raw(raw)
    assert exc_info.value.status_code == 400


def test_system_and_text():
    body = {
        "model": "platform-sota",
        "system": "你是助手",
        "messages": [{"role": "user", "content": "你好"}],
        "max_tokens": 100,
    }
    out = anthropic_to_openai(body)
    assert out["messages"][0] == {"role": "system", "content": "你是助手"}
    assert out["messages"][1] == {"role": "user", "content": "你好"}
    assert out["max_tokens"] == 100


def test_system_as_blocks():
    body = {"system": [{"type": "text", "text": "A"}, {"type": "text", "text": "B"}],
            "messages": [], "model": "m"}
    out = anthropic_to_openai(body)
    assert out["messages"][0]["content"] == "AB"


def test_system_role_in_messages_hoisted_to_front():
    # 客户端把 role=system 混进 messages（OpenAI 习惯）：必须合并置顶，
    # 否则上游 chat template 报 400 "System message must be the beginning"
    body = {
        "model": "m", "max_tokens": 10,
        "system": "顶层指令",
        "messages": [
            {"role": "user", "content": "你好"},
            {"role": "system", "content": "中途插入的系统提示"},
            {"role": "assistant", "content": "好的"},
        ],
    }
    out = anthropic_to_openai(body)
    roles = [m["role"] for m in out["messages"]]
    assert roles == ["system", "user", "assistant"]
    assert "顶层指令" in out["messages"][0]["content"]
    assert "中途插入的系统提示" in out["messages"][0]["content"]


def test_no_system_message_when_absent():
    out = anthropic_to_openai({"model": "m", "messages": [{"role": "user", "content": "hi"}]})
    assert [m["role"] for m in out["messages"]] == ["user"]


def test_thinking_only_assistant_turn_dropped():
    # 仅思考块的 assistant 回合：不得产生 {"content": null} 且无 tool_calls 的
    # 非法消息（多数上游 400），应整体丢弃；带 tool_use 时保留 tool_calls
    body = {
        "model": "m", "max_tokens": 10,
        "messages": [
            {"role": "user", "content": "问题"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "内部推理...", "signature": "sig"},
            ]},
            {"role": "assistant", "content": [
                {"type": "redacted_thinking", "data": "xxx"},
                {"type": "tool_use", "id": "t1", "name": "f", "input": {}},
            ]},
        ],
    }
    out = anthropic_to_openai(body)
    roles = [m["role"] for m in out["messages"]]
    assert roles == ["user", "assistant"]  # 纯思考回合被丢弃
    assert out["messages"][1]["tool_calls"][0]["id"] == "t1"
    assert out["messages"][1]["content"] is None  # 有 tool_calls 时 null 合法


def test_orphan_tool_result_degrades_to_user_text():
    # 历史被截断、首条即孤立 tool_result：不得让 role=tool 打头（上游 400），
    # 降级为 user 文本
    body = {
        "model": "m", "max_tokens": 10,
        "messages": [
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t0", "content": "旧结果"},
                {"type": "text", "text": "继续分析"},
            ]},
        ],
    }
    out = anthropic_to_openai(body)
    assert [m["role"] for m in out["messages"]] == ["user"]
    assert "旧结果" in out["messages"][0]["content"]
    assert "继续分析" in out["messages"][0]["content"]


def test_nonstandard_role_clamped_to_user():
    body = {"model": "m", "max_tokens": 10, "messages": [
        {"role": "tool", "content": "某工具输出"},
        {"role": "user", "content": "hi"},
    ]}
    out = anthropic_to_openai(body)
    assert [m["role"] for m in out["messages"]] == ["user", "user"]


def test_user_first_with_late_system_hoisted():
    # 「user 在第一位 + system 出现在中途」：置顶后首位必为 system，
    # 次位为 user——同时满足「system 必须最前」与「对话必须以 user 开始」
    body = {"model": "m", "max_tokens": 10, "messages": [
        {"role": "user", "content": "第一句"},
        {"role": "system", "content": "迟到的系统提示"},
    ]}
    out = anthropic_to_openai(body)
    assert out["messages"][0]["role"] == "system"
    assert out["messages"][1] == {"role": "user", "content": "第一句"}


def test_tool_result_precedes_user_text():
    # tool_result 与新用户文本同处一个 user 回合：tool 消息必须先输出
    #（OpenAI 语义要求 role=tool 紧跟 assistant 的 tool_calls）
    body = {
        "model": "m", "max_tokens": 10,
        "messages": [
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "f", "input": {}},
            ]},
            {"role": "user", "content": [
                {"type": "text", "text": "继续"},
                {"type": "tool_result", "tool_use_id": "t1", "content": "结果"},
            ]},
        ],
    }
    out = anthropic_to_openai(body)
    roles = [m["role"] for m in out["messages"]]
    assert roles == ["assistant", "tool", "user"]


def test_tool_use_and_result_roundtrip():
    body = {
        "model": "m",
        "messages": [
            {"role": "assistant", "content": [
                {"type": "text", "text": "我查一下"},
                {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "北京"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "晴 25°C"},
            ]},
        ],
        "max_tokens": 50,
    }
    out = anthropic_to_openai(body)
    asst = out["messages"][0]
    assert asst["role"] == "assistant"
    assert asst["tool_calls"][0]["id"] == "toolu_1"
    assert asst["tool_calls"][0]["function"]["name"] == "get_weather"
    assert json.loads(asst["tool_calls"][0]["function"]["arguments"]) == {"city": "北京"}
    tool_msg = out["messages"][1]
    assert tool_msg == {"role": "tool", "tool_call_id": "toolu_1", "content": "晴 25°C"}


def test_image_block():
    body = {"model": "m", "max_tokens": 10, "messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "看图"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
        ]},
    ]}
    out = anthropic_to_openai(body)
    content = out["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "看图"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,AAAA")


def test_image_url_source():
    # A社 的 source.type=url 图像同样转为 OpenAI image_url
    body = {"model": "m", "max_tokens": 10, "messages": [
        {"role": "user", "content": [
            {"type": "image", "source": {"type": "url", "url": "http://img.internal/a.png"}},
        ]},
    ]}
    out = anthropic_to_openai(body)
    content = out["messages"][0]["content"]
    assert content[0] == {"type": "image_url", "image_url": {"url": "http://img.internal/a.png"}}


def test_tools_conversion():
    body = {"model": "m", "max_tokens": 10, "messages": [],
            "tools": [{"name": "f", "description": "d", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "tool", "name": "f"}}
    out = anthropic_to_openai(body)
    assert out["tools"][0]["function"]["name"] == "f"
    assert out["tools"][0]["function"]["parameters"] == {"type": "object"}
    assert out["tool_choice"] == {"type": "function", "function": {"name": "f"}}


def test_openai_to_anthropic_text():
    oai = {"id": "x", "choices": [{"message": {"content": "答复"}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 5, "completion_tokens": 3}}
    a = openai_to_anthropic(oai, "platform-sota")
    assert a["type"] == "message" and a["role"] == "assistant"
    assert a["content"] == [{"type": "text", "text": "答复"}]
    assert a["stop_reason"] == "end_turn"
    assert a["usage"] == {"input_tokens": 5, "output_tokens": 3}


def test_openai_to_anthropic_tool_use():
    oai = {"choices": [{"message": {"content": None, "tool_calls": [
        {"id": "tc1", "function": {"name": "f", "arguments": "{\"a\": 1}"}}]}, "finish_reason": "tool_calls"}]}
    a = openai_to_anthropic(oai, "m")
    blk = a["content"][0]
    assert blk["type"] == "tool_use" and blk["name"] == "f" and blk["input"] == {"a": 1}
    assert a["stop_reason"] == "tool_use"


def test_openai_to_anthropic_cache_fields_from_openai_native_shape():
    # OpenAI 原生嵌套字段：usage.prompt_tokens_details.cached_tokens
    oai = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 100, "completion_tokens": 5,
                     "prompt_tokens_details": {"cached_tokens": 80}}}
    a = openai_to_anthropic(oai, "m")
    assert a["usage"]["cache_read_input_tokens"] == 80
    assert "cache_creation_input_tokens" not in a["usage"]  # 上游没报，留空不伪造成 0


def test_openai_to_anthropic_cache_fields_from_deepseek_flat_shape():
    # DeepSeek 平铺字段：prompt_cache_hit_tokens / prompt_cache_write_tokens
    oai = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 100, "completion_tokens": 5,
                     "prompt_cache_hit_tokens": 60, "prompt_cache_write_tokens": 40}}
    a = openai_to_anthropic(oai, "m")
    assert a["usage"]["cache_read_input_tokens"] == 60
    assert a["usage"]["cache_creation_input_tokens"] == 40


def test_openai_to_anthropic_prefers_passed_in_usage_over_raw_payload():
    # 调用方传入 finalize_stream_usage 兜底过的 usage 时，不应再从 oai["usage"]
    # 现取——否则上游漏报时内部日志按估算记账，回给客户端的却仍是 0。
    oai = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}  # 无 usage 字段
    estimated = {"prompt_tokens": 42, "completion_tokens": 7, "total_tokens": 49}
    a = openai_to_anthropic(oai, "m", estimated)
    assert a["usage"]["input_tokens"] == 42
    assert a["usage"]["output_tokens"] == 7
