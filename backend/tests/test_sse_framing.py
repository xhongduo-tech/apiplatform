"""流式转发的分帧保真：上游 SSE 怎么发，客户端就该怎么收。

回归的是这样一个 bug：转发时丢掉空行、给每一行补 "\\n\\n"，等于宣称"一行就是
一个事件"。对只发 data: 的 vLLM 恰好等价，但上游一旦发 `event:` + `data:` 这
种多行事件，就会被拆成两个残缺事件，客户端 SDK 直接解析不出来。
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.models import ModelRegistryORM
from app.proxy import chat, policy


def _model() -> ModelRegistryORM:
    return ModelRegistryORM(
        id="m", name="m", provider="", category="chat",
        base_url="http://up:8000", model_api_name="M", import_format="openai",
    )


class _FakeResponse:
    """最小可用的上游流式响应替身：按行喂 aiter_lines()。"""

    status_code = 200

    def __init__(self, payload: str) -> None:
        # 与 httpx 的 LineDecoder 一致：去掉行终止符，空行保留为 ""
        self._lines = payload.split("\n")
        if self._lines and self._lines[-1] == "":
            self._lines.pop()
        self.closed = False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        self.closed = True


class _TimeoutResponse(_FakeResponse):
    def __init__(self) -> None:
        super().__init__("")

    async def aiter_lines(self):
        if False:  # 保持为 async generator
            yield ""
        raise httpx.ReadTimeout("no bytes before read deadline")


async def _drain(payload: str, *, suppress: bool = False, body: dict | None = None) -> str:
    r = _FakeResponse(payload)
    out = b""
    async for chunk in chat._pump(
        r, model=_model(), base_log={"api_key_id": "k", "model_id": "m"},
        started=0.0, reserved_tokens=policy.NOT_METERED,  # 不碰 TPM 桶
        suppress_usage_chunk=suppress, body=body or {},
    ):
        out += chunk
    assert r.closed, "上游响应必须被关闭"
    return out.decode("utf-8")


@pytest.mark.asyncio
async def test_multiline_event_keeps_its_frame(monkeypatch):
    """`event:` + `data:` 属于同一个事件，中间不得被插入空行拆开。"""
    monkeypatch.setattr(chat, "_log", lambda record: None)
    upstream = (
        "event: message_start\n"
        'data: {"type":"message_start"}\n'
        "\n"
        "event: content_block_delta\n"
        'data: {"delta":{"text":"hi"}}\n'
        "\n"
    )
    assert await _drain(upstream) == upstream


@pytest.mark.asyncio
async def test_plain_data_stream_is_byte_identical(monkeypatch):
    monkeypatch.setattr(chat, "_log", lambda record: None)
    upstream = (
        'data: {"choices":[{"delta":{"content":"a"}}]}\n'
        "\n"
        'data: {"choices":[{"delta":{"content":"b"}}]}\n'
        "\n"
        "data: [DONE]\n"
        "\n"
    )
    assert await _drain(upstream) == upstream


@pytest.mark.asyncio
async def test_comment_line_survives(monkeypatch):
    """`: keep-alive` 这类注释行是合法 SSE，原样透传即可。"""
    monkeypatch.setattr(chat, "_log", lambda record: None)
    upstream = ": keep-alive\n\ndata: [DONE]\n\n"
    assert await _drain(upstream) == upstream


@pytest.mark.asyncio
async def test_injected_usage_event_dropped_without_leaving_blank_event(monkeypatch):
    """网关注入的纯 usage 事件要整体消失——连同它的分隔空行。"""
    monkeypatch.setattr(chat, "_log", lambda record: None)
    upstream = (
        'data: {"choices":[{"delta":{"content":"a"}}]}\n'
        "\n"
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n'
        "\n"
        "data: [DONE]\n"
        "\n"
    )
    got = await _drain(upstream, suppress=True)
    assert got == (
        'data: {"choices":[{"delta":{"content":"a"}}]}\n'
        "\n"
        "data: [DONE]\n"
        "\n"
    )
    assert "usage" not in got
    # 不能因为丢弃事件而多出一个空事件（"\n\n\n"）
    assert "\n\n\n" not in got


@pytest.mark.asyncio
async def test_client_requested_usage_chunk_is_forwarded(monkeypatch):
    """客户端自己要了 include_usage 时，usage 块必须原样送达。"""
    monkeypatch.setattr(chat, "_log", lambda record: None)
    upstream = (
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n'
        "\n"
    )
    assert await _drain(upstream, suppress=False) == upstream


@pytest.mark.asyncio
async def test_usage_is_metered_even_when_chunk_is_dropped(monkeypatch):
    """丢的是转发字节，不是计量：usage 仍要落进日志。"""
    logged: list[dict] = []
    monkeypatch.setattr(chat, "_log", lambda record: logged.append(record))
    upstream = (
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n'
        "\n"
    )
    await _drain(upstream, suppress=True)
    assert logged and logged[0]["total_tokens"] == 7
    assert logged[0]["prompt_tokens"] == 3
    assert logged[0]["completion_tokens"] == 4


@pytest.mark.asyncio
async def test_upstream_without_trailing_blank_line(monkeypatch):
    """上游最后一个事件没带分隔空行时，不要凭空补一个。"""
    monkeypatch.setattr(chat, "_log", lambda record: None)
    upstream = "data: [DONE]\n"
    assert await _drain(upstream) == upstream


@pytest.mark.asyncio
async def test_json_in_data_is_not_reserialized(monkeypatch):
    """旁路解析只为读 usage，绝不能改写转发出去的字节。"""
    monkeypatch.setattr(chat, "_log", lambda record: None)
    payload = '{"choices":[{"delta":{"content":"  空格与 中文  "}}],"usage":null}'
    upstream = f"data: {payload}\n\n"
    got = await _drain(upstream, suppress=True)
    assert got == upstream
    assert json.loads(got.split("data: ", 1)[1].strip())["usage"] is None


@pytest.mark.asyncio
async def test_stream_text_captured_as_response_preview(monkeypatch):
    """成功的流式调用也要落响应预览——/logs 展开行才有正文可看。"""
    logged: list[dict] = []
    monkeypatch.setattr(chat, "_log", lambda record: logged.append(record))
    upstream = (
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n'
        "\n"
        'data: {"choices":[{"delta":{"content":"，世界"}}]}\n'
        "\n"
        "data: [DONE]\n"
        "\n"
    )
    assert await _drain(upstream) == upstream
    assert logged and logged[0]["response_preview"] == "你好，世界"


@pytest.mark.asyncio
async def test_stream_without_usage_chunk_falls_back_to_estimate(monkeypatch):
    """上游没回报 usage 时（不支持 include_usage / 断流）：按正文估算并打标记，
    日志里不再出现误导性的 0。"""
    logged: list[dict] = []
    monkeypatch.setattr(chat, "_log", lambda record: logged.append(record))
    upstream = (
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n'
        "\n"
        'data: {"choices":[{"delta":{"content":"世界"}}]}\n'
        "\n"
        "data: [DONE]\n"
        "\n"
    )
    body = {"messages": [{"role": "user", "content": "hi"}]}
    await _drain(upstream, body=body)
    assert logged and logged[0]["usage_estimated"] is True
    assert logged[0]["stream"] is True
    assert logged[0]["completion_tokens"] == 4   # 4 个汉字
    assert logged[0]["prompt_tokens"] == 5       # 消息开销 4 + "hi"(2 字符≈1)
    assert logged[0]["total_tokens"] == (logged[0]["prompt_tokens"] + logged[0]["completion_tokens"])


@pytest.mark.asyncio
async def test_stream_with_usage_chunk_is_not_marked_estimated(monkeypatch):
    """上游回报了 usage：原样采用，不打估算标记。"""
    logged: list[dict] = []
    monkeypatch.setattr(chat, "_log", lambda record: logged.append(record))
    upstream = (
        'data: {"choices":[{"delta":{"content":"a"}}]}\n'
        "\n"
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n'
        "\n"
        "data: [DONE]\n"
        "\n"
    )
    await _drain(upstream, body={"messages": [{"role": "user", "content": "hi"}]})
    assert logged and logged[0]["usage_estimated"] is False
    assert logged[0]["stream"] is True
    assert logged[0]["total_tokens"] == 7


@pytest.mark.asyncio
async def test_stream_read_timeout_is_logged_as_504_not_handshake_200(monkeypatch):
    logged: list[dict] = []
    monkeypatch.setattr(chat, "_log", logged.append)
    response = _TimeoutResponse()

    with pytest.raises(httpx.ReadTimeout):
        async for _ in chat._pump(
            response, model=_model(),
            base_log={"api_key_id": "k", "model_id": "m"},
            started=0.0, reserved_tokens=policy.NOT_METERED,
            suppress_usage_chunk=False,
            body={"messages": [{"role": "user", "content": "hi"}]},
        ):
            pass

    assert logged[-1]["status_code"] == "504"
    assert "上游流读取超时" in logged[-1]["error_detail"]
    assert response.closed


def test_response_preview_stops_at_limit():
    """预览攒满上限后停止采集，长响应的旁路解析成本有界。"""
    from app.proxy.common import PREVIEW_LIMIT, ResponsePreview

    p = ResponsePreview()
    assert p.text is None
    p.feed_openai_chunk({"choices": [{"delta": {"content": "x" * (PREVIEW_LIMIT + 50)}}]})
    assert p.done
    assert p.text is not None and len(p.text) == PREVIEW_LIMIT
    # 到顶后继续喂块不再变化
    p.feed_openai_chunk({"choices": [{"delta": {"content": "more"}}]})
    assert p.text is not None and len(p.text) == PREVIEW_LIMIT
    # 非 content 字段（如 role）不采集
    q = ResponsePreview()
    q.feed_openai_chunk({"choices": [{"delta": {"role": "assistant"}}]})
    assert q.text is None
    # A社 事件：只认 content_block_delta 的 text
    q.feed_anthropic_event({"type": "message_start", "message": {"usage": {}}})
    assert q.text is None
    q.feed_anthropic_event({"type": "content_block_delta", "delta": {"text": "hi"}})
    assert q.text == "hi"
