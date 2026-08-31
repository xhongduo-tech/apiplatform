#!/usr/bin/env python3
"""Fail when a direct production requirement drifts from the hashed lock."""
from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NAME_RE = r"[A-Za-z0-9][A-Za-z0-9._-]*"
DIRECT_RE = re.compile(
    rf"^(?P<name>{NAME_RE})(?:\[(?P<extras>[^]]+)\])?"
    r"==(?P<version>[^\s;\\]+)(?:\s*;\s*.+)?$"
)
LOCK_RE = re.compile(
    rf"^(?P<name>{NAME_RE})==(?P<version>[^\s;\\]+)(?:\s*;\s*.+)?\s*\\?$"
)


def canonical_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def parse_direct(path: Path) -> dict[str, tuple[str, str]]:
    pins: dict[str, tuple[str, str]] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = DIRECT_RE.fullmatch(line)
        if not match:
            raise ValueError(
                f"{path}:{number}: direct production dependencies must use exact == pins: {line}"
            )
        name = canonical_name(match.group("name"))
        display = match.group("name")
        if match.group("extras"):
            extras = ",".join(
                sorted(canonical_name(item.strip()) for item in match.group("extras").split(","))
            )
            if not extras or any(not item for item in extras.split(",")):
                raise ValueError(f"{path}:{number}: invalid extras list")
            display = f"{display}[{extras}]"
        if name in pins:
            raise ValueError(f"{path}:{number}: duplicate direct dependency: {name}")
        pins[name] = (match.group("version"), display)
    if not pins:
        raise ValueError(f"{path}: no direct requirements found")
    return pins


def parse_lock(path: Path) -> dict[str, set[str]]:
    pins: dict[str, set[str]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw[:1].isspace() or not raw or raw.startswith("#"):
            continue
        match = LOCK_RE.fullmatch(raw.strip())
        if match:
            pins.setdefault(canonical_name(match.group("name")), set()).add(
                match.group("version")
            )
    if not pins:
        raise ValueError(f"{path}: no locked requirements found")
    return pins


def check(direct_path: Path, lock_path: Path) -> list[str]:
    direct = parse_direct(direct_path)
    locked = parse_lock(lock_path)
    errors: list[str] = []
    for name, (expected, display) in sorted(direct.items()):
        versions = locked.get(name)
        if not versions:
            errors.append(f"{display}=={expected}: missing from {lock_path}")
        elif versions != {expected}:
            errors.append(
                f"{display}: direct pin is {expected}, lock contains {', '.join(sorted(versions))}"
            )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "direct", nargs="?", type=Path, default=ROOT / "backend/requirements.txt"
    )
    parser.add_argument(
        "lock", nargs="?", type=Path, default=ROOT / "backend/requirements.lock"
    )
    args = parser.parse_args()
    try:
        errors = check(args.direct, args.lock)
    except (OSError, ValueError) as exc:
        print(f"requirements lock validation failed: {exc}")
        return 1
    if errors:
        print("Direct production requirements and hashed lock are out of sync:")
        for error in errors:
            print(f"  - {error}")
        return 1
    count = len(parse_direct(args.direct))
    print(f"{count} direct production requirements match the hashed lock.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
