#!/usr/bin/env bash
# Capture and validate live OCI provenance/signature/SBOM evidence for a release.
set -Eeuo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: $0 <release-dir> <version> <backend-ref> <web-ref>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR=$1
RELEASE_VERSION=$2
BACKEND_REF=$3
WEB_REF=$4

for command_name in gh cosign jq sha256sum python3; do
  command -v "${command_name}" >/dev/null || {
    echo "missing release-evidence command: ${command_name}" >&2
    exit 1
  }
done
for variable_name in GITHUB_REPOSITORY GITHUB_SHA GITHUB_REF; do
  [[ -n "${!variable_name:-}" ]] || {
    echo "missing release-evidence environment: ${variable_name}" >&2
    exit 1
  }
done
[[ "${GITHUB_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "GITHUB_SHA must be a full commit" >&2
  exit 1
}
[[ "${GITHUB_REF}" == "refs/tags/v${RELEASE_VERSION}" ]] || {
  echo "release version and GITHUB_REF differ" >&2
  exit 1
}

mkdir -p "${RELEASE_DIR}"
certificate_identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@${GITHUB_REF}"

capture_image() {
  local role=$1 image_ref=$2 sbom_path=$3 prefix
  local provenance_path signatures_path signature_verification_path attestations_path
  local image_name digest_hex
  prefix="${RELEASE_DIR}/open-api-platform-${role}-${RELEASE_VERSION}"
  provenance_path="${prefix}.github-provenance.json"
  signatures_path="${prefix}.cosign-signatures.jsonl"
  signature_verification_path="${prefix}.cosign-signature-verification.json"
  attestations_path="${prefix}.cosign-sbom-attestations.jsonl"
  image_name="${image_ref%@*}"
  digest_hex="${image_ref##*@sha256:}"
  if [[ ! "${digest_hex}" =~ ^[0-9a-f]{64}$ || \
        "${image_name}" == "${image_ref}" ]]; then
    echo "invalid exact image reference: ${image_ref}" >&2
    return 1
  fi
  [[ -s "${sbom_path}" ]] || {
    echo "missing SBOM for ${role}: ${sbom_path}" >&2
    return 1
  }

  gh attestation verify "oci://${image_ref}" \
    --bundle-from-oci \
    --repo "${GITHUB_REPOSITORY}" \
    --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release.yml" \
    --signer-digest "${GITHUB_SHA}" \
    --source-digest "${GITHUB_SHA}" \
    --source-ref "${GITHUB_REF}" \
    --deny-self-hosted-runners \
    --format json > "${provenance_path}"
  jq -e --arg image_name "${image_name}" --arg digest_hex "${digest_hex}" '
    length > 0 and any(.[].verificationResult.statement;
      .predicateType == "https://slsa.dev/provenance/v1" and
      any(.subject[]; .name == $image_name and .digest.sha256 == $digest_hex)
    )
  ' "${provenance_path}" >/dev/null || {
    echo "GitHub provenance does not bind ${image_ref}" >&2
    return 1
  }

  cosign verify \
    --certificate-identity "${certificate_identity}" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "${image_ref}" > "${signature_verification_path}"
  cosign download signature "${image_ref}" > "${signatures_path}"
  cosign verify-attestation --type spdxjson \
    --certificate-identity "${certificate_identity}" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "${image_ref}" > "${attestations_path}"

  for evidence_path in \
    "${provenance_path}" \
    "${signatures_path}" \
    "${signature_verification_path}" \
    "${attestations_path}"; do
    [[ -s "${evidence_path}" ]] || {
      echo "empty release evidence: ${evidence_path}" >&2
      return 1
    }
  done
}

backend_sbom="${RELEASE_DIR}/open-api-platform-backend-${RELEASE_VERSION}.spdx.json"
web_sbom="${RELEASE_DIR}/open-api-platform-web-${RELEASE_VERSION}.spdx.json"
capture_image backend "${BACKEND_REF}" "${backend_sbom}"
capture_image web "${WEB_REF}" "${web_sbom}"

file_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

