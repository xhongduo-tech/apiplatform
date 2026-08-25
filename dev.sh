#!/usr/bin/env bash
# ============================================================================
# Open API Platform — 本地开发编排
#   ./dev.sh            启动 postgres(compose) + redis(docker) + backend(uvicorn) + frontend(vite)
#   ./dev.sh --backend  仅重启后端
#   ./dev.sh --frontend 仅重启前端
#   ./dev.sh --status   查看状态
#   ./dev.sh --stop     停止全部
#   ./dev.sh --logs     跟踪后端日志
# 选项: --api-port N (默认 8010)  --ui-port N (默认 5173)  --no-browser
# 本地开发使用独立的非生产凭据，无需 .env；生产部署必须自行生成随机密钥。
#
# 数据库由 docker-compose.app.yml 内置的 postgres 服务提供（按 Compose 项目解析容器，
# 仅绑 127.0.0.1:5432，口令与后端默认配置一致，零配置）。本脚本检测到 postgres
# 没在跑时会自动 `docker compose -f docker-compose.app.yml up -d postgres` 拉起
# 并等待 pg_isready 健康，无需先手动起库。
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

command -v docker >/dev/null || { echo "✗ 未找到 docker"; exit 1; }

REDIS_CONTAINER="apiplatform-dev-redis"
DEV_COMPOSE=(docker compose -p apiplatform -f "$ROOT/docker-compose.app.yml")
DEV_POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-platform_dev_postgres}"
REDIS_PASSWORD="${REDIS_PASSWORD:-platform_dev_redis}"
DEV_JWT_SECRET="${JWT_SECRET:-platform-dev-only-jwt-secret-not-for-production}"
DEV_DATA_ENCRYPTION_KEY="${DATA_ENCRYPTION_KEY:-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8}"
# compose 使用必填变量；显式导出仅供本地开发，不写入任何文件。
export POSTGRES_PASSWORD="${DEV_POSTGRES_PASSWORD}"
export REDIS_PASSWORD
export JWT_SECRET="${DEV_JWT_SECRET}"
export DATA_ENCRYPTION_KEY="${DEV_DATA_ENCRYPTION_KEY}"

UI_PORT=5173
OPEN_BROWSER=1
ACTION="start"
LOG_DIR="$ROOT/.dev-logs"
mkdir -p "$LOG_DIR"

API_PORT="${BACKEND_PORT:-8010}"
# 本地开发连接串：数据库走 compose 内置 postgres（仅绑回环 5432，与生产同拓扑）
DEV_DATABASE_URL="postgresql+psycopg://platform:${DEV_POSTGRES_PASSWORD}@127.0.0.1:5432/openapi_platform"
DEV_REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)   ACTION="backend" ;;
    --frontend)  ACTION="frontend" ;;
    --status)    ACTION="status" ;;
    --stop)      ACTION="stop" ;;
    --logs)      ACTION="logs" ;;
    --api-port)  API_PORT="$2"; shift ;;
    --ui-port)   UI_PORT="$2"; shift ;;
    --no-browser) OPEN_BROWSER=0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

c() { printf "\033[1;36m%s\033[0m\n" "$*"; }

# 释放占用端口的旧进程（避免 pid 文件丢失后 5173/8010 被僵尸 Vite/uvicorn 占用）
free_port() {
  local port=$1
  local pids
  pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    c "▶ 释放端口 :${port} (pid ${pids//$'\n'/ })"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.4
  fi
}

wait_backend() {
  local i
  for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  c "⚠ 后端 :${API_PORT} 健康检查超时，请查看 .dev-logs/backend.log"
  return 1
}

# 返回 HTTP 状态码；连不上（curl 非零退出）时输出 err。用 -s 而非 -sf：
# -f 会让 4xx 也判为失败，正常代理的 401/422 会被误报成 err；连不上时
# -w '%{http_code}' 会打 000，需用退出码兜底替换成 err，而不是叠加成 000err。
http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null)" || code="err"
  printf '%s' "${code:-err}"
}

