#!/usr/bin/env bash
# ============================================================================
# 离线包全量清单校验（build-offline 产出后 / deploy-offline 部署前调用）
#
# 用法：
#   OFFLINE_DIR=/path/to/offline-images bash scripts/offline-package-verify.sh deploy
#   bash scripts/offline-package-verify.sh build    # 在仓库根目录，默认 ./offline-images
# ============================================================================
set -euo pipefail

MODE="${1:-deploy}"   # build | deploy

# 解析离线包根目录：deploy 时调用方已在包内，不能 cd offline-images
resolve_offline_dir() {
  if [[ -n "${OFFLINE_DIR:-}" ]]; then
    echo "${OFFLINE_DIR}"
    return
  fi
  # 当前目录已是离线包根（含 deploy-offline.sh + docker-compose.yml）
  if [[ -f ./deploy-offline.sh && -f ./docker-compose.yml ]]; then
    pwd
    return
  fi
  # build-offline 在仓库根目录执行
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
  checksums.sha256
  .env.template
)

# package-manifest.txt 仅新版 build 产出；deploy 时对旧包放宽
LEGACY_OPTIONAL_FILES=(
  package-manifest.txt
)

REQUIRED_DIRS=(
  monitoring
  postgres
  scripts
)

REQUIRED_SCRIPTS=(
  scripts/db-seed.sh
  scripts/export-backup.sh
  scripts/restore-backup.sh
  scripts/offline-env.sh
)

missing=0
warn=0

check_file() {
  local f=$1 req=${2:-yes}
  if [[ -f "${f}" && -s "${f}" ]]; then
    return 0
  fi
  if [[ "${req}" == "yes" ]]; then
    echo "✗ 缺少必需文件：${f}"
    missing=$((missing + 1))
  else
    echo "⚠ 可选文件缺失：${f}"
    warn=$((warn + 1))
  fi
}

check_dir() {
  local d=$1
  if [[ -d "${d}" ]]; then
    return 0
  fi
  echo "✗ 缺少必需目录：${d}/"
  missing=$((missing + 1))
}

echo "▶ 校验离线包全量清单（${OFFLINE_DIR}，mode=${MODE}）"

for f in "${REQUIRED_FILES[@]}"; do check_file "${f}"; done
for f in "${LEGACY_OPTIONAL_FILES[@]}"; do
  if [[ "${MODE}" == "build" ]]; then
    check_file "${f}" yes
  else
    check_file "${f}" no
  fi
done
for d in "${REQUIRED_DIRS[@]}"; do check_dir "${d}"; done
for f in "${REQUIRED_SCRIPTS[@]}"; do check_file "${f}"; done
# verify 脚本本身（新版包才有，旧 deploy 脚本不会调用到此处）
if [[ -f scripts/offline-package-verify.sh ]]; then
  echo "  ✓ scripts/offline-package-verify.sh"
fi

# 开源包严禁夹带运行库 dump；演示数据由镜像内的 demo_seed.py 生成。
if find . -type f \( -iname '*.dump' -o -iname '*.sql' -o -iname '*.backup' \) -not -path './postgres/*' | grep -q .; then
  echo "✗ 发行包中发现数据库 dump/SQL，拒绝继续（可能包含真实用户、Key 或日志）"
  missing=$((missing + 1))
else
  echo "  ✓ 未夹带数据库快照（演示数据由代码生成）"
fi

# image-manifest 行数须与 tar 数一致
if [[ -f image-manifest.txt ]]; then
  manifest_lines=$(grep -cve '^$' -e '^#' image-manifest.txt || true)
  if [[ "${manifest_lines}" -lt 6 ]]; then
    echo "✗ image-manifest.txt 仅 ${manifest_lines} 条，期望 ≥6"
    missing=$((missing + 1))
  else
    echo "  ✓ image-manifest.txt (${manifest_lines} 镜像)"
  fi
fi

# deploy 模式：额外校验 checksums（Linux 用 sha256sum，macOS 用 shasum）
if [[ "${MODE}" == "deploy" && -f checksums.sha256 ]]; then
  checksum_ok=0
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c checksums.sha256 >/dev/null 2>&1 && checksum_ok=1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c checksums.sha256 >/dev/null 2>&1 && checksum_ok=1
  fi
  if [[ "${checksum_ok}" -eq 1 ]]; then
    echo "  ✓ checksums.sha256"
  else
    echo "✗ checksums.sha256 与包内容不一致（拷贝损坏或内容发生变化）"
    missing=$((missing + 1))
  fi
fi

echo "  注：SHA-256 仅校验完整性，不证明发布者身份；正式发行须另行验证签名/可信发布渠道。"

if [[ "${missing}" -gt 0 ]]; then
  echo "✗ 离线包不完整（${missing} 项缺失），请在外网机重新执行 build-offline.sh"
  exit 1
fi

echo "✔ 离线包全量清单校验通过（${warn} 项可选警告）"
