"""取消安全的清理执行器(P0 槽位泄漏修复)。

客户端提前断开流式响应时(OpenAI SDK 收到 [DONE] 即关连接属标准行为),
starlette StreamingResponse 用 anyio task group 的 level-cancellation 取消
生成器——finally 中的每个 await 都会再次抛出 CancelledError,导致槽位
释放 / 用量记账永远执行不到,泄漏的 inflight 计数会把单 key 乃至整模型
的容量永久吃掉。

guarded() 把清理协程放入独立 task(生命周期不依附当前请求),再尝试
内联等待:正常路径下语义与直接 await 完全一致;所在作用域已被取消时,
等待本身会被再次取消,但独立 task 继续在后台完成,清理绝不丢失。
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("apiplatform.aioguard")

#: 强引用池：事件循环只用 WeakSet 记录 task，仅靠 create_task 的返回值维持
#: 存活。断连路径上 guarded() 的 await 会立刻被取消、局部变量随即出栈，
#: 清理 task 就可能在真正跑完前被 GC 回收——上游连接不关（连接池泄漏）、
#: TPM 预扣不返还。放进这个集合里，直到 done callback 摘除为止。
_pending: set[asyncio.Task] = set()


def _on_done(what: str):
    def cb(task: asyncio.Task) -> None:
        _pending.discard(task)
        if task.cancelled():
            log.warning("%s 后台清理被取消(不应发生)", what)
            return
        exc = task.exception()
        if exc is not None:
            log.warning("%s 后台清理失败: %s", what, exc)
    return cb


async def guarded(coro, what: str = "cleanup") -> None:
    """执行清理协程,保证其不因当前 task 被取消而丢失。

    - 正常路径:内联等待,行为等同 await coro;
    - 已取消的作用域:每个 await 点都会抛 CancelledError,此处吞掉它并
      立即返回,清理在独立 task 中继续;错误经 done callback 记日志。
    """
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        # 事件循环已关闭(进程退出中),无法调度,放弃并关闭协程防警告
        coro.close()
        return
    _pending.add(task)
    task.add_done_callback(_on_done(what))
    try:
        await asyncio.shield(task)
    except BaseException:
        # 当前 task 被取消(客户端断开):清理已转入独立 task 继续执行;
        # 协程自身的异常由 done callback 记录,这里不再向上抛——
        # finally 中的清理失败不应遮蔽业务异常。
        pass
