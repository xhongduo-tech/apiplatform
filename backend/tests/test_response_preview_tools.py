"""ResponsePreview tool call 计数。"""
from app.proxy.common import ResponsePreview


def test_stream_tool_calls_by_index():
    p = ResponsePreview()
    p.feed_openai_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "a", "arguments": "{"}}]}}]})
    p.feed_openai_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "}"}}]}}]})
    p.feed_openai_chunk({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "call_2", "function": {"name": "b", "arguments": "{}"}}]}}]})
    p.feed_openai_chunk({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    assert p.tool_calls_count == 2


def test_preview_text_limit_does_not_drop_later_tools():
    p = ResponsePreview(limit=10)
    p.feed_openai_chunk({"choices": [{"delta": {"content": "x" * 50}}]})
    assert p.done
    p.feed_openai_chunk({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_z"}]}}]})
    assert p.tool_calls_count == 1


def test_anthropic_tool_use_blocks():
    p = ResponsePreview()
    p.feed_anthropic_event({
        "type": "content_block_start",
        "content_block": {"type": "tool_use", "id": "toolu_1", "name": "search"},
    })
    p.feed_anthropic_event({
        "type": "content_block_start",
        "content_block": {"type": "tool_use", "id": "toolu_2", "name": "browse"},
    })
    assert p.tool_calls_count == 2


def test_nonstream_payload():
    p = ResponsePreview()
    p.feed_openai_payload({
        "choices": [{
            "message": {
                "tool_calls": [
                    {"id": "c1", "function": {"name": "f"}},
                    {"id": "c2", "function": {"name": "g"}},
                ],
            },
            "finish_reason": "tool_calls",
        }],
    })
    assert p.tool_calls_count == 2
