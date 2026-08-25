from __future__ import annotations

import io
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import require_recent_admin
from app.routers import admin as admin_module


@pytest.fixture
def admin_client():
    app = FastAPI()
    app.include_router(admin_module.router, prefix="/api")
    app.dependency_overrides[require_recent_admin] = lambda: None
    with TestClient(app) as client:
        yield client


def test_sanitized_export_excludes_endpoint_and_infrastructure_data(
    requires_db,
    admin_client: TestClient,
) -> None:
    response = admin_client.get("/api/admin/backup/export")
    assert response.status_code == 200, response.text
    assert response.headers["x-export-contains-sensitive-data"] == "true"
    assert response.headers["x-export-sharing"] == "private-only"
    assert response.headers["cache-control"] == "no-store"

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        assert "usage_logs.csv" not in names
        assert "infra_resources.csv" not in names
        assert "infra_topology_links.csv" not in names
        assert "EXPORT_SECURITY_NOTICE.txt" in names
        notice = archive.read("EXPORT_SECURITY_NOTICE.txt").decode("utf-8")
        assert "不得公开分享" in notice
        assert "personal and business information" in notice

        model_header = archive.read("model_registry.csv").decode("utf-8-sig").splitlines()[0]
        columns = model_header.split(",")
        assert "base_url" not in columns
        assert "api_key" not in columns
        assert "custom_headers" not in columns


def test_nested_endpoint_urls_are_redacted_from_export_cells() -> None:
    source = {
        "endpoints": [{
            "base_url": "https://internal-node.example.test/v1",
            "api_key": "secret",
            "label": "safe-label",
        }],
    }
    redacted = admin_module._redact_export_value(source)
    endpoint = redacted["endpoints"][0]
    assert endpoint["base_url"] == "[REDACTED]"
    assert endpoint["api_key"] == "[REDACTED]"
    assert endpoint["label"] == "safe-label"
