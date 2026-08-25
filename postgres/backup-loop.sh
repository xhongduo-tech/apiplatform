#!/bin/sh
# Rotating, verified PostgreSQL recovery snapshots. Storage encryption and
# off-site replication remain the operator's responsibility.
set -eu
umask 077

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-platform}"
PGPASSWORD="${PGPASSWORD:?必须通过环境变量设置 PGPASSWORD}"
PGDATABASE="${PGDATABASE:-openapi_platform}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_S="${BACKUP_INTERVAL_S:-3600}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-168}"
BACKUP_FAILURE_RETRY_S="${BACKUP_FAILURE_RETRY_S:-60}"
BACKUP_MAX_CONSECUTIVE_FAILURES="${BACKUP_MAX_CONSECUTIVE_FAILURES:-3}"
# Backend 镜像以 UID/GID 10001 非 root 运行；最终快照仅向该只读组开放。
BACKUP_READER_GID="${BACKUP_READER_GID:-10001}"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

case "${BACKUP_INTERVAL_S}" in *[!0-9]*|"") echo "invalid BACKUP_INTERVAL_S" >&2; exit 2;; esac
case "${BACKUP_RETENTION_COUNT}" in *[!0-9]*|"") echo "invalid BACKUP_RETENTION_COUNT" >&2; exit 2;; esac
case "${BACKUP_FAILURE_RETRY_S}" in *[!0-9]*|"") echo "invalid BACKUP_FAILURE_RETRY_S" >&2; exit 2;; esac
case "${BACKUP_MAX_CONSECUTIVE_FAILURES}" in *[!0-9]*|"") echo "invalid BACKUP_MAX_CONSECUTIVE_FAILURES" >&2; exit 2;; esac
case "${BACKUP_READER_GID}" in *[!0-9]*|"") echo "invalid BACKUP_READER_GID" >&2; exit 2;; esac
[ "${BACKUP_INTERVAL_S}" -ge 60 ] || { echo "BACKUP_INTERVAL_S must be >= 60" >&2; exit 2; }
[ "${BACKUP_RETENTION_COUNT}" -ge 2 ] || { echo "BACKUP_RETENTION_COUNT must be >= 2" >&2; exit 2; }
[ "${BACKUP_FAILURE_RETRY_S}" -ge 10 ] || { echo "BACKUP_FAILURE_RETRY_S must be >= 10" >&2; exit 2; }
[ "${BACKUP_MAX_CONSECUTIVE_FAILURES}" -ge 1 ] || { echo "BACKUP_MAX_CONSECUTIVE_FAILURES must be >= 1" >&2; exit 2; }
[ "${BACKUP_READER_GID}" -ge 1 ] || { echo "BACKUP_READER_GID must be >= 1" >&2; exit 2; }

mkdir -p "${BACKUP_DIR}"
chgrp "${BACKUP_READER_GID}" "${BACKUP_DIR}"
chmod 0750 "${BACKUP_DIR}"

backup_once() {
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  name="openapi_platform_${stamp}.dump"
  target="${BACKUP_DIR}/${name}"
  tmp="${target}.tmp"

  if ! pg_dump --format=custom --compress=6 --no-owner --no-acl -f "${tmp}"; then
    rm -f "${tmp}"
    echo "pg-backup: dump failed at ${stamp}; previous snapshots retained" >&2
    return 1
  fi
  if ! pg_restore --list "${tmp}" >/dev/null 2>&1; then
    rm -f "${tmp}"
    echo "pg-backup: verification failed at ${stamp}; snapshot discarded" >&2
    return 1
  fi

  mv -f "${tmp}" "${target}"
  (cd "${BACKUP_DIR}" && sha256sum "${name}" > "${name}.sha256")
  # 先固定最终文件的共享只读权限，再原子切换 latest；backend 永远不会看到
  # 一个已发布但因 root:root 0600 而不可读的快照。
  chgrp "${BACKUP_READER_GID}" "${target}" "${target}.sha256"
  chmod 0640 "${target}" "${target}.sha256"
  ln -sfn "${name}" "${BACKUP_DIR}/latest.dump"
  ln -sfn "${name}.sha256" "${BACKUP_DIR}/latest.dump.sha256"

  # File names are timestamp-only and contain no whitespace. Keep newest N.
  ls -1t "${BACKUP_DIR}"/openapi_platform_*.dump 2>/dev/null \
    | awk -v keep="${BACKUP_RETENTION_COUNT}" 'NR > keep' \
    | while IFS= read -r old; do
        rm -f "${old}" "${old}.sha256"
      done
  echo "pg-backup: verified ${target} ($(du -h "${target}" | cut -f1))"
}

echo "pg-backup: interval=${BACKUP_INTERVAL_S}s retention=${BACKUP_RETENTION_COUNT}"
failures=0
while true; do
  if backup_once; then
    failures=0
    sleep "${BACKUP_INTERVAL_S}"
  else
    failures=$((failures + 1))
    echo "pg-backup: consecutive failures=${failures}/${BACKUP_MAX_CONSECUTIVE_FAILURES}" >&2
    if [ "${failures}" -ge "${BACKUP_MAX_CONSECUTIVE_FAILURES}" ]; then
      echo "pg-backup: failure threshold reached; exiting for container restart" >&2
      exit 1
    fi
    sleep "${BACKUP_FAILURE_RETRY_S}"
  fi
done
