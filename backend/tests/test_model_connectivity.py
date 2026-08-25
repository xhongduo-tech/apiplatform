"""model_connectivity 单元测试。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.model_connectivity import probe_endpoint_eff, run_connectivity_test, snapshot_model
from app.proxy.routing import list_all_endpoint_effs


def _model(**kwargs):
    defaults = dict(
        id="test-chat",
        name="Test Chat",
        category="chat",
        base_url="http://10.0.0.1:8000/v1",
        model_api_name="test-chat",
        api_key="sk-test",
        import_format="openai",
        custom_headers=None,
        extra=None,
        resolve_to_model_id=None,
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


@pytest.mark.asyncio
async def test_probe_ok_on_models_list():
    model = _model()
    eff = list_all_endpoint_effs(model)[0]
    mock_resp = MagicMock(status_code=200)
    with patch("app.model_connectivity.get_client") as gc:
        gc.return_value.get = AsyncMock(return_value=mock_resp)
        out = await probe_endpoint_eff(model, eff)
    assert out["ok"] is True
    assert out["status_code"] == 200


@pytest.mark.asyncio
async def test_probe_connect_error():
    model = _model()
    eff = list_all_endpoint_effs(model)[0]
    with patch("app.model_connectivity.get_client") as gc:
        gc.return_value.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        out = await probe_endpoint_eff(model, eff)
    assert out["ok"] is False
    assert "连接失败" in out["message"]


@pytest.mark.asyncio
async def test_run_connectivity_test_multiple_endpoints():
    model = _model(extra={
        "endpoints": [
            {"label": "主节点", "baseUrl": "http://10.0.0.1:8000/v1", "apiKey": "sk-a", "weight": 1},
            {"label": "备用", "baseUrl": "http://10.0.0.2:8000/v1", "apiKey": "sk-b", "weight": 1},
        ],
    })
    mock_resp = MagicMock(status_code=200)
    with patch("app.model_connectivity.get_client") as gc:
        gc.return_value.get = AsyncMock(return_value=mock_resp)
        results = await run_connectivity_test(model)
    assert len(results) == 2
    assert results[0]["label"] == "主节点"
    assert results[1]["label"] == "备用"
    assert all(r["ok"] for r in results)


@pytest.mark.asyncio
async def test_run_connectivity_test_no_endpoint():
    model = _model(base_url="", extra={})
    results = await run_connectivity_test(model)
    assert len(results) == 1
    assert results[0]["ok"] is False
    assert "尚未配置" in results[0]["message"]


def test_snapshot_model_deep_copies_mutable_config():
    model = _model(extra={"endpoints": [{"baseUrl": "https://a.invalid"}]}, custom_headers={"X-Test": "1"})
    snapshot = snapshot_model(model)

    model.extra["endpoints"][0]["baseUrl"] = "https://changed.invalid"
    model.custom_headers["X-Test"] = "2"
    assert snapshot.extra["endpoints"][0]["baseUrl"] == "https://a.invalid"
    assert snapshot.custom_headers == {"X-Test": "1"}


@pytest.mark.asyncio
async def test_admin_releases_db_before_connectivity_http(monkeypatch):
    from app.routers import admin
    from app import model_connectivity

    model = _model()

    class Db:
        closed = False

        def get(self, _model_type, _model_id):
            return model

        def close(self):
            self.closed = True

    db = Db()

    async def fake_run(snapshot):
        assert db.closed is True
        assert snapshot.id == model.id
        return [{"ok": True}]

    monkeypatch.setattr(model_connectivity, "run_connectivity_test", fake_run)
    result = await admin.test_model_connectivity(model.id, db=db, _={"role": "admin"})
    assert result == {"model_id": model.id, "results": [{"ok": True}]}
