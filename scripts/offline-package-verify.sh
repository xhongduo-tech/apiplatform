#!/usr/bin/env bash
# ============================================================================
# 离线包 fail-closed 校验（build-offline 产出后 / deploy-offline 部署前调用）
#
# 用法：
#   OFFLINE_DIR=/path/to/offline-images bash scripts/offline-package-verify.sh deploy
#   bash scripts/offline-package-verify.sh build
#
# 本脚本验证包内容、完整 commit、镜像内容 ID 与上游 RepoDigest 绑定。它不把本地
# SHA-256 冒充发布者签名；正式发行还必须验证 release workflow 生成的签名证明。
# ============================================================================
set -euo pipefail

MODE="${1:-deploy}"   # build | deploy
case "${MODE}" in
  build|deploy) ;;
  *) echo "✗ mode 只能是 build 或 deploy：${MODE}"; exit 2 ;;
esac

resolve_offline_dir() {
  if [[ -n "${OFFLINE_DIR:-}" ]]; then
    echo "${OFFLINE_DIR}"
    return
  fi
  if [[ -f ./deploy-offline.sh && -f ./docker-compose.yml ]]; then
    pwd
    return
  fi
  if [[ -d ./offline-images && -f ./offline-images/deploy-offline.sh ]]; then
    echo "$(cd ./offline-images && pwd)"
    return
  fi
  echo "offline-images"
}

OFFLINE_DIR="$(resolve_offline_dir)"
cd "${OFFLINE_DIR}"

REQUIRED_FILES=(
  apiplatform-backend.tar.gz
  apiplatform-nginx.tar.gz
  apiplatform-postgres.tar.gz
  apiplatform-redis.tar.gz
  apiplatform-prometheus.tar.gz
  apiplatform-grafana.tar.gz
  docker-compose.yml
  deploy-offline.sh
  OFFLINE.md
  image-manifest.txt
  package-info.txt
  package-manifest.txt
  checksums.sha256
  .env.template
)

REQUIRED_DIRS=(monitoring postgres scripts)
REQUIRED_SCRIPTS=(
  scripts/db-seed.sh
  scripts/export-backup.sh
  scripts/restore-backup.sh
  scripts/export-seed.sh
  scripts/offline-env.sh
  scripts/offline-package-verify.sh
  scripts/compose.sh
)

missing=0

check_file() {
  local file=$1
  if [[ ! -f "${file}" || ! -s "${file}" ]]; then
    echo "✗ 缺少必需文件：${file}"
    missing=$((missing + 1))
  fi
}

check_dir() {
  local dir=$1
  if [[ ! -d "${dir}" ]]; then
    echo "✗ 缺少必需目录：${dir}/"
    missing=$((missing + 1))
  fi
}

manifest_value() {
  local file=$1 key=$2 values count
  values="$(awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print }' "${file}")"
  count="$(printf '%s\n' "${values}" | grep -c . || true)"
  [[ "${count}" -eq 1 ]] || return 1
  printf '%s\n' "${values}"
}

comment_value() {
  local file=$1 key=$2 values count
  values="$(sed -n "s/^# ${key}=//p" "${file}")"
  count="$(printf '%s\n' "${values}" | grep -c . || true)"
  [[ "${count}" -eq 1 ]] || return 1
  printf '%s\n' "${values}"
}

compose_default_image() {
  local variable=$1 values count
  values="$(awk -v variable="${variable}" '
    {
      marker = "${" variable ":-"
      start = index($0, marker)
      if (start == 0) next
      rest = substr($0, start + length(marker))
      finish = index(rest, "}")
      if (finish > 1) print substr(rest, 1, finish - 1)
    }
  ' docker-compose.yml | LC_ALL=C sort -u)"
  count="$(printf '%s\n' "${values}" | grep -c . || true)"
  [[ "${count}" -eq 1 ]] || return 1
  printf '%s\n' "${values}"
}

