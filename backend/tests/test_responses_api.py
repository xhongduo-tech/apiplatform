"""Responses API ⇄ OpenAI chat 转换单测（纯函数，无网络）。"""
import json

from app.proxy.responses import openai_to_responses, responses_to_openai


def test_string_input_becomes_user_message():
    out = responses_to_openai({"model": "m", "input": "你好"})
    assert out["messages"] == [{"role": "user", "content": "你好"}]


def test_instructions_becomes_system_message():
    out = responses_to_openai({
        "model": "m", "instructions": "你是助手",
        "input": [{"role": "user", "content": "你好"}],
    })
    assert out["messages"][0] == {"role": "system", "content": "你是助手"}
    assert out["messages"][1] == {"role": "user", "content": "你好"}


def test_developer_role_hoisted_and_merged_with_instructions():
    out = responses_to_openai({
        "model": "m", "instructions": "顶层指令",
        "input": [
            {"role": "developer", "content": "开发者指令"},
            {"role": "user", "content": "问题"},
        ],
    })
    assert out["messages"][0]["role"] == "system"
    assert "顶层指令" in out["messages"][0]["content"]
    assert "开发者指令" in out["messages"][0]["content"]
    assert out["messages"][1] == {"role": "user", "content": "问题"}


def test_content_parts_list_extracts_text():
    out = responses_to_openai({
        "model": "m",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "看看这个"}]}],
    })
    assert out["messages"][0] == {"role": "user", "content": "看看这个"}


