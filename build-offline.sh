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

BACKEND_IMAGE=apiplatform-backend:latest
NGINX_IMAGE=apiplatform-nginx:latest
POSTGRES_IMAGE=postgres:16-alpine
REDIS_IMAGE=redis:7-alpine
PROMETHEUS_IMAGE=prom/prometheus:v2.53.0
GRAFANA_IMAGE=grafana/grafana:11.1.0
POSTGRES_OFFLINE=apiplatform-postgres:16-alpine
REDIS_OFFLINE=apiplatform-redis:7-alpine
PROMETHEUS_OFFLINE=apiplatform-prometheus:v2.53.0
GRAFANA_OFFLINE=apiplatform-grafana:11.1.0

# 勿用 PLATFORM：与 bash 5.2+ 的 $var? 展开冲突
BUILD_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"
VITE_ORIGIN="${VITE_PUBLIC_API_ORIGIN:-http://localhost}"

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

# 按「tag 名」导出（内网 docker load 后须保留 apiplatform-backend:latest 等 tag；仅 save ID 时老版本引擎可能只剩 sha256）
save_image_tar() {
  local tag=$1 out=$2
  local id arch
  id="$(docker image inspect "${tag}" --format '{{.Id}}')"
  arch="$(docker image inspect "${tag}" --format '{{.Architecture}}')"
  echo "  save ${tag} (${id}, ${arch}) → $(basename "${out}")"
  docker save "${tag}" | gzip -n > "${out}"
  gzip -t "${out}"
  [[ -s "${out}" ]] || { echo "✗ ${out} 为空"; exit 1; }
  echo "${tag} ${id} ${arch}" >> "${OUT}/image-manifest.txt"
}

echo "▶ 清理 ${OUT}"; rm -rf "${OUT}"; mkdir -p "${OUT}"

echo "▶ 构建后端镜像 (${BUILD_PLATFORM})"
docker build --platform "${BUILD_PLATFORM}" -t "${BACKEND_IMAGE}" ./backend

echo "▶ 构建 nginx(含前端) 镜像 (${BUILD_PLATFORM})"
docker build --platform "${BUILD_PLATFORM}" -f nginx/Dockerfile \
  --build-arg "VITE_PUBLIC_API_ORIGIN=${VITE_ORIGIN}" \
  -t "${NGINX_IMAGE}" .

echo "▶ 物化 PostgreSQL / Redis / Prometheus / Grafana 基础镜像 (${BUILD_PLATFORM})"
materialize_hub_image "${POSTGRES_IMAGE}" "${POSTGRES_OFFLINE}"
materialize_hub_image "${REDIS_IMAGE}" "${REDIS_OFFLINE}"
materialize_hub_image "${PROMETHEUS_IMAGE}" "${PROMETHEUS_OFFLINE}"
materialize_hub_image "${GRAFANA_IMAGE}" "${GRAFANA_OFFLINE}"

echo "▶ 导出镜像 tar.gz"
: > "${OUT}/image-manifest.txt"
save_image_tar "${BACKEND_IMAGE}"       "${OUT}/apiplatform-backend.tar.gz"
save_image_tar "${NGINX_IMAGE}"         "${OUT}/apiplatform-nginx.tar.gz"
save_image_tar "${POSTGRES_OFFLINE}"    "${OUT}/apiplatform-postgres.tar.gz"
save_image_tar "${REDIS_OFFLINE}"       "${OUT}/apiplatform-redis.tar.gz"
save_image_tar "${PROMETHEUS_OFFLINE}"  "${OUT}/apiplatform-prometheus.tar.gz"
save_image_tar "${GRAFANA_OFFLINE}"     "${OUT}/apiplatform-grafana.tar.gz"

