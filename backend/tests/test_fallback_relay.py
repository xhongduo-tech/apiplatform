"""中继层兜底切换：谁被切、谁不被切、切几次、什么时候已经来不及切。"""
from __future__ import annotations

import json

import httpx
import pytest

from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import anthropic as anth_mod, chat, fallback, policy
from app.proxy.db_bridge import Prepared
from app.usage_writer import usage_writer

PRIMARY = "deepseek-v4"
BACKUP = "qwen3.6-35b"


def _primary() -> ModelRegistryORM:
    return ModelRegistryORM(
        id=PRIMARY, name=PRIMARY, provider="", category="chat",
        base_url="http://primary:8000", model_api_name="DeepSeek-V4",
        import_format="openai",
        extra={"fallback": {"enabled": True, "target_model_id": BACKUP}},
    )


def _backup() -> ModelRegistryORM:
    return ModelRegistryORM(
        id=BACKUP, name=BACKUP, provider="", category="chat",
        base_url="http://backup:8000", model_api_name="Qwen3.6-35B",
        import_format="openai",
    )


def _key() -> ApiKeyORM:
    return ApiKeyORM(id="k1", name="k", auth_id="u", project_name="p", department="d", models=[])


# ── 上游替身 ─────────────────────────────────────────────────────────────────
class _Resp:
    def __init__(self, status: int, payload: dict):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _StreamResp:
    def __init__(self, status: int, lines: list[str], body: dict | None = None):
        self.status_code = status
        self._lines = lines
        self._body = json.dumps(body or {}).encode()
        self.closed = False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return self._body

    async def aclose(self):
        self.closed = True


class _Client:
    """按脚本依次应答；记录每次上游收到的 model 名，用来断言"真的换了模型"。"""

    def __init__(self, *script):
        self.script = list(script)
        self.models_called: list[str] = []

    def _next(self):
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def post(self, url, headers=None, json=None):
        self.models_called.append(json["model"])
        return self._next()

    def build_request(self, method, url, headers=None, json=None):
        return {"model": json["model"]}

    async def send(self, req, stream=False):
        self.models_called.append(req["model"])
        return self._next()


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    """隔离掉限流桶、熔断计数与日志落库——本文件只测切换决策本身。"""
    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(policy, "refund_tokens", _noop)
    monkeypatch.setattr(policy, "record_tokens", _noop)
    monkeypatch.setattr(fallback, "record_fail", _noop)
    monkeypatch.setattr(fallback, "record_ok", _noop)
    logs: list[dict] = []
    monkeypatch.setattr(usage_writer, "enqueue", logs.append)
    fallback._open_until.clear()
    yield logs
    fallback._open_until.clear()


async def _relay(client, *, stream=False, with_fallback=True, body=None):
    body = body or {"model": PRIMARY, "messages": [{"role": "user", "content": "hi"}]}
    if stream:
        body = {**body, "stream": True}
    return await chat.relay_chat_like(
        body, _key(), _primary(), None, stream,
        fallback_model=_backup() if with_fallback else None,
    )


_OK = {"choices": [{"message": {"content": "ok"}}], "usage": {"total_tokens": 7}}


# ── 该切的 ───────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("status", [500, 502, 503, 504, 401, 403, 404])
@pytest.mark.asyncio
async def test_switches_on_node_failure(monkeypatch, status):
    client = _Client(_Resp(status, {"error": "boom"}), _Resp(200, _OK))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client)
    assert resp.status_code == 200
    assert client.models_called == ["DeepSeek-V4", "Qwen3.6-35B"]  # 真的换了上游模型名
    assert resp.headers["x-fallback-from"] == PRIMARY


@pytest.mark.asyncio
async def test_switches_on_connect_error(monkeypatch):
    client = _Client(httpx.ConnectError("refused"), _Resp(200, _OK))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client)
    assert resp.status_code == 200
    assert client.models_called == ["DeepSeek-V4", "Qwen3.6-35B"]


