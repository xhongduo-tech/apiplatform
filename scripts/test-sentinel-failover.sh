#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root_dir}"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for the Sentinel failover drill" >&2
  exit 2
}

project="apiplatform-sentinel-drill-${$}"
sentinel_temp_base="${TMPDIR:-/tmp}"
sentinel_temp_base="${sentinel_temp_base%/}"
negative_test_dir=""
compose=(
  docker compose --project-name "${project}"
  -f docker-compose.app.yml
  -f docker-compose.sentinel.yml
)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  case "${negative_test_dir}" in
    "${sentinel_temp_base}"/apiplatform-sentinel-negative.*)
      find "${negative_test_dir}" -depth -delete >/dev/null 2>&1 || true
      ;;
  esac
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
  "${compose[@]}" exec -T redis-sentinel-1 sh -c \
    'REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" redis-cli --raw -p 26379 SENTINEL get-master-addr-by-name apiplatform-master' \
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
  "${compose[@]}" exec -T redis-replica sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO replication' \
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

# Replication being online is necessary but not sufficient: Sentinel must have
# observed and registered the replica before a failover can select it.
sentinel_replica_host() {
  "${compose[@]}" exec -T redis-sentinel-1 sh -c \
    'REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" redis-cli --raw -p 26379 SENTINEL replicas apiplatform-master' \
    | awk 'previous == "ip" { print; exit } { previous = $0 }' \
    | tr -d '\r'
}
for _ in $(seq 1 30); do
  [[ "$(sentinel_replica_host 2>/dev/null || true)" == "redis-replica" ]] && break
  sleep 1
done
[[ "$(sentinel_replica_host)" == "redis-replica" ]] || {
  echo "Sentinel never registered the synchronized Redis replica" >&2
  "${compose[@]}" logs --no-color --tail=80 \
    redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3 >&2 || true
  exit 1
}

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

"${compose[@]}" exec -T redis-replica sh -c \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw SET sentinel-drill-writable ok' \
  | grep -Fx OK >/dev/null

appendonly_setting="$(
  "${compose[@]}" exec -T redis-replica sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw CONFIG GET appendonly' \
    | tail -n 1 | tr -d '\r'
)"
[[ "${appendonly_setting}" == "yes" ]] || {
  echo "promoted Redis replica is not AOF-backed" >&2
  exit 1
}

# Redis 7.4 WAITAOF confirms that the acknowledged write reached the local AOF
# before the deliberate SIGKILL. The second return value covers replicas and is
# expected to be zero in this one-replica drill after promotion.
waitaof_result="$(
  "${compose[@]}" exec -T redis-replica sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw WAITAOF 1 0 5000' \
    | tr -d '\r'
)"
waitaof_local="$(printf '%s\n' "${waitaof_result}" | sed -n '1p')"
[[ "${waitaof_local}" == "1" ]] || {
  echo "promoted Redis replica did not fsync the local AOF" >&2
  exit 1
}

replica_container="$("${compose[@]}" ps -q redis-replica)"
[[ -n "${replica_container}" ]] || {
  echo "could not resolve the isolated Redis replica container" >&2
  exit 1
}
replica_project="$(
  docker container inspect --format \
    '{{ index .Config.Labels "com.docker.compose.project" }}' \
    "${replica_container}"
)"
[[ "${replica_project}" == "${project}" ]] || {
  echo "refusing to terminate a Redis container outside the drill project" >&2
  exit 1
}

# Prove persistence under an abrupt failure, not only a graceful Redis stop.
docker kill --signal KILL "${replica_container}" >/dev/null
if [[ "$(docker container inspect --format '{{.State.Running}}' "${replica_container}")" != "true" ]]; then
  docker start "${replica_container}" >/dev/null
fi

persisted_value=""
for _ in $(seq 1 30); do
  persisted_value="$(
    docker exec "${replica_container}" sh -c \
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw GET sentinel-drill-writable' \
      2>/dev/null | tr -d '\r' || true
  )"
  [[ "${persisted_value}" == "ok" ]] && break
  sleep 1
done
[[ "${persisted_value}" == "ok" ]] || {
  echo "promoted Redis write did not survive an abrupt restart" >&2
  docker logs --tail=80 "${replica_container}" >&2 || true
  exit 1
}