echo "▶ 下载 Python wheels（内网无 PyPI 兜底，平台 ${BUILD_PLATFORM}）"
mkdir -p "${OUT}/offline-wheels"
docker run --rm --platform "${BUILD_PLATFORM}" \
  -v "${OUT}/offline-wheels:/wheels" \
  -v "${ROOT}/backend/requirements.txt:/req.txt:ro" \
  python:3.11-slim \
  pip download -r /req.txt -d /wheels >/dev/null 2>&1 || \
  echo "  (跳过 wheels：pip download 失败，镜像已自带依赖)"

echo "▶ 复制部署清单"
# 数据库已整合回本包：postgres/pg-backup 随 compose 一体化部署；
# 复制为 docker-compose.yml 以便 docker compose 默认发现，无需每次手写 -f
cp docker-compose.app.yml "${OUT}/docker-compose.yml"
cp deploy-offline.sh OFFLINE.md "${OUT}/"
cp -r monitoring "${OUT}/monitoring"   # Prometheus/Grafana 配置（compose 以相对路径挂载）
cp -r postgres "${OUT}/postgres"       # postgres 配置与 pg-backup 的 backup-loop.sh
mkdir -p "${OUT}/scripts"
cp scripts/db-seed.sh scripts/export-backup.sh scripts/restore-backup.sh scripts/export-seed.sh scripts/offline-env.sh scripts/offline-package-verify.sh scripts/compose.sh "${OUT}/scripts/"

# 离线发行物不携带任何部署秘密；deploy-offline.sh 首次在目标机原子生成 .env。
cat > "${OUT}/.env.template" <<EOF
# 配置模板（无秘密）。不要直接复制为 .env；由 deploy-offline.sh 在目标机生成。
COMPOSE_PULL_POLICY=never
BACKEND_IMAGE=apiplatform-backend:latest
NGINX_IMAGE=apiplatform-nginx:latest
POSTGRES_IMAGE=apiplatform-postgres:16-alpine
REDIS_IMAGE=apiplatform-redis:7-alpine
PROMETHEUS_IMAGE=apiplatform-prometheus:v2.53.0
GRAFANA_IMAGE=apiplatform-grafana:11.1.0
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

GIT_COMMIT="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
SEED_INCLUDED=synthetic
echo "  演示数据：由 backend/app/demo_seed.py 在全新空库中安全生成"

# 全量文件清单（deploy 部署前对照校验）
cat > "${OUT}/package-manifest.txt" <<EOF
# Open API Platform 离线包全量清单（build-offline.sh 自动生成，勿手改）
pack_mode=full
build_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target_platform=${BUILD_PLATFORM}
git_commit=${GIT_COMMIT}
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
scripts/offline-env.sh
scripts/offline-package-verify.sh

# ── 可选 ──
offline-wheels/
EOF

FILE_COUNT="$(find "${OUT}" -type f ! -name checksums.sha256 | wc -l | tr -d ' ')"
cat > "${OUT}/package-info.txt" <<EOF
pack_mode=full
build_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target_platform=${BUILD_PLATFORM}
vite_api_origin=${VITE_ORIGIN}
git_commit=${GIT_COMMIT}
frontend_version=$(node -p "require('./frontend/package.json').version" 2>/dev/null || echo unknown)
backend_baseline_stats=baked
seed_included=${SEED_INCLUDED}
file_count=${FILE_COUNT}
images=apiplatform-backend,apiplatform-nginx,apiplatform-postgres,apiplatform-redis,apiplatform-prometheus,apiplatform-grafana
EOF
echo "  package-info: git=${GIT_COMMIT} platform=${BUILD_PLATFORM} seed=${SEED_INCLUDED} files=${FILE_COUNT}"

echo "▶ 生成 checksums"
( cd "${OUT}" && find . -type f ! -name checksums.sha256 -exec shasum -a 256 {} \; > checksums.sha256 )

echo "▶ 校验全量清单"
OFFLINE_DIR="${OUT}" bash "${ROOT}/scripts/offline-package-verify.sh" build

echo "✔ 完成 → ${OUT}"
du -sh "${OUT}" 2>/dev/null || true
echo "  把整个 offline-images/ 拷贝到内网，执行 deploy-offline.sh"
