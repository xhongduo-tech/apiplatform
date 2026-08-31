#!/bin/sh
set -eu

# Resolve a Redis node's startup role from a stable majority of the persisted
# Sentinel control plane.  A fixed --replicaof command is unsafe after a
# failover: on a full topology restart it can make the promoted node follow the
# stale original master before Sentinel has a chance to intervene.

mode="${REDIS_SENTINEL_BOOTSTRAP_MODE:-node}"
redis_password="${REDIS_PASSWORD:?REDIS_PASSWORD is required}"
sentinel_password="${REDIS_SENTINEL_PASSWORD:?REDIS_SENTINEL_PASSWORD is required}"
sentinel_nodes="${REDIS_SENTINEL_NODES:-redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379}"
master_name="${REDIS_SENTINEL_MASTER:-apiplatform-master}"
timeout_s="${REDIS_SENTINEL_BOOTSTRAP_TIMEOUT_S:-90}"

case "${redis_password}" in
  *[!A-Za-z0-9_-]*)
    echo "Sentinel mode requires an alphanumeric, underscore, or hyphen Redis password" >&2
    exit 2
    ;;
esac
case "${sentinel_password}" in
  ''|*[!A-Za-z0-9_-]*)
    echo "Sentinel mode requires a non-empty alphanumeric, underscore, or hyphen Sentinel password" >&2
    exit 2
    ;;
esac
if [ "${redis_password}" = "${sentinel_password}" ]; then
  echo "Redis data-plane and Sentinel management passwords must be independent" >&2
  exit 2
fi
case "${master_name}" in
  ''|*[!A-Za-z0-9_-]*)
    echo "invalid Redis Sentinel master name" >&2
    exit 2
    ;;
esac
case "${timeout_s}" in
  ''|*[!0-9]*)
    echo "REDIS_SENTINEL_BOOTSTRAP_TIMEOUT_S must be an integer" >&2
    exit 2
    ;;
esac
if [ "${timeout_s}" -lt 10 ] || [ "${timeout_s}" -gt 600 ]; then
  echo "REDIS_SENTINEL_BOOTSTRAP_TIMEOUT_S must be between 10 and 600" >&2
  exit 2
fi

response_file="$(mktemp /tmp/sentinel-responses.XXXXXX)"
trap 'rm -f "${response_file}"' EXIT INT TERM

query_sentinel() {
  endpoint="$1"
  case "${endpoint}" in
    *:*) ;;
    *) return 1 ;;
  esac
  sentinel_host="${endpoint%:*}"
  sentinel_port="${endpoint##*:}"
  case "${sentinel_host}" in
    ''|*[!A-Za-z0-9_.-]*) return 1 ;;
  esac
  case "${sentinel_port}" in
    ''|*[!0-9]*) return 1 ;;
  esac

  response="$(
    REDISCLI_AUTH="${sentinel_password}" redis-cli --raw \
      -t 1 -h "${sentinel_host}" -p "${sentinel_port}" \
      SENTINEL master "${master_name}" 2>/dev/null
  )" || return 1

  parsed="$(
    printf '%s\n' "${response}" | awk '
      NR % 2 == 1 { key = $0; next }
      key == "ip" { ip = $0 }
      key == "port" { port = $0 }
      key == "config-epoch" { epoch = $0 }
      key == "flags" { flags = $0 }
      END {
        if (ip != "" && port != "" && epoch != "" && flags != "") {
          printf "%s|%s|%s|%s", ip, port, epoch, flags
        }
      }
    '
  )"
  [ -n "${parsed}" ] || return 1

  reported_host="${parsed%%|*}"
  remainder="${parsed#*|}"
  reported_port="${remainder%%|*}"
  remainder="${remainder#*|}"
  reported_epoch="${remainder%%|*}"
  reported_flags="${remainder#*|}"
  case "${reported_host}" in
    redis|redis-replica) ;;
    *) return 1 ;;
  esac
  [ "${reported_port}" = "6379" ] || return 1
  case "${reported_epoch}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s|%s|%s|%s\n' \
    "${reported_host}" "${reported_port}" "${reported_epoch}" "${reported_flags}"
}

majority_snapshot() {
  : >"${response_file}"
  configured=0
  old_ifs="${IFS}"
  IFS=,
  # shellcheck disable=SC2086 # intentional split of the comma-delimited list
  set -- ${sentinel_nodes}
  IFS="${old_ifs}"
  for endpoint in "$@"; do
    configured=$((configured + 1))
    observation="$(query_sentinel "${endpoint}" || true)"
    [ -n "${observation}" ] || continue
    printf '%s\n' "${observation%|*}" >>"${response_file}"
  done
  [ "${configured}" -ge 3 ] || return 1
  quorum=$((configured / 2 + 1))
  winner="$(sort "${response_file}" | uniq -c | sort -nr | awk 'NR == 1 { print $1 "|" $2 }')"
  [ -n "${winner}" ] || return 1
  winner_count="${winner%%|*}"
  winner_tuple="${winner#*|}"
  [ "${winner_count}" -ge "${quorum}" ] || return 1
  printf '%s\n' "${winner_tuple}"
}