@pytest.mark.asyncio
async def test_switches_on_read_timeout(monkeypatch):
    client = _Client(httpx.ReadTimeout("slow"), _Resp(200, _OK))
    monkeypatch.setattr(chat, "get_client", lambda: client)
    assert (await _relay(client)).status_code == 200


# ── 不该切的 ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("status", [400, 413, 422, 429])
@pytest.mark.asyncio
async def test_never_switches_on_client_error(monkeypatch, status):
    """请求本身的问题（含上下文超限、过载）如实透传——换模型是同样的错。"""
    client = _Client(_Resp(status, {"error": {"message": "上下文超限"}}))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client)
    assert resp.status_code == status
    assert client.models_called == ["DeepSeek-V4"]  # 没有第二次调用
    assert "x-fallback-from" not in resp.headers


@pytest.mark.asyncio
async def test_no_fallback_configured_passes_error_through(monkeypatch):
    client = _Client(_Resp(503, {"error": "down"}))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client, with_fallback=False)
    assert resp.status_code == 503
    assert client.models_called == ["DeepSeek-V4"]


@pytest.mark.asyncio
async def test_success_never_touches_fallback(monkeypatch):
    client = _Client(_Resp(200, _OK))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client)
    assert resp.status_code == 200
    assert client.models_called == ["DeepSeek-V4"]
    assert "x-fallback-from" not in resp.headers


# ── 只切一次 ─────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_fallback_failure_is_final(monkeypatch):
    """兜底模型也坏 → 如实返回它的错误，绝不链式再兜底（不做兜底的兜底）。"""
    client = _Client(_Resp(502, {"error": "a"}), _Resp(502, {"error": "b"}))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client)
    assert resp.status_code == 502
    assert len(client.models_called) == 2
    assert resp.headers["x-fallback-from"] == PRIMARY


@pytest.mark.asyncio
async def test_connect_error_on_fallback_propagates(monkeypatch):
    client = _Client(httpx.ConnectError("a"), httpx.ConnectError("b"))
    monkeypatch.setattr(chat, "get_client", lambda: client)
    with pytest.raises(httpx.ConnectError):
        await _relay(client)
    assert len(client.models_called) == 2


# ── 流式：建连检查点是唯一的安全切换点 ────────────────────────────────────────
@pytest.mark.asyncio
async def test_stream_switches_before_first_byte(monkeypatch):
    client = _Client(
        _StreamResp(503, [], {"error": "down"}),
        _StreamResp(200, ['data: {"choices":[{"delta":{"content":"hi"}}]}']),
    )
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client, stream=True)
    assert resp.status_code == 200
    assert client.models_called == ["DeepSeek-V4", "Qwen3.6-35B"]
    assert resp.headers["x-fallback-from"] == PRIMARY


@pytest.mark.asyncio
async def test_stream_2xx_commits_to_primary(monkeypatch):
    """一旦返回 2xx 就要开始出字，之后上游再出问题只能透传——不得半途换模型。"""
    client = _Client(_StreamResp(200, ['data: {"choices":[{"delta":{"content":"a"}}]}']))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client, stream=True)
    assert client.models_called == ["DeepSeek-V4"]
    assert "x-fallback-from" not in resp.headers


@pytest.mark.asyncio
async def test_stream_client_error_not_switched(monkeypatch):
    client = _Client(_StreamResp(400, [], {"error": {"message": "bad"}}))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    resp = await _relay(client, stream=True)
    assert resp.status_code == 400
    assert client.models_called == ["DeepSeek-V4"]


# ── 可观测：同 request_id 两条日志，各记各的模型 ───────────────────────────────
@pytest.mark.asyncio
async def test_both_attempts_logged_for_correlation(monkeypatch, isolate):
    client = _Client(_Resp(502, {"error": "boom"}), _Resp(200, _OK))
    monkeypatch.setattr(chat, "get_client", lambda: client)

    await _relay(client)
    logs = isolate
    assert [r["model_id"] for r in logs] == [PRIMARY, BACKUP]
    assert logs[0]["status_code"] == "502" and logs[1]["status_code"] == "200"
    # 失败那条不计 token，成功那条正常计费
    assert not logs[0].get("total_tokens")
    assert logs[1]["total_tokens"] == 7


