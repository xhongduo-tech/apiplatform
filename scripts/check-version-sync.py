#!/usr/bin/env python3
"""Verify every published version marker matches the root VERSION file."""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _python_version(path: Path) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__version__":
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        return node.value.value
    raise ValueError(f"{path}: missing literal __version__ assignment")


def main() -> int:
    expected = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    package = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((ROOT / "frontend/package-lock.json").read_text(encoding="utf-8"))
    versions = {
        "frontend/package.json": package["version"],
        "frontend/package-lock.json": package_lock["version"],
        "frontend/package-lock.json packages['']": package_lock["packages"][""]["version"],
        "backend/app/_version.py": _python_version(ROOT / "backend/app/_version.py"),
    }
    compose = (ROOT / "docker-compose.app.yml").read_text(encoding="utf-8")
    for variable, image in (
        ("BACKEND_IMAGE", "apiplatform-backend"),
        ("NGINX_IMAGE", "apiplatform-nginx"),
    ):
        values = set(re.findall(rf"\$\{{{variable}:-([^}}]+)\}}", compose))
        if len(values) != 1:
            versions[f"docker-compose.app.yml {variable}"] = repr(sorted(values))
        else:
            value = values.pop()
            prefix = f"{image}:"
            versions[f"docker-compose.app.yml {variable}"] = (
                value.removeprefix(prefix) if value.startswith(prefix) else value
            )
    mismatches = {name: value for name, value in versions.items() if value != expected}
    if mismatches:
        print(f"Version mismatch; VERSION is {expected!r}:")
        for name, value in mismatches.items():
            print(f"  - {name}: {value!r}")
        return 1
    print(f"Version markers are synchronized at {expected}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
