"""Model endpoint encryption, URL validation and admin response masking."""
from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.auth import require_admin
from app.database import SessionLocal
from app.model_secrets import (
    MASKED_SECRET,
    mask_sensitive_headers,
    merge_masked_sensitive_headers,
    normalize_custom_headers,
    normalize_model_base_url,
)
from app.models import ModelRegistryORM
from app.routers import admin as admin_module


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://user@example.test/v1",
        "https://user:password@example.test/v1",
        "https://example.test/v1?api_key=secret",
        "https://example.test/v1?access-token=secret",
        "https://example.test/v1?client_secret=secret",
    ],
)
def test_model_base_url_rejects_credentials(url: str) -> None:
    with pytest.raises(ValueError):
        normalize_model_base_url(url)


def test_model_base_url_allows_safe_internal_url_and_query() -> None:
    assert normalize_model_base_url(
        "  http://inference.internal:8000/v1?api-version=2026-08-01  "
    ) == "http://inference.internal:8000/v1?api-version=2026-08-01"


def test_sensitive_header_mask_and_merge_are_case_insensitive() -> None:
    stored = {
        "Authorization": "Bearer real-secret",
        "Cookie": "session=real-secret",
        "X-Api-Key": "real-key",
        "X-Trace-Id": "visible",
    }
    masked = mask_sensitive_headers(stored)
    assert masked == {
        "Authorization": MASKED_SECRET,
        "Cookie": MASKED_SECRET,
        "X-Api-Key": MASKED_SECRET,
        "X-Trace-Id": "visible",
    }
    merged = merge_masked_sensitive_headers(
        {
            "authorization": MASKED_SECRET,
            "COOKIE": MASKED_SECRET,
            "x_api_key": MASKED_SECRET,
            "X-Trace-Id": "changed",
            "X-New-Token": MASKED_SECRET,  # no previous value: never store a mask
        },
        stored,
    )
    assert merged["authorization"] == "Bearer real-secret"
    assert merged["COOKIE"] == "session=real-secret"
    assert merged["x_api_key"] == "real-key"
    assert merged["X-Trace-Id"] == "changed"
    assert "X-New-Token" not in merged


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "metadata.internal"},
        {"Content-Length": "1"},
        {"Transfer-Encoding": "chunked"},
        {"Connection": "keep-alive"},
        {"X-Request-Id": "static-id"},
        {"X-Test": "safe\r\nInjected: yes"},
        {"X-Test": 123},
        {"X-Test": "中文"},
        {"X-Test": "x" * 8193},
    ],
)
def test_custom_headers_reject_framing_and_unsafe_values(headers: dict) -> None:
    with pytest.raises(ValueError):
        normalize_custom_headers(headers)


def test_custom_headers_accept_masked_authentication_fields() -> None:
    assert normalize_custom_headers({
        "Authorization": "Bearer secret",
        "Cookie": "session=secret",
        "X-Api-Key": "secret",
        "X-Tenant": "tenant-1",
    }) == {
        "Authorization": "Bearer secret",
        "Cookie": "session=secret",
        "X-Api-Key": "secret",
        "X-Tenant": "tenant-1",
    }


@pytest.fixture
def admin_client():
    app = FastAPI()
    app.include_router(admin_module.router, prefix="/api")
    app.dependency_overrides[require_admin] = lambda: None
    with TestClient(app) as client:
        yield client


def test_model_base_url_is_encrypted_at_rest(requires_db) -> None:
    model_id = f"pytest-url-encryption-{uuid.uuid4().hex}"
    clear_url = "https://inference.example.test/v1?api-version=2026-08-01"
    db = SessionLocal()
    try:
        db.add(ModelRegistryORM(id=model_id, name="URL encryption", base_url=clear_url))
        db.commit()
        raw = db.execute(
            text("SELECT base_url FROM model_registry WHERE id = :id"), {"id": model_id},
        ).scalar_one()
        assert raw.startswith("enc:v1:")
        assert clear_url not in raw
        db.expire_all()
        assert db.get(ModelRegistryORM, model_id).base_url == clear_url
    finally:
        row = db.get(ModelRegistryORM, model_id)
        if row is not None:
            db.delete(row)
            db.commit()
        db.close()