# ── /v1/messages（CC 走这条，逻辑最复杂）────────────────────────────────────
class _Req:
    def __init__(self, body):
        self._body = body

    async def body(self):
        return json.dumps(self._body).encode("utf-8")


async def _messages(monkeypatch, client, *, with_fallback=True, stream=False):
    monkeypatch.setattr(anth_mod, "get_client", lambda: client)

    async def _prep(auth, requested):
        return Prepared(_key(), _primary(), None, _backup() if with_fallback else None, None)

    async def _pre(*a, **kw):
        return 0

    monkeypatch.setattr(anth_mod, "prepare_proxy_request", _prep)
    monkeypatch.setattr(policy, "enforce_pre", _pre)
    body = {"model": PRIMARY, "max_tokens": 64,
            "messages": [{"role": "user", "content": "hi"}]}
    if stream:
        body["stream"] = True
    return await anth_mod.messages(
        _Req(body), db=None, authorization="Bearer k", x_api_key=None, anthropic_version=None,
    )


@pytest.mark.asyncio
async def test_messages_switches_on_node_failure(monkeypatch):
    client = _Client(_Resp(503, {"error": "down"}), _Resp(200, _OK))
    resp = await _messages(monkeypatch, client)
    assert resp.status_code == 200
    assert client.models_called == ["DeepSeek-V4", "Qwen3.6-35B"]
    assert resp.headers["x-fallback-from"] == PRIMARY
    # 响应体的 model 字段如实写兜底模型，不对用户伪装
    assert json.loads(bytes(resp.body))["model"] == BACKUP


@pytest.mark.asyncio
async def test_messages_context_overflow_passes_through(monkeypatch):
    client = _Client(_Resp(400, {"error": {"message": "maximum context length"}}))
    resp = await _messages(monkeypatch, client)
    assert resp.status_code == 400
    assert client.models_called == ["DeepSeek-V4"]


@pytest.mark.asyncio
async def test_messages_stream_switches_before_first_byte(monkeypatch):
    client = _Client(
        _StreamResp(502, [], {"error": "down"}),
        _StreamResp(200, ['data: {"choices":[{"delta":{"content":"hi"}}]}']),
    )
    resp = await _messages(monkeypatch, client, stream=True)
    assert client.models_called == ["DeepSeek-V4", "Qwen3.6-35B"]
    assert resp.headers["x-fallback-from"] == PRIMARY


async def _consume_sse(resp) -> list[dict]:
    chunks = [c async for c in resp.body_iterator]
    raw = b"".join(c.encode() if isinstance(c, str) else c for c in chunks).decode()
    return [json.loads(line[len("data: "):]) for line in raw.splitlines() if line.startswith("data: ")]


@pytest.mark.asyncio
async def test_messages_stream_reports_usage_not_hardcoded_zero(monkeypatch):
    """openai 上游转 A社 SSE：message_start 不应恒为 input_tokens=0（CC 靠它做早期
    展示），message_delta 应带上游报的真实 usage（含缓存命中）而不是只有 output_tokens。"""
    client = _Client(_StreamResp(200, [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":50,"completion_tokens":3,"total_tokens":53,'
        '"prompt_cache_hit_tokens":30}}',
    ]))
    resp = await _messages(monkeypatch, client, stream=True)
    events = await _consume_sse(resp)

    start = next(e for e in events if e["type"] == "message_start")
    assert start["message"]["usage"]["input_tokens"] > 0  # 不再是硬编码的 0

    delta = next(e for e in events if e["type"] == "message_delta")
    assert delta["usage"]["input_tokens"] == 50
    assert delta["usage"]["output_tokens"] == 3
    assert delta["usage"]["cache_read_input_tokens"] == 30


