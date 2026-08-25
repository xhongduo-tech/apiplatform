#!/usr/bin/env bash
# ============================================================================
# 离线部署（在【内网目标机】执行，目录内含 build-offline.sh 产出的 tar 等）
#
# 单机一体化部署：postgres（内置 PostgreSQL 16，Compose 项目隔离数据卷）、
# pg-backup 备份边车、backend/nginx/redis/监控 全部由本 compose 拉起，
# 无需独立数据库项目。全新空库会由后端生成完全虚构、不可调用的演示数据，
# 发行包不包含任何数据库 dump。
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ROOT="$HERE"
# shellcheck source=scripts/offline-env.sh
source "${ROOT}/scripts/offline-env.sh"
offline_ensure_runtime_env "${ROOT}"
offline_init_compose

if ! offline_validate_compose_services; then
  exit 1
fi

command -v docker >/dev/null || { echo "✗ 未找到 docker"; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ docker 守护进程未运行"; exit 1; }

env_mode="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || true)"
case "${env_mode}" in
  600|400) ;;
  *)
    echo "✗ .env 权限必须为 600（当前 ${env_mode:-未知}）；请执行 chmod 600 .env" >&2
    exit 1
    ;;
esac

echo "▶ 部署一体化服务（compose: $(basename "${COMPOSE_FILE}")，COMPOSE_PULL_POLICY=${COMPOSE_PULL_POLICY}）"
offline_print_compose_hint
if [[ -f package-info.txt ]]; then
  echo "  离线包版本：$(grep -E '^pack_mode=|^build_date=|^git_commit=|^target_platform=|^seed_included=' package-info.txt | tr '\n' ' ')"
fi

echo "▶ 校验离线包全量清单"
if [[ -f scripts/offline-package-verify.sh ]]; then
  OFFLINE_DIR="$HERE" bash scripts/offline-package-verify.sh deploy
else
  echo "  (无 offline-package-verify.sh，跳过全量清单校验)"
  [[ -f checksums.sha256 ]] && shasum -a 256 -c checksums.sha256 || echo "  (无 checksums，跳过)"
fi

if [[ "${SKIP_IMAGE_LOAD:-0}" == "1" ]]; then
  echo "▶ 跳过 docker load（SKIP_IMAGE_LOAD=1，镜像已在本机）"
else
echo "▶ 加载镜像"
load_image_tar() {
  local f=$1
  [[ -f "${f}" ]] || { echo "✗ 缺少 ${f}，请用新版 build-offline.sh 重新打包"; exit 1; }
  echo "  loading ${f} ..."
  gzip -t "${f}" || { echo "✗ ${f} gzip 校验失败，文件可能未完整拷贝"; exit 1; }
  local load_out
  if ! load_out="$(gunzip -c "${f}" | docker load 2>&1)"; then
    echo "${load_out}"
    echo "✗ ${f} docker load 失败（content digest not found 多为 tar 损坏或打包时 manifest 不完整）"
    echo "  1) 外网机重新执行: TARGET_PLATFORM=linux/amd64 bash build-offline.sh"
    echo "  2) 拷贝后执行: shasum -a 256 -c checksums.sha256"
    exit 1
  fi
  echo "${load_out}" | sed 's/^/    /'
}

restore_tags_from_manifest() {
  [[ -f image-manifest.txt ]] || return 0
  echo "▶ 校验 / 补打镜像 tag"
  while read -r tag id manifest_arch; do
    [[ -z "${tag}" || "${tag}" == \#* ]] && continue
    if docker image inspect "${tag}" >/dev/null 2>&1; then
      echo "  ${tag} OK"
      continue
    fi
    if docker image inspect "${id}" >/dev/null 2>&1; then
      docker tag "${id}" "${tag}"
      echo "  补打 ${tag} ← ${id}"
      continue
    fi
    local short="${id#sha256:}"
    local loaded=""
    loaded="$(docker images --no-trunc --format '{{.ID}}' | while read -r cid; do
      if [[ "${cid}" == "${id}" || "${cid}" == *"${short}" ]]; then echo "${cid}"; break; fi
    done)"
    if [[ -n "${loaded}" ]]; then
      docker tag "${loaded}" "${tag}"
      echo "  补打 ${tag} ← ${loaded}"
      continue
    fi
    echo "✗ 无法恢复 tag ${tag}（manifest id ${id}）"
    echo "  当前镜像列表："
    docker image ls | head -15
    exit 1
  done < image-manifest.txt
}

load_image_tar apiplatform-backend.tar.gz
load_image_tar apiplatform-nginx.tar.gz
load_image_tar apiplatform-postgres.tar.gz
load_image_tar apiplatform-redis.tar.gz
load_image_tar apiplatform-prometheus.tar.gz
load_image_tar apiplatform-grafana.tar.gz
restore_tags_from_manifest

image_arch() {
  local name=$1
  local arch=""
  arch="$(docker image inspect "${name}" --format '{{.Architecture}}' 2>/dev/null || true)"
  if [[ -n "${arch}" ]]; then
    echo "${arch}"
    return
  fi
  if [[ -f image-manifest.txt ]]; then
    arch="$(awk -v t="${name}" '$1==t {print $3; exit}' image-manifest.txt)"
    if [[ -n "${arch}" ]]; then
      echo "${arch}"
      return
    fi
  fi
  if docker image inspect "${name}" >/dev/null 2>&1; then
    case "${EXPECT}" in
      linux/amd64) echo "amd64"; return ;;
      linux/arm64) echo "arm64"; return ;;
    esac
  fi
  echo "missing"
}

