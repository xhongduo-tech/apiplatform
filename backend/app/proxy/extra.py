"""rerank / image 生成 / OCR 端点（均为非流式，复用 simple_relay）。

视觉（图片理解）走 /v1/chat/completions 的多模态 messages，无需独立端点。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.proxy.common import simple_relay

router = APIRouter()


@router.post("/rerank")
async def rerank(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    return await simple_relay(request, db, authorization, "/rerank")


@router.post("/images/generations")
async def image_generations(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    return await simple_relay(request, db, authorization, "/images/generations")


@router.post("/ocr")
async def ocr(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    # 平台暴露 /v1/ocr；默认上游 /recognize（可在模型 extra 中覆盖 upstream_path）。
    return await simple_relay(request, db, authorization, "/recognize")
