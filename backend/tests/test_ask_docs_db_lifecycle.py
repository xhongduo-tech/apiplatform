"""Ask Docs 外部 HTTP 不得持有 request-scoped 同步数据库 Session。"""
from __future__ import annotations

import pytest

from app.ask_docs import ResolvedLlmConfig
from app.platform_settings import AskDocsConfig
from app.routers import ask_docs as router


class FakeDb:
    closed = False

    def close(self):
        self.closed = True


def _resolved() -> ResolvedLlmConfig:
    return ResolvedLlmConfig(
        api_base="https://example.invalid/v1",
        api_key="secret",
        model="model",
        custom_headers=None,
        max_tokens=16,
        temperature=0.1,
    )


def _prepare(monkeypatch, db: FakeDb) -> None:
    config = AskDocsConfig(enabled=True)
    monkeypatch.setattr(router, "get_ask_docs_config", lambda _db: config)
    monkeypatch.setattr(router, "get_branding_config", lambda _db: None)
    monkeypatch.setattr(router, "build_messages", lambda *_args: [{"role": "user", "content": "x"}])
    monkeypatch.setattr(router, "resolve_llm_config", lambda _db, _config: _resolved())

    async def no_rate(_auth_id):
        return None

    monkeypatch.setattr(router, "_check_ask_docs_rate", no_rate)


@pytest.mark.asyncio
async def test_non_stream_closes_db_before_http(monkeypatch):
    db = FakeDb()
    _prepare(monkeypatch, db)

    async def fake_call(_messages, config):
        assert db.closed is True
        assert isinstance(config, ResolvedLlmConfig)
        return "answer"

    monkeypatch.setattr(router, "call_llm", fake_call)
    result = await router.ask_docs(
        router.AskDocsRequest(question="question"), db=db, claims={"sub": "user"},
    )
    assert result == {"answer": "answer"}


@pytest.mark.asyncio
async def test_stream_closes_db_before_generator_http(monkeypatch):
    db = FakeDb()
    _prepare(monkeypatch, db)

    async def fake_stream(_messages, config):
        assert db.closed is True
        assert isinstance(config, ResolvedLlmConfig)
        yield '{"delta":"ok"}'
        yield "[DONE]"

    monkeypatch.setattr(router, "call_llm_stream", fake_stream)
    response = await router.ask_docs_stream(
        router.AskDocsRequest(question="question"), db=db, claims={"sub": "user"},
    )
    chunks = [chunk async for chunk in response.body_iterator]
    assert chunks == ['data: {"delta":"ok"}\n\n', "data: [DONE]\n\n"]
