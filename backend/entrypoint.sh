#!/bin/sh
set -e
cd /app

# 必须在等待数据库和执行任何迁移之前校验生产凭据；失败时不得修改 schema/数据。
echo "▶ 校验生产运行配置（无外部副作用）"
python -m app.config_preflight

# ── 等待 PostgreSQL 就绪 ────────────────────────────────────────────────────
# 数据库为 compose 内置 postgres 服务，backend 可能先启动而 postgres 尚未就绪。
# 此处最多等待 60s，避免容器因 alembic 立即失败而反复重启。
echo "▶ 等待 PostgreSQL 就绪（最多 60s）"
python - <<PY
import os, sys, time
import psycopg

url = os.environ.get("DATABASE_URL", "").strip()
if not url:
    print("✗ 缺少 DATABASE_URL，生产部署拒绝使用内置数据库口令")
    sys.exit(1)
# SQLAlchemy 连接串 postgresql+psycopg:// 需转换为原生 psycopg 连接串
conninfo = url.replace("postgresql+psycopg://", "postgresql://", 1)

for i in range(30):
    try:
        with psycopg.connect(conninfo, connect_timeout=2):
            pass
        print("  PostgreSQL 已就绪")
        sys.exit(0)
    except Exception as e:
        print(f"  等待 PostgreSQL... ({i+1}/30): {e}")
        time.sleep(2)
print("✗ PostgreSQL 未在 60s 内就绪，退出")
sys.exit(1)
PY

echo "▶ alembic upgrade head（PostgreSQL advisory lock 串行）"
python -m app.migration_lock

# Prometheus 多进程指标目录（tmpfs）：启动清空，避免上次运行的僵尸文件混入聚合
export PROMETHEUS_MULTIPROC_DIR="${PROMETHEUS_MULTIPROC_DIR:-/dev/shm/apiplatform-metrics}"
case "${PROMETHEUS_MULTIPROC_DIR}" in
  /dev/shm/apiplatform-*|/tmp/apiplatform-*) ;;
  *)
    echo "✗ PROMETHEUS_MULTIPROC_DIR 只允许使用 /dev/shm/apiplatform-* 或 /tmp/apiplatform-*" >&2
    exit 1
    ;;
esac
mkdir -p "$PROMETHEUS_MULTIPROC_DIR"
find "$PROMETHEUS_MULTIPROC_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.db' -delete

WORKERS="${GUNICORN_WORKERS:-4}"
echo "▶ gunicorn (${WORKERS} workers)"
exec gunicorn app.main:app \
  -k uvicorn.workers.UvicornWorker \
  -w "$WORKERS" \
  -b 0.0.0.0:8000 \
  -c /app/gunicorn_conf.py \
  --timeout 600 \
  --graceful-timeout 30 \
  --keep-alive 75
