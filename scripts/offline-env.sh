#!/usr/bin/env bash
# ============================================================================
# 离线 / 生产 compose 公共初始化（由 deploy / export / restore source）
#
# 用法（调用方须先设置 ROOT 为项目根或 offline-images 目录）：
#   ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   # shellcheck source=scripts/offline-env.sh
#   source "${ROOT}/scripts/offline-env.sh"
#   offline_init_compose
# ============================================================================

offline_random_hex() {
  local bytes="${1:-24}"
  LC_ALL=C od -An -N "${bytes}" -tx1 /dev/urandom | tr -d ' \n'
}

offline_random_base64url_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '/+' '_-' | tr -d '=\r\n'
  elif command -v base64 >/dev/null 2>&1; then
    dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr '/+' '_-' | tr -d '=\r\n'
  else
    echo "✗ 生成 DATA_ENCRYPTION_KEY 需要 openssl 或 base64" >&2
    return 1
  fi
}

offline_ensure_runtime_env() {
  local env_root="${1:?missing deployment root}"
  local target="${env_root}/.env"
  [[ -f "${target}" ]] && return 0
  [[ -f "${env_root}/.env.template" ]] || {
    echo "✗ 缺少 .env.template，拒绝生成部署秘密" >&2
    return 1
  }

  local old_umask tmp
  old_umask="$(umask)"
  umask 077
  tmp="$(mktemp "${env_root}/.env.tmp.XXXXXX")"
  trap 'rm -f "${tmp}"' RETURN
  cat > "${tmp}" <<EOF
# 目标机首次部署时生成；每套部署独有。不得复制到其它实例或提交源码。
COMPOSE_PULL_POLICY=never
BACKEND_IMAGE=apiplatform-backend:latest
NGINX_IMAGE=apiplatform-nginx:latest
POSTGRES_IMAGE=apiplatform-postgres:16-alpine
REDIS_IMAGE=apiplatform-redis:7-alpine
PROMETHEUS_IMAGE=apiplatform-prometheus:v2.53.0
GRAFANA_IMAGE=apiplatform-grafana:11.1.0
POSTGRES_PASSWORD=$(offline_random_hex 24)
REDIS_PASSWORD=$(offline_random_hex 24)
JWT_SECRET=$(offline_random_hex 48)
DATA_ENCRYPTION_KEY=$(offline_random_base64url_32)
ADMIN_BOOTSTRAP_TOKEN=$(offline_random_hex 32)
DEPLOYMENT_ID=$(offline_random_hex 16)
DEMO_DATA_ENABLED=true
ALLOW_PUBLIC_REGISTRATION=false
ALLOW_PASSWORD_RECOVERY=false
SESSION_COOKIE_SECURE=false
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
EOF
  chmod 600 "${tmp}"
  mv "${tmp}" "${target}"
  trap - RETURN
  umask "${old_umask}"
  echo "✔ 已在目标机生成本部署独有的 .env（权限 600；不会覆盖已有文件）"
}

offline_resolve_compose_file() {
  if [[ -f "${ROOT}/docker-compose.app.yml" ]]; then
    echo "${ROOT}/docker-compose.app.yml"
  elif [[ -f "${ROOT}/docker-compose.yml" ]]; then
    echo "${ROOT}/docker-compose.yml"
  else
    return 1
  fi
}

