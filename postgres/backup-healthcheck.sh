#!/bin/sh
# Fast RPO/atomic-publication check; full pg_restore/SHA verification happens
# before backup-loop publishes the latest.* symlinks.
set -eu

backup_dir="${BACKUP_DIR:-/backups}"
interval="${BACKUP_INTERVAL_S:-3600}"
cd "${backup_dir}"

[ -L latest.dump ] && [ -L latest.dump.sha256 ]
dump_target="$(readlink latest.dump)"
sha_target="$(readlink latest.dump.sha256)"
[ -n "${dump_target}" ] && [ "${sha_target}" = "${dump_target}.sha256" ]
[ -s "${dump_target}" ] && [ -s "${sha_target}" ]

mtime="$(stat -c '%Y' "${dump_target}")"
now="$(date +%s)"
age=$((now - mtime))
max_age=$((interval * 2 + 60))
[ "${age}" -ge 0 ] && [ "${age}" -le "${max_age}" ]
