"""异步批量用量日志写入器（队列 → DB 批写，过载不阻塞热路径）。

enqueue 同时是中继访问日志的单一出口：每次中继完成（含流式断连）都会
经过这里，因此在此注入 request-id 并输出一行结构化 JSON 访问日志——
所有中继路径（chat / messages / responses / embeddings…）零改动全覆盖。
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import logging
import os
import time
from pathlib import Path
import tempfile
from typing import Iterator

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app import platform_time
from app.config import settings
from app.database import SessionLocal
from app.metrics import (
    USAGE_DROPPED,
    USAGE_FAILOVER_PENDING,
    USAGE_FAILOVER_PERSISTED,
    USAGE_FAILOVER_RECOVERY_FAILURES,
    USAGE_QUEUE_DEPTH,
    record_relay,
)
from app.models import UsageDailySummaryORM, UsageLogORM, _uuid
from app.usage_rollups import rollup_stats
from app.request_context import get_request_id, get_request_path
from app.session_stats import count_tool_calls_in_preview

log = logging.getLogger("apiplatform.usage")
# 中继访问日志：一行一个 JSON，字段稳定，便于 grep request-id 与后续接日志检索
access_log = logging.getLogger("apiplatform.access")

_QUEUE_MAX = 10000
_BATCH_MAX = 200
_FLUSH_INTERVAL_S = 2.0
_SHUTDOWN_DRAIN_S = 25.0

# 批写可靠性（2026-08 审计修复）：瞬时 DB 故障不再静默丢整批——
# 先重试（间隔递增），仍失败则落盘 failover 文件，恢复后回灌，账不丢。
_MAX_FLUSH_RETRIES = 3
_FLUSH_RETRY_BACKOFF_S = (0.5, 2.0)
# DB 持续不可用期间的用量事件 WAL。容器部署把父目录挂到命名卷；测试可替换
# 该模块变量指向 tmp_path。usage_logs.id 就是稳定 event id，无需维护第二套标识。
_FAILOVER_FILE = Path(settings.USAGE_FAILOVER_DIR) / "usage_failover.jsonl"


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _coerce_utc_naive(value) -> datetime:
    """把 failover JSON 中的 ISO 时间恢复为数据库使用的 UTC naive 时间。"""
    if value is None:
        return _utc_now_naive()
    if isinstance(value, str):
        value = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if not isinstance(value, datetime):
        raise ValueError("created_at 必须是 datetime 或 ISO-8601 字符串")
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _prepare_record(record: dict) -> dict:
    """复制并补齐耐久重放所需的稳定字段。"""
    prepared = dict(record)
    prepared["id"] = str(prepared.get("id") or _uuid())
    prepared["created_at"] = _coerce_utc_naive(prepared.get("created_at"))
    preview = prepared.get("response_preview")
    if prepared.get("tool_calls_count") is None and isinstance(preview, str):
        # 即使内容落库关闭，仍先提取非敏感结构化计量，再丢弃原文。
        prepared["tool_calls_count"] = count_tool_calls_in_preview(preview)
    if settings.USAGE_CONTENT_LOGGING_ENABLED:
        if isinstance(preview, str):
            prepared["response_preview"] = preview[:500]
        detail = prepared.get("error_detail")
        if isinstance(detail, str):
            prepared["error_detail"] = detail[:1000]
    else:
        prepared.pop("response_preview", None)
        category = _generic_error_category(prepared)
        if category is None:
            prepared.pop("error_detail", None)
        else:
            prepared["error_detail"] = category
    return prepared


def _generic_error_category(record: dict) -> str | None:
    """把可能含正文/URL/凭据的错误细节压缩为固定、无内容分类。"""
    detail = record.get("error_detail")
    if detail is None or str(detail).strip() == "":
        return None
    lower = str(detail).casefold()
    if "timeout" in lower or "timed out" in lower or "超时" in lower:
        return "upstream_timeout"
    if "disconnect" in lower or "cancel" in lower or "断开" in lower:
        return "client_disconnected"
    if "connect" in lower or "connection" in lower or "连接" in lower:
        return "upstream_connection_error"
    try:
        status = int(str(record.get("status_code") or "").strip())
    except ValueError:
        status = 0
    if 500 <= status:
        return "upstream_server_error"
    if 400 <= status < 500:
        return "upstream_client_error"
    return "relay_error"


def _fsync_directory(path: Path) -> None:
    """持久化目录项变更；不支持目录 fsync 的文件系统上安全降级。"""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("failover WAL 写入返回 0 字节")
        view = view[written:]


@contextmanager
def _locked_failover_file() -> Iterator[Path]:
    """用独立 lock 文件串行化所有 worker 的 append/read/rewrite。"""
    path = _FAILOVER_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        yield path
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def _append_jsonl_locked(path: Path, records: list[dict]) -> None:
    if not records:
        return
    payload = "".join(
        json.dumps(record, ensure_ascii=False, default=str, separators=(",", ":")) + "\n"
        for record in records
    ).encode("utf-8")
    fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        _write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    _fsync_directory(path.parent)


def _atomic_write_bytes_locked(path: Path, payload: bytes) -> None:
    fd, raw_tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(raw_tmp)
    try:
        os.fchmod(fd, 0o600)
        _write_all(fd, payload)
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(tmp, path)
        _fsync_directory(path.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        tmp.unlink(missing_ok=True)


def _atomic_rewrite_jsonl_locked(path: Path, records: list[dict]) -> None:
    """在同目录写临时文件、fsync 后 replace，避免崩溃留下半截 WAL。"""
    if not records:
        path.unlink(missing_ok=True)
        _fsync_directory(path.parent)
        return
    payload = "".join(
        json.dumps(record, ensure_ascii=False, default=str, separators=(",", ":")) + "\n"
        for record in records
    ).encode("utf-8")
    _atomic_write_bytes_locked(path, payload)


def _wal_meta_path(path: Path) -> Path:
    return path.with_name(path.name + ".meta")


def _wal_pending_count_locked(path: Path) -> int:
    """读取 O(1) 行数元数据；WAL 大小不匹配时自动扫描修复崩溃窗口。"""
    actual_size = path.stat().st_size if path.exists() else 0
    meta_path = _wal_meta_path(path)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if int(meta.get("size", -1)) == actual_size:
            return max(0, int(meta.get("count", 0)))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    if actual_size == 0:
        return 0
    with open(path, "rb") as handle:
        return sum(1 for line in handle if line.strip())


def _write_wal_meta_locked(path: Path, count: int) -> None:
    size = path.stat().st_size if path.exists() else 0
    payload = json.dumps(
        {"size": size, "count": max(0, int(count))}, separators=(",", ":"),
    ).encode("ascii")
    _atomic_write_bytes_locked(_wal_meta_path(path), payload)


class UsageWriter:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._task: asyncio.Task | None = None
        self._stop_requested = asyncio.Event()
        self.dropped = 0

    def enqueue(self, record: dict) -> None:
        if not record.get("request_id"):
            record["request_id"] = get_request_id()
        try:
            prepared = _prepare_record(record)
        except (TypeError, ValueError) as exc:
            self.dropped += 1
            USAGE_DROPPED.inc()
            log.error("用量事件字段非法，拒绝入队: %s", exc)
            return
        self._log_access(prepared)
        record_relay(prepared)
        try:
            self._queue.put_nowait(prepared)
        except asyncio.QueueFull:
            # 热路径队列满时优先同步写耐久 WAL；只有 WAL 也失败才真正记 dropped。
            if self._persist_failover([prepared]):
                log.warning("用量队列已满，事件 %s 已写入 failover WAL", prepared["id"])
            else:
                self.dropped += 1
                USAGE_DROPPED.inc()
        USAGE_QUEUE_DEPTH.set(self._queue.qsize())

    @staticmethod
    def _log_access(record: dict) -> None:
        try:
            access_log.info(json.dumps({
                "rid": record.get("request_id"),
                "path": get_request_path(),
                "key": record.get("api_key_id"),
                "model": record.get("model_id"),
                "status": record.get("status_code"),
                "ttft_ms": record.get("latency_ms"),
                "total_ms": record.get("total_duration_ms"),
                "prompt_tokens": record.get("prompt_tokens"),
                "completion_tokens": record.get("completion_tokens"),
                "total_tokens": record.get("total_tokens"),
            }, ensure_ascii=False))
        except Exception:
            pass  # 访问日志绝不影响计量主链路

    async def start(self) -> None:
        if self._task is None:
            self._stop_requested.clear()
            # 启动先回灌上次遗留的 failover 记录，避免历史账一直躺在文件里
            await asyncio.to_thread(self._recover_failover)
            self._task = asyncio.create_task(self._consume())

    async def stop(self) -> None:
        if not self._task:
            return
        task = self._task
        self._stop_requested.set()
        try:
            # 先让 consumer 自然刷完队列，避免取消 asyncio.to_thread 后底层 DB
            # 线程仍在运行、随后连接池却已被 lifespan dispose。
            await asyncio.wait_for(asyncio.shield(task), timeout=_SHUTDOWN_DRAIN_S)
        except asyncio.TimeoutError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            log.warning("用量 consumer 未在 %.0fs 内自然退出，转为 failover 排空", _SHUTDOWN_DRAIN_S)
        except asyncio.CancelledError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        remaining: list[dict] = []
        while not self._queue.empty():
            try:
                remaining.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        if remaining:
            ok = await asyncio.to_thread(self._flush_with_retry, remaining)
            if ok:
                log.info("shutdown 刷写 %d 条用量日志", len(remaining))
            else:
                persisted = await asyncio.to_thread(self._persist_failover, remaining)
                if persisted:
                    log.warning("shutdown 批写失败，%d 条落 failover 待恢复", len(remaining))
                else:
                    self.dropped += len(remaining)
                    USAGE_DROPPED.inc(len(remaining))
                    log.warning("shutdown 批写失败且 failover 落盘失败，丢失 %d 条", len(remaining))
        self._task = None

    async def _consume(self) -> None:
        while True:
            batch: list[dict] = []
            try:
                if self._stop_requested.is_set() and self._queue.empty():
                    break
                try:
                    timeout = 0.1 if self._stop_requested.is_set() else _FLUSH_INTERVAL_S
                    first = await asyncio.wait_for(self._queue.get(), timeout=timeout)
                    batch.append(first)
                except asyncio.TimeoutError:
                    if self._stop_requested.is_set():
                        break
                    # 队列空闲：顺手回灌 failover 遗留账（DB 恢复后自动追平）
                    await asyncio.to_thread(self._recover_failover)
                    continue
                while len(batch) < _BATCH_MAX and not self._queue.empty():
                    batch.append(self._queue.get_nowait())
                USAGE_QUEUE_DEPTH.set(self._queue.qsize())
                ok = await asyncio.to_thread(self._flush_with_retry, batch)
                if ok:
                    if not self._stop_requested.is_set():
                        await asyncio.to_thread(self._recover_failover)
                else:
                    # 重试耗尽：落 failover 文件（账不丢），仅落盘本身失败才计 dropped
                    persisted = await asyncio.to_thread(self._persist_failover, batch)
                    if not persisted:
                        self.dropped += len(batch)
                        USAGE_DROPPED.inc(len(batch))
            except asyncio.CancelledError:
                # asyncio.to_thread 的底层线程无法被取消；把当前批再记入 WAL，随后
                # 无论线程最终 commit 与否，稳定 event id 都会保证重放幂等。
                if batch and not self._persist_failover(batch):
                    self.dropped += len(batch)
                    USAGE_DROPPED.inc(len(batch))
                break
            except Exception as exc:
                log.warning("用量批写失败: %s", exc)

    def _flush(self, batch: list[dict]) -> int:
        # 同一批也可能因上层重试带入重复事件；按稳定主键先去重。
        unique: dict[str, dict] = {}
        for raw in batch:
            prepared = _prepare_record(raw)
            unique.setdefault(prepared["id"], prepared)
        records = list(unique.values())
        if not records:
            return 0

        db = SessionLocal()
        try:
            # 主键 id 同时是 event id。ON CONFLICT + RETURNING 只把本次真正新增的
            # 事件交给 rollup，保证“DB commit 后、WAL rewrite 前崩溃”的重放不会重复计数。
            columns = {column.name for column in UsageLogORM.__table__.columns}
            rows = [{key: value for key, value in record.items() if key in columns} for record in records]
            stmt = (
                pg_insert(UsageLogORM)
                .values(rows)
                .on_conflict_do_nothing(index_elements=[UsageLogORM.id])
                .returning(UsageLogORM.id)
            )
            inserted_ids = set(db.execute(stmt).scalars())
            inserted = [record for record in records if record["id"] in inserted_ids]
            self._rollup(db, inserted)
            rollup_stats(db, inserted)
            db.commit()
            if inserted:
                self._broadcast(db, inserted)
            return len(inserted)
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _flush_with_retry(self, batch: list[dict]) -> bool:
        """带退避重试的批写。全部重试仍失败返回 False（由调用方落 failover）。"""
        for attempt in range(_MAX_FLUSH_RETRIES):
            try:
                self._flush(batch)
                return True
            except Exception as exc:
                if attempt < _MAX_FLUSH_RETRIES - 1:
                    delay = _FLUSH_RETRY_BACKOFF_S[min(attempt, len(_FLUSH_RETRY_BACKOFF_S) - 1)]
                    log.warning(
                        "用量批写失败（第 %d/%d 次，%.1fs 后重试）: %s",
                        attempt + 1, _MAX_FLUSH_RETRIES, delay, exc,
                    )
                    time.sleep(delay)
        return False

    def _persist_failover(self, batch: list[dict]) -> bool:
        """重试耗尽仍失败 → 整批追加到持久化 JSONL WAL。

        落盘成功即视为「账已持久化」——不回灌前绝不丢；返回是否落盘成功。
        """
        try:
            prepared = [_prepare_record(record) for record in batch]
            with _locked_failover_file() as path:
                pending = _wal_pending_count_locked(path)
                _append_jsonl_locked(path, prepared)
                pending += len(prepared)
                try:
                    _write_wal_meta_locked(path, pending)
                    USAGE_FAILOVER_PENDING.set(pending)
                except Exception as exc:
                    # WAL 已 fsync 即代表事件安全；指标元数据失败不能误报为数据丢失。
                    log.warning("更新 failover pending 指标失败（WAL 已安全落盘）: %s", exc)
            USAGE_FAILOVER_PERSISTED.inc(len(prepared))
            return True
        except Exception as exc:
            log.error("failover 落盘失败（%d 条用量可能丢失）: %s", len(batch), exc)
            return False

    def _recover_failover(self) -> None:
        """把 failover 文件里的记录分块回灌 DB；成功的移出文件，失败的留待下次。

        整个读-回灌-原子重写过程持有跨进程文件锁；即使在 DB commit 后、WAL
        rewrite 前崩溃，下一次重放也会由 usage_logs.id 唯一主键幂等忽略。
        """
        try:
            with _locked_failover_file() as path:
                if not path.exists() or path.stat().st_size == 0:
                    _write_wal_meta_locked(path, 0)
                    USAGE_FAILOVER_PENDING.set(0)
                    return
                records: list[dict] = []
                corrupt_lines: list[str] = []
                with open(path, encoding="utf-8") as f:
                    for line in f:
                        stripped = line.strip()
                        if not stripped:
                            continue
                        try:
                            records.append(_prepare_record(json.loads(stripped)))
                        except (json.JSONDecodeError, TypeError, ValueError):
                            corrupt_lines.append(stripped)

                if corrupt_lines:
                    corrupt_path = path.with_name(path.name + ".corrupt")
                    payload = [{"raw": line, "quarantined_at": _utc_now_naive()} for line in corrupt_lines]
                    _append_jsonl_locked(corrupt_path, payload)
                    log.error("failover WAL 有 %d 行损坏，已移入 %s", len(corrupt_lines), corrupt_path)

                failed: list[dict] = []
                for i in range(0, len(records), _BATCH_MAX):
                    chunk = records[i:i + _BATCH_MAX]
                    try:
                        self._flush(chunk)
                    except Exception as exc:
                        log.warning("failover 回灌失败（%d 条留待下次）: %s", len(chunk), exc)
                        failed.extend(chunk)
                        USAGE_FAILOVER_RECOVERY_FAILURES.inc(len(chunk))
                _atomic_rewrite_jsonl_locked(path, failed)
                _write_wal_meta_locked(path, len(failed))
                USAGE_FAILOVER_PENDING.set(len(failed))
                log.info("failover 回灌 %d 条，剩余 %d 条", len(records) - len(failed), len(failed))
        except Exception as exc:
            log.warning("failover 回灌异常: %s", exc)

    def _broadcast(self, db: Session, batch: list[dict]) -> None:
        """DB commit 之后异步推送给 SSE 订阅者（绝不回滚、异常静默）。"""
        try:
            from app.log_stream import broadcast_batch, log_stream_hub
            broadcast_batch(batch)  # 跨 worker 广播（fail-open，与本地订阅者有无无关）
            if log_stream_hub.subscriber_count() == 0:
                return
            key_ids = sorted({r.get("api_key_id") for r in batch if r.get("api_key_id")})
            key_meta: dict[str, dict[str, str]] = {}
            if key_ids:
                from app.models import ApiKeyORM
                for k in db.query(ApiKeyORM).filter(ApiKeyORM.id.in_(key_ids)).all():
                    key_meta[k.id] = {
                        "name": k.name or k.project_name or k.id[:8],
                        "department": k.department or "",
                        "auth_id": k.auth_id or "",
                    }
            log_stream_hub.publish_batch(batch, key_meta)
        except Exception as exc:
            log.debug("log_stream publish skipped: %s", exc)

    def _rollup(self, db: Session, batch: list[dict]) -> None:
        """按 (天, api_key_id, model_id) 原子递增永久汇总表，不受 usage_logs 清理 / Key 删除影响。

        "天"取平台业务时区（PLATFORM_TIMEZONE）的日历日，与控制台/日报口径一致；
        用 UTC 日的话，用户看到的"今天"会从本地早上 8 点才开始计。
        """
        agg: dict[tuple[object, str, str], dict[str, int]] = {}
        for r in batch:
            created_at = _coerce_utc_naive(r.get("created_at"))
            day = platform_time.to_local_naive(created_at).date()
            a = agg.setdefault((day, r["api_key_id"], r["model_id"]), {
                "calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
                "total_tokens": 0, "cache_hit_tokens": 0,
            })
            a["calls"] += 1
            a["prompt_tokens"] += r.get("prompt_tokens") or 0
            a["completion_tokens"] += r.get("completion_tokens") or 0
            a["total_tokens"] += r.get("total_tokens") or 0
            a["cache_hit_tokens"] += r.get("cache_hit_tokens") or 0
        if not agg:
            return
        stmt = pg_insert(UsageDailySummaryORM).values([
            {"day": day, "api_key_id": key_id, "model_id": model_id, **vals}
            for (day, key_id, model_id), vals in agg.items()
        ])
        stmt = stmt.on_conflict_do_update(
            index_elements=["day", "api_key_id", "model_id"],
            set_={
                "calls": UsageDailySummaryORM.calls + stmt.excluded.calls,
                "prompt_tokens": UsageDailySummaryORM.prompt_tokens + stmt.excluded.prompt_tokens,
                "completion_tokens": UsageDailySummaryORM.completion_tokens + stmt.excluded.completion_tokens,
                "total_tokens": UsageDailySummaryORM.total_tokens + stmt.excluded.total_tokens,
                "cache_hit_tokens": UsageDailySummaryORM.cache_hit_tokens + stmt.excluded.cache_hit_tokens,
            },
        )
        db.execute(stmt)


usage_writer = UsageWriter()
