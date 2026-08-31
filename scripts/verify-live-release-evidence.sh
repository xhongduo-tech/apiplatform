#!/usr/bin/env bash
# Revalidate final OCI referrers and require the immutable evidence snapshots.
set -Eeuo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: $0 <release-dir> <version> <backend-ref> <web-ref>" >&2
  exit 2
fi

RELEASE_DIR=$1
RELEASE_VERSION=$2
BACKEND_REF=$3
WEB_REF=$4

for command_name in gh cosign jq mktemp; do
  command -v "${command_name}" >/dev/null || {
    echo "missing live evidence command: ${command_name}" >&2
    exit 1
  }
done
for variable_name in GITHUB_REPOSITORY GITHUB_SHA GITHUB_REF; do
  [[ -n "${!variable_name:-}" ]] || {
    echo "missing live evidence environment: ${variable_name}" >&2
    exit 1
  }
done

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT

certificate_identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@${GITHUB_REF}"

require_snapshot_subset() {
  local snapshot=$1 live=$2 label=$3
  jq -e -n \
    --slurpfile snapshot "${snapshot}" \
    --slurpfile live "${live}" '
      def entries($values):
        [$values[] | if type == "array" then .[] else . end];
      (entries($snapshot) - entries($live) | length) == 0
    ' >/dev/null || {
      echo "immutable ${label} snapshot is no longer present in live OCI referrers" >&2
      return 1
    }
}

verify_image() {
  local role=$1 image_ref=$2 image_name digest_hex prefix sbom_path
  local provenance_path signature_path signature_verification_path attestation_path
  local live_provenance live_signatures live_signature_verification live_attestations
  image_name="${image_ref%@*}"
  digest_hex="${image_ref##*@sha256:}"
  [[ "${digest_hex}" =~ ^[0-9a-f]{64}$ && "${image_name}" != "${image_ref}" ]] || {
    echo "invalid exact release image: ${image_ref}" >&2
    return 1
  }

  prefix="${RELEASE_DIR}/open-api-platform-${role}-${RELEASE_VERSION}"
  sbom_path="${prefix}.spdx.json"
  provenance_path="${prefix}.github-provenance.json"
  signature_path="${prefix}.cosign-signatures.jsonl"
  signature_verification_path="${prefix}.cosign-signature-verification.json"
  attestation_path="${prefix}.cosign-sbom-attestations.jsonl"
  for evidence_path in \
    "${sbom_path}" \
    "${provenance_path}" \
    "${signature_path}" \
    "${signature_verification_path}" \
    "${attestation_path}"; do
    [[ -s "${evidence_path}" ]] || {
      echo "missing immutable release evidence: ${evidence_path}" >&2
      return 1
    }
  done

  live_provenance="${temporary_directory}/${role}.github-provenance.json"
  live_signatures="${temporary_directory}/${role}.cosign-signatures.jsonl"
  live_signature_verification="${temporary_directory}/${role}.cosign-signature-verification.json"
  live_attestations="${temporary_directory}/${role}.cosign-sbom-attestations.jsonl"

  gh attestation verify "oci://${image_ref}" \
    --bundle-from-oci \
    --repo "${GITHUB_REPOSITORY}" \
    --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release.yml" \
    --signer-digest "${GITHUB_SHA}" \
    --source-digest "${GITHUB_SHA}" \
    --source-ref "${GITHUB_REF}" \
    --deny-self-hosted-runners \
    --format json > "${live_provenance}"
  jq -e --arg image_name "${image_name}" --arg digest_hex "${digest_hex}" '
    length > 0 and any(.[].verificationResult.statement;
      .predicateType == "https://slsa.dev/provenance/v1" and
      any(.subject[]; .name == $image_name and .digest.sha256 == $digest_hex)
    )
  ' "${live_provenance}" >/dev/null || {
    echo "live GitHub provenance does not bind ${image_ref}" >&2
    return 1
  }

  cosign verify \
    --certificate-identity "${certificate_identity}" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "${image_ref}" > "${live_signature_verification}"
  jq -se --arg digest "sha256:${digest_hex}" '
    [.[] | if type == "array" then .[] else . end] |
    any(.[];
      ((.Critical // .critical).Image // (.Critical // .critical).image)
        ["Docker-manifest-digest"] == $digest or
      ((.Critical // .critical).Image // (.Critical // .critical).image)
        ["docker-manifest-digest"] == $digest
    )
  ' "${live_signature_verification}" >/dev/null || {
    echo "live Cosign signature does not bind ${image_ref}" >&2
    return 1
  }

  cosign download signature "${image_ref}" > "${live_signatures}"
  cosign verify-attestation --type spdxjson \
    --certificate-identity "${certificate_identity}" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "${image_ref}" > "${live_attestations}"

  jq -e -n \
    --slurpfile attestations "${live_attestations}" \
    --slurpfile sbom "${sbom_path}" \
    --arg image_name "${image_name}" \
    --arg digest_hex "${digest_hex}" '
      def entries($values):
        [$values[] | if type == "array" then .[] else . end];
      [entries($attestations)[] |
        try ((.payload // .Payload) | @base64d | fromjson) catch empty] |
      any(.[];
        .predicate == $sbom[0] and
        any(.subject[]?;
          .name == $image_name and .digest.sha256 == $digest_hex
        )
      )
    ' >/dev/null || {
      echo "live Cosign attestation does not contain the exact released ${role} SBOM" >&2
      return 1
    }

  require_snapshot_subset \
    "${signature_path}" "${live_signatures}" "${role} signature"
  require_snapshot_subset \
    "${attestation_path}" "${live_attestations}" "${role} SBOM attestation"
}

verify_image backend "${BACKEND_REF}"
verify_image web "${WEB_REF}"
echo "Live OCI provenance, signatures, and exact SBOM predicates match immutable evidence."