def test_input_image_part():
    out = responses_to_openai({
        "model": "m",
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": "看图"},
            {"type": "input_image", "image_url": "https://img.internal/a.png"},
        ]}],
    })
    content = out["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "看图"}
    assert content[1] == {"type": "image_url", "image_url": {"url": "https://img.internal/a.png"}}


def test_function_call_and_output_roundtrip():
    out = responses_to_openai({
        "model": "m",
        "input": [
            {"type": "message", "role": "user", "content": "北京天气如何"},
            {"type": "function_call", "call_id": "call_1", "name": "get_weather",
             "arguments": '{"city": "北京"}'},
            {"type": "function_call_output", "call_id": "call_1", "output": "晴 25°C"},
        ],
    })
    roles = [m["role"] for m in out["messages"]]
    assert roles == ["user", "assistant", "tool"]
    asst = out["messages"][1]
    assert asst["content"] is None
    assert asst["tool_calls"][0]["id"] == "call_1"
    assert asst["tool_calls"][0]["function"]["name"] == "get_weather"
    assert json.loads(asst["tool_calls"][0]["function"]["arguments"]) == {"city": "北京"}
    assert out["messages"][2] == {"role": "tool", "tool_call_id": "call_1", "content": "晴 25°C"}


def test_parallel_function_calls_merge_into_one_assistant_message():
    out = responses_to_openai({
        "model": "m",
        "input": [
            {"type": "function_call", "call_id": "c1", "name": "a", "arguments": "{}"},
            {"type": "function_call", "call_id": "c2", "name": "b", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "c1", "output": "1"},
            {"type": "function_call_output", "call_id": "c2", "output": "2"},
        ],
    })
    roles = [m["role"] for m in out["messages"]]
    assert roles == ["assistant", "tool", "tool"]
    assert len(out["messages"][0]["tool_calls"]) == 2


def test_reasoning_item_dropped():
    out = responses_to_openai({
        "model": "m",
        "input": [
            {"type": "reasoning", "id": "r1", "summary": [{"type": "summary_text", "text": "思考中"}]},
            {"type": "message", "role": "user", "content": "继续"},
        ],
    })
    assert [m["role"] for m in out["messages"]] == ["user"]


def test_tools_and_tool_choice_conversion():
    out = responses_to_openai({
        "model": "m", "input": [],
        "tools": [{"type": "function", "name": "f", "description": "d", "parameters": {"type": "object"}}],
        "tool_choice": {"type": "function", "name": "f"},
    })
    assert out["tools"][0]["function"]["name"] == "f"
    assert out["tools"][0]["function"]["parameters"] == {"type": "object"}
    assert out["tool_choice"] == {"type": "function", "function": {"name": "f"}}


def test_legacy_nested_function_tool_is_accepted_for_old_codex_configs():
    out = responses_to_openai({
        "model": "m", "input": "hi",
        "tools": [{"type": "function", "function": {
            "name": "shell", "description": "run command",
            "parameters": {"type": "object"}, "strict": True,
        }}],
    })
    fn = out["tools"][0]["function"]
    assert fn == {
        "name": "shell", "description": "run command",
        "parameters": {"type": "object"}, "strict": True,
    }


def test_function_call_object_arguments_are_serialized_for_chat_completions():
    out = responses_to_openai({
        "model": "m",
        "input": [{"type": "function_call", "call_id": "c1", "name": "shell",
                   "arguments": {"command": "pwd"}}],
    })
    assert out["messages"][0]["tool_calls"][0]["function"]["arguments"] == '{"command": "pwd"}'


def test_max_output_tokens_maps_to_max_tokens():
    out = responses_to_openai({"model": "m", "input": "hi", "max_output_tokens": 256})
    assert out["max_tokens"] == 256


def test_openai_to_responses_text():
    oai = {"id": "chatcmpl-1", "choices": [{"message": {"content": "答复"}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 5, "completion_tokens": 3}}
    resp = openai_to_responses(oai, "m", {})
    assert resp["status"] == "completed"
    assert resp["output"] == [{
        "id": resp["output"][0]["id"], "type": "message", "status": "completed",
        "role": "assistant", "content": [{"type": "output_text", "text": "答复", "annotations": []}],
    }]
    assert resp["output_text"] == "答复"
    assert resp["usage"]["input_tokens"] == 5
    assert resp["usage"]["output_tokens"] == 3
    assert resp["usage"]["total_tokens"] == 8


def test_openai_to_responses_tool_call():
    oai = {"choices": [{"message": {"content": None, "tool_calls": [
        {"id": "call_1", "function": {"name": "f", "arguments": '{"a": 1}'}}]}, "finish_reason": "tool_calls"}]}
    resp = openai_to_responses(oai, "m", {})
    item = resp["output"][0]
    assert item["type"] == "function_call"
    assert item["call_id"] == "call_1"
    assert item["name"] == "f"
    assert item["arguments"] == '{"a": 1}'
    assert resp["status"] == "completed"


def test_openai_to_responses_length_finish_marks_incomplete():
    oai = {"choices": [{"message": {"content": "半截"}, "finish_reason": "length"}]}
    resp = openai_to_responses(oai, "m", {})
    assert resp["status"] == "incomplete"
    assert resp["incomplete_details"] == {"reason": "max_output_tokens"}


def test_openai_to_responses_cache_fields():
    oai = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 100, "completion_tokens": 5,
                     "prompt_cache_hit_tokens": 60, "prompt_cache_write_tokens": 40}}
    resp = openai_to_responses(oai, "m", {})
    assert resp["usage"]["input_tokens_details"]["cached_tokens"] == 60
    assert resp["usage"]["input_tokens_details"]["cache_write_tokens"] == 40


def test_openai_to_responses_prefers_passed_in_usage_over_raw_payload():
    oai = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}
    estimated = {"prompt_tokens": 42, "completion_tokens": 7, "total_tokens": 49}
    resp = openai_to_responses(oai, "m", {}, estimated)
    assert resp["usage"]["input_tokens"] == 42
    assert resp["usage"]["output_tokens"] == 7


def test_openai_to_responses_echoes_request_fields():
    request_body = {
        "instructions": "系统指令", "temperature": 0.5, "top_p": 0.9,
        "tool_choice": "auto", "tools": [{"type": "function", "name": "f"}],
    }
    oai = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}
    resp = openai_to_responses(oai, "m", request_body)
    assert resp["instructions"] == "系统指令"
    assert resp["temperature"] == 0.5
    assert resp["top_p"] == 0.9
    assert resp["tools"] == request_body["tools"]
