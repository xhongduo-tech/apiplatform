"""Shared validation for JSON proxy request bodies."""

from __future__ import annotations

import json
import math
from typing import Any

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool


def _reject_nonstandard_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant: {value}")


def _validate_json_values(body: Any) -> None:
    """Reject decoded values that cannot be safely encoded as interoperable JSON."""
    pending = [body]
    while pending:
        value = pending.pop()
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("JSON numbers must be finite")
        elif isinstance(value, str):
            if any("\ud800" <= character <= "\udfff" for character in value):
                raise ValueError("JSON strings must not contain lone surrogates")
        elif isinstance(value, dict):
            pending.extend(value.keys())
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)


def _require_json_object(body: Any) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="JSON 请求体顶层必须是对象。")
    return body


def parse_json_object(raw: bytes | str) -> dict:
    """Parse raw JSON off the event loop while preserving the proxy contract."""
    try:
        body = json.loads(raw, parse_constant=_reject_nonstandard_constant)
        _validate_json_values(body)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON。") from exc
    return _require_json_object(body)


async def read_json_object(request: Request) -> dict:
    """Read a valid JSON object or return a stable client error.

    Proxy handlers access object members immediately, so accepting arrays, scalars,
    malformed input, or excessively nested JSON only turns a client error into a
    server error.  Keep this boundary consistent across every public proxy route.
    """
    raw = await request.body()
    return await run_in_threadpool(parse_json_object, raw)
