import base64

import pytest

from app.encrypted_types import (
    clear_encryption_key_cache,
    decrypt_text,
    decrypted_json_payload,
    encrypt_text,
    encrypted_json_payload,
)


@pytest.fixture(autouse=True)
def encryption_key(monkeypatch):
    key = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    monkeypatch.setenv("DATA_ENCRYPTION_KEY", key)
    clear_encryption_key_cache()
    yield
    clear_encryption_key_cache()


def test_text_round_trip_is_context_bound():
    encrypted = encrypt_text("upstream-secret", "model_registry.api_key")
    assert encrypted.startswith("enc:v1:")
    assert "upstream-secret" not in encrypted
    assert decrypt_text(encrypted, "model_registry.api_key") == "upstream-secret"
    with pytest.raises(RuntimeError):
        decrypt_text(encrypted, "platform_settings.value")


def test_runtime_rejects_plaintext_but_migration_can_explicitly_read_it():
    with pytest.raises(RuntimeError, match="加密信封"):
        decrypt_text("legacy-value", "model_registry.api_key")
    assert decrypt_text(
        "legacy-value", "model_registry.api_key", allow_plaintext=True,
    ) == "legacy-value"

    legacy_json = {"token": "legacy"}
    with pytest.raises(RuntimeError, match="加密信封"):
        decrypted_json_payload(legacy_json, "model_registry.extra")
    assert decrypted_json_payload(
        legacy_json, "model_registry.extra", allow_plaintext=True,
    ) == legacy_json


def test_json_round_trip_encrypts_entire_document():
    source = {"api_key": "secret", "nested": [1, {"token": "value"}]}
    stored = encrypted_json_payload(source, "model_registry.extra")
    assert "secret" not in str(stored)
    assert decrypted_json_payload(stored, "model_registry.extra") == source
