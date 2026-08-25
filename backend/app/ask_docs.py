"""Ask Docs — 平台文档检索 + LLM 调用。

语料来自接口文档同步产物（见 app/ask_docs_corpus.py /
scripts/sync_ask_docs_corpus.py），覆盖 /docs 全部一级章节。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.ask_docs_corpus import load_docs_corpus, search_docs
from app.models import ModelRegistryORM
from app.platform_settings import AskDocsConfig, BrandingConfig
from app.proxy.client import get_client
from app.request_context import with_upstream_request_headers

#: config.provider 为该哨兵值时，config.model 视为 model_registry 的模型 id，
#: 凭证与上游地址直接从模型注册表取（含 resolve_to_model_id 别名解析）。
PLATFORM_PROVIDER = "platform"

_PLATFORM_CONFIG_ERROR = "智能问答未配置有效模型，请前往管理后台选择接入模型"


@dataclass(frozen=True)
class ResolvedLlmConfig:
    """已从数据库完整解析、可安全跨 await/stream 生命周期使用的不可变快照。"""

    api_base: str
    api_key: str
    model: str
    custom_headers: dict[str, str] | None
    max_tokens: int
    temperature: float

def __getattr__(name: str):
    # 兼容 `from app.ask_docs import DOCS_CORPUS`：始终读最新已加载语料
    if name == "DOCS_CORPUS":
        return load_docs_corpus()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def build_messages(
    question: str,
    config: AskDocsConfig,
    branding: BrandingConfig | None = None,
) -> list[dict[str, str]]:
    """构建发给 LLM 的 messages。"""
    active_branding = branding or BrandingConfig()
    docs_context = search_docs(question)
    docs_context = (
        docs_context
        .replace("{brand}", active_branding.brand_name)
        .replace("{platformName}", active_branding.platform_name)
        .replace("{supportDepartment}", active_branding.support_department)
    )

    system = (
        config.system_prompt
        if config.system_prompt
        else (
            f"你是 {active_branding.brand_name} 的智能文档助手。你需要根据用户的问题，"
            "结合以下平台文档内容，给出准确、简洁、有帮助的回答。"
            "如果文档中没有直接答案，请诚实地告知用户并建议他们查阅完整文档或联系管理员。"
            "回答时请尽量引用文档中的具体信息，使用中文回复。"
        )
    )

    user = (
        f"以下是与用户问题相关的平台文档：\n\n{docs_context}\n\n"
        f"用户问题：{question}\n\n请根据上述文档内容回答用户的问题。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _resolve_platform_model(db: Session, model_id: str) -> ModelRegistryORM:
    """按 model_registry id 定位模型，跟随 resolve_to_model_id 链解析到具体模型
    （防环，最多 5 跳）。任一环节失败均抛出 400，提示管理员重新选择接入模型。"""
    current_id = (model_id or "").strip()
    seen: set[str] = set()
    for _ in range(5):
        if not current_id or current_id in seen:
            raise HTTPException(status_code=400, detail=_PLATFORM_CONFIG_ERROR)
        seen.add(current_id)
        rec = db.get(ModelRegistryORM, current_id)
        if rec is None:
            raise HTTPException(status_code=400, detail=_PLATFORM_CONFIG_ERROR)
        if not rec.resolve_to_model_id:
            return rec
        current_id = rec.resolve_to_model_id
    raise HTTPException(status_code=400, detail=_PLATFORM_CONFIG_ERROR)


def _llm_params(db: Session, config: AskDocsConfig) -> tuple[str, str, str, dict | None]:
    """解析本次 LLM 调用所需的 (api_base, api_key, model, custom_headers)。

    platform 模式：从模型注册表取凭证，优先 extra.endpoints[0]，缺省字段回落
    模型顶层（与 proxy.routing.select_endpoint 的端点覆盖语义一致）；其他
    provider 走旧的自定义 api_base/api_key 路径，保持老配置可用。
    """
    if (config.provider or "") != PLATFORM_PROVIDER:
        api_base = (config.api_base or "").rstrip("/") or "https://api.openai.com/v1"
        return api_base, config.api_key or "", config.model, None

    rec = _resolve_platform_model(db, config.model)
    extra = rec.extra if isinstance(rec.extra, dict) else {}
    eps = extra.get("endpoints")
    ep = eps[0] if isinstance(eps, list) and eps and isinstance(eps[0], dict) else None

    def _pick(snake: str, camel: str, fallback):
        if ep is None:
            return fallback
        v = ep.get(snake) or ep.get(camel)
        return v if v else fallback

    api_base = str(_pick("base_url", "baseUrl", rec.base_url) or "").strip().rstrip("/")
    if not api_base:
        raise HTTPException(status_code=400, detail=_PLATFORM_CONFIG_ERROR)
    api_key = _pick("api_key", "apiKey", rec.api_key) or ""
    model = _pick("model_api_name", "modelApiName", rec.model_api_name) or rec.id
    custom_headers = _pick("custom_headers", "customHeaders", rec.custom_headers)
    return api_base, api_key, model, custom_headers


def resolve_llm_config(db: Session, config: AskDocsConfig) -> ResolvedLlmConfig:
    """在同步 DB 阶段解析所有上游参数，随后请求可立即释放 Session。"""
    api_base, api_key, model, custom_headers = _llm_params(db, config)
    header_copy = None
    if isinstance(custom_headers, dict):
        header_copy = {str(key): str(value) for key, value in custom_headers.items()}
    return ResolvedLlmConfig(
        api_base=api_base,
        api_key=api_key,
        model=model,
        custom_headers=header_copy,
        max_tokens=config.max_tokens,
        temperature=config.temperature,
    )


async def call_llm(
    messages: list[dict[str, str]],
    config: ResolvedLlmConfig,
) -> str:
    """调用配置的 LLM 获取回答（非流式）。"""
    url = f"{config.api_base}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.api_key}",
    }
    if config.custom_headers:
        headers.update(config.custom_headers)
    headers = with_upstream_request_headers(headers)
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    }

    resp = await get_client().post(url, json=payload, headers=headers, timeout=httpx.Timeout(60.0))
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


async def call_llm_stream(
    messages: list[dict[str, str]],
    config: ResolvedLlmConfig,
):
    """调用配置的 LLM 获取流式回答（async generator）。"""
    url = f"{config.api_base}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.api_key}",
    }
    if config.custom_headers:
        headers.update(config.custom_headers)
    headers = with_upstream_request_headers(headers)
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
        "stream": True,
    }

    async with get_client().stream(
        "POST", url, json=payload, headers=headers, timeout=httpx.Timeout(120.0),
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if line.startswith("data: "):
                data_str = line[6:]
                if data_str == "[DONE]":
                    yield "[DONE]"
                    break
                yield data_str
