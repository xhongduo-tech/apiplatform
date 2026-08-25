from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_export_module():
    script = Path(__file__).resolve().parents[2] / "scripts" / "export-openapi.py"
    spec = importlib.util.spec_from_file_location("export_openapi", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_render_ignores_internal_routes_without_path():
    module = _load_export_module()

    assert any(not hasattr(route, "path") for route in module.app.routes)
    rendered = module.render()
    assert '"/v1/chat/completions"' in rendered
    assert '"/api/admin/' not in rendered
