"""Rotate the database envelope-encryption key during a maintenance window.

Usage (inside the backend container):

    DATA_ENCRYPTION_KEY=<current> NEW_DATA_ENCRYPTION_KEY=<new> \
      python -m app.rotate_encryption_key

The new key is read from the environment rather than an argument so it does not
appear in process listings. PostgreSQL table locks make the rewrite atomic.
"""
from __future__ import annotations

import json
import os

import sqlalchemy as sa

from app.database import engine
from app.encrypted_types import (
    clear_encryption_key_cache,
    data_encryption_key,
    decrypt_text,
    decrypted_json_payload,
    encryption_key_fingerprint,
    encrypt_text,
    encrypted_json_payload,
)

_ROTATION_LOCK_ID = 0x4150494B455952  # "APIKEYR"


def _json_text(value: object) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def rotate() -> tuple[int, int, str, str]:
    old_key = os.getenv("DATA_ENCRYPTION_KEY", "").strip()
    new_key = os.getenv("NEW_DATA_ENCRYPTION_KEY", "").strip()
    if not old_key or not new_key:
        raise RuntimeError("必须同时设置 DATA_ENCRYPTION_KEY 和 NEW_DATA_ENCRYPTION_KEY")
    if old_key == new_key:
        raise RuntimeError("新旧 DATA_ENCRYPTION_KEY 不能相同")

    # Validate both keys before opening a write transaction.
    clear_encryption_key_cache()
    current_key = data_encryption_key()
    os.environ["DATA_ENCRYPTION_KEY"] = new_key
    clear_encryption_key_cache()
    replacement_key = data_encryption_key()
    os.environ["DATA_ENCRYPTION_KEY"] = old_key
    clear_encryption_key_cache()

    model_rows: list[dict] = []
    setting_rows: list[dict] = []
    with engine.begin() as conn:
        conn.execute(sa.text("SELECT pg_advisory_xact_lock(:id)"), {"id": _ROTATION_LOCK_ID})
        conn.execute(sa.text(
            "LOCK TABLE model_registry, platform_settings IN SHARE ROW EXCLUSIVE MODE"
        ))

        for row in conn.execute(sa.text(
            "SELECT id, base_url, api_key, custom_headers, extra FROM model_registry"
        )).mappings():
            model_rows.append({
                "id": row["id"],
                "base_url": (
                    decrypt_text(str(row["base_url"]), "model_registry.base_url")
                    if row["base_url"] is not None else None
                ),
                "api_key": (
                    decrypt_text(str(row["api_key"]), "model_registry.api_key")
                    if row["api_key"] is not None else None
                ),
                "custom_headers": (
                    decrypted_json_payload(row["custom_headers"], "model_registry.custom_headers")
                    if row["custom_headers"] is not None else None
                ),
                "extra": (
                    decrypted_json_payload(row["extra"], "model_registry.extra")
                    if row["extra"] is not None else None
                ),
            })
        for row in conn.execute(sa.text(
            "SELECT key, value FROM platform_settings"
        )).mappings():
            setting_rows.append({
                "key": row["key"],
                "value": decrypted_json_payload(row["value"], "platform_settings.value"),
            })

        # All current ciphertext has authenticated successfully. Switch only
        # now, then rewrite every protected value inside the same transaction.
        os.environ["DATA_ENCRYPTION_KEY"] = new_key
        clear_encryption_key_cache()
        for row in model_rows:
            conn.execute(
                sa.text("""
                    UPDATE model_registry
                    SET base_url = :base_url,
                        api_key = :api_key,
                        custom_headers = CAST(:custom_headers AS json),
                        extra = CAST(:extra AS json)
                    WHERE id = :id
                """),
                {
                    "id": row["id"],
                    "base_url": (
                        encrypt_text(row["base_url"], "model_registry.base_url")
                        if row["base_url"] is not None else None
                    ),
                    "api_key": (
                        encrypt_text(row["api_key"], "model_registry.api_key")
                        if row["api_key"] is not None else None
                    ),
                    "custom_headers": _json_text(
                        encrypted_json_payload(
                            row["custom_headers"], "model_registry.custom_headers",
                        ) if row["custom_headers"] is not None else None
                    ),
                    "extra": _json_text(
                        encrypted_json_payload(row["extra"], "model_registry.extra")
                        if row["extra"] is not None else None
                    ),
                },
            )
        for row in setting_rows:
            conn.execute(
                sa.text("""
                    UPDATE platform_settings
                    SET value = CAST(:value AS json)
                    WHERE key = :key
                """),
                {
                    "key": row["key"],
                    "value": _json_text(
                        encrypted_json_payload(row["value"], "platform_settings.value")
                    ),
                },
            )

    return (
        len(model_rows),
        len(setting_rows),
        encryption_key_fingerprint(current_key),
        encryption_key_fingerprint(replacement_key),
    )


def main() -> None:
    models, settings, old_fingerprint, new_fingerprint = rotate()
    print(
        "encryption key rotated: "
        f"model_registry={models}, platform_settings={settings}, "
        f"old_fingerprint={old_fingerprint}, new_fingerprint={new_fingerprint}"
    )


if __name__ == "__main__":
    main()
