"""POST /v1/embeddings — 嵌入中继（复用 simple_relay）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.proxy.common import simple_relay

router = APIRouter()


@router.post("/embeddings")
async def embeddings(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    return await simple_relay(request, db, authorization, "/embeddings")