# 校验当前 Compose 项目的 postgres 使用本地开发库名与口令。
# 只认「正在运行且配置吻合」，避免误连同名的残留容器。
db_container_ok() {
  local container_id
  local envs
  container_id="$("${DEV_COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
  [[ -n "${container_id}" ]] || return 1
  envs="$(docker inspect "${container_id}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)"
  grep -q '^POSTGRES_USER=platform$' <<<"$envs" \
    && grep -q '^POSTGRES_DB=openapi_platform$' <<<"$envs" \
    && grep -q "^POSTGRES_PASSWORD=${DEV_POSTGRES_PASSWORD}$" <<<"$envs"
}

ensure_db() {
  # postgres 由 Compose 管理并按项目解析，不依赖实现相关的容器名。
  # 不用 timeout 命令：macOS 默认不带 GNU coreutils；改走容器自己的 pg_isready。
  local container_id
  container_id="$("${DEV_COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
  if [[ -n "${container_id}" ]] \
      && [[ "$(docker inspect -f '{{.State.Status}}' "${container_id}" 2>/dev/null || true)" == "running" ]] \
      && db_container_ok; then
    return 0
  fi
  c "▶ 启动 postgres（compose 内置服务，仅绑 127.0.0.1:5432）"
  "${DEV_COMPOSE[@]}" up -d --force-recreate postgres
  local i
  for i in $(seq 1 40); do
    if "${DEV_COMPOSE[@]}" exec -T postgres pg_isready -U platform -d openapi_platform >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  cat <<'EOF'
✗ postgres 启动超时（约 20s）仍未健康。

  查看日志：docker compose -p apiplatform -f docker-compose.app.yml logs postgres
  手工拉起：docker compose -p apiplatform -f docker-compose.app.yml up -d postgres
EOF
  exit 1
}

ensure_redis() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
    docker start "$REDIS_CONTAINER" >/dev/null
  else
    c "▶ 首次启动 redis 容器 ($REDIS_CONTAINER)"
    docker run -d --name "$REDIS_CONTAINER" \
      -p 127.0.0.1:6379:6379 \
      redis:7-alpine \
      redis-server --appendonly yes --save 60 1 --requirepass "$REDIS_PASSWORD" >/dev/null
  fi
}

ensure_infra() {
  ensure_db
  ensure_redis
}

# 创建/自愈 .venv 并安装依赖。迁移与后端启动都依赖它——全新机器上 .venv 是空的，
# 若先跑 alembic 会因缺模块触发 set -e 提前退出，整条启动链路起不来。
prepare_backend() {
  c "▶ 后端依赖 (.venv)"
  [[ -d backend/.venv ]] || python3 -m venv backend/.venv
  heal_venv_paths
  # 一律走 python -m，不依赖 console script 的 shebang
  "$ROOT/backend/.venv/bin/python" -m pip install -q -r backend/requirements.txt
}

run_migrations() {
  prepare_backend
  c "▶ 数据库迁移 (alembic upgrade head)"
  ( cd backend && \
    ENVIRONMENT=development \
    DATABASE_URL="$DEV_DATABASE_URL" \
    "$ROOT/backend/.venv/bin/python" -m alembic upgrade head )
}

