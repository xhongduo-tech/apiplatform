#!/usr/bin/env bash
# ============================================================================
# 离线打包（在【外网可用机】执行）
# 产出 offline-images/：全量离线包（6 镜像 tar + compose + 脚本 + 监控 + 校验清单）。
# 拷贝整个目录到目标机即可部署。发行包只含代码生成的虚构演示数据，绝不打包运行库。
# 数据库已整合回本包：postgres:16-alpine 随应用一并部署，使用独立数据卷。
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"
OUT="${ROOT}/offline-images"

RELEASE_VERSION="$(tr -d '[:space:]' < "${ROOT}/VERSION")"
GIT_COMMIT="$(git -C "${ROOT}" rev-parse --verify HEAD^{commit})"
if [[ ! "${RELEASE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "✗ VERSION 不是可用的发行版本：${RELEASE_VERSION}"; exit 1
fi
if [[ ! "${GIT_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "✗ 无法解析完整的 40 位 Git commit"; exit 1
fi
UNTRACKED_SOURCE_FILES="$(git -C "${ROOT}" ls-files --others --exclude-standard || true)"
if ! git -C "${ROOT}" diff --quiet -- || \
   ! git -C "${ROOT}" diff --cached --quiet -- || \
   [[ -n "${UNTRACKED_SOURCE_FILES}" ]]; then
  echo "✗ 工作树不干净；离线包必须能完整绑定到单一 Git commit"
  echo "  请提交、暂存到别处或清理改动后重试。"
  exit 1
fi

# 勿用 PLATFORM：与 bash 5.2+ 的 $var? 展开冲突。当前只对两个已测试的
# Linux 架构生成离线包；前端 API origin 是 nginx 镜像的构建输入。
BUILD_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"
VITE_ORIGIN="${VITE_PUBLIC_API_ORIGIN:-http://localhost}"
case "${BUILD_PLATFORM}" in
  linux/amd64|linux/arm64) ;;
  *) echo "✗ TARGET_PLATFORM 只支持 linux/amd64 或 linux/arm64：${BUILD_PLATFORM}"; exit 1 ;;
esac
if [[ ! "${VITE_ORIGIN}" =~ ^https?://[^[:space:][:cntrl:]]+$ ]]; then
  echo "✗ VITE_PUBLIC_API_ORIGIN 必须是不含空白/控制字符的 http(s) URL：${VITE_ORIGIN}"
  exit 1
fi
BUILD_VARIANT_SHA256="$(
  printf '%s\0%s\0' "${BUILD_PLATFORM}" "${VITE_ORIGIN}" \
    | shasum -a 256 | awk '{print $1}'
)"
if [[ ! "${BUILD_VARIANT_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "✗ 无法计算构建变体 SHA-256"; exit 1
fi
BUILD_VARIANT_TAG="${BUILD_VARIANT_SHA256:0:32}"

# 正式离线 tag 在镜像构建完成后使用完整本地 image ID 生成。因此即使相同
# commit/platform/origin 的网络构建产生了不同内容，也不会静默覆盖同名 tag。
BUILD_SESSION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/apiplatform-image-session.XXXXXX")"
BUILD_SESSION_ID="$(basename "${BUILD_SESSION_DIR}")-$$"
rmdir "${BUILD_SESSION_DIR}"
BACKEND_BUILD_IMAGE="apiplatform-backend:build-${GIT_COMMIT:0:12}-${BUILD_SESSION_ID}"
NGINX_BUILD_IMAGE="apiplatform-nginx:build-${GIT_COMMIT:0:12}-${BUILD_SESSION_ID}"
POSTGRES_BUILD_IMAGE="apiplatform-postgres:build-${BUILD_SESSION_ID}"
REDIS_BUILD_IMAGE="apiplatform-redis:build-${BUILD_SESSION_ID}"
PROMETHEUS_BUILD_IMAGE="apiplatform-prometheus:build-${BUILD_SESSION_ID}"
GRAFANA_BUILD_IMAGE="apiplatform-grafana:build-${BUILD_SESSION_ID}"
BUILD_IMAGE_TAGS=(
  "${BACKEND_BUILD_IMAGE}" "${NGINX_BUILD_IMAGE}" "${POSTGRES_BUILD_IMAGE}"
  "${REDIS_BUILD_IMAGE}" "${PROMETHEUS_BUILD_IMAGE}" "${GRAFANA_BUILD_IMAGE}"
)

cleanup_build_tags() {
  local build_tag
  for build_tag in "${BUILD_IMAGE_TAGS[@]}"; do
    docker image rm "${build_tag}" >/dev/null 2>&1 || true
  done
}
trap cleanup_build_tags EXIT

compose_default_image() {
  local variable=$1 values count
  values="$(awk -v variable="${variable}" '
    {
      marker = "${" variable ":-"
      start = index($0, marker)
      if (start == 0) next
      rest = substr($0, start + length(marker))
      finish = index(rest, "}")
      if (finish > 1) print substr(rest, 1, finish - 1)
    }
  ' "${ROOT}/docker-compose.app.yml" | LC_ALL=C sort -u)"
  count="$(printf '%s\n' "${values}" | grep -c . || true)"
  if [[ "${count}" -ne 1 ]]; then
    echo "✗ docker-compose.app.yml 中 ${variable} 的默认镜像不是唯一值" >&2
    return 1
  fi
  printf '%s\n' "${values}"
}

require_repo_digest() {
  local ref=$1 label=$2
  if [[ ! "${ref}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "✗ ${label} 必须固定到完整 OCI sha256 RepoDigest：${ref}" >&2
    return 1
  fi
}

# 单一事实源：离线包的四个第三方镜像必须与生产 Compose 默认 digest 完全一致。
POSTGRES_SOURCE_IMAGE="$(compose_default_image POSTGRES_IMAGE)"
REDIS_SOURCE_IMAGE="$(compose_default_image REDIS_IMAGE)"
PROMETHEUS_SOURCE_IMAGE="$(compose_default_image PROMETHEUS_IMAGE)"
GRAFANA_SOURCE_IMAGE="$(compose_default_image GRAFANA_IMAGE)"
PYTHON_WHEEL_IMAGE="python:3.11-slim@sha256:9c900dea9e8fb7e16277c179b555cc72d29a352dbc33cff48ad5a0412fd5bfc7"
for source_spec in \
  "POSTGRES_SOURCE_IMAGE=${POSTGRES_SOURCE_IMAGE}" \
  "REDIS_SOURCE_IMAGE=${REDIS_SOURCE_IMAGE}" \
  "PROMETHEUS_SOURCE_IMAGE=${PROMETHEUS_SOURCE_IMAGE}" \
  "GRAFANA_SOURCE_IMAGE=${GRAFANA_SOURCE_IMAGE}" \
  "PYTHON_WHEEL_IMAGE=${PYTHON_WHEEL_IMAGE}"; do
  require_repo_digest "${source_spec#*=}" "${source_spec%%=*}"
done

# 仅正式发布 workflow 应传入刚刚 push 后得到的两个 GHCR RepoDigest。普通调用
# 始终从当前干净 commit 构建，并标记为 UNSIGNED_USER_BUILD。
BACKEND_SOURCE_REF="${OFFLINE_BACKEND_SOURCE_REF:-}"
NGINX_SOURCE_REF="${OFFLINE_NGINX_SOURCE_REF:-}"
if [[ -n "${BACKEND_SOURCE_REF}" || -n "${NGINX_SOURCE_REF}" ]]; then
  if [[ -z "${BACKEND_SOURCE_REF}" || -z "${NGINX_SOURCE_REF}" ]]; then
    echo "✗ OFFLINE_BACKEND_SOURCE_REF 与 OFFLINE_NGINX_SOURCE_REF 必须同时设置"; exit 1
  fi
  require_repo_digest "${BACKEND_SOURCE_REF}" OFFLINE_BACKEND_SOURCE_REF
  require_repo_digest "${NGINX_SOURCE_REF}" OFFLINE_NGINX_SOURCE_REF
  PROJECT_SOURCE_KIND=oci-release
else
  PROJECT_SOURCE_KIND=source-build
  BACKEND_SOURCE_REF="git:${GIT_COMMIT}"
  NGINX_SOURCE_REF="git:${GIT_COMMIT}"
fi
PACKAGE_TRUST=UNSIGNED_USER_BUILD

content_tag_for() {
  local prefix=$1 build_image=$2 image_id
  image_id="$(docker image inspect "${build_image}" --format '{{.Id}}')"
  if [[ ! "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "✗ ${build_image} 缺少完整本地内容 image ID：${image_id}" >&2
    return 1
  fi
  printf '%s:sha256-%s\n' "${prefix}" "${image_id#sha256:}"
}

bind_content_tag() {
  local build_image=$1 content_tag=$2 build_id existing_id
  build_id="$(docker image inspect "${build_image}" --format '{{.Id}}')"
  existing_id="$(docker image inspect "${content_tag}" --format '{{.Id}}' 2>/dev/null || true)"
  if [[ -n "${existing_id}" && "${existing_id}" != "${build_id}" ]]; then
    echo "✗ 内容寻址 tag ${content_tag} 已指向 ${existing_id}，期望 ${build_id}" >&2
    return 1
  fi
  docker tag "${build_image}" "${content_tag}"
}

require_pinned_dockerfile_bases() {
  local dockerfile ref failed=0
  for dockerfile in "${ROOT}/backend/Dockerfile" "${ROOT}/nginx/Dockerfile"; do
    while read -r ref; do
      [[ -z "${ref}" || "${ref}" == scratch ]] && continue
      if [[ ! "${ref}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
        echo "✗ ${dockerfile#"${ROOT}/"} 含可变 FROM：${ref}"
        failed=1
      fi
    done < <(awk 'toupper($1) == "FROM" { print $2 }' "${dockerfile}")
  done
  [[ "${failed}" -eq 0 ]]
}

require_pinned_dockerfile_bases || exit 1

want_arch() {
  case "${BUILD_PLATFORM}" in
    linux/amd64) echo amd64 ;;
    linux/arm64) echo arm64 ;;
    *) echo "${BUILD_PLATFORM#linux/}" ;;
  esac
}

# 通过 docker build --platform 物化 hub 基础镜像（比 pull+tag 更可靠，避免 manifest 索引无 Architecture）
materialize_hub_image() {
  local hub=$1 offline=$2
  require_repo_digest "${hub}" "materialize source"
  echo "  materialize ${hub} → ${offline} (${BUILD_PLATFORM})"
  docker rmi -f "${offline}" 2>/dev/null || true
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/apiplatform-offline.XXXXXX")"
  printf 'FROM %s\n' "${hub}" > "${tmp}/Dockerfile"
  if ! docker build --platform="${BUILD_PLATFORM}" -t "${offline}" "${tmp}"; then
    rm -rf "${tmp}"
    echo "✗ 构建 ${offline} 失败（FROM ${hub}）"; exit 1
  fi
  rm -rf "${tmp}"

  local want_arch_val img_arch layer_count img_id
  want_arch_val="$(want_arch)"
  img_id="$(docker image inspect "${offline}" --format '{{.Id}}')"
  img_arch="$(docker image inspect "${offline}" --format '{{.Architecture}}')"
  layer_count="$(docker image inspect "${offline}" --format '{{len .RootFS.Layers}}')"
  if [[ -z "${img_arch}" ]]; then
    echo "✗ ${offline} 无 Architecture 字段（镜像 ID ${img_id}）"; exit 1
  fi
  if [[ "${img_arch}" != "${want_arch_val}" ]]; then
    echo "✗ ${offline} 架构为 ${img_arch}，期望 ${want_arch_val}，TARGET_PLATFORM=${BUILD_PLATFORM}"; exit 1
  fi
  if [[ -z "${layer_count}" || "${layer_count}" -lt 1 ]]; then
    echo "✗ ${offline} 层数据不完整"; exit 1
  fi
  echo "  ready ${offline} ← ${img_id} (${img_arch}, ${layer_count} layers)"
}

# 按 manifest 中的 commit/digest tag 导出；仅 save ID 时老版本引擎可能丢失 tag。
save_image_tar() {
  local role=$1 tag=$2 out=$3 source_kind=$4 source_ref=$5
  local id arch source_digest
  id="$(docker image inspect "${tag}" --format '{{.Id}}')"
  arch="$(docker image inspect "${tag}" --format '{{.Architecture}}')"
  if [[ ! "${id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "✗ ${tag} 缺少完整的本地内容寻址 image ID：${id}"; exit 1
  fi
  case "${source_kind}" in
    source-build)
      [[ "${source_ref}" == "git:${GIT_COMMIT}" ]] || {
        echo "✗ 项目源码镜像未绑定当前完整 commit"; exit 1;
      }
      source_digest="${id}"
      ;;
    oci-release|oci-upstream)
      require_repo_digest "${source_ref}" "${role} source"
      source_digest="${source_ref##*@}"
      ;;
    *)
      echo "✗ 未知镜像来源类型：${source_kind}"; exit 1
      ;;
  esac
  echo "  save ${tag} (${id}, ${arch}) → $(basename "${out}")"
  docker save "${tag}" | gzip -n > "${out}"
  gzip -t "${out}"
  [[ -s "${out}" ]] || { echo "✗ ${out} 为空"; exit 1; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${role}" "${tag}" "${id}" "${arch}" "${source_kind}" \
    "${source_ref}" "${source_digest}" "${GIT_COMMIT}" \
    >> "${OUT}/image-manifest.txt"
}

echo "▶ 清理 ${OUT}"; rm -rf "${OUT}"; mkdir -p "${OUT}"

if [[ "${PROJECT_SOURCE_KIND}" == source-build ]]; then
  echo "▶ 构建后端镜像 (${BUILD_PLATFORM})"
  docker build --platform "${BUILD_PLATFORM}" -t "${BACKEND_BUILD_IMAGE}" ./backend

  echo "▶ 构建 nginx(含前端) 镜像 (${BUILD_PLATFORM})"
  docker build --platform "${BUILD_PLATFORM}" -f nginx/Dockerfile \
    --build-arg "VITE_PUBLIC_API_ORIGIN=${VITE_ORIGIN}" \
    -t "${NGINX_BUILD_IMAGE}" .
else
  echo "▶ 物化正式发布的项目镜像 (${BUILD_PLATFORM})"
  materialize_hub_image "${BACKEND_SOURCE_REF}" "${BACKEND_BUILD_IMAGE}"
  materialize_hub_image "${NGINX_SOURCE_REF}" "${NGINX_BUILD_IMAGE}"
  for project_image in "${BACKEND_BUILD_IMAGE}" "${NGINX_BUILD_IMAGE}"; do
    image_revision="$(docker image inspect "${project_image}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    image_version="$(docker image inspect "${project_image}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
    if [[ "${image_revision}" != "${GIT_COMMIT}" || "${image_version}" != "${RELEASE_VERSION}" ]]; then
      echo "✗ ${project_image} 的 OCI revision/version 与当前发行不一致"; exit 1
    fi
  done
fi

echo "▶ 物化 PostgreSQL / Redis / Prometheus / Grafana 基础镜像 (${BUILD_PLATFORM})"
materialize_hub_image "${POSTGRES_SOURCE_IMAGE}" "${POSTGRES_BUILD_IMAGE}"
materialize_hub_image "${REDIS_SOURCE_IMAGE}" "${REDIS_BUILD_IMAGE}"
materialize_hub_image "${PROMETHEUS_SOURCE_IMAGE}" "${PROMETHEUS_BUILD_IMAGE}"
materialize_hub_image "${GRAFANA_SOURCE_IMAGE}" "${GRAFANA_BUILD_IMAGE}"

echo "▶ 按完整本地 image ID 绑定离线 tag"
BACKEND_IMAGE="$(content_tag_for apiplatform-backend "${BACKEND_BUILD_IMAGE}")"
NGINX_IMAGE="$(content_tag_for apiplatform-nginx "${NGINX_BUILD_IMAGE}")"
POSTGRES_OFFLINE="$(content_tag_for apiplatform-postgres "${POSTGRES_BUILD_IMAGE}")"
REDIS_OFFLINE="$(content_tag_for apiplatform-redis "${REDIS_BUILD_IMAGE}")"
PROMETHEUS_OFFLINE="$(content_tag_for apiplatform-prometheus "${PROMETHEUS_BUILD_IMAGE}")"
GRAFANA_OFFLINE="$(content_tag_for apiplatform-grafana "${GRAFANA_BUILD_IMAGE}")"
bind_content_tag "${BACKEND_BUILD_IMAGE}" "${BACKEND_IMAGE}"
bind_content_tag "${NGINX_BUILD_IMAGE}" "${NGINX_IMAGE}"
bind_content_tag "${POSTGRES_BUILD_IMAGE}" "${POSTGRES_OFFLINE}"
bind_content_tag "${REDIS_BUILD_IMAGE}" "${REDIS_OFFLINE}"
bind_content_tag "${PROMETHEUS_BUILD_IMAGE}" "${PROMETHEUS_OFFLINE}"
bind_content_tag "${GRAFANA_BUILD_IMAGE}" "${GRAFANA_OFFLINE}"
cleanup_build_tags

echo "▶ 导出镜像 tar.gz"
cat > "${OUT}/image-manifest.txt" <<EOF
# format=3
# git_commit=${GIT_COMMIT}
# publisher_status=${PACKAGE_TRUST}
# target_platform=${BUILD_PLATFORM}
# vite_api_origin=${VITE_ORIGIN}
# build_variant_sha256=${BUILD_VARIANT_SHA256}
# columns=role tag local_image_id architecture source_kind source_ref source_digest git_commit
EOF
save_image_tar backend    "${BACKEND_IMAGE}"      "${OUT}/apiplatform-backend.tar.gz"    "${PROJECT_SOURCE_KIND}" "${BACKEND_SOURCE_REF}"
save_image_tar nginx      "${NGINX_IMAGE}"        "${OUT}/apiplatform-nginx.tar.gz"      "${PROJECT_SOURCE_KIND}" "${NGINX_SOURCE_REF}"
save_image_tar postgres   "${POSTGRES_OFFLINE}"   "${OUT}/apiplatform-postgres.tar.gz"   oci-upstream "${POSTGRES_SOURCE_IMAGE}"
save_image_tar redis      "${REDIS_OFFLINE}"      "${OUT}/apiplatform-redis.tar.gz"      oci-upstream "${REDIS_SOURCE_IMAGE}"
save_image_tar prometheus "${PROMETHEUS_OFFLINE}" "${OUT}/apiplatform-prometheus.tar.gz" oci-upstream "${PROMETHEUS_SOURCE_IMAGE}"
save_image_tar grafana    "${GRAFANA_OFFLINE}"    "${OUT}/apiplatform-grafana.tar.gz"    oci-upstream "${GRAFANA_SOURCE_IMAGE}"

echo "▶ 下载 Python wheels（内网无 PyPI 兜底，平台 ${BUILD_PLATFORM}）"
mkdir -p "${OUT}/offline-wheels"
docker run --rm --platform "${BUILD_PLATFORM}" \
  -v "${OUT}/offline-wheels:/wheels" \
  -v "${ROOT}/backend/requirements.lock:/requirements.lock:ro" \
  "${PYTHON_WHEEL_IMAGE}" \
  pip download --require-hashes -r /requirements.lock -d /wheels >/dev/null 2>&1 || \
  echo "  (跳过 wheels：pip download 失败，镜像已自带依赖)"

echo "▶ 复制部署清单"
# 数据库已整合回本包：postgres/pg-backup 随 compose 一体化部署；
# 只复制显式白名单中的 Git tracked 普通文件。不递归复制源目录，
# 因此即使 .gitignore 隐藏了 customer.dump、.env 或日志，也不会混入离线包。
copy_tracked_release_file() {
  local source=$1 destination=${2:-$1}
  if ! git -C "${ROOT}" ls-files --error-unmatch -- "${source}" >/dev/null 2>&1; then
    echo "✗ 离线包白名单项不是 Git tracked 文件：${source}"; exit 1
  fi
  if [[ ! -f "${ROOT}/${source}" || -L "${ROOT}/${source}" ]]; then
    echo "✗ 离线包白名单项必须是非符号链接的普通文件：${source}"; exit 1
  fi
  mkdir -p "${OUT}/$(dirname "${destination}")"
  cp -p "${ROOT}/${source}" "${OUT}/${destination}"
}

release_files=(
  deploy-offline.sh
  OFFLINE.md
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
copy_tracked_release_file docker-compose.app.yml docker-compose.yml
for release_file in "${release_files[@]}"; do
  copy_tracked_release_file "${release_file}"
done

# 离线发行物不携带任何部署秘密；deploy-offline.sh 首次在目标机原子生成 .env。
cat > "${OUT}/.env.template" <<EOF
# 配置模板（无秘密）。不要直接复制为 .env；由 deploy-offline.sh 在目标机生成。
COMPOSE_PULL_POLICY=never
BACKEND_IMAGE=${BACKEND_IMAGE}
NGINX_IMAGE=${NGINX_IMAGE}
POSTGRES_IMAGE=${POSTGRES_OFFLINE}
REDIS_IMAGE=${REDIS_OFFLINE}
PROMETHEUS_IMAGE=${PROMETHEUS_OFFLINE}
GRAFANA_IMAGE=${GRAFANA_OFFLINE}
POSTGRES_PASSWORD=<generated-on-target>
REDIS_PASSWORD=<generated-on-target>
JWT_SECRET=<generated-on-target>
DATA_ENCRYPTION_KEY=<generated-on-target>
ADMIN_BOOTSTRAP_TOKEN=<generated-on-target>
DEMO_DATA_ENABLED=true
ALLOW_PUBLIC_REGISTRATION=false
ALLOW_PASSWORD_RECOVERY=false
SESSION_COOKIE_SECURE=false
# first-claim 管理员完成首次设密前只监听本机回环。
HTTP_BIND_ADDRESS=127.0.0.1
HTTP_PORT=80
POSTGRES_BIND_ADDRESS=127.0.0.1
POSTGRES_PORT=5432
REDIS_BIND_ADDRESS=127.0.0.1
REDIS_PORT=6379
PROMETHEUS_BIND_ADDRESS=127.0.0.1
PROMETHEUS_PORT=9090
GRAFANA_BIND_ADDRESS=127.0.0.1
GRAFANA_PORT=3000
TRUSTED_PROXY_CIDRS=
# VITE_PUBLIC_API_ORIGIN 仅影响构建时的前端 API 根地址，部署后不可改（已烘焙进 nginx 镜像）
EOF

SEED_INCLUDED=synthetic
echo "  演示数据：由 backend/app/demo_seed.py 在全新空库中安全生成"

# 全量文件清单（deploy 部署前对照校验）
cat > "${OUT}/package-manifest.txt" <<EOF
# Open API Platform 离线包全量清单（build-offline.sh 自动生成，勿手改）
pack_mode=full
build_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target_platform=${BUILD_PLATFORM}
vite_api_origin=${VITE_ORIGIN}
build_variant_sha256=${BUILD_VARIANT_SHA256}
git_commit=${GIT_COMMIT}
publisher_status=${PACKAGE_TRUST}
project_source_kind=${PROJECT_SOURCE_KIND}
seed_included=${SEED_INCLUDED}

# ── 镜像 tar（6）──
apiplatform-backend.tar.gz
apiplatform-nginx.tar.gz
apiplatform-postgres.tar.gz
apiplatform-redis.tar.gz
apiplatform-prometheus.tar.gz
apiplatform-grafana.tar.gz

# ── 部署元数据 ──
image-manifest.txt
package-info.txt
package-manifest.txt
checksums.sha256
.env.template
docker-compose.yml
deploy-offline.sh
OFFLINE.md

# ── 配置与脚本目录 ──
monitoring/
postgres/
scripts/db-seed.sh
scripts/export-backup.sh
scripts/restore-backup.sh
scripts/export-seed.sh
scripts/offline-env.sh
scripts/offline-package-verify.sh
scripts/compose.sh

# ── 可选 ──
offline-wheels/
EOF

# package-info.txt 尚未写入，因此加 1；checksums.sha256 是派生根校验文件，不计入。
FILE_COUNT="$(( $(find "${OUT}" -type f ! -name checksums.sha256 | wc -l | tr -d ' ') + 1 ))"
cat > "${OUT}/package-info.txt" <<EOF
pack_mode=full
build_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target_platform=${BUILD_PLATFORM}
vite_api_origin=${VITE_ORIGIN}
build_variant_sha256=${BUILD_VARIANT_SHA256}
git_commit=${GIT_COMMIT}
publisher_status=${PACKAGE_TRUST}
project_source_kind=${PROJECT_SOURCE_KIND}
backend_image=${BACKEND_IMAGE}
nginx_image=${NGINX_IMAGE}
postgres_image=${POSTGRES_OFFLINE}
redis_image=${REDIS_OFFLINE}
prometheus_image=${PROMETHEUS_OFFLINE}
grafana_image=${GRAFANA_OFFLINE}
frontend_version=$(node -p "require('./frontend/package.json').version" 2>/dev/null || echo unknown)
backend_baseline_stats=baked
seed_included=${SEED_INCLUDED}
file_count=${FILE_COUNT}
images=apiplatform-backend,apiplatform-nginx,apiplatform-postgres,apiplatform-redis,apiplatform-prometheus,apiplatform-grafana
EOF
echo "  package-info: git=${GIT_COMMIT} source=${PROJECT_SOURCE_KIND} trust=${PACKAGE_TRUST} platform=${BUILD_PLATFORM} variant=${BUILD_VARIANT_TAG} seed=${SEED_INCLUDED} files=${FILE_COUNT}"

echo "▶ 生成 checksums"
( cd "${OUT}" && find . -type f ! -name checksums.sha256 -exec shasum -a 256 {} \; > checksums.sha256 )

echo "▶ 校验全量清单"
OFFLINE_DIR="${OUT}" bash "${ROOT}/scripts/offline-package-verify.sh" build

echo "✔ 完成 → ${OUT}"
du -sh "${OUT}" 2>/dev/null || true
echo "  把整个 offline-images/ 拷贝到内网，执行 deploy-offline.sh"
