"""运营巡检定时器。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.config import settings
from app.database import SessionLocal
from app.leader import acquire_once
from app.ops_report import generate_daily_report

log = logging.getLogger("apiplatform.ops_scheduler")


def _tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.OPS_REPORT_TIMEZONE)
    except Exception:
        return ZoneInfo("Asia/Shanghai")


def _local_now() -> datetime:
    return datetime.now(_tz())


class OpsReportScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is not None or not settings.OPS_REPORT_ENABLED:
            if not settings.OPS_REPORT_ENABLED:
                log.info("运营巡检已禁用（OPS_REPORT_ENABLED=false）")
            return
        self._task = asyncio.create_task(self._run())
        log.info(
            "运营巡检定时器已启动（每日 %02d:00 %s 生成昨日日报）",
            settings.OPS_REPORT_RUN_HOUR, settings.OPS_REPORT_TIMEZONE,
        )

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self) -> None:
        # 多 worker 抢锁：回补只需一个进程做（generate_report 幂等，锁纯去重）
        try:
            if settings.OPS_REPORT_BACKFILL_DAYS > 0 and await acquire_once("ops_report_backfill", 3600):
                await asyncio.to_thread(self._backfill)
        except Exception as exc:
            log.warning("运营巡检回补失败: %s", exc)

        interval = max(60, settings.OPS_REPORT_CHECK_INTERVAL_S)
        while True:
            try:
                await asyncio.sleep(interval)
                if _local_now().hour >= settings.OPS_REPORT_RUN_HOUR:
                    # 每个巡检周期只放一个 worker 进入（消除并发生成的唯一索引
                    # 冲突噪音）；锁 TTL=周期长度，进程崩溃后下个周期自动有人接手
                    if await acquire_once("ops_report_tick", interval):
                        await asyncio.to_thread(self._ensure_yesterday)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.warning("运营巡检周期执行异常: %s", exc)

    def _ensure_yesterday(self) -> None:
        db = SessionLocal()
        try:
            generate_daily_report(db)
        finally:
            db.close()

    def _backfill(self) -> None:
        days = max(0, settings.OPS_REPORT_BACKFILL_DAYS)
        if days == 0:
            return
        db = SessionLocal()
        try:
            local = _local_now()
            today = local.replace(hour=0, minute=0, second=0, microsecond=0)
            for n in range(1, days + 1):
                day = (today - timedelta(days=n)).replace(tzinfo=None)
                generate_daily_report(db, day)
        finally:
            db.close()


ops_scheduler = OpsReportScheduler()