# Sentinel persists the elected master and configuration epoch in its config
# file. Abruptly restart all three processes and prove they do not fall back to
# the original, still-stopped master definition.
for _ in $(seq 1 30); do
  promoted="$(sentinel_master_host 2>/dev/null || true)"
  [[ "${promoted}" == "redis-replica" || "${promoted}" == "${replica_ip}" ]] && break
  sleep 1
done
[[ "${promoted}" == "redis-replica" || "${promoted}" == "${replica_ip}" ]] || {
  echo "Sentinel lost the promoted master after the Redis restart" >&2
  exit 1
}

sentinel_containers=()
for sentinel_service in redis-sentinel-1 redis-sentinel-2 redis-sentinel-3; do
  sentinel_container="$("${compose[@]}" ps -q "${sentinel_service}")"
  [[ -n "${sentinel_container}" ]] || {
    echo "could not resolve ${sentinel_service}" >&2
    exit 1
  }
  sentinel_project="$(
    docker container inspect --format \
      '{{ index .Config.Labels "com.docker.compose.project" }}' \
      "${sentinel_container}"
  )"
  [[ "${sentinel_project}" == "${project}" ]] || {
    echo "refusing to terminate a Sentinel outside the drill project" >&2
    exit 1
  }
  sentinel_containers+=("${sentinel_container}")
done
docker kill --signal KILL "${sentinel_containers[@]}" >/dev/null
for sentinel_container in "${sentinel_containers[@]}"; do
  if [[ "$(docker container inspect --format '{{.State.Running}}' "${sentinel_container}")" != "true" ]]; then
    docker start "${sentinel_container}" >/dev/null
  fi
done

promoted_after_sentinel_restart=""
for _ in $(seq 1 30); do
  promoted_after_sentinel_restart="$(sentinel_master_host 2>/dev/null || true)"
  if [[ "${promoted_after_sentinel_restart}" == "redis-replica" \
      || "${promoted_after_sentinel_restart}" == "${replica_ip}" ]]; then
    break
  fi
  sleep 1
done
[[ "${promoted_after_sentinel_restart}" == "redis-replica" \
    || "${promoted_after_sentinel_restart}" == "${replica_ip}" ]] || {
  echo "Sentinel state did not retain the promoted master across an abrupt restart" >&2
  exit 1
}
quorum_status=""
for _ in $(seq 1 30); do
  quorum_status="$(
    "${compose[@]}" exec -T redis-sentinel-1 \
      sh -c 'REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" redis-cli --raw -p 26379 SENTINEL CKQUORUM apiplatform-master' \
      2>/dev/null | tr -d '\r' || true
  )"
  [[ "${quorum_status}" == OK* ]] && break
  sleep 1
done
[[ "${quorum_status}" == OK* ]] || {
  echo "Sentinel quorum did not recover after the abrupt restart" >&2
  "${compose[@]}" logs --no-color --tail=120 \
    redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3 >&2 || true
  exit 1
}

# The critical recovery case is a complete container and network recreation,
# while retaining all five state volumes.  Both Redis entrypoints must derive
# their role from a stable 2/3 Sentinel majority; neither may fall back to the
# original hard-coded master.
"${compose[@]}" down --remove-orphans >/dev/null
"${compose[@]}" up -d \
  redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3

master_after_full_restart=""
for _ in $(seq 1 60); do
  master_after_full_restart="$(sentinel_master_host 2>/dev/null || true)"
  [[ "${master_after_full_restart}" == "redis-replica" ]] && break
  sleep 1
done
[[ "${master_after_full_restart}" == "redis-replica" ]] || {
  echo "full topology restart did not retain redis-replica as master" >&2
  "${compose[@]}" logs --no-color --tail=120 \
    redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3 >&2 || true
  exit 1
}

# A persisted Sentinel address alone is not readiness.  The same 2/3 quorum
# gate used by backend startup must confirm that the selected node has loaded
# its AOF and is serving as master before any read or write is attempted.
"${compose[@]}" run --rm --no-deps redis-sentinel-quorum >/dev/null

persisted_value="$(
  "${compose[@]}" exec -T redis-replica \
    sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw GET sentinel-drill-writable' \
    2>/dev/null | tr -d '\r' || true
)"
[[ "${persisted_value}" == "ok" ]] || {
  echo "acknowledged write was lost after complete topology recreation" >&2
  "${compose[@]}" logs --no-color --tail=160 \
    redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3 >&2 || true
  exit 1
}

