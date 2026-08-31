#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root_dir}"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for the Sentinel failover drill" >&2
  exit 2
}

project="apiplatform-sentinel-drill-${$}"
compose=(
  docker compose --project-name "${project}"
  -f docker-compose.app.yml
  -f docker-compose.sentinel.yml
)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Compose expands the full manifest even though the drill starts only Redis services.
export POSTGRES_PASSWORD="sentinel-drill-postgres-${project}"
export REDIS_PASSWORD="sentinel-drill-redis-${project}"
export REDIS_SENTINEL_PASSWORD="sentinel-drill-sentinel-${project}"
export JWT_SECRET="sentinel-drill-jwt-secret-at-least-32-characters-${project}"
export DATA_ENCRYPTION_KEY="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
export ADMIN_BOOTSTRAP_TOKEN="sentinel-drill-bootstrap-token-at-least-32-random-bytes-${project}"

"${compose[@]}" up -d \
  redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3

sentinel_master_host() {
  "${compose[@]}" exec -T redis-sentinel-1 \
    redis-cli -p 26379 --no-auth-warning -a "${REDIS_SENTINEL_PASSWORD}" \
    SENTINEL get-master-addr-by-name apiplatform-master \
    | sed -n '1p' | tr -d '\r'
}

for _ in $(seq 1 20); do
  [[ "$(sentinel_master_host 2>/dev/null || true)" == "redis" ]] && break
  sleep 1
done
[[ "$(sentinel_master_host)" == "redis" ]] || {
  echo "Sentinel did not discover the initial redis master" >&2
  exit 1
}

replica_link_status() {
  "${compose[@]}" exec -T redis-replica \
    redis-cli --no-auth-warning -a "${REDIS_PASSWORD}" INFO replication \
    | awk -F: '/^master_link_status:/{gsub("\\r", "", $2); print $2}'
}

for _ in $(seq 1 30); do
  [[ "$(replica_link_status 2>/dev/null || true)" == "up" ]] && break
  sleep 1
done
[[ "$(replica_link_status)" == "up" ]] || {
  echo "Redis replica never completed its initial synchronization" >&2
  "${compose[@]}" logs --no-color --tail=80 redis redis-replica >&2 || true
  exit 1
}
replica_ip="$("${compose[@]}" exec -T redis-replica hostname -i | awk '{print $1}' | tr -d '\r')"

# This is destructive only inside the unique, trap-cleaned drill project.
"${compose[@]}" stop --timeout 1 redis >/dev/null

promoted=""
for _ in $(seq 1 35); do
  promoted="$(sentinel_master_host 2>/dev/null || true)"
  [[ "${promoted}" == "redis-replica" || "${promoted}" == "${replica_ip}" ]] && break
  sleep 1
done
[[ "${promoted}" == "redis-replica" || "${promoted}" == "${replica_ip}" ]] || {
  echo "Sentinel did not promote redis-replica after the master stopped (reported: ${promoted:-none})" >&2
  "${compose[@]}" logs --no-color --tail=80 \
    redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3 >&2 || true
  exit 1
}

"${compose[@]}" exec -T redis-replica \
  redis-cli --no-auth-warning -a "${REDIS_PASSWORD}" \
  SET sentinel-drill-writable ok | grep -Fx OK >/dev/null

echo "Sentinel failover drill passed: redis-replica promoted and writable"
