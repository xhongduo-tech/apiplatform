"""prompt token 估算单测（TPM 预扣 + count_tokens 端点共用的估算器）。"""
from app.proxy.token_estimate import estimate_prompt_tokens


def test_estimate_counts_tools_and_tool_calls():
    base = {"messages": [{"role": "user", "content": "hi"}]}
    with_tools = {
        **base,
        "tools": [{"type": "function", "function": {
            "name": "search", "description": "web search " * 200,
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        }}],
    }
    assert estimate_prompt_tokens(with_tools) > estimate_prompt_tokens(base) + 100

    with_tc = {"messages": [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "tool_calls": [{"type": "function", "function": {
            "name": "search", "arguments": '{"q": "' + "长查询" * 500 + '"}'}}]},
        {"role": "tool", "content": "result " * 300},
    ]}
    assert estimate_prompt_tokens(with_tc) > 1000


def test_estimate_anthropic_format():
    body = {
        "system": [{"type": "text", "text": "系统提示" * 100}],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "问题" * 100},
            {"type": "image", "source": {"type": "base64", "data": "x" * 100000}},
        ]}],
        "max_tokens": 4096,
    }
    est = estimate_prompt_tokens(body)
    # 图片按固定 1024 计，不能被 base64 长度撑爆
    assert 1024 < est < 3000


def test_estimate_completions_prompt_and_responses_input():
    assert estimate_prompt_tokens({"prompt": "补全" * 500}) >= 1000
    assert estimate_prompt_tokens({"input": "输入" * 500, "instructions": "指令" * 100}) >= 1200