require_repo_digest() {
  local ref=$1
  [[ "${ref}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]
}

echo "▶ 校验离线包全量清单（${OFFLINE_DIR}，mode=${MODE}）"
for file in "${REQUIRED_FILES[@]}"; do check_file "${file}"; done
for dir in "${REQUIRED_DIRS[@]}"; do check_dir "${dir}"; done
for file in "${REQUIRED_SCRIPTS[@]}"; do check_file "${file}"; done
if [[ "${missing}" -gt 0 ]]; then
  echo "✗ 离线包缺少 ${missing} 个必需项"
  exit 1
fi

# 包中只允许目录和普通文件：拒绝符号链接、FIFO、socket 和设备节点，
# 避免 checksum 无法覆盖的条目越界读取或在校验时阻塞。
if find . -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
  echo "✗ 发行包中发现非普通文件条目，拒绝继续"
  exit 1
fi

# Checksums prove coverage but are not an authorization list: an attacker able
# to add a file could also recompute checksums. Enforce the exact deployment
# surface emitted by build-offline.sh, with only flat package archives allowed
# below the optional offline-wheels directory and a top-level runtime .env.
is_allowed_file() {
  local path=$1 wheel_name
  case "${path}" in
    apiplatform-backend.tar.gz|apiplatform-nginx.tar.gz|\
    apiplatform-postgres.tar.gz|apiplatform-redis.tar.gz|\
    apiplatform-prometheus.tar.gz|apiplatform-grafana.tar.gz|\
    docker-compose.yml|deploy-offline.sh|OFFLINE.md|image-manifest.txt|\
    package-info.txt|package-manifest.txt|checksums.sha256|.env.template|.env|\
    monitoring/alerts.yml|monitoring/prometheus.yml|\
    monitoring/grafana/dashboards/apiplatform-dashboard.json|\
    monitoring/grafana/provisioning/alerting/empty.yml|\
    monitoring/grafana/provisioning/dashboards/provider.yml|\
    monitoring/grafana/provisioning/datasources/prometheus.yml|\
    monitoring/grafana/provisioning/plugins/empty.yml|\
    postgres/backup-healthcheck.sh|postgres/backup-loop.sh|\
    postgres/config/pg_hba.conf|postgres/config/postgresql.conf|\
    scripts/db-seed.sh|scripts/export-backup.sh|scripts/restore-backup.sh|\
    scripts/export-seed.sh|scripts/offline-env.sh|\
    scripts/offline-package-verify.sh|scripts/compose.sh)
      return 0
      ;;
    offline-wheels/*)
      wheel_name="${path#offline-wheels/}"
      [[ "${wheel_name}" != */* && \
         "${wheel_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*\.(whl|zip|tar\.gz)$ ]]
      return
      ;;
    *)
      return 1
      ;;
  esac
}

while IFS= read -r -d '' package_path; do
  package_path="${package_path#./}"
  if ! is_allowed_file "${package_path}"; then
    echo "✗ 离线包包含白名单外文件：${package_path}"
    exit 1
  fi
done < <(find . -type f -print0)

while IFS= read -r -d '' package_dir; do
  package_dir="${package_dir#./}"
  case "${package_dir}" in
    monitoring|monitoring/grafana|monitoring/grafana/dashboards|\
    monitoring/grafana/provisioning|\
    monitoring/grafana/provisioning/alerting|\
    monitoring/grafana/provisioning/dashboards|\
    monitoring/grafana/provisioning/datasources|\
    monitoring/grafana/provisioning/plugins|postgres|postgres/config|scripts|\
    offline-wheels)
      ;;
    *)
      echo "✗ 离线包包含白名单外目录：${package_dir}/"
      exit 1
      ;;
  esac
done < <(find . -mindepth 1 -type d -print0)
echo "  ✓ 文件与目录均在离线部署白名单内"

