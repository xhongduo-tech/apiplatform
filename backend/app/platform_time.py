"""平台业务时区（settings.PLATFORM_TIMEZONE，默认 Asia/Shanghai）下的统计口径。

**存储不变**：所有时间戳仍以 UTC naive 落库（`usage_logs.created_at` 等列是
`timestamp without time zone`，由 PG `now()` 或 Python 的 UTC now 写入）。改存储
要动表结构，还会让历史行与新行混在一起无从分辨，得不偿失。

**换算发生在读取侧**，两种场景：

1. 按天 / 按月 / 按小时分桶 → 用 :func:`local_ts` 把列换算到平台时区再截取；
2. 需要"某个本地日历日的区间" → 在本地把边界算好，
   再用 :func:`to_utc_naive` 转回 UTC naive 去比较。

不这么做的话，一天会从平台本地时间早上 8 点开始算起（UTC+8 场景），"今日用量"
把昨天下午的调用算进来；日报里的"高峰时段"也会整体偏移 8 小时。
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, literal_column

from app.config import settings

# IANA 时区名的合法字符集。时区取自配置而非请求，这里做白名单只是为了让
# literal_column 的内联绝对安全（见 local_ts 的说明）。
_TZ_NAME_RE = re.compile(r"^[A-Za-z0-9_+\-/]{1,64}$")


def tz() -> ZoneInfo | timezone:
    """平台业务时区。配置写错时回落 UTC——宁可口径偏移，也不能让统计端点整个 500。"""
    try:
        return ZoneInfo(settings.PLATFORM_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return timezone.utc


def now_local() -> datetime:
    """当前时刻的平台本地墙上时间（naive，便于与本地日历运算）。"""
    return datetime.now(tz()).replace(tzinfo=None)


def today_local() -> date:
    """平台本地的"今天"。usage_daily_summary.day 等按天汇总一律用它。"""
    return now_local().date()


def to_local_naive(utc_naive: datetime) -> datetime:
    """UTC naive → 平台本地墙上时间（naive）。"""
    return utc_naive.replace(tzinfo=timezone.utc).astimezone(tz()).replace(tzinfo=None)


def to_utc_naive(local_naive: datetime) -> datetime:
    """平台本地墙上时间（naive）→ UTC naive，用于和库里的时间列比较。"""
    return local_naive.replace(tzinfo=tz()).astimezone(timezone.utc).replace(tzinfo=None)


def _tz_literal():
    """时区名以字面量（而非绑定参数）进入 SQL。

    这不是可选的写法问题：绑定参数每出现一次就生成一个新名字（$1/$2/…），
    于是 SELECT 里的 `date(timezone($1,timezone($2,created_at)))` 与 GROUP BY 里的
    `date(timezone($3,timezone($4,created_at)))` 在 PG 看来是两个不同的表达式，
    直接报 “column must appear in the GROUP BY clause”。内联成字面量后两处文本
    完全一致，分组才成立。取值来自配置且过白名单，不存在注入面。
    """
    name = settings.PLATFORM_TIMEZONE
    if not _TZ_NAME_RE.match(str(name or "")):
        name = "UTC"
    return literal_column(f"'{name}'")


def local_ts(col):
    """SQLAlchemy 表达式：把 UTC naive 的时间列换算成平台时区的墙上时间。

    等价 SQL：``col AT TIME ZONE 'UTC' AT TIME ZONE '<平台时区>'``
    —— 内层把 naive 解释为 UTC 得到 timestamptz，外层再取目标时区的墙上时间。
    可以在 SELECT / GROUP BY / ORDER BY 里分别调用，生成的 SQL 文本一致。
    """
    return func.timezone(_tz_literal(), func.timezone(literal_column("'UTC'"), col))


def sql_tz_param() -> dict:
    """配合 ``text()`` 原生 SQL 里内联的 ``AT TIME ZONE :tz`` 使用的绑定参数。"""
    return {"tz": settings.PLATFORM_TIMEZONE}


def sql_tz_name() -> str:
    """迁移 / 原生 SQL 内联时区名（已过白名单）。"""
    name = settings.PLATFORM_TIMEZONE
    if not _TZ_NAME_RE.match(str(name or "")):
        return "UTC"
    return name