@pytest.mark.asyncio
async def test_messages_stream_waits_for_split_tool_name_before_start(monkeypatch):
    client = _Client(_StreamResp(200, [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",'
        '"function":{"arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"name":"shell","arguments":"{\\"command\\":\\"pwd\\"}"}}]},'
        '"finish_reason":"tool_calls"}]}',
    ]))
    resp = await _messages(monkeypatch, client, stream=True)
    events = await _consume_sse(resp)
    start = next(
        e for e in events
        if e["type"] == "content_block_start" and e["content_block"]["type"] == "tool_use"
    )
    assert start["content_block"]["name"] == "shell"
    assert start["content_block"]["id"] == "call_1"


@pytest.mark.asyncio
async def test_messages_stream_surfaces_midstream_error(monkeypatch):
    client = _Client(_StreamResp(200, [
        'data: {"error":{"type":"overloaded_error","message":"engine overloaded"}}',
    ]))
    resp = await _messages(monkeypatch, client, stream=True)
    events = await _consume_sse(resp)
    error = next(e for e in events if e["type"] == "error")
    assert error["error"]["type"] == "overloaded_error"
    assert error["error"]["message"] == "engine overloaded"
    assert not any(e["type"] == "message_stop" for e in events)


@pytest.mark.asyncio
async def test_messages_stream_read_timeout_is_logged_as_504(monkeypatch, isolate):
    class _TimedOut(_StreamResp):
        async def aiter_lines(self):
            if False:
                yield ""
            raise httpx.ReadTimeout("messages stream stalled")

    resp = await _messages(monkeypatch, _Client(_TimedOut(200, [])), stream=True)
    with pytest.raises(httpx.ReadTimeout):
        async for _ in resp.body_iterator:
            pass
    assert isolate[-1]["status_code"] == "504"
    assert "上游流读取超时" in isolate[-1]["error_detail"]


@pytest.mark.asyncio
async def test_messages_stream_echoes_requested_alias_not_resolved_model(monkeypatch):
    """虚拟/LTS 模型场景：没发生兜底时，流式 message_start.model 应回显用户
    请求的别名，同非流式路径——此前这里恒用解析后的真实模型 id，等于把虚拟
    模型的对齐目标泄漏给了客户端，流式和非流式看到的模型名对不上。"""
    client = _Client(_StreamResp(200, ['data: {"choices":[{"delta":{"content":"hi"}}]}']))
    monkeypatch.setattr(anth_mod, "get_client", lambda: client)

    body = {"model": "platform-sota", "max_tokens": 64, "stream": True,
            "messages": [{"role": "user", "content": "hi"}]}
    resp = await anth_mod._attempt(
        body, _key(), _primary(), None, None,
        reserved=0, fallback_from=None, fallback_trigger=None, can_fallback=False,
    )
    events = await _consume_sse(resp)
    start = next(e for e in events if e["type"] == "message_start")
    assert start["message"]["model"] == "platform-sota"


@pytest.mark.asyncio
async def test_messages_stream_echoes_real_model_after_fallback(monkeypatch):
    """兜底发生时，流式 message_start.model 应如实改写为实际出结果的模型，
    不对用户伪装——同非流式路径的既有约定。"""
    client = _Client(_StreamResp(200, ['data: {"choices":[{"delta":{"content":"hi"}}]}']))
    monkeypatch.setattr(anth_mod, "get_client", lambda: client)

    body = {"model": PRIMARY, "max_tokens": 64, "stream": True,
            "messages": [{"role": "user", "content": "hi"}]}
    resp = await anth_mod._attempt(
        body, _key(), _backup(), None, None,
        reserved=0, fallback_from=PRIMARY, fallback_trigger="retry", can_fallback=False,
    )
    events = await _consume_sse(resp)
    start = next(e for e in events if e["type"] == "message_start")
    assert start["message"]["model"] == BACKUP