def test_admin_model_masks_headers_and_all_update_paths_preserve_masks(
    requires_db,
    admin_client: TestClient,
) -> None:
    model_id = f"pytest-header-mask-{uuid.uuid4().hex}"
    endpoint_url = "https://node.example.test/v1"
    db = SessionLocal()
    try:
        db.add(ModelRegistryORM(
            id=model_id,
            name="Header mask",
            provider="test",
            status="online",
            category="chat",
            base_url=endpoint_url,
            api_key="top-api-secret",
            model_api_name="upstream-model",
            custom_headers={
                "Authorization": "Bearer top-secret",
                "Cookie": "top-session=secret",
                "X-Api-Key": "top-key-secret",
                "X-Trace-Id": "visible",
            },
            extra={
                "endpoints": [{
                    "label": "node-a",
                    "base_url": endpoint_url,
                    "model_api_name": "upstream-model",
                    "api_key": "node-api-secret",
                    "custom_headers": {
                        "Authorization": "Bearer node-secret",
                        "Cookie": "node-session=secret",
                        "X-Api-Key": "node-key-secret",
                        "X-Trace-Id": "node-visible",
                    },
                }],
            },
        ))
        db.commit()

        response = admin_client.get("/api/admin/models")
        assert response.status_code == 200
        item = next(row for row in response.json() if row["id"] == model_id)
        rendered = str(item)
        for secret in (
            "top-api-secret", "top-secret", "top-session=secret", "top-key-secret",
            "node-api-secret", "node-secret", "node-session=secret", "node-key-secret",
        ):
            assert secret not in rendered
        assert item["baseUrl"] == endpoint_url
        assert item["customHeaders"]["Authorization"] == MASKED_SECRET
        assert item["customHeaders"]["Cookie"] == MASKED_SECRET
        assert item["customHeaders"]["X-Api-Key"] == MASKED_SECRET
        assert item["customHeaders"]["X-Trace-Id"] == "visible"
        endpoint = item["endpoints"][0]
        assert endpoint["api_key"] == MASKED_SECRET
        assert endpoint["custom_headers"]["Authorization"] == MASKED_SECRET
        assert endpoint["custom_headers"]["Cookie"] == MASKED_SECRET
        assert endpoint["custom_headers"]["X-Api-Key"] == MASKED_SECRET
        assert endpoint["base_url"] == endpoint_url

        # PUT: both the API-key mask and sensitive header masks mean keep old.
        put_headers = dict(item["customHeaders"])
        put_headers["X-Trace-Id"] = "put-visible"
        response = admin_client.put(f"/api/admin/models/{model_id}", json={
            "id": model_id,
            "name": "Header mask",
            "provider": "test",
            "status": "online",
            "category": "chat",
            "base_url": endpoint_url,
            "api_key": MASKED_SECRET,
            "model_api_name": "upstream-model",
            "custom_headers": put_headers,
        })
        assert response.status_code == 200, response.text
        db.expire_all()
        row = db.get(ModelRegistryORM, model_id)
        assert row.api_key == "top-api-secret"
        assert row.custom_headers["Authorization"] == "Bearer top-secret"
        assert row.custom_headers["Cookie"] == "top-session=secret"
        assert row.custom_headers["X-Api-Key"] == "top-key-secret"
        assert row.custom_headers["X-Trace-Id"] == "put-visible"

        # PATCH endpoints: returned masks preserve each node's independent values.
        endpoint_payload = dict(endpoint)
        endpoint_payload["custom_headers"] = dict(endpoint["custom_headers"])
        endpoint_payload["custom_headers"]["X-Trace-Id"] = "node-changed"
        response = admin_client.patch(f"/api/admin/models/{model_id}", json={
            "endpoints": [endpoint_payload],
        })
        assert response.status_code == 200, response.text
        db.expire_all()
        row = db.get(ModelRegistryORM, model_id)
        stored_endpoint = row.extra["endpoints"][0]
        assert stored_endpoint["api_key"] == "node-api-secret"
        assert stored_endpoint["custom_headers"]["Authorization"] == "Bearer node-secret"
        assert stored_endpoint["custom_headers"]["Cookie"] == "node-session=secret"
        assert stored_endpoint["custom_headers"]["X-Api-Key"] == "node-key-secret"
        assert stored_endpoint["custom_headers"]["X-Trace-Id"] == "node-changed"

        # Bulk sync follows the same keep-old contract for the primary headers.
        response = admin_client.post("/api/admin/models/sync", json={"models": [{
            "id": model_id,
            "apiKey": MASKED_SECRET,
            "customHeaders": {
                "Authorization": MASKED_SECRET,
                "Cookie": MASKED_SECRET,
                "X-Api-Key": MASKED_SECRET,
                "X-Trace-Id": "sync-visible",
            },
        }]})
        assert response.status_code == 200, response.text
        db.expire_all()
        row = db.get(ModelRegistryORM, model_id)
        assert row.api_key == "node-api-secret"
        assert row.custom_headers["Authorization"] == "Bearer node-secret"
        assert row.custom_headers["Cookie"] == "node-session=secret"
        assert row.custom_headers["X-Api-Key"] == "node-key-secret"
        assert row.custom_headers["X-Trace-Id"] == "sync-visible"
    finally:
        db.rollback()
        row = db.get(ModelRegistryORM, model_id)
        if row is not None:
            db.delete(row)
            db.commit()
        db.close()


def test_admin_endpoint_rejects_url_credentials(requires_db, admin_client: TestClient) -> None:
    model_id = f"pytest-unsafe-url-{uuid.uuid4().hex}"
    response = admin_client.patch(f"/api/admin/models/{model_id}", json={
        "name": "unsafe",
        "endpoints": [{
            "baseUrl": "https://user:password@node.example.test/v1",
            "modelApiName": "m",
        }],
    })
    assert response.status_code == 400
    db = SessionLocal()
    try:
        assert db.get(ModelRegistryORM, model_id) is None
    finally:
        db.close()
