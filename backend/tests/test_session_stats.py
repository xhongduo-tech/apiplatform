"""session_stats 单元测试。"""
from app.session_stats import (
    TOOL_CALL_BUCKETS,
    _counts_from_tool_totals,
    count_successful_tool_calls_in_body,
    count_tool_calls_in_preview,
    resolve_tool_calls_count,
)


def test_count_tool_calls_openai_chat():
    preview = '{"choices":[{"message":{"tool_calls":[{"id":"c1","function":{"name":"f"}}]},"finish_reason":"tool_calls"}]}'
    assert count_tool_calls_in_preview(preview) == 1


def test_count_tool_calls_empty():
    assert count_tool_calls_in_preview(None) == 0
    assert count_tool_calls_in_preview('{"choices":[{"message":{"content":"hi"}}]}') == 0


def test_count_tool_calls_truncated_heuristic():
    truncated = '{"choices":[{"message":{"tool_calls":[{"id":"call_abc","function":{"'
    assert count_tool_calls_in_preview(truncated) >= 1


def test_resolve_tool_calls_falls_back_to_response_when_body_empty():
    """首轮 tool call（请求尚无 tool 回填）应计入响应里的 tool_calls 数。"""
    body = {
        "messages": [
            {"role": "user", "content": "查天气"},
        ]
    }
    assert resolve_tool_calls_count(body, response_proposed=3) == 3
    assert resolve_tool_calls_count(body, response_proposed=0) == 0


def test_successful_tools_from_openai_request_context():
    """成功次数 = 最后一轮 assistant.tool_calls 之后的 role=tool 条数。"""
    body = {
        "messages": [
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "a"}},
                    {"id": "c2", "type": "function", "function": {"name": "b"}},
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "ok1"},
            {"role": "tool", "tool_call_id": "c2", "content": "ok2"},
        ]
    }
    assert count_successful_tool_calls_in_body(body) == 2
    assert resolve_tool_calls_count(body, response_proposed=9) == 2


def test_successful_tools_ignore_already_consumed_round():
    """tool_result 已被后续 assistant 消费 → 当前请求计 0。"""
    body = {
        "messages": [
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "a"}}],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "ok"},
            {"role": "assistant", "content": "done"},
            {"role": "user", "content": "next"},
        ]
    }
    assert count_successful_tool_calls_in_body(body) == 0


def test_successful_tools_anthropic_tool_result_blocks():
    body = {
        "messages": [
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "t1", "name": "search", "input": {}}],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "hit"},
                    {"type": "tool_result", "tool_use_id": "t2", "content": "hit2"},
                ],
            },
        ]
    }
    assert count_successful_tool_calls_in_body(body) == 2


def test_successful_tools_responses_api_input():
    body = {
        "input": [
            {"type": "function_call", "call_id": "f1", "name": "x"},
            {"type": "function_call_output", "call_id": "f1", "output": "1"},
            {"type": "function_call_output", "call_id": "f2", "output": "2"},
        ]
    }
    assert count_successful_tool_calls_in_body(body) == 2


def test_per_request_bucket_like_context_length():
    """一次对话 = 一次请求：不按空闲间隔合并。"""
    out = _counts_from_tool_totals([0, 0, 3, 12, 0])
    assert out["total_sessions"] == 5
    by_label = {b["label"]: b for b in out["buckets"]}
    assert by_label["0"]["count"] == 3
    assert by_label["1–5"]["count"] == 1
    assert by_label["11–25"]["count"] == 1


def test_bucket_labels_cover_all():
    assert len(TOOL_CALL_BUCKETS) == 7
    assert TOOL_CALL_BUCKETS[0][0] == "0"
    assert TOOL_CALL_BUCKETS[-1][0] == "100+"


def test_context_bucket_index():
    from app.session_stats import context_bucket_index

    assert context_bucket_index(500) == 0
    assert context_bucket_index(1000) == 1
    assert context_bucket_index(1_500_000) == 11
    assert context_bucket_index(0) == -1
