"""Security boundaries for model upstream URLs and custom HTTP headers.

Model endpoints are administrator supplied and are used for real outbound
requests.  Keeping validation and masking in one small module makes the ORM,
admin API and data migration agree on what is safe to store or disclose.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qsl, urlsplit


MASKED_SECRET = "******"

_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_MAX_CUSTOM_HEADERS = 64
_MAX_HEADER_NAME_BYTES = 128
_MAX_HEADER_VALUE_BYTES = 8192
_MAX_CUSTOM_HEADER_BYTES = 32 * 1024
# These fields control HTTP framing, routing, connection reuse, or the
# platform's own trace identity. Allowing a custom map to override them can
# turn a configuration error into request smuggling or credential misrouting.
_RESERVED_CUSTOM_HEADER_NAMES = frozenset({
    "connection",
    "content-length",
    "content-type",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-platform-request-id",
    "x-platform-trace-id",
    "x-request-id",
})

_SENSITIVE_QUERY_NAMES = frozenset({
    "api_key", "apikey", "x_api_key", "key", "token", "access_token",
    "auth_token", "authorization", "auth", "password", "passwd", "pwd",
    "secret", "client_secret", "signature", "sig", "credential",
    "credentials", "session", "session_id",
})
_SENSITIVE_QUERY_PARTS = frozenset({
    "token", "secret", "password", "passwd", "pwd", "credential",
    "credentials", "authorization", "signature",
})
_SENSITIVE_HEADER_NAMES = frozenset({
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token",
    "x-session-token",
})
_SENSITIVE_HEADER_PARTS = frozenset({
    "authorization", "cookie", "token", "secret", "password", "passwd",
    "credential", "credentials",
})


def _name_parts(value: str) -> tuple[str, ...]:
    return tuple(part for part in re.split(r"[^a-z0-9]+", value.casefold()) if part)


def is_sensitive_query_name(name: str) -> bool:
    lowered = name.strip().casefold()
    if lowered in _SENSITIVE_QUERY_NAMES:
        return True
    parts = _name_parts(lowered)
    if any(part in _SENSITIVE_QUERY_PARTS for part in parts):
        return True
    # api-key / subscription-key / signing-key and similar credential carriers.
    return bool(parts and parts[-1] == "key")


def normalize_model_base_url(value: str | None, *, where: str = "base_url") -> str | None:
    """Return a stripped, safe HTTP(S) base URL or raise ``ValueError``.

    Private network hosts remain valid because self-hosted deployments commonly
    point at internal inference nodes.  Credentials must instead live in the
    encrypted API-key/custom-header fields, never URL userinfo or query values.
    """
    if value is None or not str(value).strip():
        return None
    raw = str(value).strip()
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw):
        raise ValueError(f"{where} 不能包含控制字符")
    try:
        parsed = urlsplit(raw)
        # Accessing port also validates malformed/non-numeric port values.
        _ = parsed.port
    except ValueError as exc:
        raise ValueError(f"{where} 不是有效 URL") from exc
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{where} 仅支持带主机名的 http/https URL")
    if "\\" in parsed.netloc:
        raise ValueError(f"{where} 主机部分不能包含反斜杠")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{where} 禁止在 URL 中携带用户名或密码")
    sensitive = sorted({
        name for name, _value in parse_qsl(parsed.query, keep_blank_values=True)
        if is_sensitive_query_name(name)
    })
    if sensitive:
        raise ValueError(
            f"{where} 禁止在查询参数中携带凭据：{', '.join(sensitive)}"
        )
    return raw


def safe_model_base_url_for_output(value: str | None) -> str | None:
    """Fail closed for legacy rows that predate URL validation."""
    try:
        return normalize_model_base_url(value)
    except ValueError:
        return None


def is_sensitive_header_name(name: object) -> bool:
    lowered = str(name).strip().casefold().replace("_", "-")
    if lowered in _SENSITIVE_HEADER_NAMES:
        return True
    parts = _name_parts(lowered)
    if any(part in _SENSITIVE_HEADER_PARTS for part in parts):
        return True
    return bool(parts and parts[-1] == "key")


def mask_sensitive_headers(headers: Mapping[object, Any] | None) -> dict[str, Any] | None:
    if not isinstance(headers, Mapping):
        return None
    return {
        str(name): (
            MASKED_SECRET
            if is_sensitive_header_name(name) and value is not None
            else value
        )
        for name, value in headers.items()
    }


def normalize_custom_headers(
    headers: Mapping[object, Any] | None,
    *,
    where: str = "custom_headers",
) -> dict[str, str] | None:
    """Validate and normalize administrator-supplied upstream headers.

    HTTPX serializes these values into shared outbound connections. Reject
    framing/routing fields, control characters, non-ASCII values, and unbounded
    maps before they reach that boundary. Authentication headers remain
    supported; they are encrypted at rest and masked on every read.
    """
    if headers is None:
        return None
    if not isinstance(headers, Mapping):
        raise ValueError(f"{where} 必须是 JSON 对象")
    if len(headers) > _MAX_CUSTOM_HEADERS:
        raise ValueError(f"{where} 最多允许 {_MAX_CUSTOM_HEADERS} 个请求头")

    normalized: dict[str, str] = {}
    total_bytes = 0
    seen: set[str] = set()
    for raw_name, raw_value in headers.items():
        if not isinstance(raw_name, str):
            raise ValueError(f"{where} 的请求头名称必须是字符串")
        name = raw_name.strip()
        name_bytes = name.encode("ascii") if name.isascii() else b""
        if (
            not name
            or not name_bytes
            or len(name_bytes) > _MAX_HEADER_NAME_BYTES
            or not _HEADER_NAME_RE.fullmatch(name)
        ):
            raise ValueError(f"{where} 包含非法请求头名称：{raw_name!r}")
        lowered = name.casefold()
        if lowered in _RESERVED_CUSTOM_HEADER_NAMES:
            raise ValueError(f"{where} 不允许覆盖受保护请求头：{name}")
        if lowered in seen:
            raise ValueError(f"{where} 包含大小写重复的请求头：{name}")
        seen.add(lowered)

        if not isinstance(raw_value, str):
            raise ValueError(f"{where}.{name} 的值必须是字符串")
        if not raw_value.isascii() or any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_value):
            raise ValueError(f"{where}.{name} 只能包含不带控制字符的 ASCII 文本")
        value_bytes = raw_value.encode("ascii")
        if len(value_bytes) > _MAX_HEADER_VALUE_BYTES:
            raise ValueError(
                f"{where}.{name} 不能超过 {_MAX_HEADER_VALUE_BYTES} 字节"
            )
        total_bytes += len(name_bytes) + len(value_bytes)
        if total_bytes > _MAX_CUSTOM_HEADER_BYTES:
            raise ValueError(f"{where} 总大小不能超过 {_MAX_CUSTOM_HEADER_BYTES} 字节")
        normalized[name] = raw_value
    return normalized or None


def merge_masked_sensitive_headers(
    incoming: Mapping[object, Any],
    existing: Mapping[object, Any] | None,
    *,
    where: str = "custom_headers",
) -> dict[str, Any]:
    """Replace a header map while treating returned masks as "keep old".

    Missing keys retain normal replacement semantics (they are removed).  Only
    an explicit mask for a sensitive header is resolved from the previous map;
    if no previous value exists, the placeholder is discarded rather than ever
    being sent upstream as a credential.
    """
    old_by_name = {
        str(name).strip().casefold().replace("_", "-"): value
        for name, value in (existing.items() if isinstance(existing, Mapping) else ())
    }
    merged: dict[str, Any] = {}
    for raw_name, value in incoming.items():
        name = str(raw_name)
        normalized = name.strip().casefold().replace("_", "-")
        if is_sensitive_header_name(name) and value == MASKED_SECRET:
            if normalized in old_by_name:
                merged[name] = old_by_name[normalized]
            continue
        merged[name] = value
    return normalize_custom_headers(merged, where=where) or {}