echo "▶ 校验镜像架构"
EXPECT="${TARGET_PLATFORM:-linux/amd64}"

images_to_check=(apiplatform-backend:latest apiplatform-nginx:latest apiplatform-postgres:16-alpine apiplatform-redis:7-alpine apiplatform-prometheus:v3.13.2 apiplatform-grafana:13.2.0)

for name in "${images_to_check[@]}"; do
  if ! docker image inspect "${name}" >/dev/null 2>&1; then
    echo "✗ 镜像 ${name} 不存在（load 后 tag 丢失，请用新版 build-offline.sh 重新打包）"
    docker image ls | head -15
    exit 1
  fi
  img_arch="$(image_arch "${name}")"
  if [[ "${img_arch}" == "missing" ]]; then
    echo "✗ 无法读取 ${name} 的架构"; exit 1
  fi
  case "${EXPECT}" in
    linux/amd64) want="amd64" ;;
    linux/arm64) want="arm64" ;;
    *) want="${EXPECT#linux/}" ;;
  esac
  if [[ "${img_arch}" != "${want}" ]]; then
    echo "✗ 镜像 ${name} 架构为 ${img_arch}，与目标 ${EXPECT} 不符"
    echo "  请在外网打包机执行: TARGET_PLATFORM=${EXPECT} bash build-offline.sh"
    exit 1
  fi
  echo "  ${name} → ${img_arch} OK"
done
fi

${DOCKER_COMPOSE} config >/dev/null

# 先起库再等健康，这段不能省：backend 连不上库时 /health 返回 503，healthcheck 永远
# 不 healthy，而 nginx 是 `depends_on: backend: condition: service_healthy`——于是
# nginx 压根不启动，浏览器只看到「连接被拒绝」，完全看不出根因在数据库。宁可在这里失败。
echo "▶ [阶段 1/2] 仅启动 postgres（backend / nginx / redis 尚未拉起，属正常现象）"
if ! docker image inspect apiplatform-postgres:16-alpine >/dev/null 2>&1; then
  echo "✗ 镜像 apiplatform-postgres:16-alpine 不存在；请重新加载 apiplatform-postgres.tar.gz"
  exit 1
fi
if ! ${DOCKER_COMPOSE} up -d postgres; then
  echo "✗ compose 启动 postgres 失败"
  offline_postgres_failure_help
  exit 1
fi
if ! offline_wait_postgres; then
  exit 1
fi

echo "▶ [阶段 2/2] 启动全部服务（后端将在空库中生成安全演示数据）"
${DOCKER_COMPOSE} up -d --remove-orphans --no-build --force-recreate

echo "▶ 健康检查（要求 status=ok）"
PORT="${HTTP_PORT:-80}"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "✔ 部署成功 → http://127.0.0.1:${PORT}"
    echo "  对外域名由部署方的 DNS / 反向代理自行配置"
    echo "  后台 /admin.html：首次访问时设置管理员密码  |  用户注册: 默认关闭"
    echo "  本机探测 → http://127.0.0.1:${PORT}/health"
    echo "  数据库 → ${POSTGRES_BIND_ADDRESS:-127.0.0.1}:${POSTGRES_PORT:-5432}（容器与卷由 Compose 项目隔离）"
    echo "  备份 → pg-backup 每小时生成并校验快照（/backups/latest.dump，默认保留 168 份）"
    echo "  导出备份 → bash scripts/export-backup.sh（恢复：bash scripts/restore-backup.sh <dump文件>）"
    echo "  仅更新配置/compose → SKIP_IMAGE_LOAD=1 bash deploy-offline.sh"
    exit 0
  fi
  sleep 3
done
echo "✗ 健康检查超时，请查看 ${DOCKER_COMPOSE} logs"; exit 1
