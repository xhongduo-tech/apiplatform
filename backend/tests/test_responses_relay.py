"""/v1/responses 中继层测试：openai 上游走转换，custom/anthropic 上游维持透传。

复现的正是用户报的 bug——Codex 发 Responses 协议（input 字段），此前网关对
openai 上游原样透传，上游拿不到 messages 直接 400
（USER_MESSAGES_NOT_EMPTY）。这里断言网关现在会把它转成 messages 再转发。
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import policy, responses as resp_mod
from app.proxy.db_bridge import Prepared
from app.usage_writer import usage_writer

PRIMARY = "deepseek-v4"
BACKUP = "qwen3.6-35b"


def _openai_model(model_id=PRIMARY, api_name="DeepSeek-V4", **fallback) -> ModelRegistryORM:
    extra = {"fallback": fallback} if fallback else {}
    return ModelRegistryORM(
        id=model_id, name=model_id, provider="", category="chat",
        base_url="http://primary:8000", model_api_name=api_name,
        import_format="openai", extra=extra,
    )


def _custom_model() -> ModelRegistryORM:
    return ModelRegistryORM(
        id=PRIMARY, name=PRIMARY, provider="", category="chat",
        base_url="http://custom:8000", model_api_name="whatever",
        import_format="custom",
    )


def _key() -> ApiKeyORM:
    return ApiKeyORM(id="k1", name="k", auth_id="u", project_name="p", department="d", models=[])


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
    def __init__(self, *script):
        self.script = list(script)
        self.bodies_sent: list[dict] = []

    def _next(self):
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def post(self, url, headers=None, json=None):
        self.bodies_sent.append(json)
        return self._next()

    def build_request(self, method, url, headers=None, json=None):
        self.bodies_sent.append(json)
        return json

    async def send(self, req, stream=False):
        return self._next()


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(policy, "refund_tokens", _noop)
    monkeypatch.setattr(policy, "record_tokens", _noop)
    logs: list[dict] = []
    monkeypatch.setattr(usage_writer, "enqueue", logs.append)
    yield logs


_CODEX_BODY = {
    "model": PRIMARY,
    "instructions": "你是编程助手",
    "input": [{"type": "message", "role": "user", "content": "写个 hello world"}],
}

_OAI_OK = {"choices": [{"message": {"content": "print('hi')"}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}


@pytest.mark.asyncio
async def test_openai_backend_gets_messages_not_input(monkeypatch):
    """核心回归：openai 上游此前会收到裸 input 字段直接 400，现在应转成 messages。"""
    client = _Client(_Resp(200, _OAI_OK))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)

    result = await resp_mod._attempt(
        _CODEX_BODY, _key(), _openai_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    sent = client.bodies_sent[0]
    assert "input" not in sent
    assert sent["messages"][0] == {"role": "system", "content": "你是编程助手"}
    assert sent["messages"][1] == {"role": "user", "content": "写个 hello world"}

    payload = json.loads(bytes(result.body))
    assert payload["object"] == "response"
    assert payload["status"] == "completed"
    assert payload["output"][0]["type"] == "message"
    assert payload["output_text"] == "print('hi')"
    assert payload["usage"]["input_tokens"] == 10
    assert payload["usage"]["output_tokens"] == 4


@pytest.mark.asyncio
async def test_custom_backend_stays_raw_passthrough(monkeypatch):
    """custom 接入格式：管理员自行掌控协议，网关不做转换，行为与此前一致。"""
    client = _Client(_Resp(200, {"whatever": "shape"}))
    monkeypatch.setattr("app.proxy.common.get_client", lambda: client)

    await resp_mod._attempt(
        _CODEX_BODY, _key(), _custom_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    sent = client.bodies_sent[0]
    assert "input" in sent  # 原样转发，未被改写成 messages
    assert sent["input"] == _CODEX_BODY["input"]


@pytest.mark.asyncio
async def test_stream_emits_responses_completed_event(monkeypatch):
    client = _Client(_StreamResp(200, [
        'data: {"choices":[{"delta":{"content":"print"}}]}',
        'data: {"choices":[{"delta":{"content":"(1)"},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":6,"completion_tokens":2,"total_tokens":8}}',
        "data: [DONE]",
    ]))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)

    stream_body = {**_CODEX_BODY, "stream": True}
    result = await resp_mod._attempt(
        stream_body, _key(), _openai_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    chunks = [c async for c in result.body_iterator]
    raw = b"".join(c.encode() if isinstance(c, str) else c for c in chunks).decode()

    events = [json.loads(line[len("data: "):]) for line in raw.splitlines() if line.startswith("data: ")]
    types = [e["type"] for e in events]
    assert "response.created" in types
    assert "response.output_text.delta" in types
    assert types.count("response.output_text.delta") == 2
    completed = next(e for e in events if e["type"] == "response.completed")
    assert completed["response"]["output_text"] == "print(1)"
    assert completed["response"]["usage"]["total_tokens"] == 8
    assert completed["response"]["status"] == "completed"


@pytest.mark.asyncio
async def test_stream_recovers_tool_name_split_into_later_chunk(monkeypatch):
    client = _Client(_StreamResp(200, [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",'
        '"function":{"arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"name":"shell","arguments":"{\\"command\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"arguments":"\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
    ]))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)

    result = await resp_mod._attempt(
        {**_CODEX_BODY, "stream": True}, _key(), _openai_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    events = await _sse_events(result)
    done = next(e for e in events if e["type"] == "response.output_item.done")
    assert done["item"]["name"] == "shell"
    assert done["item"]["arguments"] == '{"command":"pwd"}'


@pytest.mark.asyncio
async def test_stream_surfaces_midstream_error_as_response_failed(monkeypatch):
    client = _Client(_StreamResp(200, [
        'data: {"error":{"type":"server_error","message":"engine stopped"}}',
    ]))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)
    result = await resp_mod._attempt(
        {**_CODEX_BODY, "stream": True}, _key(), _openai_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    events = await _sse_events(result)
    failed = next(e for e in events if e["type"] == "response.failed")
    assert failed["response"]["status"] == "failed"
    assert failed["response"]["error"]["message"] == "engine stopped"
    assert not any(e["type"] == "response.completed" for e in events)


@pytest.mark.asyncio
async def test_stream_read_timeout_is_logged_as_504(monkeypatch, isolate):
    class _TimedOut(_StreamResp):
        async def aiter_lines(self):
            if False:
                yield ""
            raise httpx.ReadTimeout("responses stream stalled")

    client = _Client(_TimedOut(200, []))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)
    result = await resp_mod._attempt(
        {**_CODEX_BODY, "stream": True}, _key(), _openai_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    with pytest.raises(httpx.ReadTimeout):
        async for _ in result.body_iterator:
            pass
    assert isolate[-1]["status_code"] == "504"
    assert "上游流读取超时" in isolate[-1]["error_detail"]


async def _sse_events(result):
    chunks = [c async for c in result.body_iterator]
    raw = b"".join(c.encode() if isinstance(c, str) else c for c in chunks).decode()
    return [json.loads(line[len("data: "):]) for line in raw.splitlines() if line.startswith("data: ")]


@pytest.mark.asyncio
async def test_stream_echoes_requested_alias_not_resolved_model(monkeypatch):
    """虚拟/LTS 模型场景：没发生兜底时，流式 response.model 应回显用户请求的
    别名，同非流式路径一致——不泄漏虚拟模型背后的真实对齐目标。"""
    client = _Client(_StreamResp(200, ['data: {"choices":[{"delta":{"content":"hi"}}]}']))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)

    body = {**_CODEX_BODY, "model": "platform-sota", "stream": True}
    result = await resp_mod._attempt(
        body, _key(), _openai_model(), None,
        reserved=0, fallback_from=None, can_fallback=False,
    )
    events = await _sse_events(result)
    created = next(e for e in events if e["type"] == "response.created")
    assert created["response"]["model"] == "platform-sota"


@pytest.mark.asyncio
async def test_stream_echoes_real_model_after_fallback(monkeypatch):
    """兜底发生时，流式 response.model 应如实改写为实际出结果的模型。"""
    client = _Client(_StreamResp(200, ['data: {"choices":[{"delta":{"content":"hi"}}]}']))
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)

    body = {**_CODEX_BODY, "stream": True}
    result = await resp_mod._attempt(
        body, _key(), _openai_model(BACKUP, "Qwen3.6-35B"), None,
        reserved=0, fallback_from=PRIMARY, can_fallback=False,
    )
    events = await _sse_events(result)
    created = next(e for e in events if e["type"] == "response.created")
    assert created["response"]["model"] == BACKUP


async def _route(monkeypatch, client, *, with_fallback=True, stream=False):
    monkeypatch.setattr(resp_mod, "get_client", lambda: client)

    async def _prep(auth, requested):
        return Prepared(_key(), _openai_model(), None,
                        _openai_model(BACKUP, "Qwen3.6-35B") if with_fallback else None, None)

    async def _pre(*a, **kw):
        return 0

    monkeypatch.setattr(resp_mod, "prepare_proxy_request", _prep)
    monkeypatch.setattr(policy, "enforce_pre", _pre)
    body = dict(_CODEX_BODY)
    if stream:
        body["stream"] = True

    class _Req:
        async def body(self):
            return json.dumps(body).encode("utf-8")

    return await resp_mod.responses(_Req(), db=None, authorization="Bearer k")


@pytest.mark.asyncio
async def test_route_switches_to_fallback_on_node_failure(monkeypatch):
    client = _Client(_Resp(503, {"error": "down"}), _Resp(200, _OAI_OK))
    resp = await _route(monkeypatch, client)
    assert resp.status_code == 200
    assert resp.headers["x-fallback-from"] == PRIMARY
    sent_models = [b["model"] for b in client.bodies_sent]
    assert sent_models == ["DeepSeek-V4", "Qwen3.6-35B"]
    # 兜底后 messages 字段仍然存在（两次都经过了转换，不是第二次退回透传）
    assert all("messages" in b for b in client.bodies_sent)


@pytest.mark.asyncio
async def test_route_client_error_not_switched(monkeypatch):
    client = _Client(_Resp(400, {"error": {"message": "bad request"}}))
    resp = await _route(monkeypatch, client)
    assert resp.status_code == 400
    assert len(client.bodies_sent) == 1
