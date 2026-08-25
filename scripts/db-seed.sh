#!/usr/bin/env bash
# 写入开源演示数据（幂等、安全）。
#
# 不再接收或恢复全库 dump。演示数据由 backend/app/demo_seed.py 生成：只在
# users/api_keys 均为空时写入，人物与统计完全虚构，所有演示 Key 均已撤销。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# shellcheck source=scripts/offline-env.sh
source "${ROOT}/scripts/offline-env.sh"
offline_init_compose

if ! ${DOCKER_COMPOSE} ps backend 2>/dev/null | grep -qE 'Up|running'; then
  cat <<'EOF'
✗ backend 尚未运行，无法写入演示数据。

  请先启动平台：
    docker compose -f docker-compose.app.yml up -d

  再执行：
    bash scripts/db-seed.sh
EOF
  exit 1
fi

echo "▶ 写入安全演示数据（已有用户或 API Key 时自动跳过）"
${DOCKER_COMPOSE} exec -T backend python -m app.demo_seed </dev/null
