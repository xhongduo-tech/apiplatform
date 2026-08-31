"""跨源访问只开放给无 Cookie 的公开模型中继端点。"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import GatewayCORSMiddleware


def _cors_test_app() -> FastAPI:
    app = FastAPI()

    @app.get("/v1/models")
    def models():
        return {"data": []}

    @app.post("/api/admin/login")
    def admin_login():
        return {"ok": True}

    app.add_middleware(
        GatewayCORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    return app


def test_gateway_preflight_allows_cross_origin_bearer_client() -> None:
    with TestClient(_cors_test_app()) as client:
        response = client.options(
            "/v1/models",
            headers={
                "Origin": "https://client.example",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def test_admin_first_claim_does_not_opt_into_cross_origin_requests() -> None:
    with TestClient(_cors_test_app()) as client:
        preflight = client.options(
            "/api/admin/login",
            headers={
                "Origin": "https://attacker.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        response = client.post(
            "/api/admin/login",
            headers={"Origin": "https://attacker.example"},
        )

    assert preflight.status_code == 405
    assert "access-control-allow-origin" not in preflight.headers
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
