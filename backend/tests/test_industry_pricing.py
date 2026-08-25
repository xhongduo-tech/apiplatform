"""成本估算仅使用管理员配置，不携带供应商或内部价格。"""
from app.industry_pricing import estimate_tokens_cost, industry_pricing, resolve_pricing


def test_unconfigured_model_has_no_assumed_price():
    assert industry_pricing("demo-chat-model") == (0.0, 0.0)


def test_estimate_is_zero_when_unpriced():
    assert estimate_tokens_cost(1_000_000, 500_000, model_id="demo-chat-model") == 0.0


def test_admin_override_beats_industry():
    class _M:
        id = "demo-chat-model"
        pricing_input = 10.0
        pricing_output = 20.0

    pin, pout = resolve_pricing(_M(), "demo-chat-model")
    assert (pin, pout) == (10.0, 20.0)
    cost = estimate_tokens_cost(1_000_000, 0, model=_M(), model_id="demo-chat-model")
    assert cost == 10.0


def test_unknown_model_gets_default():
    assert industry_pricing("totally-unknown-xyz") == (0.0, 0.0)
