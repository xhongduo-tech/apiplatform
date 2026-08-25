"""流式用量兜底单测：上游未回报 usage 时按正文/请求体估算并标记。"""
from app.proxy.usage import finalize_stream_usage


def test_measured_usage_passthrough():
    seen = {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    usage, estimated = finalize_stream_usage(seen, body={}, streamed_text="")
    assert usage == seen
    assert estimated is False


def test_fallback_estimates_prompt_and_completion():
    usage, estimated = finalize_stream_usage(
        {},
        body={"messages": [{"role": "user", "content": "你好"}]},
        streamed_text="这是一个回复",
    )
    assert estimated is True
    # 请求体：1 条消息结构开销 4 + 内容 2 个汉字 → 6；正文 6 个汉字 → 6
    assert usage["prompt_tokens"] == 6
    assert usage["completion_tokens"] == 6
    assert usage["total_tokens"] == 12


def test_fallback_keeps_measured_side():
    # 上游只回报了 prompt 侧（无 total）：保留实测值，只补 completion
    seen = {"prompt_tokens": 8, "completion_tokens": None, "total_tokens": None}
    usage, estimated = finalize_stream_usage(seen, body={}, streamed_text="hello")
    assert estimated is True
    assert usage["prompt_tokens"] == 8
    assert usage["completion_tokens"] == 2  # 5 字母 ≈ 2 token
    assert usage["total_tokens"] == 10


def test_empty_stream_no_fake_tokens():
    usage, estimated = finalize_stream_usage({}, body={}, streamed_text="")
    assert estimated is True
    assert usage["total_tokens"] == 0
