"""Transparent envelope encryption for credentials stored in PostgreSQL.

Only fields that must be recovered at runtime (upstream endpoints/API keys and
sensitive configuration JSON) use these types. User/API-key authenticators
remain one-way hashes and are never decryptable.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from functools import lru_cache
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import JSON, String
from sqlalchemy.types import TypeDecorator

_TEXT_PREFIX = "enc:v1:"
_JSON_MARKER = "__apiplatform_encrypted_v1__"


@lru_cache(maxsize=1)
def data_encryption_key() -> bytes:
    """Load a 256-bit key; production must provide it explicitly.

    Development derives a deterministic local-only key from JWT_SECRET so test
    databases remain usable without another fixture. Runtime validation rejects
    this fallback in production.
    """
    raw = os.getenv("DATA_ENCRYPTION_KEY", "").strip()
    if raw:
        try:
            decoded = base64.b64decode(
                raw + "=" * (-len(raw) % 4), altchars=b"-_", validate=True,
            )
        except Exception as exc:  # pragma: no cover - exact codec error varies
            raise RuntimeError("DATA_ENCRYPTION_KEY 必须是 URL-safe base64") from exc
        if len(decoded) != 32:
            raise RuntimeError("DATA_ENCRYPTION_KEY 解码后必须恰好为 32 字节")
        return decoded
    if os.getenv("ENVIRONMENT", "production").strip().lower() == "production":
        raise RuntimeError("生产环境必须设置独立的 DATA_ENCRYPTION_KEY")
    material = os.getenv("JWT_SECRET", "apiplatform-development-only")
    return hashlib.sha256(("data-encryption:" + material).encode()).digest()


def clear_encryption_key_cache() -> None:
    data_encryption_key.cache_clear()


def encryption_key_fingerprint(key: bytes | None = None) -> str:
    """Return a non-secret identifier for backup/key inventory records."""
    material = data_encryption_key() if key is None else key
    return hashlib.sha256(material).hexdigest()[:16]


def encrypt_text(value: str, context: str) -> str:
    nonce = os.urandom(12)
    ciphertext = AESGCM(data_encryption_key()).encrypt(
        nonce, value.encode("utf-8"), context.encode("utf-8"),
    )
    return _TEXT_PREFIX + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def decrypt_text(value: str, context: str, *, allow_plaintext: bool = False) -> str:
    if not value.startswith(_TEXT_PREFIX):
        if allow_plaintext:
            return value  # only Alembic's transactional legacy-data migration
        raise RuntimeError(f"数据库凭据字段 {context} 不是受支持的加密信封")
    try:
        packed = base64.urlsafe_b64decode(value[len(_TEXT_PREFIX):].encode("ascii"))
        plaintext = AESGCM(data_encryption_key()).decrypt(
            packed[:12], packed[12:], context.encode("utf-8"),
        )
        return plaintext.decode("utf-8")
    except Exception as exc:
        raise RuntimeError(f"无法解密数据库凭据字段 {context}") from exc


def encrypted_json_payload(value: Any, context: str) -> dict[str, str]:
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return {_JSON_MARKER: encrypt_text(serialized, context)}


def decrypted_json_payload(
    value: Any,
    context: str,
    *,
    allow_plaintext: bool = False,
) -> Any:
    if not isinstance(value, dict) or set(value) != {_JSON_MARKER}:
        if allow_plaintext:
            return value  # only Alembic's transactional legacy-data migration
        raise RuntimeError(f"数据库配置字段 {context} 不是受支持的加密信封")
    return json.loads(decrypt_text(str(value[_JSON_MARKER]), context))


class EncryptedString(TypeDecorator[str]):
    """Store a string as AES-256-GCM ciphertext in a normal VARCHAR column."""

    impl = String
    cache_ok = True

    def __init__(self, context: str, length: int | None = None):
        self.context = context
        super().__init__(length=length)

    def process_bind_param(self, value: str | None, dialect) -> str | None:
        if value is None:
            return None
        return encrypt_text(str(value), self.context)

    def process_result_value(self, value: str | None, dialect) -> str | None:
        if value is None:
            return None
        return decrypt_text(str(value), self.context)


class EncryptedJSON(TypeDecorator[Any]):
    """Encrypt an entire JSON document and store a versioned JSON wrapper."""

    impl = JSON
    cache_ok = True

    def __init__(self, context: str):
        self.context = context
        super().__init__()

    def process_bind_param(self, value: Any, dialect) -> Any:
        if value is None:
            return None
        return encrypted_json_payload(value, self.context)

    def process_result_value(self, value: Any, dialect) -> Any:
        if value is None:
            return None
        return decrypted_json_payload(value, self.context)
