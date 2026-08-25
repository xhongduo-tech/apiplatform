#!/usr/bin/env bash
# Build a disposable, isolated production-like stack and run browser release checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-apiplatform-e2e}"
export BACKEND_IMAGE="${BACKEND_IMAGE:-apiplatform-backend:e2e}"
export NGINX_IMAGE="${NGINX_IMAGE:-apiplatform-nginx:e2e}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-e2e-postgres-password-release-check}"
export REDIS_PASSWORD="${REDIS_PASSWORD:-e2e-redis-password-release-check}"
export JWT_SECRET="${JWT_SECRET:-e2e-jwt-secret-release-check-at-least-32-characters}"
export DATA_ENCRYPTION_KEY="${DATA_ENCRYPTION_KEY:-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8}"
export ADMIN_BOOTSTRAP_TOKEN="${ADMIN_BOOTSTRAP_TOKEN:-e2e-bootstrap-token-release-check-2026}"
export SESSION_COOKIE_SECURE="false"
export DEMO_DATA_ENABLED="false"
export HTTP_PORT="${HTTP_PORT:-18080}"
export POSTGRES_PORT="${POSTGRES_PORT:-65432}"
export REDIS_PORT="${REDIS_PORT:-6399}"

compose=(docker compose -f docker-compose.yml -f docker-compose.e2e.yml)

cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${compose[@]}" logs --no-color || true
  fi
  if [[ "${KEEP_E2E_STACK:-0}" != "1" ]]; then
    "${compose[@]}" down --volumes --remove-orphans
  fi
  exit "${status}"
}
trap cleanup EXIT

"${compose[@]}" down --volumes --remove-orphans
docker build -t "${BACKEND_IMAGE}" backend
docker build -t "${NGINX_IMAGE}" -f nginx/Dockerfile .
"${compose[@]}" up -d --wait postgres redis mock-upstream backend nginx

cd frontend
npm ci
npx playwright install chromium
PLAYWRIGHT_BASE_URL="http://127.0.0.1:${HTTP_PORT}" npm run test:e2e
