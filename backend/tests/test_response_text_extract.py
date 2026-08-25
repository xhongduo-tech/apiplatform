"""非流式响应正文提取单测：completion 侧兜底估算复用，四种响应格式通吃。"""
from app.proxy.usage import extract_response_text_any


def test_openai_chat_message_content():
    payload = {"choices": [{"message": {"content": "你好世界"}}]}
    assert extract_response_text_any(payload) == "你好世界"


def test_openai_chat_tool_call_arguments():
    payload = {"choices": [{"message": {
        "content": None,
        "tool_calls": [{"function": {"arguments": '{"x":1}'}}],
    }}]}
    assert extract_response_text_any(payload) == '{"x":1}'


def test_legacy_completions_text():
    payload = {"choices": [{"text": "旧版补全正文", "index": 0}]}
    assert extract_response_text_any(payload) == "旧版补全正文"


def test_anthropic_text_block():
    payload = {"content": [{"type": "text", "text": "回答内容"}]}
    assert extract_response_text_any(payload) == "回答内容"


def test_anthropic_tool_use_block():
    payload = {"content": [{"type": "tool_use", "input": {"a": 1}}]}
    assert extract_response_text_any(payload) == '{"a": 1}'


def test_responses_api_output_text():
    payload = {"output_text": "响应正文"}
    assert extract_response_text_any(payload) == "响应正文"


def test_responses_api_output_items():
    payload = {"output": [{"content": [{"text": "分段一"}, {"text": "分段二"}]}]}
    assert extract_response_text_any(payload) == "分段一分段二"


def test_none_or_empty_payload():
    assert extract_response_text_any(None) == ""
    assert extract_response_text_any({}) == ""
    assert extract_response_text_any({"data": [{"url": "x"}]}) == ""
