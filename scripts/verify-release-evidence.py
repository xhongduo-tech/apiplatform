#!/usr/bin/env python3
"""Validate offline *structure* and digest binding in release evidence.

This parser deliberately does not implement Sigstore cryptography. Trust first
comes from verifying the accompanying ``SHA256SUMS-*.sigstore.json`` with
``cosign verify-blob``; that signed checksum manifest authenticates this
evidence manifest and every file whose binding is checked below.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_REF_RE = re.compile(r"^(?P<name>ghcr\.io/[^@\s]+)@sha256:(?P<digest>[0-9a-f]{64})$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$")
TOP_LEVEL_KEYS = {
    "schema",
    "repository",
    "release_version",
    "release_commit",
    "source_ref",
    "images",
}
IMAGE_KEYS = {
    "ref",
    "sbom",
    "sbom_sha256",
    "github_provenance",
    "github_provenance_sha256",
    "cosign_signatures",
    "cosign_signatures_sha256",
    "cosign_signature_verification",
    "cosign_signature_verification_sha256",
    "cosign_sbom_attestations",
    "cosign_sbom_attestations_sha256",
}


class EvidenceError(ValueError):
    """A release-evidence invariant was not satisfied."""


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EvidenceError(f"invalid JSON file: {path.name}") from exc


def _load_json_stream(path: Path) -> list[Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise EvidenceError(f"invalid JSON evidence: {path.name}") from exc
    decoder = json.JSONDecoder()
    offset = 0
    values: list[Any] = []
    while offset < len(text):
        while offset < len(text) and text[offset].isspace():
            offset += 1
        if offset == len(text):
            break
        try:
            value, offset = decoder.raw_decode(text, offset)
        except json.JSONDecodeError as exc:
            raise EvidenceError(f"invalid JSON stream: {path.name}") from exc
        values.extend(value if isinstance(value, list) else [value])
    if not values:
        raise EvidenceError(f"empty JSON evidence: {path.name}")
    return values


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise EvidenceError(f"cannot read evidence file: {path.name}") from exc
    return digest.hexdigest()


def _safe_file(root: Path, name: Any, expected_hash: Any) -> Path:
    if not isinstance(name, str) or name != Path(name).name or name in {"", ".", ".."}:
        raise EvidenceError(f"unsafe evidence filename: {name!r}")
    if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
        raise EvidenceError(f"invalid SHA-256 for {name}")
    path = root / name
    if not path.is_file() or path.is_symlink():
        raise EvidenceError(f"missing regular evidence file: {name}")
    actual_hash = _sha256(path)
    if actual_hash != expected_hash:
        raise EvidenceError(
            f"evidence digest mismatch for {name}: expected={expected_hash} actual={actual_hash}"
        )
    return path


def _decoded_statement(entry: Any) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    encoded = entry.get("payload", entry.get("Payload"))
    if not isinstance(encoded, str) or not encoded:
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
        statement = json.loads(raw)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return statement if isinstance(statement, dict) else None


def _subject_matches(statement: Any, name: str, digest: str) -> bool:
    if not isinstance(statement, dict):
        return False
    subjects = statement.get("subject")
    if not isinstance(subjects, list):
        return False
    return any(
        isinstance(subject, dict)
        and subject.get("name") == name
        and isinstance(subject.get("digest"), dict)
        and subject["digest"].get("sha256") == digest
        for subject in subjects
    )


def _cosign_signature_claim_matches(entry: Any, digest: str) -> bool:
    statement = _decoded_statement(entry)
    if statement is None and isinstance(entry, dict):
        statement = entry
    if not isinstance(statement, dict):
        return False
    critical = statement.get("Critical", statement.get("critical"))
    if not isinstance(critical, dict):
        return False
    image = critical.get("Image", critical.get("image"))
    if not isinstance(image, dict):
        return False
    claimed = image.get("Docker-manifest-digest", image.get("docker-manifest-digest"))
    return claimed in {digest, f"sha256:{digest}"}


def verify(
    root: Path,
    manifest_path: Path,
    *,
    repository: str,
    release_commit: str,
    source_ref: str,
    release_version: str,
    backend_ref: str,
    web_ref: str,
) -> None:
    manifest = _load_json(manifest_path)
    if not isinstance(manifest, dict) or set(manifest) != TOP_LEVEL_KEYS:
        raise EvidenceError("release evidence has unknown or missing top-level fields")
    if manifest.get("schema") != 1:
        raise EvidenceError("unsupported release-evidence schema")
    if manifest.get("repository") != repository:
        raise EvidenceError("release-evidence repository mismatch")
    if manifest.get("release_commit") != release_commit or not re.fullmatch(
        r"[0-9a-f]{40}", release_commit
    ):
        raise EvidenceError("release-evidence commit mismatch")
    if manifest.get("source_ref") != source_ref:
        raise EvidenceError("release-evidence source ref mismatch")
    if manifest.get("release_version") != release_version or not VERSION_RE.fullmatch(
        release_version
    ):
        raise EvidenceError("release-evidence version mismatch")
    if source_ref != f"refs/tags/v{release_version}":
        raise EvidenceError("release ref and version are inconsistent")

    images = manifest.get("images")
    if not isinstance(images, dict) or set(images) != {"backend", "web"}:
        raise EvidenceError("release evidence must contain exactly backend and web")

    referenced_files: set[str] = set()
    expected_refs = {"backend": backend_ref, "web": web_ref}
    for role in ("backend", "web"):
        record = images[role]
        if not isinstance(record, dict) or set(record) != IMAGE_KEYS:
            raise EvidenceError(f"{role} evidence has unknown or missing fields")
        image_ref = record.get("ref")
        match = IMAGE_REF_RE.fullmatch(image_ref) if isinstance(image_ref, str) else None
        if match is None:
            raise EvidenceError(f"{role} image is not an exact GHCR sha256 reference")
        if image_ref != expected_refs[role]:
            raise EvidenceError(f"{role} evidence image does not match the selected digest")
        image_name = match.group("name")
        digest = match.group("digest")
        expected_name = f"ghcr.io/{repository.lower()}-{role}"
        if image_name != expected_name:
            raise EvidenceError(f"{role} evidence image is outside the release repository")

        file_pairs = (
            ("sbom", "sbom_sha256"),
            ("github_provenance", "github_provenance_sha256"),
            ("cosign_signatures", "cosign_signatures_sha256"),
            (
                "cosign_signature_verification",
                "cosign_signature_verification_sha256",
            ),
            ("cosign_sbom_attestations", "cosign_sbom_attestations_sha256"),
        )
        files: dict[str, Path] = {}
        for name_key, hash_key in file_pairs:
            name = record.get(name_key)
            if name in referenced_files:
                raise EvidenceError(f"evidence file is reused by multiple records: {name}")
            path = _safe_file(root, name, record.get(hash_key))
            referenced_files.add(str(name))
            files[name_key] = path

        sbom = _load_json(files["sbom"])
        if not isinstance(sbom, dict) or sbom.get("spdxVersion") != "SPDX-2.3":
            raise EvidenceError(f"{role} SBOM is not SPDX 2.3 JSON")

        provenance_entries = _load_json_stream(files["github_provenance"])
        if not any(
            isinstance(entry, dict)
            and isinstance(entry.get("attestation"), dict)
            and isinstance(entry.get("verificationResult"), dict)
            and (statement := entry["verificationResult"].get("statement")) is not None
            and isinstance(statement, dict)
            and statement.get("predicateType") == "https://slsa.dev/provenance/v1"
            and _subject_matches(statement, image_name, digest)
            for entry in provenance_entries
        ):
            raise EvidenceError(f"{role} provenance does not bind the exact image subject")

        raw_signatures = _load_json_stream(files["cosign_signatures"])
        verified_signatures = _load_json_stream(files["cosign_signature_verification"])
        if not any(_cosign_signature_claim_matches(entry, digest) for entry in raw_signatures):
            raise EvidenceError(f"{role} raw Cosign signatures do not bind the image digest")
        if not any(
            _cosign_signature_claim_matches(entry, digest) for entry in verified_signatures
        ):
            raise EvidenceError(f"{role} verified Cosign signature does not bind the digest")

        attestation_entries = _load_json_stream(files["cosign_sbom_attestations"])
        if not any(
            (statement := _decoded_statement(entry)) is not None
            and _subject_matches(statement, image_name, digest)
            and statement.get("predicate") == sbom
            for entry in attestation_entries
        ):
            raise EvidenceError(
                f"{role} Cosign attestation does not contain the exact released SBOM"
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("release_dir", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--backend-ref", required=True)
    parser.add_argument("--web-ref", required=True)
    args = parser.parse_args()
    try:
        verify(
            args.release_dir.resolve(),
            args.manifest.resolve(),
            repository=args.repository,
            release_commit=args.commit,
            source_ref=args.source_ref,
            release_version=args.version,
            backend_ref=args.backend_ref,
            web_ref=args.web_ref,
        )
    except EvidenceError as exc:
        print(f"release evidence invalid: {exc}")
        return 1
    print(
        "Release evidence structure binds both exact image digests and SPDX SBOM "
        "predicates; authenticate SHA256SUMS with Cosign before trusting it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
