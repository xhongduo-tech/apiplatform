#!/usr/bin/env bash
# Promote already verified staging digests without treating REST visibility as absence.
set -Eeuo pipefail

if [[ "$#" -ne 8 ]]; then
  echo "usage: $0 <backend-tag> <backend-ref> <backend-staging-tag> <backend-needs-promotion> <web-tag> <web-ref> <web-staging-tag> <web-needs-promotion>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_IMAGE=$1
BACKEND_REF=$2
BACKEND_STAGING_IMAGE=$3
BACKEND_NEEDS_PROMOTION=$4
WEB_IMAGE=$5
WEB_REF=$6
WEB_STAGING_IMAGE=$7
WEB_NEEDS_PROMOTION=$8

[[ -n "${GHCR_TOKEN:-}" ]] || {
  echo "::error::GHCR_TOKEN is required for authenticated registry state" >&2
  exit 1
}

registry_ref_if_exists() {
  local image=$1 image_path repository_path tag token_json bearer
  local response headers status api_digest inspect_output inspect_digest
  image_path="${image#ghcr.io/}"
  if [[ "${image_path}" == "${image}" || "${image_path}" != *:* ]]; then
    echo "::error::canonical image is not a tagged GHCR reference: ${image}" >&2
    return 1
  fi
  repository_path="${image_path%:*}"
  tag="${image_path##*:}"
  token_json="$(curl --fail-with-body --silent --show-error \
    --user "${GITHUB_ACTOR}:${GHCR_TOKEN}" \
    --get \
    --data-urlencode service=ghcr.io \
    --data-urlencode "scope=repository:${repository_path}:pull" \
    https://ghcr.io/token)"
  bearer="$(jq -er '(.token // .access_token) | strings | select(length > 0)' \
    <<<"${token_json}")"
  response="$(curl --silent --show-error \
    --request HEAD \
    --header "Authorization: Bearer ${bearer}" \
    --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    --dump-header - \
    --output /dev/null \
    --write-out $'\n%{http_code}' \
    "https://ghcr.io/v2/${repository_path}/manifests/${tag}")"
  headers="${response%$'\n'*}"
  status="${response##*$'\n'}"
  case "${status}" in
    200)
      api_digest="$(awk '
        tolower($1) == "docker-content-digest:" {
          gsub("\\r", "", $2); digest=$2
        }
        END { print digest }
      ' <<<"${headers}")"
      if [[ ! "${api_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        echo "::error::GHCR returned 200 without a complete Docker-Content-Digest for ${image}" >&2
        return 1
      fi
      if ! inspect_output="$(docker buildx imagetools inspect "${image}" 2>&1)"; then
        echo "::error::GHCR found ${image}, but OCI inspection failed" >&2
        printf '%s\n' "${inspect_output}" >&2
        return 1
      fi
      inspect_digest="$(awk '$1 == "Digest:" { print $2; exit }' \
        <<<"${inspect_output}")"
      if [[ "${inspect_digest}" != "${api_digest}" ]]; then
        echo "::error::GHCR HEAD and OCI inspection disagree for ${image}" >&2
        return 1
      fi
      printf '%s@%s\n' "${image%:*}" "${api_digest}"
      ;;
    404)
      return 10
      ;;
    *)
      echo "::error::GHCR check for ${image} returned HTTP ${status}; absence is not proven" >&2
      return 1
      ;;
  esac
}

resolve_remote_ref() {
  local image=$1 output digest attempt
  for attempt in 1 2 3 4 5; do
    if output="$(docker buildx imagetools inspect "${image}" 2>&1)"; then
      digest="$(awk '$1 == "Digest:" { print $2; exit }' <<<"${output}")"
      if [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        printf '%s@%s\n' "${image%:*}" "${digest}"
        return 0
      fi
    fi
    sleep 2
  done
  echo "::error::registry did not resolve ${image} to a complete digest" >&2
  printf '%s\n' "${output:-no registry response}" >&2
  return 1
}

promote_or_revalidate() {
  local canonical_tag=$1 expected_ref=$2 staging_tag=$3 needs_promotion=$4
  local canonical_ref state staging_ref promote_output
  if [[ "${expected_ref%@*}" != "${canonical_tag%:*}" || \
        ! "${expected_ref#*@}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::promotion source is not an exact digest in the canonical repository" >&2
    return 1
  fi
  if canonical_ref="$(registry_ref_if_exists "${canonical_tag}")"; then
    if [[ "${canonical_ref}" != "${expected_ref}" ]]; then
      echo "::error::canonical tag appeared or moved to a different digest; refusing overwrite" >&2
      echo "::error::expected=${expected_ref} registry=${canonical_ref}" >&2
      return 1
    fi
    return 0
  fi
  state=$?
  [[ "${state}" -eq 10 ]] || return "${state}"
  if [[ "${needs_promotion}" != true ]]; then
    echo "::error::previously selected canonical tag disappeared; refusing reconstruction" >&2
    return 1
  fi

  staging_ref="$(resolve_remote_ref "${staging_tag}")"
  if [[ "${staging_ref}" != "${expected_ref}" ]]; then
    echo "::error::staging tag moved away from the push-acknowledged digest" >&2
    return 1
  fi
  # GHCR exposes no atomic create-if-absent tag operation. Workflow concurrency
  # serializes this repository's release runs only; package write access must be
  # operationally restricted to this workflow during the promotion window. The
  # checks above and below prove the selected and final digest, but cannot prove
  # that an independent writer did not briefly create this tag between them.
  if ! promote_output="$(docker buildx imagetools create \
    --prefer-index=false --tag "${canonical_tag}" "${expected_ref}" 2>&1)"; then
    printf '%s\n' "${promote_output}" >&2
    echo "::error::failed to promote verified digest to ${canonical_tag}" >&2
    return 1
  fi
  printf '%s\n' "${promote_output}"
  canonical_ref="$(resolve_remote_ref "${canonical_tag}")"
  if [[ "${canonical_ref}" != "${expected_ref}" ]]; then
    echo "::error::canonical tag does not bind the exact verified digest" >&2
    echo "::error::expected=${expected_ref} registry=${canonical_ref}" >&2
    return 1
  fi
}

GH_TOKEN="${GH_TOKEN:-${GHCR_TOKEN}}" \
  bash "${ROOT}/scripts/verify-release-tag.sh"
promote_or_revalidate \
  "${BACKEND_IMAGE}" "${BACKEND_REF}" "${BACKEND_STAGING_IMAGE}" \
  "${BACKEND_NEEDS_PROMOTION}"
promote_or_revalidate \
  "${WEB_IMAGE}" "${WEB_REF}" "${WEB_STAGING_IMAGE}" \
  "${WEB_NEEDS_PROMOTION}"
GH_TOKEN="${GH_TOKEN:-${GHCR_TOKEN}}" \
  bash "${ROOT}/scripts/verify-release-tag.sh"
