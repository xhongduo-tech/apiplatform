"""Request-body validation shared by all public proxy routes."""

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.proxy.request_body import parse_json_object, read_json_object


def _client() -> TestClient:
    app = FastAPI()

    @app.post("/probe")
    async def probe(request: Request):
        return await read_json_object(request)

    return TestClient(app)


def test_accepts_json_object() -> None:
    response = _client().post("/probe", json={"model": "demo"})
    assert response.status_code == 200
    assert response.json() == {"model": "demo"}


def test_rejects_malformed_json_as_bad_request() -> None:
    response = _client().post(
        "/probe",
        content="{",
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "请求体必须是有效 JSON。"


def test_rejects_non_object_json_as_unprocessable() -> None:
    response = _client().post("/probe", json=[{"model": "demo"}])
    assert response.status_code == 422
    assert response.json()["detail"] == "JSON 请求体顶层必须是对象。"


@pytest.mark.parametrize(
    "content",
    (
        '{"value": NaN}',
        '{"value": Infinity}',
        '{"value": -Infinity}',
        '{"value": 1e9999}',
        '{"value": "\\ud800"}',
        '{"\\udfff": "value"}',
    ),
)
def test_rejects_non_interoperable_json_values(content: str) -> None:
    response = _client().post(
        "/probe",
        content=content,
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "请求体必须是有效 JSON。"


@pytest.mark.parametrize(
    "raw",
    (
        b'{"value": NaN}',
        b'{"value": 1e9999}',
        b'{"value": "\\ud800"}',
    ),
)
def test_sync_parser_rejects_non_interoperable_json_values(raw: bytes) -> None:
    with pytest.raises(HTTPException) as exc_info:
        parse_json_object(raw)
    assert exc_info.value.status_code == 400
