"""usage 提取单测：OpenAI chat 与 Responses API 双格式 + 流式 completed 事件。"""
from app.proxy.usage import extract_usage, extract_usage_any


def test_openai_chat_usage():
    u = extract_usage_any({"usage": {"prompt_tokens": 10, "completion_tokens": 20,
                                     "total_tokens": 30}})
    assert (u["prompt_tokens"], u["completion_tokens"], u["total_tokens"]) == (10, 20, 30)


def test_responses_api_usage():
    u = extract_usage_any({"usage": {"input_tokens": 100, "output_tokens": 50,
                                     "total_tokens": 150,
                                     "input_tokens_details": {"cached_tokens": 64}}})
    assert (u["prompt_tokens"], u["completion_tokens"], u["total_tokens"]) == (100, 50, 150)
    assert u["cache_hit_tokens"] == 64


def test_responses_completed_event_nested_usage():
    # 流式 response.completed 事件：usage 藏在 response.usage
    evt = {"type": "response.completed",
           "response": {"id": "resp_1", "usage": {"input_tokens": 7, "output_tokens": 3}}}
    u = extract_usage_any(evt)
    assert (u["prompt_tokens"], u["completion_tokens"], u["total_tokens"]) == (7, 3, 10)


def test_empty_payload():
    assert extract_usage_any(None)["total_tokens"] is None
    assert extract_usage_any({})["total_tokens"] is None
    assert extract_usage(None)["total_tokens"] is None
