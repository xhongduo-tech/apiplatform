"""用量日志定期清理（USAGE_LOG_RETENTION_DAYS）。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.inspection import inspect as sa_inspect

from app.config import settings
from app.database import SessionLocal
from app.leader import acquire_once
from app.models import UsageLogORM, UsageRequestProfileORM

log = logging.getLogger("apiplatform.usage_retention")

_PURGE_INTERVAL_S = 86400  # 每日


class UsageRetentionScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is not None or settings.USAGE_LOG_RETENTION_DAYS <= 0:
            return
        self._task = asyncio.create_task(self._run())
        log.info("用量日志清理已启动（保留 %d 天）", settings.USAGE_LOG_RETENTION_DAYS)

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self) -> None:
        await self._purge_if_leader()
        while True:
            try:
                await asyncio.sleep(_PURGE_INTERVAL_S)
                await self._purge_if_leader()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.warning("用量日志清理失败: %s", exc)

    async def _purge_if_leader(self) -> None:
        """多 worker 抢锁：每天只需一个进程清理（按日期键，TTL 23h）。
        当天执行者崩溃仅损失当日清理，删除按 cutoff 累积，次日自动补齐。"""
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if await acquire_once(f"usage_purge:{day}", 82800):
            await asyncio.to_thread(self._purge_once)

    def _purge_once(self) -> None:
        days = settings.USAGE_LOG_RETENTION_DAYS
        if days <= 0:
            return
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
        db = SessionLocal()
        try:
            total = _batch_delete(db, UsageLogORM, cutoff)
            if total:
                log.info("已清理 %d 条过期用量日志（早于 %s）", total, cutoff.date())

            profile_days = settings.USAGE_PROFILE_RETENTION_DAYS
            if profile_days > 0:
                profile_cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=profile_days)
                pt = _batch_delete(db, UsageRequestProfileORM, profile_cutoff)
                if pt:
                    log.info("已清理 %d 条过期 request profile（早于 %s）", pt, profile_cutoff.date())
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()


_PURGE_BATCH = 5000


def _batch_delete(db, model, cutoff: datetime) -> int:
    """分批 DELETE：避免单条事务删数百万行导致表膨胀/大回滚段/锁竞争。

    每批 DELETE ... LIMIT N 后立即提交，崩溃只损失当批，cutoff 幂等次日补齐。
    """
    total = 0
    while True:
        res = db.execute(_batch_delete_statement(model, cutoff))
        db.commit()
        n = res.rowcount
        total += n
        if n < _PURGE_BATCH:
            break
    return total


def _batch_delete_statement(model, cutoff: datetime):
    """构造 PostgreSQL 兼容的有限批量删除语句。

    PostgreSQL 和 SQLAlchemy 的通用 ``DELETE`` 都没有 ``LIMIT``。先在子查询中
    选出一批主键，再按主键删除，可保持每批事务有界；排序同时让重试和测试结果
    稳定。当前两个清理模型都是单列主键，若将来引入复合主键则应显式扩展此处。
    """
    primary_key = tuple(sa_inspect(model).primary_key)
    if len(primary_key) != 1:
        raise ValueError(f"{model.__name__} 必须使用单列主键才能分批清理")
    pk = primary_key[0]
    batch_ids = (
        select(pk)
        .where(model.created_at < cutoff)
        .order_by(model.created_at, pk)
        .limit(_PURGE_BATCH)
    )
    return delete(model).where(pk.in_(batch_ids))


usage_retention = UsageRetentionScheduler()
