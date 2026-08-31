#!/usr/bin/env bash
# Fast fixture tests for the offline package verifier; no Docker daemon needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/apiplatform-offline-test.XXXXXX")"
trap 'rm -rf "${FIXTURE}"' EXIT

commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
target_platform=linux/amd64
vite_api_origin=http://localhost
if command -v sha256sum >/dev/null 2>&1; then
  build_variant_sha256="$(printf '%s\0%s\0' "${target_platform}" "${vite_api_origin}" | sha256sum | awk '{print $1}')"
else
  build_variant_sha256="$(printf '%s\0%s\0' "${target_platform}" "${vite_api_origin}" | shasum -a 256 | awk '{print $1}')"
fi
image_a="sha256:$(printf '1%.0s' {1..64})"
image_b="sha256:$(printf '2%.0s' {1..64})"
image_c="sha256:$(printf '3%.0s' {1..64})"
image_d="sha256:$(printf '4%.0s' {1..64})"
image_e="sha256:$(printf '5%.0s' {1..64})"
image_f="sha256:$(printf '6%.0s' {1..64})"
backend_tag="apiplatform-backend:sha256-${image_a#sha256:}"
nginx_tag="apiplatform-nginx:sha256-${image_b#sha256:}"

compose_default() {
  local variable=$1
  awk -v variable="${variable}" '
    {
      marker = "${" variable ":-"
      start = index($0, marker)
      if (start == 0) next
      rest = substr($0, start + length(marker))
      finish = index(rest, "}")
      if (finish > 1) print substr(rest, 1, finish - 1)
    }
  ' "${ROOT}/docker-compose.app.yml" | LC_ALL=C sort -u
}

postgres_ref="$(compose_default POSTGRES_IMAGE)"
redis_ref="$(compose_default REDIS_IMAGE)"
prometheus_ref="$(compose_default PROMETHEUS_IMAGE)"
grafana_ref="$(compose_default GRAFANA_IMAGE)"
postgres_tag="apiplatform-postgres:sha256-${image_c#sha256:}"
redis_tag="apiplatform-redis:sha256-${image_d#sha256:}"
prometheus_tag="apiplatform-prometheus:sha256-${image_e#sha256:}"
grafana_tag="apiplatform-grafana:sha256-${image_f#sha256:}"

cp "${ROOT}/docker-compose.app.yml" "${FIXTURE}/docker-compose.yml"
cp "${ROOT}/deploy-offline.sh" "${ROOT}/OFFLINE.md" "${FIXTURE}/"
release_files=(
  monitoring/alerts.yml
  monitoring/prometheus.yml
  monitoring/grafana/dashboards/apiplatform-dashboard.json
  monitoring/grafana/provisioning/alerting/empty.yml
  monitoring/grafana/provisioning/dashboards/provider.yml
  monitoring/grafana/provisioning/datasources/prometheus.yml
  monitoring/grafana/provisioning/plugins/empty.yml
  postgres/backup-healthcheck.sh
  postgres/backup-loop.sh
  postgres/config/pg_hba.conf
  postgres/config/postgresql.conf
  scripts/db-seed.sh
  scripts/export-backup.sh
  scripts/restore-backup.sh
  scripts/export-seed.sh
  scripts/offline-env.sh
  scripts/offline-package-verify.sh
  scripts/compose.sh
)
for release_file in "${release_files[@]}"; do
  mkdir -p "${FIXTURE}/$(dirname "${release_file}")"
  cp "${ROOT}/${release_file}" "${FIXTURE}/${release_file}"
done
for archive in backend nginx postgres redis prometheus grafana; do
  printf 'fake image archive: %s\n' "${archive}" \
    > "${FIXTURE}/apiplatform-${archive}.tar.gz"
done

