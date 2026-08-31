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

[[ -f scripts/offline-package-verify.sh ]] || {
  echo "✗ 缺少强制离线包校验器；拒绝运行旧版或不完整的包" >&2
  exit 1
}
echo "▶ 在执行包内其它脚本前校验离线包"
OFFLINE_DIR="$HERE" bash scripts/offline-package-verify.sh deploy

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
echo "  离线包版本：$(grep -E '^pack_mode=|^build_date=|^git_commit=|^publisher_status=|^target_platform=|^seed_included=' package-info.txt | tr '\n' ' ')"

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
  echo "▶ 按完整 image ID 校验 / 补打镜像 tag"
  while IFS=$'\t' read -r role tag expected_id manifest_arch _rest; do
    [[ -z "${role}" || "${role}" == \#* ]] && continue
    if docker image inspect "${tag}" >/dev/null 2>&1; then
      actual_id="$(docker image inspect "${tag}" --format '{{.Id}}')"
      if [[ "${actual_id}" != "${expected_id}" ]]; then
        echo "✗ 本机已有 tag ${tag}，但内容为 ${actual_id}，期望 ${expected_id}"
        echo "  拒绝以同名可变 tag 覆盖 manifest 绑定。"
        exit 1
      fi
    elif docker image inspect "${expected_id}" >/dev/null 2>&1; then
      docker tag "${expected_id}" "${tag}"
      echo "  补打 ${tag} ← ${expected_id}"
    else
      echo "✗ 无法恢复 ${role} tag ${tag}（manifest ID ${expected_id}）"
      docker image ls | head -15
      exit 1
    fi
    actual_arch="$(docker image inspect "${tag}" --format '{{.Architecture}}')"
    [[ "${actual_arch}" == "${manifest_arch}" ]] || {
      echo "✗ ${tag} 架构为 ${actual_arch}，manifest 为 ${manifest_arch}"; exit 1;
    }
    echo "  ${role}: ${tag} → ${expected_id} (${actual_arch})"
  done < image-manifest.txt
}

if [[ "${SKIP_IMAGE_LOAD:-0}" == "1" ]]; then
  echo "▶ 跳过 docker load（仍强制校验本机镜像的完整 image ID）"
else
  echo "▶ 加载镜像"
  load_image_tar apiplatform-backend.tar.gz
  load_image_tar apiplatform-nginx.tar.gz
  load_image_tar apiplatform-postgres.tar.gz
  load_image_tar apiplatform-redis.tar.gz
  load_image_tar apiplatform-prometheus.tar.gz
  load_image_tar apiplatform-grafana.tar.gz
fi
restore_tags_from_manifest

${DOCKER_COMPOSE} config >/dev/null

# 先起库再等健康，这段不能省：backend 连不上库时 /health 返回 503，healthcheck 永远
# 不 healthy，而 nginx 是 `depends_on: backend: condition: service_healthy`——于是
# nginx 压根不启动，浏览器只看到「连接被拒绝」，完全看不出根因在数据库。宁可在这里失败。
echo "▶ [阶段 1/2] 仅启动 postgres（backend / nginx / redis 尚未拉起，属正常现象）"
POSTGRES_OFFLINE_IMAGE="$(awk -F '\t' '$1 == "postgres" { print $2; exit }' image-manifest.txt)"
if [[ -z "${POSTGRES_OFFLINE_IMAGE}" ]] || ! docker image inspect "${POSTGRES_OFFLINE_IMAGE}" >/dev/null 2>&1; then
  echo "✗ manifest 中的 PostgreSQL 镜像不存在；请重新加载 apiplatform-postgres.tar.gz"
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

echo "▶ 健康检查（nginx 容器内部 /health，要求 status=ok）"
for i in $(seq 1 40); do
  health_payload="$(${DOCKER_COMPOSE} exec -T nginx \
    wget -qO- http://127.0.0.1:8080/health 2>/dev/null || true)"
  if grep -q '"status":"ok"' <<<"${health_payload}"; then
    published_http="$(${DOCKER_COMPOSE} port nginx 8080 2>/dev/null | head -n 1 || true)"
    echo "✔ 部署成功（nginx 容器内部健康）"
    if [[ -n "${published_http}" ]]; then
      echo "  宿主机入口映射 → ${published_http}"
    else
      echo "  宿主机入口以 .env 的 HTTP_BIND_ADDRESS / HTTP_PORT 为准"
    fi
    echo "  对外域名由部署方的 DNS / 反向代理自行配置"
    echo "  后台 /admin.html：首次访问时设置管理员密码  |  用户注册: 默认关闭"
    echo "  容器内探测 → nginx:8080/health"
    echo "  数据库 → ${POSTGRES_BIND_ADDRESS:-127.0.0.1}:${POSTGRES_PORT:-5432}（容器与卷由 Compose 项目隔离）"
    echo "  备份 → pg-backup 每小时生成并校验快照（/backups/latest.dump，默认保留 168 份）"
    echo "  导出备份 → bash scripts/export-backup.sh（恢复：bash scripts/restore-backup.sh <dump文件>）"
    echo "  仅更新配置/compose → SKIP_IMAGE_LOAD=1 bash deploy-offline.sh"
    exit 0
  fi
  sleep 3
done
echo "✗ 健康检查超时，容器状态与最近日志如下"
${DOCKER_COMPOSE} ps 2>/dev/null || true
${DOCKER_COMPOSE} logs --tail 50 backend nginx 2>/dev/null || true
exit 1