primary_role="$(
  "${compose[@]}" exec -T redis \
    sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO replication' \
    | awk -F: '/^role:/{gsub("\\r", "", $2); print $2}'
)"
promoted_role="$(
  "${compose[@]}" exec -T redis-replica \
    sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO replication' \
    | awk -F: '/^role:/{gsub("\\r", "", $2); print $2}'
)"
[[ "${primary_role}" == "slave" && "${promoted_role}" == "master" ]] || {
  echo "topology recreation produced an invalid or dual-master Redis role set" >&2
  exit 1
}

"${compose[@]}" exec -T redis-replica \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw SET sentinel-drill-after-recreate ok' \
  | grep -Fx OK >/dev/null

# Loss of one Sentinel state volume must remain recoverable from the other two
# persisted voters.  Resolve and validate the exact drill-owned volume before
# the deliberate removal.
sentinel1_volume="$(
  docker volume ls \
    --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.volume=redissentinel1data" \
    --format '{{.Name}}'
)"
[[ -n "${sentinel1_volume}" ]] || {
  echo "could not resolve the isolated Sentinel state volume" >&2
  exit 1
}
sentinel1_project="$(
  docker volume inspect --format \
    '{{ index .Labels "com.docker.compose.project" }}' "${sentinel1_volume}"
)"
[[ "${sentinel1_project}" == "${project}" ]] || {
  echo "refusing to remove a Sentinel volume outside the drill project" >&2
  exit 1
}

"${compose[@]}" down --remove-orphans >/dev/null
docker volume rm "${sentinel1_volume}" >/dev/null
"${compose[@]}" up -d \
  redis redis-replica redis-sentinel-1 redis-sentinel-2 redis-sentinel-3

master_after_single_state_loss=""
for _ in $(seq 1 60); do
  master_after_single_state_loss="$(sentinel_master_host 2>/dev/null || true)"
  [[ "${master_after_single_state_loss}" == "redis-replica" ]] && break
  sleep 1
done
[[ "${master_after_single_state_loss}" == "redis-replica" ]] || {
  echo "2/3 persisted Sentinel voters did not recover the promoted master" >&2
  exit 1
}
"${compose[@]}" run --rm --no-deps redis-sentinel-quorum >/dev/null
persisted_value="$(
  "${compose[@]}" exec -T redis-replica \
    sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw GET sentinel-drill-writable' \
    2>/dev/null | tr -d '\r' || true
)"
[[ "${persisted_value}" == "ok" ]] || {
  echo "write was lost when one Sentinel state volume was unavailable" >&2
  exit 1
}

# A split control plane must never make either Redis node fall back to the
# original service. Three deliberately incompatible (host, port, epoch)
# observations have no majority, so the node bootstrap must time out closed.
negative_test_dir="$(mktemp -d "${sentinel_temp_base}/apiplatform-sentinel-negative.XXXXXXXX")"
cat >"${negative_test_dir}/redis-cli" <<'EOF'
#!/bin/sh
host=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h) host=$2; shift 2 ;;
    *) shift ;;
  esac
done
case "$host" in
  sentinel-a) reported_host=redis; epoch=1 ;;
  sentinel-b) reported_host=redis-replica; epoch=1 ;;
  sentinel-c) reported_host=redis; epoch=2 ;;
  *) exit 1 ;;
esac
printf 'ip\n%s\nport\n6379\nconfig-epoch\n%s\nflags\nmaster\n' \
  "$reported_host" "$epoch"
EOF
chmod 0500 "${negative_test_dir}/redis-cli"
if PATH="${negative_test_dir}:${PATH}" \
  REDIS_PASSWORD=negative-data-password \
  REDIS_SENTINEL_PASSWORD=negative-management-password \
  REDIS_SENTINEL_NODES=sentinel-a:26379,sentinel-b:26379,sentinel-c:26379 \
  REDIS_SENTINEL_MASTER=apiplatform-master \
  REDIS_SENTINEL_BOOTSTRAP_TIMEOUT_S=10 \
  REDIS_NODE_NAME=redis \
  sh scripts/redis-sentinel-bootstrap.sh \
  >"${negative_test_dir}/stdout" 2>"${negative_test_dir}/stderr"; then
  echo "Redis node bootstrap accepted a Sentinel control plane with no majority" >&2
  exit 1
fi
grep -F 'no stable Sentinel majority' "${negative_test_dir}/stderr" >/dev/null || {
  echo "Redis node bootstrap did not fail closed for the expected reason" >&2
  exit 1
}

echo "Sentinel failover drill passed: failover, AOF, full recreation, quorum gate, 2/3 recovery, and no-majority rejection verified"
