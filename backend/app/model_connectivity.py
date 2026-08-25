"""管理端模型接入连通性探活。"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
import time
from typing import Any

import httpx

from app.models import ModelRegistryORM
from app.proxy.client import get_client
from app.proxy.routing import build_endpoint, list_all_endpoint_effs

# 探活专用超时：比生产 relay 更短，避免管理界面长时间挂起
_PROBE_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=5.0)
_PROBE_CONCURRENCY = 4


@dataclass(frozen=True)
class ModelProbeConfig:
    """从 ORM 复制出的纯数据快照，可在释放 DB session 后安全探活。"""

    id: str
    name: str
    category: str
    base_url: str | None
    model_api_name: str | None
    api_key: str | None
    import_format: str | None
    custom_headers: dict | None
    extra: dict | None
    resolve_to_model_id: str | None


def snapshot_model(model: ModelRegistryORM) -> ModelProbeConfig:
    return ModelProbeConfig(
        id=model.id,
        name=model.name,
        category=model.category,
        base_url=model.base_url,
        model_api_name=model.model_api_name,
        api_key=model.api_key,
        import_format=model.import_format,
        custom_headers=deepcopy(model.custom_headers) if isinstance(model.custom_headers, dict) else None,
        extra=deepcopy(model.extra) if isinstance(model.extra, dict) else None,
        resolve_to_model_id=model.resolve_to_model_id,
    )


def _endpoint_label(model: ModelRegistryORM, eff: dict, fallback: str) -> str:
    extra = model.extra if isinstance(model.extra, dict) else {}
    eps = extra.get("endpoints")
    idx = eff.get("ep_idx", 0)
    if isinstance(eps, list) and 0 <= idx < len(eps):
        ep = eps[idx]
        if isinstance(ep, dict):
            label = (ep.get("label") or "").strip()
            if label:
                return label
    return fallback


def _model_name(model: ModelRegistryORM, eff: dict) -> str:
    return (eff.get("model_api_name") or model.model_api_name or model.id).strip()


def _result(
    *,
    ok: bool,
    latency_ms: int,
    message: str,
    status_code: int | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": ok, "latency_ms": latency_ms, "message": message}
    if status_code is not None:
        out["status_code"] = status_code
    return out


async def _probe_openai_models(model: ModelRegistryORM, eff: dict) -> httpx.Response:
    client = get_client()
    url, headers, _ = build_endpoint(model, "/models", eff)
    return await client.get(url, headers=headers, timeout=_PROBE_TIMEOUT)


async def _probe_openai_post(
    model: ModelRegistryORM, eff: dict, suffix: str, body: dict,
) -> httpx.Response:
    client = get_client()
    url, headers, _ = build_endpoint(model, suffix, eff)
    return await client.post(url, headers=headers, json=body, timeout=_PROBE_TIMEOUT)


async def probe_endpoint_eff(model: ModelRegistryORM, eff: dict) -> dict[str, Any]:
    """对单个接入 eff 执行连通性探活。"""
    t0 = time.perf_counter()
    base = (eff.get("base_url") or "").strip()
    if not base:
        return _result(ok=False, latency_ms=0, message="未配置 base_url")

    imp = eff.get("import_format") or "openai"
    name = _model_name(model, eff)

    try:
        if imp == "custom":
            url, headers, _ = build_endpoint(model, "", eff)
            resp = await get_client().post(url, headers=headers, json={}, timeout=_PROBE_TIMEOUT)
        elif imp == "anthropic":
            base = eff["base_url"].rstrip("/")
            url = f"{base}/v1/messages"
            headers: dict[str, str] = {
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
            }
            if eff.get("api_key"):
                headers["x-api-key"] = eff["api_key"]
            if eff.get("custom_headers"):
                headers.update(eff["custom_headers"])
            body = {
                "model": name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ping"}],
            }
            resp = await get_client().post(url, headers=headers, json=body, timeout=_PROBE_TIMEOUT)
        elif model.category == "embedding":
            resp = await _probe_openai_post(
                model, eff, "/embeddings", {"model": name, "input": "ping"},
            )
        elif model.category == "reranker":
            resp = await _probe_openai_post(
                model, eff, "/rerank",
                {"model": name, "query": "ping", "documents": ["pong"]},
            )
        elif model.category == "ocr":
            resp = await _probe_openai_post(model, eff, "/recognize", {})
        elif model.category == "image_generation":
            resp = await _probe_openai_post(
                model, eff, "/images/generations",
                {"model": name, "prompt": "ping", "n": 1, "size": "256x256"},
            )
        else:
            resp = await _probe_openai_models(model, eff)
            if resp.status_code == 404:
                resp = await _probe_openai_post(
                    model, eff, "/chat/completions",
                    {
                        "model": name,
                        "max_tokens": 1,
                        "messages": [{"role": "user", "content": "ping"}],
                    },
                )
    except httpx.ConnectError:
        latency = int((time.perf_counter() - t0) * 1000)
        return _result(ok=False, latency_ms=latency, message="连接失败，无法到达上游")
    except httpx.TimeoutException:
        latency = int((time.perf_counter() - t0) * 1000)
        return _result(ok=False, latency_ms=latency, message="连接超时")
    except Exception as exc:  # noqa: BLE001 — 管理端探活需兜底展示
        latency = int((time.perf_counter() - t0) * 1000)
        return _result(ok=False, latency_ms=latency, message=f"探活异常：{exc}")

    latency = int((time.perf_counter() - t0) * 1000)
    code = resp.status_code
    if code < 400:
        return _result(ok=True, latency_ms=latency, status_code=code, message="连通正常")
    if code in (401, 403):
        return _result(
            ok=False, latency_ms=latency, status_code=code,
            message="可达但鉴权失败，请检查 API Key",
        )
    if code >= 500:
        return _result(
            ok=False, latency_ms=latency, status_code=code,
            message=f"上游服务异常（HTTP {code}）",
        )
    return _result(
        ok=False, latency_ms=latency, status_code=code,
        message=f"上游返回 HTTP {code}",
    )


async def run_connectivity_test(model: ModelRegistryORM) -> list[dict[str, Any]]:
    """逐接入探活，返回带 label / base_url 的结果列表。"""
    effs = list_all_endpoint_effs(model)
    if not effs:
        return [{
            "index": 0,
            "label": "—",
            "base_url": "",
            "ok": False,
            "latency_ms": 0,
            "message": "该模型尚未配置任何接入",
        }]

    semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

    async def run_one(i: int, eff: dict) -> dict[str, Any]:
        async with semaphore:
            probe = await probe_endpoint_eff(model, eff)
        return {
            "index": eff.get("ep_idx", i),
            "label": _endpoint_label(model, eff, f"接入 {i + 1}"),
            "base_url": eff.get("base_url") or "",
            **probe,
        }

    # gather 保持输入顺序，同时避免多节点逐个等待 15s 超时。
    return list(await asyncio.gather(*(run_one(i, eff) for i, eff in enumerate(effs))))
