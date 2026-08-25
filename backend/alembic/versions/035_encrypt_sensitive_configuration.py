"""Encrypt recoverable upstream configuration and erase client-key plaintext.

Revision ID: 035_encrypt_secrets
Revises: 034_user_auth_hardening

The database column types do not change. Selected values are individually
wrapped in a versioned AES-256-GCM envelope so runtime code and future key
rotation can identify protected columns deterministically. This is field-level
protection and does not make a PostgreSQL snapshot an encrypted backup.
"""
from __future__ import annotations

import hashlib

from alembic import op
import sqlalchemy as sa

from app.encrypted_types import (
    decrypt_text,
    decrypted_json_payload,
    encrypt_text,
    encrypted_json_payload,
)
from app.model_secrets import normalize_model_base_url

revision = "035_encrypt_secrets"
down_revision = "034_user_auth_hardening"
branch_labels = None
depends_on = None

_JSON_MARKER = "__apiplatform_encrypted_v1__"


def _tables() -> tuple[sa.Table, sa.Table, sa.Table]:
    model_registry = sa.table(
        "model_registry",
        sa.column("id", sa.String()),
        sa.column("base_url", sa.String()),
        sa.column("api_key", sa.String()),
        sa.column("custom_headers", sa.JSON()),
        sa.column("extra", sa.JSON()),
    )
    platform_settings = sa.table(
        "platform_settings",
        sa.column("key", sa.String()),
        sa.column("value", sa.JSON()),
    )
    api_keys = sa.table(
        "api_keys",
        sa.column("id", sa.String()),
        sa.column("api_key", sa.String()),
        sa.column("key_hash", sa.String()),
        sa.column("key_prefix", sa.String()),
    )
    return model_registry, platform_settings, api_keys


def _is_encrypted_json(value: object) -> bool:
    return isinstance(value, dict) and set(value) == {_JSON_MARKER}


def _validate_model_urls(model_id: str, base_url: object, extra: object) -> str | None:
    plain_base_url = None
    if base_url is not None:
        raw = str(base_url)
        plain_base_url = (
            decrypt_text(raw, "model_registry.base_url")
            if raw.startswith("enc:v1:") else raw
        )
        try:
            plain_base_url = normalize_model_base_url(plain_base_url)
        except ValueError as exc:
            raise RuntimeError(
                f"model_registry[{model_id}] 包含不安全的 base_url；"
                "请移除 URL 中的 userinfo/敏感查询参数后重试迁移"
            ) from exc

    decoded_extra = (
        decrypted_json_payload(
            extra, "model_registry.extra", allow_plaintext=True,
        )
        if extra is not None else None
    )
    endpoints = decoded_extra.get("endpoints") if isinstance(decoded_extra, dict) else None
    if isinstance(endpoints, list):
        for index, endpoint in enumerate(endpoints):
            if not isinstance(endpoint, dict):
                continue
            endpoint_url = endpoint.get("base_url") or endpoint.get("baseUrl")
            try:
                normalize_model_base_url(
                    endpoint_url,
                    where=f"extra.endpoints[{index}].base_url",
                )
            except ValueError as exc:
                raise RuntimeError(
                    f"model_registry[{model_id}] 包含不安全的 endpoint URL；"
                    "请移除 URL 中的 userinfo/敏感查询参数后重试迁移"
                ) from exc
    return plain_base_url


def _migrate_client_api_keys(bind, api_keys: sa.Table) -> None:
    """Repair verifiers from surviving plaintext before erasing that plaintext.

    Preflight the final verifier set first.  If two rows would authenticate the
    same raw key, abort the transactional migration with the evidence intact.
    Incorrect existing hashes are nulled in a first phase so verifier swaps do
    not hit the unique index transiently.
    """
    rows = list(bind.execute(
        sa.select(api_keys.c.id, api_keys.c.api_key, api_keys.c.key_hash)
    ).mappings())
    planned: list[tuple[str, str | None, str]] = []
    desired_owner: dict[str, str] = {}
    for row in rows:
        row_id = str(row["id"])
        raw = None if row["api_key"] is None else str(row["api_key"])
        expected = hashlib.sha256(raw.encode("utf-8")).hexdigest() if raw is not None else None
        desired = expected or (str(row["key_hash"]) if row["key_hash"] else None)
        if desired:
            owner = desired_owner.get(desired)
            if owner is not None and owner != row_id:
                raise RuntimeError(
                    "api_keys 中存在会产生相同 verifier 的重复客户端密钥："
                    f"{owner}, {row_id} (sha256={desired[:12]}…)；"
                    "迁移已中止且未清除明文，请先吊销/轮换重复密钥"
                )
            desired_owner[desired] = row_id
        if expected is not None:
            planned.append((row_id, str(row["key_hash"]) if row["key_hash"] else None, expected))

    for row_id, current, expected in planned:
        if current is not None and current != expected:
            bind.execute(
                sa.update(api_keys).where(api_keys.c.id == row_id).values(key_hash=None)
            )
    for row_id, _current, expected in planned:
        bind.execute(
            sa.update(api_keys)
            .where(api_keys.c.id == row_id)
            .values(api_key=None, key_hash=expected)
        )


