#!/usr/bin/env bash
# ============================================================================
# 从备份恢复（覆盖当前库）
#
#   bash scripts/restore-backup.sh ./openapi_platform_20260805_120000.dump
#
# ⚠ 破坏性操作：会停止写入服务、重建空数据库，再导入快照并迁移到当前 revision。
#   任一步失败都会保持写入服务停止，等待人工排障，避免在半恢复状态继续运行。
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# shellcheck source=scripts/offline-env.sh
source "${ROOT}/scripts/offline-env.sh"
offline_init_compose

DUMP="${1:?用法：bash scripts/restore-backup.sh <备份文件.sql|.dump>}"
[[ -f "${DUMP}" ]] || { echo "✗ 找不到文件：${DUMP}"; exit 1; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [[ -f "${DUMP}.sha256" ]]; then
  echo "▶ 校验备份 SHA-256"
  expected="$(awk 'NR == 1 {print $1}' "${DUMP}.sha256")"
  actual="$(sha256_file "${DUMP}")"
  [[ -n "${expected}" && "${actual}" == "${expected}" ]] || {
    echo "✗ 备份 SHA-256 不匹配，拒绝恢复" >&2
    exit 1
  }
else
  if [[ "${ALLOW_UNVERIFIED_BACKUP_RESTORE:-false}" != "true" ]]; then
    echo "✗ 缺少 ${DUMP}.sha256；默认拒绝恢复未经完整性校验的备份" >&2
    echo "  仅在已通过其它可信通道验证时，显式设置 ALLOW_UNVERIFIED_BACKUP_RESTORE=true" >&2
    exit 1
  fi
  echo "⚠ 已显式允许恢复无 SHA-256 边车文件的备份" >&2
fi

base="$(basename "${DUMP}")"
container_dump="/tmp/apiplatform_restore_input"
echo "▶ 上传并预检备份"
${DOCKER_COMPOSE} cp "${DUMP}" "postgres:${container_dump}"
cleanup_restore_upload() {
  ${DOCKER_COMPOSE} exec -T postgres rm -f "${container_dump}" >/dev/null 2>&1 || true
}
restore_succeeded=0
restore_failure_guard() {
  cleanup_restore_upload
  if [[ "${restore_succeeded}" -ne 1 ]]; then
    echo "✗ 恢复未完成；backend/nginx/pg-backup（若已停止）将保持停止，请排障后重试" >&2
  fi
}
trap restore_failure_guard EXIT

is_custom=0
if [[ "${base}" != *.sql ]]; then
  ${DOCKER_COMPOSE} exec -T postgres pg_restore --list "${container_dump}" >/dev/null
  is_custom=1
fi

cat <<EOF
════════════════════════════════════════════
 恢复到当前 Compose 项目的 PostgreSQL
════════════════════════════════════════════
  备份文件 : ${DUMP} ($(du -h "${DUMP}" | cut -f1))
  目标库   : openapi_platform @ postgres（compose 服务）

  ⚠ 恢复会停止 nginx/backend/pg-backup，终止数据库连接并删除后重建
    openapi_platform。请同时确认没有 Compose 之外的外部写入方。

EOF
read -r -p "确认恢复？输入 RESTORE 回车：" ans
[[ "${ans}" == "RESTORE" ]] || { echo "已取消"; exit 1; }

service_running() {
  local id
  id="$(${DOCKER_COMPOSE} ps -q "$1" 2>/dev/null || true)"
  [[ -n "${id}" ]] && [[ "$(docker inspect -f '{{.State.Status}}' "${id}" 2>/dev/null || true)" == "running" ]]
}

restart_nginx=0
restart_backend=0
restart_backup=0
service_running nginx && restart_nginx=1
service_running backend && restart_backend=1
service_running pg-backup && restart_backup=1

echo "▶ 停止所有平台写入/入口服务"
${DOCKER_COMPOSE} stop nginx backend pg-backup >/dev/null

echo "▶ 终止旧连接并重建空数据库"
${DOCKER_COMPOSE} exec -T postgres sh -ec '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -U platform -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '\''openapi_platform'\'' AND pid <> pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS openapi_platform;" \
    -c "CREATE DATABASE openapi_platform OWNER platform TEMPLATE template0;"
'

if [[ "${is_custom}" -eq 0 ]]; then
  echo "▶ psql 单事务导入旧版明文 SQL"
  ${DOCKER_COMPOSE} exec -T postgres sh -ec '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql -U platform -d openapi_platform -v ON_ERROR_STOP=1 --single-transaction \
      -f /tmp/apiplatform_restore_input
  '
else
  echo "▶ pg_restore 向空数据库执行单事务恢复"
  ${DOCKER_COMPOSE} exec -T postgres sh -ec '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    pg_restore -U platform -d openapi_platform --no-owner --no-acl \
      --single-transaction /tmp/apiplatform_restore_input
  '
fi

echo "▶ 在写入服务仍停止时迁移到当前代码 revision"
${DOCKER_COMPOSE} run --rm --no-deps --entrypoint python backend -m app.config_preflight
${DOCKER_COMPOSE} run --rm --no-deps --entrypoint python backend -m app.migration_lock

echo "▶ 验证核心表、Alembic revision 与数据加密密钥"
${DOCKER_COMPOSE} exec -T postgres sh -ec '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -U platform -d openapi_platform -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM pg_class WHERE relname IN ('\''users'\'','\''api_keys'\'','\''model_registry'\'','\''alembic_version'\'') HAVING count(*) = 4;"
' | grep -qx '4'
${DOCKER_COMPOSE} run --rm --no-deps --entrypoint python backend -c '
from sqlalchemy import select
from app.database import SessionLocal
from app.models import ModelRegistryORM, PlatformSettingORM
with SessionLocal() as db:
    model_count = 0
    setting_count = 0
    # Read every protected row.  Checking only one arbitrary row can miss a
    # wrong DATA_ENCRYPTION_KEY when that row has no encrypted values.
    for model in db.scalars(select(ModelRegistryORM)):
        _ = model.base_url, model.api_key, model.custom_headers, model.extra
        model_count += 1
    for setting in db.scalars(select(PlatformSettingORM)):
        _ = setting.value
        setting_count += 1
print(f"restore decryption check passed: models={model_count} settings={setting_count}")
'

cleanup_restore_upload
restore_succeeded=1
trap - EXIT

echo "✔ 恢复完成"
[[ "${restart_backup}" -eq 1 ]] && ${DOCKER_COMPOSE} up -d pg-backup
[[ "${restart_backend}" -eq 1 ]] && ${DOCKER_COMPOSE} up -d backend
[[ "${restart_nginx}" -eq 1 ]] && ${DOCKER_COMPOSE} up -d nginx
echo "  恢复前处于运行状态的服务已重新启动；请检查 /health 与备份状态。"
