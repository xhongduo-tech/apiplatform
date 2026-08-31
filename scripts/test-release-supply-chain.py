#!/usr/bin/env python3
"""Static and mutation tests for the Community release trust boundaries."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/release.yml"
PROMOTION = ROOT / "scripts/promote-release-images.sh"
TAG_GATE = ROOT / "scripts/verify-release-tag.sh"
CAPTURE = ROOT / "scripts/capture-release-evidence.sh"
LIVE_EVIDENCE = ROOT / "scripts/verify-live-release-evidence.sh"
PAYLOAD_ASSETS = (
    "image-digests-${RELEASE_VERSION}.txt",
    "image-evidence-${RELEASE_VERSION}.json",
    "open-api-platform-${RELEASE_VERSION}.tar.gz",
    "open-api-platform-backend-${RELEASE_VERSION}.cosign-sbom-attestations.jsonl",
    "open-api-platform-backend-${RELEASE_VERSION}.cosign-signature-verification.json",
    "open-api-platform-backend-${RELEASE_VERSION}.cosign-signatures.jsonl",
    "open-api-platform-backend-${RELEASE_VERSION}.github-provenance.json",
    "open-api-platform-backend-${RELEASE_VERSION}.spdx.json",
    "open-api-platform-web-${RELEASE_VERSION}.cosign-sbom-attestations.jsonl",
    "open-api-platform-web-${RELEASE_VERSION}.cosign-signature-verification.json",
    "open-api-platform-web-${RELEASE_VERSION}.cosign-signatures.jsonl",
    "open-api-platform-web-${RELEASE_VERSION}.github-provenance.json",
    "open-api-platform-web-${RELEASE_VERSION}.spdx.json",
)
RELEASE_ASSETS = (
    "SHA256SUMS-${RELEASE_VERSION}.sigstore.json",
    "SHA256SUMS-${RELEASE_VERSION}.txt",
    *PAYLOAD_ASSETS,
)


def registry_state(http_status: int, digest: str | None) -> str:
    """Model the authenticated OCI HEAD decision: only 404 proves absence."""
    if http_status == 404:
        return "missing"
    if http_status != 200:
        raise ValueError("registry failure is not absence")
    if digest is None or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("registry success requires a complete digest")
    return digest


def promotion_decision(
    canonical: str | None, expected: str, needs_promotion: bool
) -> str:
    """Model fail-closed rerun behavior at the canonical tag boundary."""
    if canonical is not None:
        if canonical != expected:
            raise ValueError("canonical tag cannot be overwritten")
        return "reuse"
    if not needs_promotion:
        raise ValueError("a selected existing canonical tag cannot disappear")
    return "promote"


def staged_push_is_bound(repository: str, push_digest: str, staging_ref: str) -> bool:
    return bool(
        re.fullmatch(r"sha256:[0-9a-f]{64}", push_digest)
        and staging_ref == f"{repository}@{push_digest}"
    )


def draft_resume_action(asset_count: int, candidate_valid: bool) -> str:
    """Only an empty draft can accept new assets; complete drafts are reused."""
    if asset_count < 0:
        raise ValueError("asset count cannot be negative")
    if asset_count == 0:
        return "upload"
    if not candidate_valid:
        raise ValueError("non-empty unverified draft must be rebuilt manually")
    return "reuse"


def exact_asset_whitelist(actual: list[str], expected: tuple[str, ...]) -> bool:
    """Reject missing, duplicated, or extra files, even when names look safe."""
    return len(actual) == len(expected) and sorted(actual) == sorted(expected)


def shell_array(text: str, variable: str) -> tuple[str, ...] | None:
    match = re.search(
        rf"^\s*{re.escape(variable)}=\(\n(?P<body>.*?)^\s*\)$",
        text,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        return None
    return tuple(re.findall(r'^\s*"([^"]+)"\s*$', match.group("body"), re.MULTILINE))


def validate_release(files: dict[str, str]) -> list[str]:
    errors: list[str] = []
    workflow = files["workflow"]
    promotion = files["promotion"]
    tag_gate = files["tag_gate"]
    capture = files["capture"]
    live = files["live"]

    workflow_required = (
        'if [[ "$default_head" != "$GITHUB_SHA" ]]; then',
        "Publish images to unique commit/run/attempt-bound staging tags",
        'staging_suffix="staging-${version}-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
        "docker push did not report exactly one complete staging digest",
        'if [[ "$staging_ref" != "${staging_image%:*}@${push_digest}" ]]; then',
        "Select immutable canonical candidates through the OCI registry",
        "Docker-Content-Digest",
        "HTTP ${status}; absence is not proven",
        "steps.candidates.outputs.backend_ref",
        "steps.candidates.outputs.web_ref",
        "syft-version: v1.42.3",
        ".creationInfo.created = $created",
        ".documentNamespace = $namespace",
        "attest_exact_sbom_if_missing",
        "Capture exact pre-promotion OCI evidence",
        "Promote or revalidate exact canonical image tags",
        "Re-capture post-promotion OCI evidence",
        "Require anonymous access to linked Community packages",
        "artifact-ids: ${{ needs.signed-images.outputs.artifact_id }}",
        "Bind the downloaded artifact to this workflow attempt",
        "publish-release:",
        "Install checksum-pinned Cosign without a third-party action",
        "cosign-release: v3.0.6",
        "Sign the checksum manifest for offline verification",
        'cosign sign-blob --yes --bundle "$bundle" "$checksum"',
        'cosign verify-blob "${root}/${checksum_name}"',
        '--certificate-github-workflow-sha "$GITHUB_SHA"',
        'checksum_bundle="SHA256SUMS-${RELEASE_VERSION}.sigstore.json"',
        "scripts/verify-release-evidence.py",
        "scripts/verify-live-release-evidence.sh",
        "verify_live_oci_evidence",
        "verify_release_tag_identity",
        "verify_canonical_image_tags",
        '--json assets,author,body,isDraft,isImmutable,name,tagName',
        '.author.login == $author',
        'release_body="Verified automated Community release ${GITHUB_REF_NAME} for source commit ${GITHUB_SHA}."',
        '--notes "$release_body"',
        'candidate_dir="$(mktemp -d "${RUNNER_TEMP%/}/release-candidate.XXXXXX")"',
        'gh release download "$GITHUB_REF_NAME" \\',
        '--dir "$candidate_dir" "${download_arguments[@]}"',
        'verify_release_bundle "$candidate_dir" || return 1',
        'verify_live_oci_evidence "$candidate_dir"',
        'if [[ "$asset_count" -gt 0 ]]; then',
        'if [[ "$asset_count" -eq 0 ]]; then',
        'gh release upload "$GITHUB_REF_NAME" "${assets[@]}"',
        "delete it manually and rerun",
        "release payload contains a missing, extra, symbolic, or non-file entry before checksumming",
        "signed release bundle is not the exact 15-asset whitelist",
        'download_arguments+=(--pattern "$asset_name")',
        'gzip -t "${root}/open-api-platform-${RELEASE_VERSION}.tar.gz"',
        'gzip -dc -- "${root}/open-api-platform-${RELEASE_VERSION}.tar.gz"',
        "git archive --format=tar",
        "release source archive does not byte-match the clean checkout",
        "bash scripts/verify-release-tag.sh || return 1",
        '--certificate-github-workflow-sha "$GITHUB_SHA" || return 1',
    )
    for value in workflow_required:
        if value not in workflow:
            errors.append(f"release workflow missing {value}")

    forbidden_workflow = (
        "git merge-base --is-ancestor",
        "steps.existing.outputs",
        "versions?per_page=100",
        "grep -Fq '(HTTP 404)'",
        "Publish missing images to commit-bound staging tags",
        "Promote verified digests to missing immutable version tags",
        "--clobber",
        "--generate-notes",
        "release_assets_match",
        "assets=(release/*)",
    )
    for value in forbidden_workflow:
        if value in workflow:
            errors.append(f"release workflow retains unsafe legacy logic: {value}")
    if workflow.count("image: ${{ steps.candidates.outputs.backend_ref }}") != 1:
        errors.append("backend SBOM must be generated from the selected exact digest")
    if workflow.count("image: ${{ steps.candidates.outputs.web_ref }}") != 1:
        errors.append("web SBOM must be generated from the selected exact digest")

    signed_start = workflow.find("  signed-images:")
    publish_start = workflow.find("  publish-release:")
    if not (0 <= signed_start < publish_start):
        errors.append("release jobs are missing or ordered incorrectly")
    else:
        signed_job = workflow[signed_start:publish_start]
        publish_job = workflow[publish_start:]
        if "contents: write" in signed_job:
            errors.append("image/evidence job must not have contents:write")
        if "contents: write" not in publish_job:
            errors.append("only the final Release job should receive contents:write")
        allowed_publish_actions = {
            "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
            "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
        }
        used = set(re.findall(r"^\s*uses:\s*([^\s#]+)", publish_job, re.MULTILINE))
        if used - allowed_publish_actions:
            errors.append("contents:write job invokes a non-GitHub third-party action")

    ordered_names = (
        "Publish images to unique commit/run/attempt-bound staging tags",
        "Select immutable canonical candidates through the OCI registry",
        "Generate backend SBOM",
        "Capture exact pre-promotion OCI evidence",
        "Promote or revalidate exact canonical image tags",
        "Re-capture post-promotion OCI evidence",
        "Require anonymous access to linked Community packages",
        "Sign the checksum manifest for offline verification",
        "Upload verifiable release bundle",
        "publish-release:",
    )
    positions = [workflow.find(name) for name in ordered_names]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        errors.append("staging, evidence, promotion, visibility, and Release order drifted")

    if workflow.count("bash scripts/capture-release-evidence.sh") != 2:
        errors.append("OCI evidence must be captured before and after canonical promotion")
    if workflow.count("verify_live_oci_evidence") < 5:
        errors.append("live OCI evidence must be checked around every Release boundary")
    if workflow.count('--certificate-github-workflow-sha "$GITHUB_SHA"') != 2:
        errors.append("checksum signing and resumed verification must bind workflow SHA")

    for variable, expected in (
        ("payload_assets", PAYLOAD_ASSETS),
        ("release_assets", RELEASE_ASSETS),
        ("expected_asset_name_list", RELEASE_ASSETS),
    ):
        actual = shell_array(workflow, variable)
        if actual != expected:
            errors.append(f"{variable} must be the exact hard-coded release whitelist")

    promotion_required = (
        "Docker-Content-Digest",
        "    404)",
        "return 10",
        "absence is not proven",
        "docker buildx imagetools inspect",
        "--prefer-index=false",
        "canonical tag appeared or moved to a different digest; refusing overwrite",
        "previously selected canonical tag disappeared",
        'bash "${ROOT}/scripts/verify-release-tag.sh"',
    )
    for value in promotion_required:
        if value not in promotion:
            errors.append(f"promotion gate missing {value}")
    if promotion.count('bash "${ROOT}/scripts/verify-release-tag.sh"') != 2:
        errors.append("release tag/default HEAD must be checked before and after promotion")
    if "versions?per_page=100" in promotion or "(HTTP 404)" in promotion:
        errors.append("promotion must not infer canonical absence from Packages REST")

    tag_required = (
        ".default_branch",
        "/git/ref/heads/${encoded_default_branch}",
        ".object.sha == $expected_commit",
        "/git/ref/tags/${encoded_tag}",
        ".verification.verified == true",
        '.tagger.email == "x.hongduo@hotmail.com"',
    )
    for value in tag_required:
        if value not in tag_gate:
            errors.append(f"release identity gate missing {value}")

    for label, text in (("capture", capture), ("live", live)):
        for value in (
            "--bundle-from-oci",
            '--signer-digest "${GITHUB_SHA}"',
            '--source-digest "${GITHUB_SHA}"',
            '--source-ref "${GITHUB_REF}"',
            "--deny-self-hosted-runners",
            "cosign verify-attestation --type spdxjson",
        ):
            if value not in text:
                errors.append(f"{label} evidence gate missing {value}")
    for value in (
        "cosign download signature",
        "verify-release-evidence.py",
        "cosign_sbom_attestations_sha256",
    ):
        if value not in capture:
            errors.append(f"immutable evidence capture missing {value}")
    for value in (
        "require_snapshot_subset() {",
        ".predicate == $sbom[0]",
        "immutable ${label} snapshot is no longer present",
    ):
        if value not in live:
            errors.append(f"final live OCI verification missing {value}")
    return errors


def main() -> int:
    files = {
        "workflow": WORKFLOW.read_text(encoding="utf-8"),
        "promotion": PROMOTION.read_text(encoding="utf-8"),
        "tag_gate": TAG_GATE.read_text(encoding="utf-8"),
        "capture": CAPTURE.read_text(encoding="utf-8"),
        "live": LIVE_EVIDENCE.read_text(encoding="utf-8"),
    }
    errors = validate_release(files)
    if errors:
        print("Release workflow supply-chain regression:")
        for error in errors:
            print(f"  - {error}")
        return 1

    mutations = {
        "ancestor release commit": (
            "workflow",
            files["workflow"].replace(
                'if [[ "$default_head" != "$GITHUB_SHA" ]]; then',
                'if git merge-base --is-ancestor "$GITHUB_SHA" HEAD; then',
            ),
        ),
        "403 treated as registry absence": (
            "promotion",
            files["promotion"].replace("    404)", "    403)"),
        ),
        "canonical digest header omitted": (
            "promotion",
            files["promotion"].replace("Docker-Content-Digest", "ETag"),
        ),
        "SBOM generated from staging ref": (
            "workflow",
            files["workflow"].replace(
                "image: ${{ steps.candidates.outputs.backend_ref }}",
                "image: ${{ steps.images.outputs.backend_ref }}",
                1,
            ),
        ),
        "post-promotion evidence omitted": (
            "workflow",
            files["workflow"].replace(
                "Re-capture post-promotion OCI evidence", "No final evidence"
            ),
        ),
        "promotion post-tag gate omitted": (
            "promotion",
            files["promotion"].rsplit(
                'GH_TOKEN="${GH_TOKEN:-${GHCR_TOKEN}}" \\\n+  bash "${ROOT}/scripts/verify-release-tag.sh"',
                1,
            )[0],
        ),
        "provenance signer commit omitted": (
            "capture",
            files["capture"].replace('--signer-digest "${GITHUB_SHA}"', ""),
        ),
        "live snapshot binding omitted": (
            "live",
            files["live"].replace(
                "require_snapshot_subset()", "ignored_snapshot_subset()"
            ),
        ),
        "checksum manifest signature omitted": (
            "workflow",
            files["workflow"].replace(
                'cosign sign-blob --yes --bundle "$bundle" "$checksum"',
                "true # omitted checksum-manifest signature",
            ),
        ),
        "checksum signature verification omitted": (
            "workflow",
            files["workflow"].replace(
                'cosign verify-blob "${root}/${checksum_name}"',
                "true # omitted checksum-manifest authentication",
            ),
        ),
        "checksum workflow commit binding omitted": (
            "workflow",
            files["workflow"].replace(
                '--certificate-github-workflow-sha "$GITHUB_SHA"', ""
            ),
        ),
        "existing candidate download omitted": (
            "workflow",
            files["workflow"].replace(
                'gh release download "$GITHUB_REF_NAME" \\',
                "true # omitted existing Release download",
            ),
        ),
        "existing candidate authentication omitted": (
            "workflow",
            files["workflow"].replace(
                'verify_release_bundle "$candidate_dir" || return 1',
                "true # omitted downloaded Release authentication",
            ),
        ),
        "release author binding omitted": (
            "workflow",
            files["workflow"].replace(".author.login == $author", "true"),
        ),
        "release upload overwrite enabled": (
            "workflow",
            files["workflow"].replace(
                'gh release upload "$GITHUB_REF_NAME" "${assets[@]}"',
                'gh release upload "$GITHUB_REF_NAME" "${assets[@]}" --clobber',
            ),
        ),
        "generated release notes enabled": (
            "workflow",
            files["workflow"].replace(
                '--notes "$release_body"', "--generate-notes"
            ),
        ),
        "pre-sign exact whitelist omitted": (
            "workflow",
            files["workflow"].replace(
                "release payload contains a missing, extra, symbolic, or non-file entry before checksumming",
                "release payload accepted without exact whitelist",
            ),
        ),
        "source archive checkout comparison omitted": (
            "workflow",
            files["workflow"].replace(
                "release source archive does not byte-match the clean checkout",
                "release source archive was not reconstructed",
            ),
        ),
    }
    mutations["promotion post-tag gate omitted"] = (
        "promotion",
        files["promotion"].replace(
            'bash "${ROOT}/scripts/verify-release-tag.sh"',
            "true # omitted release identity gate",
            1,
        ),
    )
    for label, (name, mutated) in mutations.items():
        candidate = dict(files)
        candidate[name] = mutated
        if not validate_release(candidate):
            print(f"Mutation fixture was not rejected: {label}")
            return 1

    digest = "sha256:" + "a" * 64
    if registry_state(404, None) != "missing":
        return 1
    if registry_state(200, digest) != digest:
        return 1
    negative_registry_states = (
        (200, None),
        (200, "sha256:short"),
        (401, None),
        (403, None),
        (500, None),
    )
    for status, candidate_digest in negative_registry_states:
        try:
            registry_state(status, candidate_digest)
        except ValueError:
            pass
        else:
            print(
                "Registry-state negative fixture was accepted: "
                f"{status}/{candidate_digest}"
            )
            return 1

    if promotion_decision(digest, digest, False) != "reuse":
        return 1
    if promotion_decision(None, digest, True) != "promote":
        return 1
    for canonical, expected, needs in (
        ("sha256:" + "b" * 64, digest, False),
        (None, digest, False),
    ):
        try:
            promotion_decision(canonical, expected, needs)
        except ValueError:
            pass
        else:
            print("Promotion overwrite/disappearance fixture was accepted")
            return 1

    if not staged_push_is_bound(
        "ghcr.io/example/app", digest, f"ghcr.io/example/app@{digest}"
    ):
        return 1
    if staged_push_is_bound(
        "ghcr.io/example/app",
        digest,
        "ghcr.io/example/app@sha256:" + "b" * 64,
    ):
        print("Mismatched staging digest fixture was accepted")
        return 1

    if draft_resume_action(0, False) != "upload":
        return 1
    if draft_resume_action(2, True) != "reuse":
        return 1
    for count, candidate_valid in ((-1, True), (1, False), (9, False)):
        try:
            draft_resume_action(count, candidate_valid)
        except ValueError:
            pass
        else:
            print("Unsafe draft-resume fixture was accepted")
            return 1

    expected_assets = list(RELEASE_ASSETS)
    if not exact_asset_whitelist(expected_assets, RELEASE_ASSETS):
        return 1
    for unsafe_assets in (
        expected_assets + ["debug.txt"],
        expected_assets[:-1],
        expected_assets + [expected_assets[-1]],
    ):
        if exact_asset_whitelist(unsafe_assets, RELEASE_ASSETS):
            print("Missing, duplicate, or extra Release asset fixture was accepted")
            return 1

    evidence_test = subprocess.run(
        ["python3", str(ROOT / "scripts/test-release-evidence.py")],
        check=False,
    )
    if evidence_test.returncode != 0:
        return evidence_test.returncode
    print("Release staging, promotion, evidence, and boundary mutation tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
