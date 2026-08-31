#!/usr/bin/env bash
# Revalidate the signed annotated release tag at each irreversible boundary.
set -Eeuo pipefail

for variable_name in GITHUB_REPOSITORY GITHUB_REF_NAME GITHUB_SHA EXPECTED_TAG_OBJECT_SHA; do
  [[ -n "${!variable_name:-}" ]] || {
    echo "::error::missing release-tag environment: ${variable_name}" >&2
    exit 1
  }
done
[[ "${GITHUB_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "::error::GITHUB_SHA is not a complete commit" >&2
  exit 1
}
[[ "${EXPECTED_TAG_OBJECT_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "::error::verified tag object SHA is incomplete" >&2
  exit 1
}

repository_json="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/${GITHUB_REPOSITORY}")"
default_branch="$(jq -er '.default_branch | strings | select(length > 0)' \
  <<<"${repository_json}")"
encoded_default_branch="$(jq -rn --arg branch "${default_branch}" '$branch | @uri')"
default_ref_json="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/${GITHUB_REPOSITORY}/git/ref/heads/${encoded_default_branch}")"
jq -e \
  --arg expected_ref "refs/heads/${default_branch}" \
  --arg expected_commit "${GITHUB_SHA}" '
    .ref == $expected_ref and
    .object.type == "commit" and
    .object.sha == $expected_commit
  ' <<<"${default_ref_json}" >/dev/null || {
    echo "::error::release commit is no longer the exact default-branch HEAD" >&2
    exit 1
  }

encoded_tag="$(jq -rn --arg tag "${GITHUB_REF_NAME}" '$tag | @uri')"
ref_json="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/${GITHUB_REPOSITORY}/git/ref/tags/${encoded_tag}")"
jq -e \
  --arg expected_ref "refs/tags/${GITHUB_REF_NAME}" \
  --arg expected_tag_sha "${EXPECTED_TAG_OBJECT_SHA}" '
    .ref == $expected_ref and
    .object.type == "tag" and
    .object.sha == $expected_tag_sha
  ' <<<"${ref_json}" >/dev/null || {
    echo "::error::release tag ref moved after the initial identity gate" >&2
    exit 1
  }

tag_json="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/${GITHUB_REPOSITORY}/git/tags/${EXPECTED_TAG_OBJECT_SHA}")"
jq -e \
  --arg expected_tag "${GITHUB_REF_NAME}" \
  --arg expected_tag_sha "${EXPECTED_TAG_OBJECT_SHA}" \
  --arg expected_commit "${GITHUB_SHA}" '
    .sha == $expected_tag_sha and
    .tag == $expected_tag and
    .object.type == "commit" and
    .object.sha == $expected_commit and
    .verification.verified == true and
    .verification.reason == "valid" and
    .tagger.name == "徐鸿铎" and
    .tagger.email == "x.hongduo@hotmail.com"
  ' <<<"${tag_json}" >/dev/null || {
    echo "::error::release tag identity/signature no longer matches the initial gate" >&2
    exit 1
  }
