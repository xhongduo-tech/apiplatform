#!/usr/bin/env python3
"""Negative fixtures for the immutable release-evidence verifier."""

from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts" / "verify-release-evidence.py"
COMMIT = "a" * 40
DIGESTS = {"backend": "b" * 64, "web": "c" * 64}
VERSION = "1.2.3"
REPOSITORY = "example/open-api-platform"
SOURCE_REF = f"refs/tags/v{VERSION}"


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _envelope(statement: dict[str, Any]) -> dict[str, str]:
    return {
        "payload": base64.b64encode(_compact(statement).encode()).decode(),
        "signature": "fixture",
    }


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.write_text(_compact(value) + "\n", encoding="utf-8")


def make_fixture(root: Path) -> tuple[Path, dict[str, Any]]:
    images: dict[str, Any] = {}
    for role, digest in DIGESTS.items():
        image_name = f"ghcr.io/example/open-api-platform-{role}"
        image_ref = f"{image_name}@sha256:{digest}"
        sbom = {
            "spdxVersion": "SPDX-2.3",
            "dataLicense": "CC0-1.0",
            "SPDXID": "SPDXRef-DOCUMENT",
            "name": image_name,
            "documentNamespace": f"https://example.invalid/sbom/{role}/{digest}",
            "creationInfo": {
                "created": "2026-01-01T00:00:00Z",
                "creators": ["Tool: fixture"],
            },
            "packages": [],
            "relationships": [],
        }
        subject = [{"name": image_name, "digest": {"sha256": digest}}]
        provenance_statement = {
            "_type": "https://in-toto.io/Statement/v1",
            "subject": subject,
            "predicateType": "https://slsa.dev/provenance/v1",
            "predicate": {"buildDefinition": {}},
        }
        signature_claim = {
            "Critical": {
                "Identity": {"docker-reference": image_name},
                "Image": {"Docker-manifest-digest": digest},
                "Type": "cosign container image signature",
            },
            "Optional": None,
        }
        sbom_statement = {
            "_type": "https://in-toto.io/Statement/v0.1",
            "subject": subject,
            "predicateType": "https://spdx.dev/Document",
            "predicate": sbom,
        }

        names = {
            "sbom": f"{role}.spdx.json",
            "github_provenance": f"{role}.github-provenance.json",
            "cosign_signatures": f"{role}.cosign-signatures.jsonl",
            "cosign_signature_verification": f"{role}.cosign-verified.json",
            "cosign_sbom_attestations": f"{role}.cosign-sbom.jsonl",
        }
        _write_json(root / names["sbom"], sbom)
        _write_json(
            root / names["github_provenance"],
            [
                {
                    "attestation": {"mediaType": "fixture"},
                    "verificationResult": {"statement": provenance_statement},
                }
            ],
        )
        _write_json(root / names["cosign_signatures"], _envelope(signature_claim))
        _write_json(root / names["cosign_signature_verification"], signature_claim)
        _write_json(root / names["cosign_sbom_attestations"], _envelope(sbom_statement))

        record: dict[str, Any] = {"ref": image_ref}
        for name_key, filename in names.items():
            record[name_key] = filename
            record[f"{name_key}_sha256"] = _sha256(root / filename)
        images[role] = record

    manifest = {
        "schema": 1,
        "repository": REPOSITORY,
        "release_version": VERSION,
        "release_commit": COMMIT,
        "source_ref": SOURCE_REF,
        "images": images,
    }
    manifest_path = root / f"image-evidence-{VERSION}.json"
    _write_json(manifest_path, manifest)
    return manifest_path, manifest


def run_verifier(root: Path, manifest_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "python3",
            str(VERIFIER),
            str(root),
            str(manifest_path),
            "--repository",
            REPOSITORY,
            "--commit",
            COMMIT,
            "--source-ref",
            SOURCE_REF,
            "--version",
            VERSION,
            "--backend-ref",
            f"ghcr.io/example/open-api-platform-backend@sha256:{DIGESTS['backend']}",
            "--web-ref",
            f"ghcr.io/example/open-api-platform-web@sha256:{DIGESTS['web']}",
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def mutate_and_require_failure(
    label: str,
    mutation: Callable[[Path, dict[str, Any]], None],
) -> None:
    with tempfile.TemporaryDirectory(prefix="release-evidence-negative-") as directory:
        root = Path(directory)
        manifest_path, manifest = make_fixture(root)
        mutation(root, manifest)
        _write_json(manifest_path, manifest)
        result = run_verifier(root, manifest_path)
        if result.returncode == 0:
            raise AssertionError(f"release-evidence verifier accepted: {label}")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="release-evidence-valid-") as directory:
        root = Path(directory)
        manifest_path, _ = make_fixture(root)
        result = run_verifier(root, manifest_path)
        if result.returncode != 0:
            print(result.stdout, end="")
            print(result.stderr, end="")
            return 1

    def mutate_sbom(root: Path, manifest: dict[str, Any]) -> None:
        record = manifest["images"]["backend"]
        path = root / record["sbom"]
        sbom = json.loads(path.read_text(encoding="utf-8"))
        sbom["name"] = "tampered"
        _write_json(path, sbom)
        record["sbom_sha256"] = _sha256(path)

    def mutate_provenance(root: Path, manifest: dict[str, Any]) -> None:
        record = manifest["images"]["backend"]
        path = root / record["github_provenance"]
        evidence = json.loads(path.read_text(encoding="utf-8"))
        evidence[0]["verificationResult"]["statement"]["subject"][0]["digest"][
            "sha256"
        ] = "d" * 64
        _write_json(path, evidence)
        record["github_provenance_sha256"] = _sha256(path)

    def mutate_signature(root: Path, manifest: dict[str, Any]) -> None:
        record = manifest["images"]["backend"]
        path = root / record["cosign_signature_verification"]
        claim = json.loads(path.read_text(encoding="utf-8"))
        claim["Critical"]["Image"]["Docker-manifest-digest"] = "e" * 64
        _write_json(path, claim)
        record["cosign_signature_verification_sha256"] = _sha256(path)

    def mutate_path(_root: Path, manifest: dict[str, Any]) -> None:
        manifest["images"]["backend"]["sbom"] = "../backend.spdx.json"

    def mutate_unknown(_root: Path, manifest: dict[str, Any]) -> None:
        manifest["unexpected"] = True

    def mutate_selected_ref(_root: Path, manifest: dict[str, Any]) -> None:
        manifest["images"]["backend"]["ref"] = (
            "ghcr.io/example/open-api-platform-backend@sha256:" + "d" * 64
        )

    fixtures = {
        "SBOM differs from attested predicate": mutate_sbom,
        "provenance subject differs": mutate_provenance,
        "verified signature digest differs": mutate_signature,
        "evidence path traversal": mutate_path,
        "unknown manifest field": mutate_unknown,
        "evidence differs from selected image": mutate_selected_ref,
    }
    for label, mutation in fixtures.items():
        mutate_and_require_failure(label, mutation)

    print("Release evidence positive and negative fixtures passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
