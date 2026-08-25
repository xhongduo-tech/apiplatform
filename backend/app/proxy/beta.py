"""POST /beta/v1/chat/completions — 前缀续写（Beta）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.proxy.chat import relay_chat_like
from app.proxy.db_bridge import prepare_proxy_request
from app.proxy import policy
from app.proxy.token_estimate import estimate_prompt_tokens_async

router = APIRouter()


@router.post("/chat/completions")
async def beta_chat_completions(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    body = await request.json()
    prep = await prepare_proxy_request(authorization, body.get("model"))
    reserved = await policy.enforce_pre(prep.key, request, db, await estimate_prompt_tokens_async(body), model=prep.model)
    return await relay_chat_like(
        body, prep.key, prep.model, prep.resolved_id, bool(body.get("stream")),
        upstream_suffix="/beta/chat/completions",
        reserved_tokens=reserved,
        request=request,
        fallback_model=prep.fallback,
        fallback_from=prep.fallback_from,
    )