offline_init_compose() {
  local env_compose_file="${COMPOSE_FILE:-}"
  COMPOSE_FILE="$(offline_resolve_compose_file)" || {
    echo "✗ 未找到 docker-compose.app.yml / docker-compose.yml（请在项目根或 offline-images 目录执行）"
    exit 1
  }

  # 内网无 Docker Hub：默认禁止 compose 尝试 pull（可被环境变量或 .env 覆盖）
  export COMPOSE_PULL_POLICY="${COMPOSE_PULL_POLICY:-never}"

  # 手工 `docker-compose ps` 无 -f 时会读 $COMPOSE_FILE 或 ./docker-compose.yml；
  # 若 shell 里 COMPOSE_FILE 指向别的栈，会报 No such service: postgres，与 deploy 用的文件不一致。
  if [[ -n "${env_compose_file}" && "${env_compose_file}" != "${COMPOSE_FILE}" ]]; then
    echo "⚠ 环境变量 COMPOSE_FILE=${env_compose_file}"
    echo "  与离线包 compose（${COMPOSE_FILE}）不一致；手工命令请加 -f 或 unset COMPOSE_FILE"
  fi
  export OFFLINE_COMPOSE_FILE="${COMPOSE_FILE}"

  # 内网常见为 docker-compose v1 独立二进制；优先于 docker compose 插件
  if [[ "${COMPOSE_BIN:-}" == "plugin" ]] && docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose -f ${COMPOSE_FILE}"
  elif [[ "${COMPOSE_BIN:-}" == "v1" ]] && command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose -f ${COMPOSE_FILE}"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose -f ${COMPOSE_FILE}"
  elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose -f ${COMPOSE_FILE}"
  else
    echo "✗ 未找到 docker-compose 或 docker compose，请安装 Docker Compose"
    exit 1
  fi
}

# 打印当前 compose 命令（deploy / 排障时调用）
offline_print_compose_hint() {
  echo "▶ Compose 命令: ${DOCKER_COMPOSE}"
  echo "  工作目录: ${ROOT}"
  echo "  推荐手工操作（与 deploy 同源，避免 No such service: postgres）:"
  echo "    bash scripts/compose.sh ps"
  echo "    bash scripts/compose.sh logs postgres --tail 50"
  echo "  或显式 -f: ${DOCKER_COMPOSE} ps"
}

# 确认 compose 文件含 postgres 服务（旧离线包 / 读错 compose 时提前失败）
offline_validate_compose_services() {
  local services
  if ! services="$(${DOCKER_COMPOSE} config --services 2>/dev/null)"; then
    echo "✗ 无法解析 compose 文件: ${COMPOSE_FILE}"
    return 1
  fi
  if ! grep -qx 'postgres' <<<"${services}"; then
    echo "✗ compose 文件不含 postgres 服务: ${COMPOSE_FILE}"
    echo "  当前 services:"
    echo "${services}" | sed 's/^/    /'
    echo "  常见原因：离线包过旧，或 COMPOSE_FILE 指向了别的 docker-compose.yml"
    echo "  请在外网重新 build-offline.sh，或 unset COMPOSE_FILE 后 cd 到 offline-images 再部署"
    return 1
  fi
  return 0
}