manifest_path="${RELEASE_DIR}/image-evidence-${RELEASE_VERSION}.json"
jq -n \
  --arg repository "${GITHUB_REPOSITORY}" \
  --arg release_version "${RELEASE_VERSION}" \
  --arg release_commit "${GITHUB_SHA}" \
  --arg source_ref "${GITHUB_REF}" \
  --arg backend_ref "${BACKEND_REF}" \
  --arg backend_sbom "$(basename "${backend_sbom}")" \
  --arg backend_sbom_sha256 "$(file_sha256 "${backend_sbom}")" \
  --arg backend_github_provenance "open-api-platform-backend-${RELEASE_VERSION}.github-provenance.json" \
  --arg backend_github_provenance_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-backend-${RELEASE_VERSION}.github-provenance.json")" \
  --arg backend_cosign_signatures "open-api-platform-backend-${RELEASE_VERSION}.cosign-signatures.jsonl" \
  --arg backend_cosign_signatures_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-backend-${RELEASE_VERSION}.cosign-signatures.jsonl")" \
  --arg backend_cosign_signature_verification "open-api-platform-backend-${RELEASE_VERSION}.cosign-signature-verification.json" \
  --arg backend_cosign_signature_verification_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-backend-${RELEASE_VERSION}.cosign-signature-verification.json")" \
  --arg backend_cosign_sbom_attestations "open-api-platform-backend-${RELEASE_VERSION}.cosign-sbom-attestations.jsonl" \
  --arg backend_cosign_sbom_attestations_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-backend-${RELEASE_VERSION}.cosign-sbom-attestations.jsonl")" \
  --arg web_ref "${WEB_REF}" \
  --arg web_sbom "$(basename "${web_sbom}")" \
  --arg web_sbom_sha256 "$(file_sha256 "${web_sbom}")" \
  --arg web_github_provenance "open-api-platform-web-${RELEASE_VERSION}.github-provenance.json" \
  --arg web_github_provenance_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-web-${RELEASE_VERSION}.github-provenance.json")" \
  --arg web_cosign_signatures "open-api-platform-web-${RELEASE_VERSION}.cosign-signatures.jsonl" \
  --arg web_cosign_signatures_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-web-${RELEASE_VERSION}.cosign-signatures.jsonl")" \
  --arg web_cosign_signature_verification "open-api-platform-web-${RELEASE_VERSION}.cosign-signature-verification.json" \
  --arg web_cosign_signature_verification_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-web-${RELEASE_VERSION}.cosign-signature-verification.json")" \
  --arg web_cosign_sbom_attestations "open-api-platform-web-${RELEASE_VERSION}.cosign-sbom-attestations.jsonl" \
  --arg web_cosign_sbom_attestations_sha256 \
    "$(file_sha256 "${RELEASE_DIR}/open-api-platform-web-${RELEASE_VERSION}.cosign-sbom-attestations.jsonl")" '
    {
      schema: 1,
      repository: $repository,
      release_version: $release_version,
      release_commit: $release_commit,
      source_ref: $source_ref,
      images: {
        backend: {
          ref: $backend_ref,
          sbom: $backend_sbom,
          sbom_sha256: $backend_sbom_sha256,
          github_provenance: $backend_github_provenance,
          github_provenance_sha256: $backend_github_provenance_sha256,
          cosign_signatures: $backend_cosign_signatures,
          cosign_signatures_sha256: $backend_cosign_signatures_sha256,
          cosign_signature_verification: $backend_cosign_signature_verification,
          cosign_signature_verification_sha256: $backend_cosign_signature_verification_sha256,
          cosign_sbom_attestations: $backend_cosign_sbom_attestations,
          cosign_sbom_attestations_sha256: $backend_cosign_sbom_attestations_sha256
        },
        web: {
          ref: $web_ref,
          sbom: $web_sbom,
          sbom_sha256: $web_sbom_sha256,
          github_provenance: $web_github_provenance,
          github_provenance_sha256: $web_github_provenance_sha256,
          cosign_signatures: $web_cosign_signatures,
          cosign_signatures_sha256: $web_cosign_signatures_sha256,
          cosign_signature_verification: $web_cosign_signature_verification,
          cosign_signature_verification_sha256: $web_cosign_signature_verification_sha256,
          cosign_sbom_attestations: $web_cosign_sbom_attestations,
          cosign_sbom_attestations_sha256: $web_cosign_sbom_attestations_sha256
        }
      }
    }
  ' > "${manifest_path}"

python3 "${ROOT}/scripts/verify-release-evidence.py" \
  "${RELEASE_DIR}" "${manifest_path}" \
  --repository "${GITHUB_REPOSITORY}" \
  --commit "${GITHUB_SHA}" \
  --source-ref "${GITHUB_REF}" \
  --version "${RELEASE_VERSION}" \
  --backend-ref "${BACKEND_REF}" \
  --web-ref "${WEB_REF}"