# venv 里的 console script（uvicorn/pip/pytest/alembic…）把解释器绝对路径写死在
# shebang 里，项目目录一旦被移动或改名，这些脚本全部变成 "bad interpreter"。
# 而 nohup 只会在日志里留一行 "No such file or directory"，前端表现却是所有
# /api 请求 500（Vite 代理连不上后端），根因极难看出来。此处开机自愈。
heal_venv_paths() {
  local venv="$ROOT/backend/.venv"
  [[ -d "$venv/bin" ]] || return 0
  local stale
  stale="$(sed -n '1s/^#!\(.*\)\/bin\/python.*/\1/p' "$venv/bin/pip" 2>/dev/null || true)"
  [[ -z "$stale" || "$stale" == "$venv" ]] && return 0
  c "▶ 检测到 .venv 记录的路径已过期（$stale），就地修正为 $venv"
  local f
  for f in "$venv"/bin/*; do
    [[ -f "$f" ]] && grep -qF "$stale" "$f" 2>/dev/null && sed -i '' "s|$stale|$venv|g" "$f"
  done
}

start_backend() {
  free_port "$API_PORT"
  prepare_backend
  c "▶ 启动 backend :$API_PORT"
  # macOS 默认 fd 上限 256,数百并发即触发 Errno 24(连 Redis 都连不上)
  ( cd backend && \
    ulimit -n 65536 2>/dev/null; \
    ENVIRONMENT=development \
    DATABASE_URL="$DEV_DATABASE_URL" \
    REDIS_URL="$DEV_REDIS_URL" \
    JWT_SECRET="$DEV_JWT_SECRET" \
    nohup "$ROOT/backend/.venv/bin/python" -m uvicorn app.main:app --host 0.0.0.0 --port "$API_PORT" --reload \
      > "$LOG_DIR/backend.log" 2>&1 & echo $! > "$LOG_DIR/backend.pid" )
  # 不再 activate/deactivate：全部命令显式走 .venv/bin/python，不污染当前 shell
}

start_frontend() {
  free_port "$UI_PORT"
  c "▶ 前端依赖"
  ( cd frontend && { [[ -d node_modules ]] || npm install; } )
  c "▶ 启动 frontend :${UI_PORT} (API proxy -> :${API_PORT})"
  ( cd frontend && \
    VITE_DEV_API_PORT="$API_PORT" VITE_DEV_UI_PORT="$UI_PORT" \
    nohup npm run dev -- --port "$UI_PORT" --strictPort \
      > "$LOG_DIR/frontend.log" 2>&1 & echo $! > "$LOG_DIR/frontend.pid" )
  [[ $OPEN_BROWSER -eq 1 ]] && (sleep 3; open "http://localhost:$UI_PORT" 2>/dev/null || true) &
}

stop_one() {
  [[ -f "$LOG_DIR/$1.pid" ]] && kill "$(cat "$LOG_DIR/$1.pid")" 2>/dev/null || true
  rm -f "$LOG_DIR/$1.pid"
}

case "$ACTION" in
  start)    stop_one backend; stop_one frontend; free_port "$API_PORT"; free_port "$UI_PORT"
            ensure_infra; run_migrations; start_backend; wait_backend || true; start_frontend
            c "✔ 就绪 — 前端 http://localhost:$UI_PORT · 管理后台 http://localhost:$UI_PORT/admin.html · 后端 http://localhost:$API_PORT/health" ;;
  backend)  stop_one backend; free_port "$API_PORT"; ensure_infra; run_migrations; start_backend; wait_backend || true ;;
  frontend) stop_one frontend; free_port "$UI_PORT"; start_frontend ;;
  stop)     stop_one backend; stop_one frontend; free_port "$API_PORT"; free_port "$UI_PORT"
            docker stop "$REDIS_CONTAINER" >/dev/null 2>&1 || true
            c "✔ 已停止（postgres 由 compose 管理，不受本脚本管辖；需要停止：docker compose -p apiplatform -f docker-compose.app.yml stop postgres）" ;;
  status)   c "── 进程 ──"; for s in backend frontend; do
              if [[ -f "$LOG_DIR/$s.pid" ]] && kill -0 "$(cat "$LOG_DIR/$s.pid")" 2>/dev/null; then
                echo "  $s: 运行中 (pid $(cat "$LOG_DIR/$s.pid"))"; else echo "  $s: 停止"; fi
            done
            c "── 端口 ──"
            echo "  后端 :${API_PORT} → $(curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null && echo OK || echo 不可达)"
            echo "  前端 :${UI_PORT} → $(curl -sf "http://127.0.0.1:${UI_PORT}/" >/dev/null && echo OK || echo 不可达)"
            echo "  代理 /api → $(http_code -X POST "http://127.0.0.1:${UI_PORT}/api/admin/login" -H 'Content-Type: application/json' -d '{}') (401/422=正常, 404=代理端口错误)"
            echo "  撤回接口 → $(http_code -X DELETE "http://127.0.0.1:${API_PORT}/api/apply/upgrade/__probe__" -H 'Authorization: Bearer x') (401=路由已加载, 404=需 ./dev.sh --backend 重启后端)"
            c "── 容器 ──"
            echo "  redis (${REDIS_CONTAINER}) → $(docker inspect -f '{{.State.Status}}' "$REDIS_CONTAINER" 2>/dev/null || echo 未创建)"
            postgres_id="$("${DEV_COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
            echo "  postgres (compose) :5432 → $([[ -n "${postgres_id}" ]] && docker inspect -f '{{.State.Status}}' "${postgres_id}" 2>/dev/null || echo 未创建)" ;;
  logs)     tail -f "$LOG_DIR/backend.log" ;;
esac
