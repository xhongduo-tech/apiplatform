"""Claude Code / Codex 网关契约的聚焦回归。"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import anthropic as anth_mod, fallback, models as model_mod, policy
from app.proxy.common import iter_with_keepalive, stream_transport_log


class _Response:
    status_code = 200
    text = '{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}'

    def json(self):
        return {"type": "message", "usage": {"input_tokens": 1, "output_tokens": 1}}


class _RecordingClient:
    def __init__(self):
        self.url = None
        self.headers = None

    async def post(self, url, headers=None, json=None):
        self.url = url
        self.headers = headers
        return _Response()


@pytest.mark.asyncio
async def test_anthropic_passthrough_forwards_beta_header_and_query(monkeypatch):
    client = _RecordingClient()
    monkeypatch.setattr(anth_mod, "get_client", lambda: client)
    monkeypatch.setattr(anth_mod, "select_endpoint", lambda model: {
        "base_url": "https://upstream.example", "ep_idx": 0,
        "import_format": "anthropic", "api_key": "upstream-key",
        "custom_headers": {}, "model_api_name": "claude-upstream",
    })

    async def _noop(*args, **kwargs):
        return None

    async def _healthy(*args, **kwargs):
        return False

    monkeypatch.setattr(policy, "record_tokens", _noop)
    monkeypatch.setattr(fallback, "after_upstream", _healthy)
    monkeypatch.setattr(anth_mod.usage_writer, "enqueue", lambda row: None)

    key = ApiKeyORM(id="k1", name="key", auth_id="u", project_name="p", department="d", models=[])
    model = ModelRegistryORM(id="m", name="m", provider="", category="chat")
    await anth_mod._attempt(
        {"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8},
        key, model, None, "2023-06-01", reserved=0, fallback_from=None,
        forward_headers={
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
        },
        query_string="beta=true",
    )

    assert client.url == "https://upstream.example/v1/messages?beta=true"
    assert client.headers["anthropic-beta"] == "prompt-caching-2024-07-31"
    assert client.headers["x-api-key"] == "upstream-key"


@pytest.mark.asyncio
async def test_model_discovery_accepts_claude_x_api_key(monkeypatch):
    seen = []

    async def _validate(value):
        seen.append(value)
        return SimpleNamespace(auth_id="u")

    monkeypatch.setattr(model_mod, "async_validate_api_key", _validate)
    monkeypatch.setattr(model_mod, "_list_exposed_models_sync", lambda auth_id: [])
    result = await model_mod.list_models(authorization=None, x_api_key="client-secret")
    assert result == {"object": "list", "data": []}
    assert seen == ["Bearer client-secret"]


@pytest.mark.asyncio
async def test_keepalive_does_not_cancel_slow_upstream_read():
    async def _slow_source():
        await asyncio.sleep(0.02)
        yield "data: done"

    seen = []
    async for item in iter_with_keepalive(_slow_source(), interval_s=0.001):
        seen.append(item)
    assert None in seen
    assert seen[-1] == "data: done"


def test_stream_transport_log_uses_gateway_error_codes():
    assert stream_transport_log(httpx.ReadTimeout("slow"))[0] == "504"
    assert stream_transport_log(httpx.RemoteProtocolError("reset"))[0] == "502"
