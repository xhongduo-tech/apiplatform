#!/bin/sh
set -eu

# Redis Sentinel invokes this hook after every successful failover. Persist a
# stable service identity instead of a Docker-network IP so that a later
# `docker compose down && up` can safely rebind the elected master to the new
# network address. The hook is idempotent and every Sentinel owns its own copy.

[ "$#" -eq 7 ] || {
  echo "unexpected Sentinel reconfiguration argument count" >&2
  exit 2
}

master_name="$1"
role="$2"
state="$3"
to_address="$6"
to_port="$7"
expected_master="${REDIS_SENTINEL_MASTER:-apiplatform-master}"
primary_address="${REDIS_SENTINEL_PRIMARY_ADDRESS:-169.254.240.10}"
replica_address="${REDIS_SENTINEL_REPLICA_ADDRESS:-169.254.240.11}"

[ "${master_name}" = "${expected_master}" ] || {
  echo "unexpected Sentinel master name" >&2
  exit 2
}
case "${role}" in
  leader|observer) ;;
  *) echo "unexpected Sentinel reconfiguration role" >&2; exit 2 ;;
esac
case "${state}" in
  start|failover) ;;
  *) echo "unexpected Sentinel reconfiguration state" >&2; exit 2 ;;
esac
[ "${to_port}" = "6379" ] || {
  echo "unexpected Redis master port" >&2
  exit 2
}

if [ "${to_address}" = "redis" ] || [ "${to_address}" = "${primary_address}" ]; then
  selected=redis
elif [ "${to_address}" = "redis-replica" ] \
  || [ "${to_address}" = "${replica_address}" ]; then
  selected=redis-replica
else
  # Exit 1 asks Sentinel to retry. A promoted node should remain resolvable;
  # accepting an unknown address would make the persisted recovery decision
  # unsafe.
  echo "could not map the elected Redis address to a stable node identity" >&2
  exit 1
fi

state_file=/data/master-identity
umask 077
temp_file="$(mktemp /data/.master-identity.XXXXXX)"
trap 'rm -f "${temp_file}"' EXIT INT TERM
printf '%s\n' "${selected}" >"${temp_file}"
chmod 0600 "${temp_file}"
mv -f "${temp_file}" "${state_file}"
trap - EXIT INT TERM