# 严禁任何位置的数据库导出、私钥、嵌套环境文件或生成物。
# 顶层 .env 只是目标机首次部署生成的运行配置，不计入发行 checksum。
if find . -type f \
    \( -iname '*.dump' -o -iname '*.sql' -o -iname '*.backup' \
       -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' \
       -o -iname '*.log' -o -iname '*.pyc' -o -iname '*.pyo' -o -name '.DS_Store' \
       -o -iname '*.db' -o -iname '*.sqlite' -o -iname '*.sqlite3' \) \
    -print -quit | grep -q .; then
  echo "✗ 发行包中发现数据库导出、私钥或生成物，拒绝继续"
  exit 1
fi
if find . -type f \( -name '.env' -o -name '.env.*' \) \
    ! -path './.env' ! -path './.env.template' -print -quit | grep -q .; then
  echo "✗ 发行包中发现嵌套环境文件，拒绝继续"
  exit 1
fi
if grep -RIlE --exclude='checksums.sha256' \
    '^[[:space:]]*-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----[[:space:]]*$' \
    . 2>/dev/null | grep -q .; then
  echo "✗ 发行包中发现私钥内容，拒绝继续"
  exit 1
fi
echo "  ✓ 未夹带数据库快照、私钥、嵌套 .env 或生成物"

# 清单必须绑定同一个完整 commit，禁止短 SHA、unknown 或字段漂移。
git_commit="$(manifest_value package-info.txt git_commit || true)"
package_commit="$(manifest_value package-manifest.txt git_commit || true)"
image_commit="$(comment_value image-manifest.txt git_commit || true)"
if [[ ! "${git_commit}" =~ ^[0-9a-f]{40}$ || \
      "${package_commit}" != "${git_commit}" || "${image_commit}" != "${git_commit}" ]]; then
  echo "✗ package/image manifest 未绑定同一个完整 40 位 Git commit"
  exit 1
fi

publisher_status="$(manifest_value package-info.txt publisher_status || true)"
package_status="$(manifest_value package-manifest.txt publisher_status || true)"
manifest_status="$(comment_value image-manifest.txt publisher_status || true)"
if [[ "${publisher_status}" != UNSIGNED_USER_BUILD || \
      "${package_status}" != "${publisher_status}" || \
      "${manifest_status}" != "${publisher_status}" ]]; then
  echo "✗ 未签名包不得声称官方发布者身份"
  exit 1
fi

project_source_kind="$(manifest_value package-info.txt project_source_kind || true)"
package_source_kind="$(manifest_value package-manifest.txt project_source_kind || true)"
if [[ "${project_source_kind}" != source-build && "${project_source_kind}" != oci-release ]] || \
   [[ "${package_source_kind}" != "${project_source_kind}" ]]; then
  echo "✗ 项目镜像来源类型缺失或不一致"
  exit 1
fi

target_platform="$(manifest_value package-info.txt target_platform || true)"
case "${target_platform}" in
  linux/amd64) expected_arch=amd64 ;;
  linux/arm64) expected_arch=arm64 ;;
  *) echo "✗ 非法 target_platform：${target_platform}"; exit 1 ;;
esac

package_platform="$(manifest_value package-manifest.txt target_platform || true)"
image_platform="$(comment_value image-manifest.txt target_platform || true)"
vite_api_origin="$(manifest_value package-info.txt vite_api_origin || true)"
package_vite_origin="$(manifest_value package-manifest.txt vite_api_origin || true)"
image_vite_origin="$(comment_value image-manifest.txt vite_api_origin || true)"
build_variant_sha256="$(manifest_value package-info.txt build_variant_sha256 || true)"
package_variant_sha256="$(manifest_value package-manifest.txt build_variant_sha256 || true)"
image_variant_sha256="$(comment_value image-manifest.txt build_variant_sha256 || true)"
if [[ "${package_platform}" != "${target_platform}" || \
      "${image_platform}" != "${target_platform}" || \
      ! "${vite_api_origin}" =~ ^https?://[^[:space:][:cntrl:]]+$ || \
      "${package_vite_origin}" != "${vite_api_origin}" || \
      "${image_vite_origin}" != "${vite_api_origin}" || \
      ! "${build_variant_sha256}" =~ ^[0-9a-f]{64}$ || \
      "${package_variant_sha256}" != "${build_variant_sha256}" || \
      "${image_variant_sha256}" != "${build_variant_sha256}" ]]; then
  echo "✗ 构建平台、前端 origin 或变体指纹在清单间不一致"
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  expected_variant="$(printf '%s\0%s\0' "${target_platform}" "${vite_api_origin}" | sha256sum | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  expected_variant="$(printf '%s\0%s\0' "${target_platform}" "${vite_api_origin}" | shasum -a 256 | awk '{print $1}')"
else
  echo "✗ 缺少 sha256sum 或 shasum"; exit 1
