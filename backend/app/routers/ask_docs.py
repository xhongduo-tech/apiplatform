"""Ask Docs 用户端点（/api/ask-docs）。"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.ask_docs import build_messages, call_llm, call_llm_stream, resolve_llm_config
from app.auth import require_user
from app.database import get_db
from app.platform_settings import get_ask_docs_config, get_branding_config
from app.redis_client import redis

router = APIRouter(prefix="/ask-docs", tags=["ask-docs"])

# 无鉴权 + 无限流曾经是这两个端点的实际状态：任何能访问到网关的请求方都能
# 免费、无限次驱动一次真实的上游 LLM 调用（用管理员配置的凭证），网关既不
# 认身份也不计次——与 /v1/* 系列端点统一走 policy.enforce_pre 完全不同口径。
# 这里不复用 enforce_pre（它是按 ApiKeyORM 的 RPM/TPM 设计的，Ask Docs 没有
# API Key 概念，只有登录态），改用与 _check_early_access_rate 同款的按
# auth_id 分桶计数，量级按"交互式问答"给，比申请/反馈类端点宽松得多。
_ASK_DOCS_RATE_PER_HOUR = 30


async def _check_ask_docs_rate(auth_id: str) -> None:
    """fail-open：Redis 异常一律放行，不因协调层抖动挡住正常提问。"""
    bucket = int(time.time() // 3600)
    key = f"askdocs:rate:{auth_id}:{bucket}"
    try:
        n = int(await redis.incr(key))
        if n == 1:
            await redis.expire(key, 3700)
        if n > _ASK_DOCS_RATE_PER_HOUR:
            ttl = await redis.ttl(key)
            retry = max(1, int(ttl) if ttl and ttl > 0 else 3600)
            raise HTTPException(
                status_code=429,
                detail=f"提问过于频繁（每小时上限 {_ASK_DOCS_RATE_PER_HOUR} 次），请约 {retry} 秒后重试。",
                headers={"Retry-After": str(retry)},
            )
    except HTTPException:
        raise
    except Exception:
        pass


class AskDocsRequest(BaseModel):
    question: str


@router.post("")
async def ask_docs(
    body: AskDocsRequest, db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """Ask Docs 问答（非流式）。"""
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")
    await _check_ask_docs_rate(claims.get("sub") or "anonymous")

    config = get_ask_docs_config(db)
    if config is None or not config.enabled:
        raise HTTPException(status_code=503, detail="Ask Docs 尚未配置或未启用")

    messages = build_messages(body.question, config, get_branding_config(db))
    resolved = resolve_llm_config(db, config)
    # 之后只有外部 HTTP await；显式释放同步 DB session，避免占用连接最长 60s。
    db.close()
    try:
        answer = await call_llm(messages, resolved)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {e}") from e

    return {"answer": answer}


@router.post("/stream")
async def ask_docs_stream(
    body: AskDocsRequest, db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    """Ask Docs 问答（SSE 流式）。"""
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")
    await _check_ask_docs_rate(claims.get("sub") or "anonymous")

    config = get_ask_docs_config(db)
    if config is None or not config.enabled:
        raise HTTPException(status_code=503, detail="Ask Docs 尚未配置或未启用")

    messages = build_messages(body.question, config, get_branding_config(db))
    resolved = resolve_llm_config(db, config)
    # StreamingResponse 的生成器可能持续数分钟，禁止把 request-scoped Session
    # 捕获进生成器；这里只传入完整的不可变上游配置快照。
    db.close()

    async def generate():
        try:
            async for chunk in call_llm_stream(messages, resolved):
                if chunk == "[DONE]":
                    yield "data: [DONE]\n\n"
                    break
                yield f"data: {chunk}\n\n"
        except Exception as e:
            yield f"data: {{\"error\": \"{e}\"}}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
