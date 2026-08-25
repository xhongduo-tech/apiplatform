"""同 key 高并发下的会话隔离：响应字节与 request_id 归因不得串线。"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import app.request_context as rc
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import chat, fallback, policy
from app.request_context import RequestContextMiddleware, get_request_id, get_request_path


def _model() -> ModelRegistryORM:
    return ModelRegistryORM(
        id="m", name="m", provider="", category="chat",
        base_url="http://up:8000", model_api_name="M", import_format="openai",
    )


def _key() -> ApiKeyORM:
    return ApiKeyORM(
        id="k-shared", name="k", auth_id="u", project_name="p", department="d", models=[],
    )


class _InterleavedStream:
    """两路流在 barrier 处交错推进，放大共享状态串线风险。"""

    status_code = 200

    def __init__(self, marker: str, barrier: asyncio.Barrier) -> None:
        self._marker = marker
        self._barrier = barrier
        self.closed = False

    async def aiter_lines(self):
        yield (
            'data: {"choices":[{"delta":{"content":"%s-1"}}]}' % self._marker
        )
        await self._barrier.wait()
        yield ""
        yield (
            'data: {"choices":[{"delta":{"content":"%s-2"}}]}' % self._marker
        )
        yield ""
        yield "data: [DONE]"

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_concurrent_pumps_same_key_do_not_cross_contaminate(monkeypatch):
    """同 key 双流并发：各 SSE 只含本路 marker，绝不混入另一路正文。"""
    logs: list[dict] = []
    monkeypatch.setattr(chat, "_log", logs.append)

    async def _noop(*_a, **_kw):
        return None

    monkeypatch.setattr(policy, "record_tokens", _noop)

    barrier = asyncio.Barrier(2)

    async def drain(marker: str) -> str:
        out = b""
        async for chunk in chat._pump(
            _InterleavedStream(marker, barrier),
            model=_model(),
            base_log={"api_key_id": _key().id, "model_id": "m", "request_id": f"rid-{marker}"},
            started=0.0,
            reserved_tokens=policy.NOT_METERED,
            suppress_usage_chunk=False,
            body={"messages": [{"role": "user", "content": marker}]},
        ):
            out += chunk
        return out.decode("utf-8")

    alpha, beta = await asyncio.gather(drain("ALPHA"), drain("BETA"))

    assert "ALPHA-1" in alpha and "ALPHA-2" in alpha
    assert "BETA" not in alpha
    assert "BETA-1" in beta and "BETA-2" in beta
    assert "ALPHA" not in beta

    # 日志预览也按请求隔离
    by_rid = {r["request_id"]: r for r in logs}
    assert by_rid["rid-ALPHA"]["response_preview"] and "ALPHA" in by_rid["rid-ALPHA"]["response_preview"]
    assert "BETA" not in (by_rid["rid-ALPHA"]["response_preview"] or "")
    assert by_rid["rid-BETA"]["response_preview"] and "BETA" in by_rid["rid-BETA"]["response_preview"]
    assert "ALPHA" not in (by_rid["rid-BETA"]["response_preview"] or "")


@pytest.mark.asyncio
async def test_concurrent_relay_streams_isolate_markers(monkeypatch):
    """完整 relay 路径：同 key 双流并发，客户端收到的字节互不串线。"""
    logs: list[dict] = []
    monkeypatch.setattr(chat, "_log", logs.append)

    async def _noop(*_a, **_kw):
        return None

    monkeypatch.setattr(policy, "record_tokens", _noop)
    monkeypatch.setattr(policy, "refund_tokens", _noop)
    monkeypatch.setattr(fallback, "record_ok", _noop)
    monkeypatch.setattr(fallback, "record_fail", _noop)
    fallback._open_until.clear()

    barrier = asyncio.Barrier(2)

    class _Client:
        def build_request(self, method, url, headers=None, json=None):
            content = ""
            for m in (json or {}).get("messages") or []:
                if isinstance(m, dict) and m.get("role") == "user":
                    content = m.get("content") or ""
            return {"marker": content}

        async def send(self, req, stream=False):
            return _InterleavedStream(req["marker"], barrier)

    monkeypatch.setattr(chat, "get_client", lambda: _Client())

    async def one(marker: str) -> str:
        body = {
            "model": "m",
            "stream": True,
            "messages": [{"role": "user", "content": marker}],
        }
        resp = await chat.relay_chat_like(
            body, _key(), _model(), None, True,
        )
        chunks: list[bytes] = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode())
        return b"".join(chunks).decode("utf-8")

    a, b = await asyncio.gather(one("MARK_A"), one("MARK_B"))
    assert "MARK_A" in a and "MARK_B" not in a
    assert "MARK_B" in b and "MARK_A" not in b


def test_enrich_usage_log_snapshots_request_id():
    """尝试开始时写入 request_id；ContextVar 复位后日志 dict 仍保留快照。"""
    token = rc._request_id.set("snap-rid-0012")
    try:
        record = fallback.enrich_usage_log(
            {"api_key_id": "k1", "model_id": "m1"},
            fallback_from=None,
        )
        assert record["request_id"] == "snap-rid-0012"
    finally:
        rc._request_id.reset(token)

    assert get_request_id() is None
    assert record["request_id"] == "snap-rid-0012"


def test_enrich_usage_log_keeps_explicit_request_id():
    token = rc._request_id.set("other-rid-xx")
    try:
        record = fallback.enrich_usage_log(
            {"api_key_id": "k1", "request_id": "explicit-rid1"},
            fallback_from=None,
        )
        assert record["request_id"] == "explicit-rid1"
    finally:
        rc._request_id.reset(token)


@pytest.mark.asyncio
async def test_middleware_resets_contextvars_after_request():
    """请求结束后复位 ContextVar，避免同任务复用时读到上一请求的 id。"""
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/ping")
    def ping():
        return {"rid": get_request_id(), "path": get_request_path()}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/ping", headers={"X-Request-Id": "iso-test-rid1"})
        assert r.status_code == 200
        assert r.json()["rid"] == "iso-test-rid1"
        assert r.headers["x-request-id"] == "iso-test-rid1"

    assert get_request_id() is None
    assert get_request_path() is None