# pg_isready 始终通过 Compose 解析当前项目，避免误连同机另一套部署。
offline_pg_isready() {
  if ${DOCKER_COMPOSE} exec -T postgres pg_isready -U platform -d openapi_platform >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# 等待 postgres 就绪；失败时打印容器状态与日志（内网排障用）
offline_postgres_failure_help() {
  echo ""
  echo "── postgres 诊断 ──"
  ${DOCKER_COMPOSE} ps postgres 2>/dev/null || true
  local postgres_id
  postgres_id="$(${DOCKER_COMPOSE} ps -q postgres 2>/dev/null || true)"
  if [[ -n "${postgres_id}" ]] && docker inspect "${postgres_id}" >/dev/null 2>&1; then
    echo "  容器状态: $(docker inspect -f 'status={{.State.Status}} exit={{.State.ExitCode}} err={{.State.Error}}' "${postgres_id}" 2>/dev/null)"
  else
    echo "  当前 Compose 项目的 postgres 容器不存在（compose up 可能未成功创建）"
  fi
  if ! docker image inspect apiplatform-postgres:16-alpine >/dev/null 2>&1; then
    echo "  ✗ 镜像 apiplatform-postgres:16-alpine 不存在 → 请先 docker load apiplatform-postgres.tar.gz"
  fi
  echo "  最近日志:"
  ${DOCKER_COMPOSE} logs postgres --tail 40 2>/dev/null | sed 's/^/    /' || true
  if command -v ss >/dev/null 2>&1; then
    echo "  宿主机 5432 端口:"
    ss -lntp 2>/dev/null | grep ':5432' | sed 's/^/    /' || echo "    （未监听或未检测到 ss）"
  fi
  cat <<'EOF'

  常见原因：
    1) 镜像未 load / tag 丢失 → 重新 bash deploy-offline.sh（勿 SKIP_IMAGE_LOAD）
    2) 宿主机已有 PostgreSQL 占用 127.0.0.1:5432 → systemctl stop postgresql
    3) 当前 Compose 项目的旧数据卷损坏或口令不一致 → 先导出/核对卷，再决定是否重建（切勿直接删库）
    4) offline-images/postgres/config/ 未完整拷贝 → 检查 postgresql.conf / pg_hba.conf
    5) 首次 initdb 较慢 → POSTGRES_WAIT_SEC=180 bash deploy-offline.sh

  若手工执行 docker-compose ps postgres 报 No such service: postgres：
    - 未加 -f 或 COMPOSE_FILE 指向别的文件 → unset COMPOSE_FILE；cd offline-images
    - 推荐: bash scripts/compose.sh ps
    - 或直接检查: bash scripts/compose.sh exec -T postgres pg_isready -U platform -d openapi_platform

  说明：deploy-offline.sh 分三阶段执行。阶段 1 只起 postgres，此时 docker ps 仅见
  只有 postgres 服务是正常的；阶段 1 失败退出则永远不会进入阶段 3，其它容器不会出现。

  若手动确认 pg_isready 已成功，可跳过等待直接续部署（命令行以前述「Compose 命令」为准）：
    cd offline-images 目录
    bash scripts/db-seed.sh
    bash scripts/compose.sh up -d --no-build --force-recreate
EOF
}

offline_wait_postgres() {
  local wait_sec="${POSTGRES_WAIT_SEC:-120}"
  local sleep_s=2
  local max_attempts=$(( wait_sec / sleep_s ))
  [[ "${max_attempts}" -lt 1 ]] && max_attempts=1

  echo "▶ 等待 postgres 就绪（最多 ${wait_sec}s）"
  local attempt=0
  while [[ "${attempt}" -lt "${max_attempts}" ]]; do
    attempt=$((attempt + 1))
    local postgres_id=""
    local state="missing"
    postgres_id="$(${DOCKER_COMPOSE} ps -q postgres 2>/dev/null || true)"
    if [[ -n "${postgres_id}" ]]; then
      state="$(docker inspect -f '{{.State.Status}}' "${postgres_id}" 2>/dev/null || echo missing)"
    fi

    if [[ "${state}" == "running" ]]; then
      if offline_pg_isready; then
        echo "  ✓ postgres 健康"
        return 0
      fi
    elif [[ "${state}" == "restarting" || "${state}" == "exited" ]]; then
      if [[ $((attempt % 5)) -eq 1 ]]; then
        echo "  ⚠ 容器状态=${state}（第 ${attempt} 次探测）"
        ${DOCKER_COMPOSE} logs postgres --tail 6 2>/dev/null | sed 's/^/    /'
      fi
    elif [[ "${state}" == "missing" && "${attempt}" -eq 3 ]]; then
      if ! docker image inspect apiplatform-postgres:16-alpine >/dev/null 2>&1; then
        echo "✗ 镜像 apiplatform-postgres:16-alpine 不存在，无法启动数据库"
        offline_postgres_failure_help
        return 1
      fi
    fi

    if [[ $((attempt % 15)) -eq 0 ]]; then
      echo "  … 仍在等待（${attempt}/${max_attempts}，容器=${state}）"
    fi
    sleep "${sleep_s}"
  done

  echo "✗ postgres 启动超时（${wait_sec}s）"
  offline_postgres_failure_help
  return 1
}
