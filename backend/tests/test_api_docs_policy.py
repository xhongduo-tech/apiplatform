from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]


def _docs_urls(environment: str, override: str | None = None) -> str:
    env = os.environ.copy()
    env["ENVIRONMENT"] = environment
    env["PYTHONPATH"] = str(BACKEND)
    if override is None:
        env.pop("API_DOCS_ENABLED", None)
    else:
        env["API_DOCS_ENABLED"] = override
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from app.main import app; print(app.docs_url, app.redoc_url, app.openapi_url)",
        ],
        cwd=BACKEND,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def test_production_disables_interactive_docs_by_default() -> None:
    assert _docs_urls("production") == "None None None"


def test_development_enables_interactive_docs_by_default() -> None:
    assert _docs_urls("development") == "/docs /redoc /openapi.json"


def test_explicit_override_is_honored() -> None:
    assert _docs_urls("production", "true") == "/docs /redoc /openapi.json"
