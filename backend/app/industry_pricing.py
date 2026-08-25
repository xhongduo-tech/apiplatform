"""Token 成本估算。

开源版本不预置供应商价格或内部采购口径。管理员可在模型注册表中配置每百万
Token 的输入/输出价格；未配置时返回 0，避免把示例值误当作真实账单。
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models import ModelRegistryORM


def industry_pricing(model_id: str | None) -> tuple[float, float]:
    """兼容旧调用方；未配置的模型不推测价格。"""
    del model_id
    return (0.0, 0.0)


def resolve_pricing(
    model: ModelRegistryORM | None = None,
    model_id: str | None = None,
) -> tuple[float, float]:
    """管理员配置优先，未配置时按零成本返回。"""
    if model is not None and (model.pricing_input is not None or model.pricing_output is not None):
        return (float(model.pricing_input or 0.0), float(model.pricing_output or 0.0))
    return industry_pricing(model_id or (model.id if model is not None else None))


def estimate_tokens_cost(
    prompt_tokens: int | None,
    completion_tokens: int | None,
    *,
    model: ModelRegistryORM | None = None,
    model_id: str | None = None,
) -> float:
    pin, pout = resolve_pricing(model, model_id)
    return round(
        ((prompt_tokens or 0) * pin + (completion_tokens or 0) * pout) / 1_000_000,
        6,
    )
