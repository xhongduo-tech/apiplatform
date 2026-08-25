#!/usr/bin/env python3
"""Export the reviewed, public gateway OpenAPI document.

The running production application keeps interactive documentation disabled.
This export intentionally contains only SDK-facing compatibility endpoints.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# Release checks invoke this script from a clean source tree. Importing the
# application must not leave ignored bytecode behind and make the subsequent
# public-release hygiene check fail.
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("ENVIRONMENT", "production")

from fastapi.openapi.utils import get_openapi  # noqa: E402

from app._version import __version__  # noqa: E402
from app.main import app  # noqa: E402


OUTPUT = ROOT / "docs/openapi-gateway.json"
PUBLIC_PREFIXES = ("/v1/", "/beta/v1/")


def _component_references(value: object) -> set[str]:
    if isinstance(value, dict):
        references = {
            ref
            for key, ref in value.items()
            if key == "$ref" and isinstance(ref, str) and ref.startswith("#/components/")
        }
        for child in value.values():
            references.update(_component_references(child))
        return references
    if isinstance(value, list):
        references: set[str] = set()
        for child in value:
            references.update(_component_references(child))
        return references
    return set()


def _prune_components(schema: dict[str, object]) -> None:
    components = schema.get("components")
    if not isinstance(components, dict):
        return

    pending = _component_references(schema.get("paths", {}))
    retained: dict[str, dict[str, object]] = {}
    visited: set[str] = set()
    while pending:
        reference = pending.pop()
        if reference in visited:
            continue
        visited.add(reference)
        parts = reference.split("/", 3)
        if len(parts) != 4:
            continue
        section_name, item_name = parts[2], parts[3]
        section = components.get(section_name)
        if not isinstance(section, dict) or item_name not in section:
            continue
        item = section[item_name]
        retained.setdefault(section_name, {})[item_name] = item
        pending.update(_component_references(item))

    if retained:
        schema["components"] = retained
    else:
        schema.pop("components", None)


def render() -> str:
    schema = get_openapi(
        title="Open API Platform Gateway",
        version=__version__,
        description=(
            "Public OpenAI- and Anthropic-compatible inference gateway. "
            "Administrative and end-user portal APIs are intentionally excluded."
        ),
        # Passing the complete route collection lets current FastAPI versions
        # expand lazy included routers. Filter the resulting document below so
        # internal portal and administrative paths never enter the artifact.
        routes=app.routes,
    )
    schema["paths"] = {
        path: operation
        for path, operation in schema.get("paths", {}).items()
        if path.startswith(PUBLIC_PREFIXES)
    }
    _prune_components(schema)
    return json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail when the committed export is stale")
    args = parser.parse_args()
    expected = render()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != expected:
            print(f"{OUTPUT.relative_to(ROOT)} is stale; run scripts/export-openapi.py", file=sys.stderr)
            return 1
        print(f"{OUTPUT.relative_to(ROOT)} is current.")
        return 0
    OUTPUT.write_text(expected, encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
