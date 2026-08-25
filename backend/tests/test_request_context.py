"""request-id 贯穿：中间件生成/沿用/拒绝非法 ID + enqueue 注入与访问日志。"""
from __future__ import annotations

import asyncio
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

import app.request_context as rc
from app.request_context import (
    RequestContextMiddleware,
    get_request_id,
    get_upstream_request_id,
    with_upstream_request_headers,
)


def _make_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/ping")
    def ping():
        return {"rid": get_request_id()}

    return app


def test_generates_id_and_echoes_header():
    r = TestClient(_make_app()).get("/ping")
    rid = r.headers.get("x-request-id")
    assert rid and len(rid) == 12
    # 处理器内 contextvar 读到的与响应头一致
    assert r.json()["rid"] == rid


def test_honors_valid_inbound_id():
    r = TestClient(_make_app()).get("/ping", headers={"X-Request-Id": "nginx-abc.123"})
    assert r.headers["x-request-id"] == "nginx-abc.123"
    assert r.json()["rid"] == "nginx-abc.123"


def test_rejects_invalid_inbound_id():
    bad = "bad id\nwith junk"
    r = TestClient(_make_app()).get("/ping", headers={"X-Request-Id": "x"})  # 过短
    assert r.headers["x-request-id"] != "x"
    r2 = TestClient(_make_app()).get("/ping", headers={"X-Request-Id": bad.replace("\n", " ")})
    assert r2.headers["x-request-id"] != bad


def test_upstream_id_is_not_controlled_by_client_or_static_model_header():
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/upstream-headers")
    async def upstream_headers():
        return with_upstream_request_headers({
            "x-request-id": "static-model-value",
            "x-platform-request-id": "static-platform-value",
            "x-platform-trace-id": "static-trace-value",
        })

    r = TestClient(app).get(
        "/upstream-headers", headers={"X-Request-Id": "client-reused-id"},
    )
    body = r.json()
    assert r.headers["x-request-id"] == "client-reused-id"
    assert body["X-Platform-Trace-Id"] == "client-reused-id"
    assert body["X-Request-Id"] == body["X-Platform-Request-Id"]
    assert body["X-Request-Id"] != "client-reused-id"
    assert body["X-Request-Id"] != "static-model-value"
    assert not any(k.islower() for k in body)
    assert len(body["X-Request-Id"]) == 32


def test_concurrent_requests_get_unique_upstream_ids_even_with_same_client_id():
    """高并发复用同一外部追踪 ID 时，上游调用仍必须一请求一 ID。"""
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/upstream-id")
    async def upstream_id():
        await asyncio.sleep(0)
        return {
            "trace": get_request_id(),
            "upstream": get_upstream_request_id(),
        }

    async def run() -> list[dict[str, str]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            responses = await asyncio.gather(*(
                client.get("/upstream-id", headers={"X-Request-Id": "shared-client-id"})
                for _ in range(100)
            ))
        return [r.json() for r in responses]

    rows = asyncio.run(run())
    assert {row["trace"] for row in rows} == {"shared-client-id"}
    assert len({row["upstream"] for row in rows}) == 100
    assert all(len(row["upstream"]) == 32 for row in rows)
    assert get_request_id() is None
    assert get_upstream_request_id() is None


def test_enqueue_injects_request_id_and_emits_access_log(caplog):
    from app.usage_writer import UsageWriter

    token = rc._request_id.set("rid4test12ab")
    ptoken = rc._request_path.set("/v1/chat/completions")
    try:
        w = UsageWriter()
        with caplog.at_level("INFO", logger="apiplatform.access"):
            w.enqueue({"api_key_id": "k1", "model_id": "m1", "status_code": "200",
                       "latency_ms": 5, "total_duration_ms": 9, "total_tokens": 42})
        rec = w._queue.get_nowait()
        assert rec["request_id"] == "rid4test12ab"
        # 访问日志：单行 JSON，字段齐全
        line = next(m for m in caplog.messages if "rid4test12ab" in m)
        obj = json.loads(line)
        assert obj["path"] == "/v1/chat/completions"
        assert obj["model"] == "m1" and obj["status"] == "200"
        assert obj["ttft_ms"] == 5 and obj["total_ms"] == 9 and obj["total_tokens"] == 42
    finally:
        rc._request_id.reset(token)
        rc._request_path.reset(ptoken)


def test_enqueue_keeps_explicit_request_id():
    from app.usage_writer import UsageWriter

    w = UsageWriter()
    w.enqueue({"api_key_id": "k1", "model_id": "m1", "request_id": "explicit-id1"})
    assert w._queue.get_nowait()["request_id"] == "explicit-id1"