fi
if [[ "${expected_variant}" != "${build_variant_sha256}" ]]; then
  echo "✗ build_variant_sha256 未绑定 target_platform 与 vite_api_origin"
  exit 1
fi

expected_columns='# columns=role tag local_image_id architecture source_kind source_ref source_digest git_commit'
if [[ "$(comment_value image-manifest.txt format || true)" != 3 ]] || \
   ! grep -Fqx "${expected_columns}" image-manifest.txt; then
  echo "✗ image-manifest.txt 不是受支持的 format=3"
  exit 1
fi

roles_seen=' '
image_count=0
while IFS=$'\t' read -r role tag image_id arch source_kind source_ref source_digest line_commit extra; do
  [[ -z "${role}" || "${role}" == \#* ]] && continue
  image_count=$((image_count + 1))
  if [[ -n "${extra:-}" || ! "${role}" =~ ^(backend|nginx|postgres|redis|prometheus|grafana)$ || \
        "${roles_seen}" == *" ${role} "* ]]; then
    echo "✗ image-manifest.txt 含重复/未知 role 或额外字段：${role}"
    exit 1
  fi
  roles_seen="${roles_seen}${role} "
  if [[ ! "${tag}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ || "${tag}" == *:latest || \
        ! "${image_id}" =~ ^sha256:[0-9a-f]{64}$ || "${arch}" != "${expected_arch}" || \
        "${line_commit}" != "${git_commit}" ]]; then
    echo "✗ ${role} 的 tag/image ID/架构/commit 绑定无效"
    exit 1
  fi

  expected_content_tag="apiplatform-${role}:sha256-${image_id#sha256:}"
  if [[ "${tag}" != "${expected_content_tag}" ]]; then
    echo "✗ ${role} 的离线 tag 未由完整本地 image ID 寻址"
    exit 1
  fi

  expected_tag="$(manifest_value package-info.txt "${role}_image" || true)"
  template_key="$(printf '%s_IMAGE' "${role}" | tr '[:lower:]' '[:upper:]')"
  template_tag="$(manifest_value .env.template "${template_key}" || true)"
  if [[ "${tag}" != "${expected_tag}" || "${tag}" != "${template_tag}" ]]; then
    echo "✗ ${role} 镜像 tag 在 image manifest、package-info 与 .env.template 间漂移"
    exit 1
  fi
  if [[ -f .env ]]; then
    runtime_tag="$(manifest_value .env "${template_key}" || true)"
    if [[ "${runtime_tag}" != "${tag}" ]]; then
      echo "✗ .env 中 ${template_key} 偏离离线 manifest，拒绝可变镜像覆盖"
      exit 1
    fi
  fi

  case "${role}" in
    backend|nginx)
      if [[ "${source_kind}" != "${project_source_kind}" ]]; then
        echo "✗ ${role} 来源类型与 package-info 不一致"; exit 1
      fi
      if [[ "${source_kind}" == source-build ]]; then
        if [[ "${source_ref}" != "git:${git_commit}" || "${source_digest}" != "${image_id}" ]]; then
          echo "✗ ${role} 源码构建未绑定 commit 与本地内容 digest"; exit 1
        fi
      elif ! require_repo_digest "${source_ref}" || [[ "${source_digest}" != "${source_ref##*@}" ]]; then
        echo "✗ ${role} 正式镜像未绑定完整 RepoDigest"; exit 1
      fi
      ;;
    postgres|redis|prometheus|grafana)
      compose_variable="$(printf '%s_IMAGE' "${role}" | tr '[:lower:]' '[:upper:]')"
      compose_ref="$(compose_default_image "${compose_variable}" || true)"
      if [[ "${source_kind}" != oci-upstream ]] || ! require_repo_digest "${source_ref}" || \
         [[ "${source_ref}" != "${compose_ref}" || "${source_digest}" != "${source_ref##*@}" ]]; then
        echo "✗ ${role} 未绑定 docker-compose.yml 的完整上游 RepoDigest"; exit 1
      fi
      ;;
  esac
done < image-manifest.txt

if [[ "${image_count}" -ne 6 || "${roles_seen}" != *' backend '* || \
      "${roles_seen}" != *' nginx '* || "${roles_seen}" != *' postgres '* || \
      "${roles_seen}" != *' redis '* || "${roles_seen}" != *' prometheus '* || \
      "${roles_seen}" != *' grafana '* ]]; then
  echo "✗ image-manifest.txt 必须且只能包含六个预期镜像"
  exit 1
fi
echo "  ✓ 六个镜像均绑定完整 commit、内容 digest 与不可变来源"

# 先拒绝危险/重复路径，再验证 SHA-256，并要求 checksums 覆盖包中每个文件。
if ! awk '
  NF != 2 || $1 !~ /^[0-9a-f]{64}$/ { exit 1 }
  {
    path=$2; sub(/^\*/, "", path); sub(/^\.\//, "", path)
    if (path == "" || path ~ /^\// || path ~ /(^|\/)\.\.($|\/)/ || seen[path]++) exit 1
  }
' checksums.sha256; then
  echo "✗ checksums.sha256 含非法 digest、重复项或路径穿越"
  exit 1
fi

tmp_actual="$(mktemp "${TMPDIR:-/tmp}/apiplatform-files.XXXXXX")"
tmp_listed="$(mktemp "${TMPDIR:-/tmp}/apiplatform-checksums.XXXXXX")"
trap 'rm -f "${tmp_actual}" "${tmp_listed}"' EXIT
find . -type f ! -name checksums.sha256 ! -name .env -print \
  | sed 's#^\./##' | LC_ALL=C sort > "${tmp_actual}"
awk '{ path=$2; sub(/^\*/, "", path); sub(/^\.\//, "", path); print path }' checksums.sha256 \
  | LC_ALL=C sort > "${tmp_listed}"
if ! cmp -s "${tmp_actual}" "${tmp_listed}"; then
  echo "✗ checksums.sha256 未精确覆盖包内全部文件"
  diff -u "${tmp_listed}" "${tmp_actual}" || true
  exit 1
fi

checksum_ok=0
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c checksums.sha256 >/dev/null 2>&1 && checksum_ok=1
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c checksums.sha256 >/dev/null 2>&1 && checksum_ok=1
else
  echo "✗ 缺少 sha256sum 或 shasum"; exit 1
fi
if [[ "${checksum_ok}" -ne 1 ]]; then
  echo "✗ checksums.sha256 与包内容不一致（拷贝损坏或内容发生变化）"
  exit 1
fi
echo "  ✓ checksums.sha256 精确覆盖并匹配全部文件"

if [[ "${MODE}" == build ]]; then
  while IFS=$'\t' read -r role tag expected_id _rest; do
    [[ -z "${role}" || "${role}" == \#* ]] && continue
    actual_id="$(docker image inspect "${tag}" --format '{{.Id}}' 2>/dev/null || true)"
    if [[ "${actual_id}" != "${expected_id}" ]]; then
      echo "✗ 构建机上的 ${tag} 与 image-manifest 内容 digest 不一致"; exit 1
    fi
  done < image-manifest.txt
  echo "  ✓ 构建机镜像内容 ID 与 manifest 一致"
fi

echo "⚠ 此包内部状态为 UNSIGNED_USER_BUILD：SHA-256 只证明包内一致性，不能证明发布者身份。"
echo "  官方离线发行必须额外验证 release workflow 对外层发行 manifest 的 Sigstore 签名。"
echo "✔ 离线包全量清单校验通过"