def upgrade() -> None:
    bind = op.get_bind()
    present = set(sa.inspect(bind).get_table_names())
    models, settings, api_keys = _tables()

    if "api_keys" in present:
        _migrate_client_api_keys(bind, api_keys)

    if "model_registry" in present:
        for row in bind.execute(
            sa.select(
                models.c.id, models.c.base_url, models.c.api_key,
                models.c.custom_headers, models.c.extra,
            )
        ).mappings():
            values: dict[str, object] = {}
            plain_base_url = _validate_model_urls(
                str(row["id"]), row["base_url"], row["extra"],
            )
            base_url = row["base_url"]
            if base_url is not None and not str(base_url).startswith("enc:v1:"):
                values["base_url"] = encrypt_text(
                    plain_base_url or "", "model_registry.base_url",
                )
            api_key = row["api_key"]
            if api_key and not str(api_key).startswith("enc:v1:"):
                values["api_key"] = encrypt_text(str(api_key), "model_registry.api_key")
            for column in ("custom_headers", "extra"):
                value = row[column]
                if value is not None and not _is_encrypted_json(value):
                    values[column] = encrypted_json_payload(
                        value, f"model_registry.{column}",
                    )
            if values:
                bind.execute(
                    sa.update(models).where(models.c.id == row["id"]).values(**values)
                )

    if "platform_settings" in present:
        for row in bind.execute(sa.select(settings.c.key, settings.c.value)).mappings():
            if not _is_encrypted_json(row["value"]):
                bind.execute(
                    sa.update(settings)
                    .where(settings.c.key == row["key"])
                    .values(
                        value=encrypted_json_payload(
                            row["value"], "platform_settings.value",
                        )
                    )
                )

def downgrade() -> None:
    """Restore application-readable plaintext for an intentional code rollback."""
    bind = op.get_bind()
    present = set(sa.inspect(bind).get_table_names())
    models, settings, _api_keys = _tables()

    if "model_registry" in present:
        for row in bind.execute(
            sa.select(
                models.c.id, models.c.base_url, models.c.api_key,
                models.c.custom_headers, models.c.extra,
            )
        ).mappings():
            values: dict[str, object] = {}
            base_url = row["base_url"]
            if base_url and str(base_url).startswith("enc:v1:"):
                values["base_url"] = decrypt_text(
                    str(base_url), "model_registry.base_url",
                )
            api_key = row["api_key"]
            if api_key and str(api_key).startswith("enc:v1:"):
                values["api_key"] = decrypt_text(str(api_key), "model_registry.api_key")
            for column in ("custom_headers", "extra"):
                if _is_encrypted_json(row[column]):
                    values[column] = decrypted_json_payload(
                        row[column], f"model_registry.{column}",
                    )
            if values:
                bind.execute(
                    sa.update(models).where(models.c.id == row["id"]).values(**values)
                )

    if "platform_settings" in present:
        for row in bind.execute(sa.select(settings.c.key, settings.c.value)).mappings():
            if _is_encrypted_json(row["value"]):
                bind.execute(
                    sa.update(settings)
                    .where(settings.c.key == row["key"])
                    .values(
                        value=decrypted_json_payload(
                            row["value"], "platform_settings.value",
                        )
                    )
                )

    # api_keys.api_key cannot be reconstructed from its one-way verifier.  It
    # intentionally remains NULL; clients can rotate/claim a new credential.
