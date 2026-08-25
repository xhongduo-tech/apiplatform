#!/usr/bin/env bash
# 旧版脚本曾把运行中的整库（用户、Key、日志、上游配置）导出为发布 seed，极易
# 将真实数据带入源码或离线发行包。开源版明确禁止这条路径。
set -euo pipefail

cat <<'EOF'
✗ 已禁用全库 seed 导出。

开源发行包的演示数据由 backend/app/demo_seed.py 确定性生成，不来源于运行库。
若要备份私有实例，请使用 scripts/export-backup.sh，并把备份保存在仓库之外。
EOF
exit 2