cat > "${FIXTURE}/.env.template" <<EOF
BACKEND_IMAGE=${backend_tag}
NGINX_IMAGE=${nginx_tag}
POSTGRES_IMAGE=${postgres_tag}
REDIS_IMAGE=${redis_tag}
PROMETHEUS_IMAGE=${prometheus_tag}
GRAFANA_IMAGE=${grafana_tag}
EOF

cat > "${FIXTURE}/package-info.txt" <<EOF
target_platform=${target_platform}
vite_api_origin=${vite_api_origin}
build_variant_sha256=${build_variant_sha256}
git_commit=${commit}
publisher_status=UNSIGNED_USER_BUILD
project_source_kind=source-build
backend_image=${backend_tag}
nginx_image=${nginx_tag}
postgres_image=${postgres_tag}
redis_image=${redis_tag}
prometheus_image=${prometheus_tag}
grafana_image=${grafana_tag}
EOF
cat > "${FIXTURE}/package-manifest.txt" <<EOF
target_platform=${target_platform}
vite_api_origin=${vite_api_origin}
build_variant_sha256=${build_variant_sha256}
git_commit=${commit}
publisher_status=UNSIGNED_USER_BUILD
project_source_kind=source-build
EOF

cat > "${FIXTURE}/image-manifest.txt" <<EOF
# format=3
# git_commit=${commit}
# publisher_status=UNSIGNED_USER_BUILD
# target_platform=${target_platform}
# vite_api_origin=${vite_api_origin}
# build_variant_sha256=${build_variant_sha256}
# columns=role tag local_image_id architecture source_kind source_ref source_digest git_commit
backend	${backend_tag}	${image_a}	amd64	source-build	git:${commit}	${image_a}	${commit}
nginx	${nginx_tag}	${image_b}	amd64	source-build	git:${commit}	${image_b}	${commit}
postgres	${postgres_tag}	${image_c}	amd64	oci-upstream	${postgres_ref}	${postgres_ref##*@}	${commit}
redis	${redis_tag}	${image_d}	amd64	oci-upstream	${redis_ref}	${redis_ref##*@}	${commit}
prometheus	${prometheus_tag}	${image_e}	amd64	oci-upstream	${prometheus_ref}	${prometheus_ref##*@}	${commit}
grafana	${grafana_tag}	${image_f}	amd64	oci-upstream	${grafana_ref}	${grafana_ref##*@}	${commit}
EOF

refresh_checksums() {
  (
    cd "${FIXTURE}"
    find . -type f ! -name checksums.sha256 ! -name .env \
      -exec shasum -a 256 {} \; > checksums.sha256
  )
}

expect_failure() {
  local label=$1
  if OFFLINE_DIR="${FIXTURE}" bash "${ROOT}/scripts/offline-package-verify.sh" deploy \
      >/dev/null 2>&1; then
    echo "✗ verifier accepted invalid fixture: ${label}" >&2
    exit 1
  fi
}

expect_forbidden_file() {
  local relative_path=$1 contents=${2:-forbidden}
  mkdir -p "$(dirname "${FIXTURE}/${relative_path}")"
  printf '%s\n' "${contents}" > "${FIXTURE}/${relative_path}"
  refresh_checksums
  expect_failure "forbidden ${relative_path}"
  rm -f "${FIXTURE}/${relative_path}"
  refresh_checksums
}

refresh_checksums
OFFLINE_DIR="${FIXTURE}" bash "${ROOT}/scripts/offline-package-verify.sh" deploy >/dev/null

# Even a fully re-hashed package may not relabel a different build input as the
# original variant.
cp "${FIXTURE}/package-info.txt" "${FIXTURE}/package-info.good"
sed 's#^vite_api_origin=.*#vite_api_origin=https://api.example.invalid#' \
  "${FIXTURE}/package-info.good" > "${FIXTURE}/package-info.txt"
refresh_checksums
expect_failure "build input fingerprint drift"
mv "${FIXTURE}/package-info.good" "${FIXTURE}/package-info.txt"
refresh_checksums

# A mutually consistent relabel across every manifest still cannot detach the
# local tag from the complete image content ID.
bad_backend_tag="apiplatform-backend:sha256-$(printf '9%.0s' {1..64})"
for manifest_file in .env.template package-info.txt image-manifest.txt; do
  sed "s#${backend_tag}#${bad_backend_tag}#g" \
    "${FIXTURE}/${manifest_file}" > "${FIXTURE}/${manifest_file}.mutated"
  mv "${FIXTURE}/${manifest_file}.mutated" "${FIXTURE}/${manifest_file}"
done
refresh_checksums
expect_failure "content-addressed image tag drift"
for manifest_file in .env.template package-info.txt image-manifest.txt; do
  sed "s#${bad_backend_tag}#${backend_tag}#g" \
    "${FIXTURE}/${manifest_file}" > "${FIXTURE}/${manifest_file}.restored"
  mv "${FIXTURE}/${manifest_file}.restored" "${FIXTURE}/${manifest_file}"
done
refresh_checksums

cp "${FIXTURE}/image-manifest.txt" "${FIXTURE}/image-manifest.good"
sed "s#${postgres_ref}#postgres:16-alpine@sha256:$(printf '9%.0s' {1..64})#g" \
  "${FIXTURE}/image-manifest.good" > "${FIXTURE}/image-manifest.txt"
rm "${FIXTURE}/image-manifest.good"
refresh_checksums
expect_failure "upstream digest drift"

# Restore the semantic baseline, then prove unlisted additions fail coverage.
sed "s#postgres:16-alpine@sha256:$(printf '9%.0s' {1..64})#${postgres_ref}#g" \
  "${FIXTURE}/image-manifest.txt" > "${FIXTURE}/image-manifest.restored"
mv "${FIXTURE}/image-manifest.restored" "${FIXTURE}/image-manifest.txt"
refresh_checksums
printf 'not listed\n' > "${FIXTURE}/unexpected.txt"
expect_failure "file absent from checksums"
rm "${FIXTURE}/unexpected.txt"

# Semantic rejects must still fail after an attacker recomputes checksums.
expect_forbidden_file "postgres/customer.dump"
expect_forbidden_file "postgres/customer.sql"
expect_forbidden_file "monitoring/archive.backup"
expect_forbidden_file "monitoring/nested/.env" "SECRET=leaked"
rmdir "${FIXTURE}/monitoring/nested"
refresh_checksums
expect_forbidden_file "postgres/server.key" "not-even-a-real-key"
expect_forbidden_file "monitoring/generated.log"
expect_forbidden_file "monitoring/key.txt" \
  "$(printf '%s%s' '-----BEGIN PRIVATE ' 'KEY-----')"
expect_forbidden_file "monitoring/extra.yml"
expect_forbidden_file "README-extra.txt"

mkdir "${FIXTURE}/unexpected-empty-directory"
refresh_checksums
expect_failure "unexpected empty directory"
rmdir "${FIXTURE}/unexpected-empty-directory"
refresh_checksums

ln -s package-info.txt "${FIXTURE}/package-info-link.txt"
refresh_checksums
expect_failure "symbolic link"
rm "${FIXTURE}/package-info-link.txt"
refresh_checksums

mkfifo "${FIXTURE}/unexpected.pipe"
refresh_checksums
expect_failure "FIFO"
rm "${FIXTURE}/unexpected.pipe"
refresh_checksums

cp "${FIXTURE}/.env.template" "${FIXTURE}/.env"
OFFLINE_DIR="${FIXTURE}" bash "${ROOT}/scripts/offline-package-verify.sh" deploy >/dev/null
sed "s#^BACKEND_IMAGE=.*#BACKEND_IMAGE=apiplatform-backend:latest#" \
  "${FIXTURE}/.env.template" > "${FIXTURE}/.env"
expect_failure "runtime image override"

echo "✔ offline package verifier fixture tests passed"
