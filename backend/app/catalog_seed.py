"""全新实例的中性演示目录。

目录仅用于展示平台能力，不包含任何真实部署地址、上游密钥或内部模型清单。
管理员可在后台删除、改名或重新配置任意条目；启动补种不会覆盖这些改动。
"""
from __future__ import annotations

import os

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import CatalogSeededIdORM, ModelRegistryORM


# 仅同步展示与策略字段；部署地址、上游凭证和自定义请求头永远以数据库为准。
_CATALOG_FIELDS = (
    "name",
    "provider",
    "short_desc",
    "description",
    "context_window",
    "category",
    "speed",
    "import_format",
    "resolve_to_model_id",
    "status",
)


def _extra(*, tags: list[str], badge: str = "演示", **values: object) -> dict:
    return {
        "synthetic": True,
        "tags": tags,
        "badge": badge,
        "scene": "auto",
        "scenes": ["auto"],
        "autoApprove": True,
        **values,
    }


_DEMO_NOTICE = "虚构演示条目，不连接真实上游；投入使用前请由管理员配置模型与端点。"


CATALOG_MODELS: list[dict] = [
    {
        "id": "platform-sota",
        "name": "platform-sota",
        "provider": "Platform",
        "category": "lts",
        "status": "online",
        "short_desc": "可配置的高能力稳定别名",
        "description": f"管理员可将该别名指向当前首选模型。{_DEMO_NOTICE}",
        "context_window": "动态",
        "speed": "medium",
        "import_format": "openai",
        "resolve_to_model_id": "demo-reasoning-model",
        "extra": _extra(tags=["稳定别名", "推理", "工具调用"]),
    },
    {
        "id": "platform-flash",
        "name": "platform-flash",
        "provider": "Platform",
        "category": "lts",
        "status": "online",
        "short_desc": "可配置的低延迟稳定别名",
        "description": f"管理员可将该别名指向当前低延迟模型。{_DEMO_NOTICE}",
        "context_window": "动态",
        "speed": "fast",
        "import_format": "openai",
        "resolve_to_model_id": "demo-chat-model",
        "extra": _extra(tags=["稳定别名", "高速", "工具调用"]),
    },
    {
        "id": "demo-chat-model",
        "name": "Demo Chat Model",
        "provider": "Example Provider",
        "category": "chat",
        "status": "online",
        "short_desc": "通用对话模型占位条目",
        "description": _DEMO_NOTICE,
        "context_window": "32K",
        "speed": "fast",
        "import_format": "openai",
        "extra": _extra(tags=["对话", "文本生成", "工具调用"], arch="Demo", params="—"),
    },
    {
        "id": "demo-reasoning-model",
        "name": "Demo Reasoning Model",
        "provider": "Example Provider",
        "category": "flagship",
        "status": "online",
        "short_desc": "复杂推理模型占位条目",
        "description": _DEMO_NOTICE,
        "context_window": "64K",
        "speed": "medium",
        "import_format": "openai",
        "extra": _extra(tags=["推理", "代码", "长上下文"], arch="Demo", params="—"),
    },
    {
        "id": "demo-vision-model",
        "name": "Demo Vision Model",
        "provider": "Example Provider",
        "category": "vision",
        "status": "online",
        "short_desc": "图文理解模型占位条目",
        "description": _DEMO_NOTICE,
        "context_window": "16K",
        "speed": "medium",
        "import_format": "openai",
        "extra": _extra(tags=["图文理解", "多模态", "文本生成"], params="—"),
    },
    {
        "id": "demo-embedding-model",
        "name": "Demo Embedding Model",
        "provider": "Example Provider",
        "category": "embedding",
        "status": "online",
        "short_desc": "文本向量模型占位条目",
        "description": _DEMO_NOTICE,
        "context_window": "8K",
        "speed": "fast",
        "import_format": "openai",
        "extra": _extra(tags=["向量", "语义搜索", "RAG"], dimension="1024", params="—"),
    },
    {
        "id": "demo-reranker-model",
        "name": "Demo Reranker Model",
        "provider": "Example Provider",
        "category": "reranker",
        "status": "online",
        "short_desc": "检索重排序模型占位条目",
        "description": _DEMO_NOTICE,
        "context_window": "8K",
        "speed": "fast",
        "import_format": "openai",
        "extra": _extra(tags=["重排序", "语义搜索", "RAG"], params="—"),
    },
    {
        "id": "demo-ocr-model",
        "name": "Demo OCR Model",
        "provider": "Example Provider",
        "category": "ocr",
        "status": "online",
        "short_desc": "文档识别模型占位条目",
        "description": _DEMO_NOTICE,
        "context_window": "—",
        "speed": "fast",
        "import_format": "custom",
        "extra": _extra(tags=["文字识别", "文档理解", "结构化"], upstream_path="/recognize"),
    },
]


def _merge_extra(existing: dict | None, catalog_extra: dict) -> dict:
    """只补/更新目录拥有的展示字段，保留管理员扩展字段。"""
    merged = dict(existing or {})
    merged.update(catalog_extra)
    return merged


def seed_catalog_models(db: Session) -> None:
    """空库引导演示目录，且永久尊重管理员的删除、改名和部署配置。

    ``catalog_seeded_ids`` 记录历史上已补种的 id，因而管理员删除条目后，
    下次启动不会将其复活。仅在显式设置 ``CATALOG_FORCE_SYNC=1`` 时同步已有
    条目的展示字段；任何模式下都不写 base_url、api_key 或 custom_headers。
    """
    force = os.getenv("CATALOG_FORCE_SYNC", "").strip().lower() in ("1", "true", "yes", "on")
    ever_seeded = {model_id for (model_id,) in db.execute(select(CatalogSeededIdORM.model_id))}

    for spec in CATALOG_MODELS:
        model_id = spec["id"]
        catalog_extra = spec.get("extra") or {}
        row = db.get(ModelRegistryORM, model_id)

        if row is None:
            if model_id in ever_seeded:
                continue
            data = {field: spec[field] for field in _CATALOG_FIELDS if field in spec}
            data["id"] = model_id
            data["status"] = spec.get("status", "online")
            data["extra"] = _merge_extra(None, catalog_extra)
            db.add(ModelRegistryORM(**data))
            db.add(CatalogSeededIdORM(model_id=model_id))
            continue

        if model_id not in ever_seeded:
            db.add(CatalogSeededIdORM(model_id=model_id))
        if not force:
            continue
        for field in _CATALOG_FIELDS:
            if field in spec:
                setattr(row, field, spec[field])
        row.extra = _merge_extra(row.extra, catalog_extra)


# key 保持兼容既有数据；label 是中性默认值，并可在后台维护。
DEFAULT_SCENE_TYPES: list[tuple[str, str, int]] = [
    ("key", "重点业务", 1),
    ("labor_contest", "专项活动", 2),
    ("innovation", "创新实验", 3),
    ("explore", "概念验证", 4),
    ("dept_explore", "团队试用", 5),
]


def seed_scene_types(db: Session) -> None:
    """补种缺失的中性场景分类，不覆盖管理员已维护的条目。"""
    db.execute(
        text(
            "INSERT INTO scene_types (key, label, sort_order) "
            "VALUES (:k, :l, :o) ON CONFLICT (key) DO NOTHING"
        ),
        [{"k": key, "l": label, "o": order} for key, label, order in DEFAULT_SCENE_TYPES],
    )
