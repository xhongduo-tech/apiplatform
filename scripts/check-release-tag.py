#!/usr/bin/env python3
"""Reject release tags that do not match the repository's single version source."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-release-tag.py v<semver>", file=sys.stderr)
        return 2

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    tag = sys.argv[1].strip()
    if not SEMVER.fullmatch(version):
        print(f"VERSION is not valid SemVer: {version!r}", file=sys.stderr)
        return 1
    if tag != f"v{version}":
        print(f"release tag {tag!r} must equal 'v{version}'", file=sys.stderr)
        return 1

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if not re.search(rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$", changelog, re.MULTILINE):
        print(f"CHANGELOG.md has no dated [{version}] release section", file=sys.stderr)
        return 1

    print(f"release tag, VERSION, code markers and changelog agree on {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