stable_majority() {
  elapsed=0
  stable_count=0
  previous=""
  while [ "${elapsed}" -lt "${timeout_s}" ]; do
    current="$(majority_snapshot || true)"
    if [ -n "${current}" ] && [ "${current}" = "${previous}" ]; then
      stable_count=$((stable_count + 1))
    elif [ -n "${current}" ]; then
      previous="${current}"
      stable_count=1
    else
      previous=""
      stable_count=0
    fi
    if [ "${stable_count}" -ge 3 ]; then
      printf '%s\n' "${current}"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

sentinel_quorum_ready() {
  expected_tuple="$1"
  healthy=0
  configured=0
  old_ifs="${IFS}"
  IFS=,
  # shellcheck disable=SC2086 # intentional split of the comma-delimited list
  set -- ${sentinel_nodes}
  IFS="${old_ifs}"
  for endpoint in "$@"; do
    configured=$((configured + 1))
    observation="$(query_sentinel "${endpoint}" || true)"
    [ -n "${observation}" ] || continue
    tuple="${observation%|*}"
    flags="${observation##*|}"
    [ "${tuple}" = "${expected_tuple}" ] || continue
    case ",${flags}," in
      *,s_down,*|*,o_down,*|*,disconnected,*) continue ;;
    esac
    sentinel_host="${endpoint%:*}"
    sentinel_port="${endpoint##*:}"
    quorum_status="$(
      REDISCLI_AUTH="${sentinel_password}" redis-cli --raw \
        -t 1 -h "${sentinel_host}" -p "${sentinel_port}" \
        SENTINEL CKQUORUM "${master_name}" 2>/dev/null || true
    )"
    case "${quorum_status}" in
      OK*) healthy=$((healthy + 1)) ;;
    esac
  done
  [ "${configured}" -ge 3 ] || return 1
  [ "${healthy}" -ge $((configured / 2 + 1)) ]
}

if [ "${mode}" = "gate" ]; then
  selected="$(stable_majority || true)"
  [ -n "${selected}" ] || {
    echo "Sentinel quorum did not produce a stable majority" >&2
    exit 1
  }
  elapsed=0
  while [ "${elapsed}" -lt "${timeout_s}" ]; do
    current="$(majority_snapshot || true)"
    if [ -n "${current}" ] && [ "${current}" != "${selected}" ]; then
      echo "Sentinel majority changed during the startup gate; retry required" >&2
      exit 1
    fi
    if [ "${current}" = "${selected}" ] && sentinel_quorum_ready "${selected}"; then
      selected_host="${selected%%|*}"
      master_role="$(
        REDISCLI_AUTH="${redis_password}" redis-cli --raw \
          -t 1 -h "${selected_host}" -p 6379 \
          INFO replication 2>/dev/null \
          | awk -F: '/^role:/{gsub("\\r", "", $2); print $2}'
      )"
      if [ "${master_role}" = "master" ]; then
        exit 0
      fi
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "Sentinel quorum did not converge on a reachable Redis master" >&2
  exit 1
fi

[ "${mode}" = "node" ] || {
  echo "unknown REDIS_SENTINEL_BOOTSTRAP_MODE" >&2
  exit 2
}
node_name="${REDIS_NODE_NAME:?REDIS_NODE_NAME is required in node mode}"
case "${node_name}" in
  redis|redis-replica) ;;
  *) echo "REDIS_NODE_NAME must be redis or redis-replica" >&2; exit 2 ;;
esac

selected="$(stable_majority || true)"
[ -n "${selected}" ] || {
  echo "no stable Sentinel majority; refusing to choose a fixed Redis master" >&2
  exit 1
}
selected_host="${selected%%|*}"

config=/tmp/redis-sentinel-node.conf
umask 077
cat >"${config}" <<EOF
appendonly yes
appendfsync everysec
save 60 1
masterauth ${redis_password}
requirepass ${redis_password}
replica-announce-ip ${node_name}
replica-announce-port 6379
EOF
if [ "${selected_host}" != "${node_name}" ]; then
  printf 'replicaof %s 6379\n' "${selected_host}" >>"${config}"
fi
exec redis-server "${config}"
