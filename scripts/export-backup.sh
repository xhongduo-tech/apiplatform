#!/usr/bin/env bash
# ============================================================================
# 导出数据库备份（在部署机上执行）
#
#   bash scripts/export-backup.sh            # 取到当前目录
#   bash scripts/export-backup.sh /data/bak  # 取到指定目录
#
# pg-backup 边车默认每小时生成 PostgreSQL custom-format 快照，先用 pg_restore
# 校验再原子发布，并保留最近 168 份。本脚本导出 latest.dump 及匹配的校验和。
# ============================================================================
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# shellcheck source=scripts/offline-env.sh
source "${ROOT}/scripts/offline-env.sh"
offline_init_compose

OUT_DIR="${1:-.}"
[[ -d "${OUT_DIR}" ]] || { echo "✗ 输出目录不存在：${OUT_DIR}"; exit 1; }

# 发布指针只会指向已通过 pg_restore --list 的完整快照。
if ! ${DOCKER_COMPOSE} exec -T pg-backup test -f /backups/latest.dump 2>/dev/null; then
  cat <<EOF
✗ 备份文件不存在：pg-backup:/backups/latest.dump

  确认 pg-backup 在跑：${DOCKER_COMPOSE} ps pg-backup
  首次部署可能要等首个备份周期（默认 3600 秒）结束。
EOF
  exit 1
fi

echo "▶ 在备份容器内复核最新快照"
${DOCKER_COMPOSE} exec -T pg-backup sh -c \
  'cd /backups && sha256sum -c latest.dump.sha256 >/dev/null && pg_restore --list latest.dump >/dev/null'
EXPECTED="$(${DOCKER_COMPOSE} exec -T pg-backup awk '{print $1}' /backups/latest.dump.sha256 | tr -d '\r\n')"

OUT="${OUT_DIR%/}/openapi_platform_$(date +%Y%m%d_%H%M%S).dump"
if [[ -e "${OUT}" || -e "${OUT}.sha256" ]]; then
  echo "✗ 输出文件已存在，拒绝覆盖：${OUT}" >&2
  exit 1
fi
TMP="${OUT}.partial.$$"
cleanup_partial() { rm -f "${TMP}" "${TMP}.sha256"; }
trap cleanup_partial EXIT
echo "▶ 导出卷内最新备份 → ${OUT}"
${DOCKER_COMPOSE} cp --follow-link pg-backup:/backups/latest.dump "${TMP}"
chmod 600 "${TMP}"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMP}" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "${TMP}" | awk '{print $1}')"
fi
if [[ -z "${EXPECTED}" || "${ACTUAL}" != "${EXPECTED}" ]]; then
  echo "✗ 导出后的 SHA-256 与卷内快照不一致，拒绝交付" >&2
  exit 1
fi
printf '%s  %s\n' "${ACTUAL}" "$(basename "${OUT}")" > "${TMP}.sha256"
chmod 600 "${TMP}.sha256"
mv "${TMP}" "${OUT}"
mv "${TMP}.sha256" "${OUT}.sha256"
trap - EXIT
echo "✔ 完成：${OUT} ($(du -h "${OUT}" | cut -f1))"
echo "  校验和：${OUT}.sha256"
echo "  建议定期把它同步到另一台机器/移动介质，防单机盘损。"
echo "  恢复：bash scripts/restore-backup.sh ${OUT}"
