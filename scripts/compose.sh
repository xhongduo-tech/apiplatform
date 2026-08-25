#!/usr/bin/env bash
# ============================================================================
# 与 deploy-offline.sh 使用同一套 docker-compose / compose 命令（内网排障用）
#
#   cd /data/offline-images
#   bash scripts/compose.sh ps
#   bash scripts/compose.sh logs postgres --tail 50
#   bash scripts/compose.sh exec -T postgres pg_isready -U platform -d openapi_platform
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
# shellcheck source=scripts/offline-env.sh
source "${ROOT}/scripts/offline-env.sh"
offline_init_compose
exec ${DOCKER_COMPOSE} "$@"
