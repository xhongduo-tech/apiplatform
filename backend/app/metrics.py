"""Prometheus 指标（gunicorn 多进程兼容）。

多进程模式：entrypoint 设置 PROMETHEUS_MULTIPROC_DIR（容器内 /dev/shm 下的
tmpfs 目录）后，各 worker 把指标写入共享文件，/metrics 端点用
MultiProcessCollector 聚合输出全部进程的数据——否则 Prometheus 每次抓取
随机落在某个 worker，只能看到 1/4 的流量且数值来回跳。
未设该环境变量（dev.sh 单进程 / 单测）时退回默认注册表，行为不变。

指标记录点与访问日志同源（usage_writer.enqueue）：中继每次完成必经，
零侵入覆盖全部端点。记录失败绝不影响计量主链路。
"""
from __future__ import annotations

import logging
import os

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
    multiprocess,
)

log = logging.getLogger("apiplatform.metrics")

# ── 中继维度 ──────────────────────────────────────────────────────────────────
RELAY_REQUESTS = Counter(
    "apiplatform_relay_requests_total", "中继请求数", ["model", "status"],
)
RELAY_TTFT = Histogram(
    "apiplatform_relay_ttft_seconds", "首字延迟（流式为 TTFT，非流式为整体耗时）", ["model"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120),
)
RELAY_DURATION = Histogram(
    "apiplatform_relay_duration_seconds", "整体完成耗时", ["model"],
    buckets=(0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600),
)
RELAY_TOKENS = Counter(
    "apiplatform_relay_tokens_total", "token 消耗", ["model", "kind"],  # kind=prompt|completion
)

# ── 计量管线健康 ──────────────────────────────────────────────────────────────
USAGE_QUEUE_DEPTH = Gauge(
    "apiplatform_usage_queue_depth", "用量写入队列深度（各 worker 求和）",
    multiprocess_mode="livesum",
)
USAGE_DROPPED = Counter(
    "apiplatform_usage_dropped_total", "队列满被丢弃的用量记录数",
)
USAGE_FAILOVER_PENDING = Gauge(
    "apiplatform_usage_failover_pending",
    "持久化 failover WAL 中待回灌的用量事件数",
    # 所有 worker 观察同一共享 WAL 并写入绝对值，取最近一次设置而不是求和。
    multiprocess_mode="livemostrecent",
)
USAGE_FAILOVER_PERSISTED = Counter(
    "apiplatform_usage_failover_persisted_total",
    "数据库不可用或队列过载时成功写入 failover WAL 的事件数",
)
USAGE_FAILOVER_RECOVERY_FAILURES = Counter(
    "apiplatform_usage_failover_recovery_failures_total",
    "尝试回灌但数据库写入失败、仍留在 WAL 的事件数",
)

# ── 备份恢复点健康 ────────────────────────────────────────────────────────────
BACKUP_AGE_SECONDS = Gauge(
    "apiplatform_backup_age_seconds",
    "最新已发布 PostgreSQL 快照距今秒数（无快照为 -1）",
    multiprocess_mode="livemostrecent",
)
BACKUP_VERIFIED = Gauge(
    "apiplatform_backup_verified",
    "最新 PostgreSQL 快照及 SHA-256 是否验证通过（1/0）",
    multiprocess_mode="livemostrecent",
)
BACKUP_STALE = Gauge(
    "apiplatform_backup_stale",
    "最新 PostgreSQL 快照是否超过 RPO 或无法验证（1/0）",
    multiprocess_mode="livemostrecent",
)


def refresh_backup_metrics() -> None:
    """Refresh read-only snapshot health; never fail the metrics endpoint."""
    try:
        from app.backup_status import read_backup_status
        from app.config import settings

        status = read_backup_status(
            settings.BACKUP_DIR,
            interval_s=settings.BACKUP_INTERVAL_S,
            latest_name=settings.BACKUP_DUMP_FILE,
        )
        age = status.get("age_seconds")
        BACKUP_AGE_SECONDS.set(float(age) if isinstance(age, (int, float)) else -1)
        BACKUP_VERIFIED.set(1 if status.get("verified") else 0)
        BACKUP_STALE.set(1 if status.get("stale", True) else 0)
    except Exception as exc:
        BACKUP_AGE_SECONDS.set(-1)
        BACKUP_VERIFIED.set(0)
        BACKUP_STALE.set(1)
        log.warning("读取备份状态失败: %s", exc)


def record_relay(record: dict) -> None:
    """从 usage_writer.enqueue 的记录中提取指标。任何异常吞掉，不碰主链路。"""
    try:
        model = str(record.get("model_id") or "unknown")
        status = str(record.get("status_code") or "unknown")
        RELAY_REQUESTS.labels(model=model, status=status).inc()
        ttft_ms = record.get("latency_ms")
        if isinstance(ttft_ms, (int, float)) and ttft_ms >= 0:
            RELAY_TTFT.labels(model=model).observe(ttft_ms / 1000.0)
        total_ms = record.get("total_duration_ms")
        if isinstance(total_ms, (int, float)) and total_ms >= 0:
            RELAY_DURATION.labels(model=model).observe(total_ms / 1000.0)
        pt = record.get("prompt_tokens")
        if isinstance(pt, (int, float)) and pt > 0:
            RELAY_TOKENS.labels(model=model, kind="prompt").inc(pt)
        ct = record.get("completion_tokens")
        if isinstance(ct, (int, float)) and ct > 0:
            RELAY_TOKENS.labels(model=model, kind="completion").inc(ct)
    except Exception:
        pass


def render_metrics() -> tuple[bytes, str]:
    """输出 Prometheus 文本格式。多进程模式聚合全部 worker。"""
    refresh_backup_metrics()
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        try:
            multiprocess.MultiProcessCollector(registry)
        except Exception as exc:
            log.warning("多进程指标聚合失败，回退单进程注册表: %s", exc)
            return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
        return generate_latest(registry), CONTENT_TYPE_LATEST
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
