"""跨 worker 的「按周期抢锁」：全平台只需做一次的后台任务去重。

不做常驻 leader 选举——每个后台任务都有天然的幂等周期键（如
usage_purge:2026-07-20），干活前 SET NX EX 抢一次锁即可：抢到 = 我干，
没抢到 = 别的 worker 在干/已干过。锁随 TTL 自动消失，worker 增减、
重启零协调成本。

正确性分层：锁只负责去重（消除并发写入的告警噪音与重复劳动），
任务自身的幂等性（日报的存在即返回、清理的删除幂等）才是正确性保证。
因此 fail-open：Redis 异常时返回 True（各 worker 都跑）——退化为
无锁现状，绝不因协调层故障漏跑任务。
"""
from __future__ import annotations

import logging

from app.redis_client import redis

log = logging.getLogger("apiplatform.leader")


async def acquire_once(task_key: str, ttl_s: int) -> bool:
    """尝试成为 task_key 的执行者。True=本 worker 干活；False=已有人干。"""
    try:
        ok = await redis.set(f"lock:{task_key}", "1", nx=True, ex=max(1, int(ttl_s)))
        return bool(ok)
    except Exception as exc:
        log.warning("抢锁 %s 异常（fail-open 放行）: %s", task_key, exc)
        return True
