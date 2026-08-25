"""GET /v1/models 与 /v1/models/{id} — OpenAI 兼容模型清单。

只暴露真正可调用的模型：状态可调用且部署就绪（base_url / model_api_name
已配置），虚拟模型（lts / 带 resolve_to_model_id）要求对齐目标就绪——
否则客户端拉列表逐个调用全是 503，会被误判为"平台不可用"。

抢先体验计划模型（status=upcoming）按调用者授权与否分别可见：已获批的统一
认证号能在清单里看到它们，未获批的看不到——列出一个必定 403 的模型同样是
误导。
"""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import select

from app.database import SessionLocal
from app.auth import normalize_client_auth
from app.early_access import EARLY_ACCESS_STATUS, is_approved
from app.models import ModelRegistryORM
from app.proxy.db_bridge import async_validate_api_key
from app.proxy.routing import _CALLABLE_STATUS, _deploy_ready, normalize_model_ref

router = APIRouter()


def _list_exposed_models_sync(auth_id: str | None = None) -> list[ModelRegistryORM]:
    db = SessionLocal()
    try:
        statuses = list(_CALLABLE_STATUS)
        if is_approved(db, auth_id):
            statuses.append(EARLY_ACCESS_STATUS)
        rows = list(
            db.execute(
                select(ModelRegistryORM).where(ModelRegistryORM.status.in_(statuses))
            ).scalars().all()
        )
    finally:
        db.close()

    by_ref: dict[str, ModelRegistryORM] = {}
    for m in rows:
        by_ref[normalize_model_ref(m.id)] = m

    exposed: list[ModelRegistryORM] = []
    for m in rows:
        if m.category == "lts" or m.resolve_to_model_id:
            target = by_ref.get(normalize_model_ref(m.resolve_to_model_id or ""))
            if target is not None and _deploy_ready(target):
                exposed.append(m)
        elif _deploy_ready(m):
            exposed.append(m)
    return exposed


def _to_openai(m: ModelRegistryORM, now: int) -> dict:
    return {"id": m.id, "object": "model", "created": now, "owned_by": m.provider or "platform"}


@router.get("/models")
async def list_models(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
):
    key = await async_validate_api_key(normalize_client_auth(authorization, x_api_key))
    rows = await asyncio.to_thread(_list_exposed_models_sync, key.auth_id)
    now = int(time.time())
    return {"object": "list", "data": [_to_openai(m, now) for m in rows]}


@router.get("/models/{model_id}")
async def retrieve_model(
    model_id: str,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
):
    """OpenAI SDK models.retrieve 兼容端点（部分框架用它探测模型可用性）。"""
    key = await async_validate_api_key(normalize_client_auth(authorization, x_api_key))
    rows = await asyncio.to_thread(_list_exposed_models_sync, key.auth_id)
    needle = normalize_model_ref(model_id)
    for m in rows:
        if normalize_model_ref(m.id) == needle or normalize_model_ref(m.name or "") == needle:
            return _to_openai(m, int(time.time()))
    raise HTTPException(status_code=404, detail=f"模型不存在: {model_id}")
