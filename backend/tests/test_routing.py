"""上游路径解析单测。"""
from app.models import ModelRegistryORM
from app.proxy.routing import (
    _ep_counters,
    adapt_request,
    build_endpoint,
    resolve_upstream_path,
    select_endpoint,
)


def test_resolve_upstream_path_default():
    m = ModelRegistryORM(id="x", name="x", provider="")
    assert resolve_upstream_path(m, "/embeddings") == "/embeddings"


def test_resolve_upstream_path_from_extra():
    m = ModelRegistryORM(
        id="pp-ocrv6", name="pp", provider="",
        extra={"upstream_path": "/recognize"},
    )
    assert resolve_upstream_path(m, "/ocr") == "/recognize"


def test_build_endpoint_openai_with_override():
    m = ModelRegistryORM(
        id="pp-ocrv6", name="pp", provider="",
        base_url="http://localhost:8080",
        import_format="openai",
        extra={"upstream_path": "/recognize"},
    )
    url, _, _ = build_endpoint(m, "/ocr")
    assert url == "http://localhost:8080/recognize"


def _hetero_model() -> ModelRegistryORM:
    """同一模型部署在两个集群，各集群 base_url / 密钥 / 上游模型名 / 路径均不同。"""
    return ModelRegistryORM(
        id="hetero-1", name="hetero", provider="",
        # 顶层字段镜像 primary（endpoints[0]）
        base_url="http://cluster-a:8000", api_key="key-a",
        model_api_name="Qwen-A", import_format="openai",
        extra={"endpoints": [
            {"base_url": "http://cluster-a:8000", "api_key": "key-a",
             "model_api_name": "Qwen-A", "import_format": "openai",
             "upstream_path": "/v1/chat/completions"},
            {"base_url": "http://cluster-b:9000", "api_key": "key-b",
             "model_api_name": "Qwen-B", "import_format": "openai",
             "upstream_path": "/proxy/chat"},
        ]},
    )


def test_select_endpoint_round_robins_full_fields():
    """轮询必须整节点切换：密钥/模型名/路径随所选节点一起变，不再恒取 primary。"""
    m = _hetero_model()
    _ep_counters.pop(m.id, None)  # 复位进程内轮询计数器

    first = select_endpoint(m)
    second = select_endpoint(m)
    # 两次分别命中两个不同节点
    picks = {first["ep_idx"]: first, second["ep_idx"]: second}
    assert set(picks) == {0, 1}

    a, b = picks[0], picks[1]
    assert (a["base_url"], a["api_key"], a["model_api_name"]) == (
        "http://cluster-a:8000", "key-a", "Qwen-A")
    assert (b["base_url"], b["api_key"], b["model_api_name"]) == (
        "http://cluster-b:9000", "key-b", "Qwen-B")

    # build_endpoint / adapt_request 使用 eff，鉴权、路径、模型名整节点一致
    url_b, headers_b, _ = build_endpoint(m, "/chat/completions", b)
    assert url_b == "http://cluster-b:9000/proxy/chat"
    assert headers_b["Authorization"] == "Bearer key-b"
    assert adapt_request({"model": "hetero-1"}, m, b)["model"] == "Qwen-B"


def _partial_endpoints_model() -> ModelRegistryORM:
    """最常见的加节点方式：新节点只填 base_url，其余沿用模型顶层配置。"""
    return ModelRegistryORM(
        id="partial-1", name="partial", provider="",
        base_url="http://node-a:8000", api_key="model-key",
        model_api_name="Qwen3-235B", import_format="anthropic",
        custom_headers={"X-Tenant": "example-tenant"},
        extra={"endpoints": [
            {"base_url": "http://node-a:8000"},
            {"base_url": "http://node-b:8000", "api_key": "key-b"},
        ]},
    )


def test_endpoint_omitted_fields_fall_back_to_model():
    """端点没填的字段必须回落模型顶层，不能变成 None / 被硬塞 openai。

    回归的是这样一个 bug：只填 base_url 的节点会丢掉上游 api_key（转发不带
    鉴权）、丢掉 model_api_name（把用户请求的别名原样发给推理节点），
    import_format 还被强制成 "openai"——anthropic 格式的模型因此走进转换
    路径。多节点轮询下同一模型相邻两次请求走上不同处理路径，表现为并发
    调用结果互相打架。
    """
    m = _partial_endpoints_model()
    _ep_counters.pop(m.id, None)

    picks = {}
    for _ in range(2):
        eff = select_endpoint(m)
        picks[eff["ep_idx"]] = eff
    assert set(picks) == {0, 1}

    a, b = picks[0], picks[1]
    # 全部字段回落模型顶层
    assert a["api_key"] == "model-key"
    assert a["model_api_name"] == "Qwen3-235B"
    assert a["import_format"] == "anthropic"
    assert a["custom_headers"] == {"X-Tenant": "example-tenant"}
    # 节点显式填了的字段仍然优先；未填的照旧回落
    assert b["api_key"] == "key-b"
    assert b["model_api_name"] == "Qwen3-235B"
    assert b["import_format"] == "anthropic"

    # 两个节点的处理路径必须一致，只有 base_url / 凭证不同
    assert a["import_format"] == b["import_format"]
    for eff, expect_key in ((a, "model-key"), (b, "key-b")):
        _, headers, _ = build_endpoint(m, "/chat/completions", eff)
        assert headers["Authorization"] == f"Bearer {expect_key}"
        assert headers["X-Tenant"] == "example-tenant"


def test_endpoint_explicit_empty_string_also_falls_back():
    """admin 表单留空会存成 ""，与"没填"必须同义，不能当成"显式置空"。"""
    m = ModelRegistryORM(
        id="blank-1", name="blank", provider="",
        base_url="http://node:8000", api_key="model-key",
        model_api_name="RealName", import_format="openai",
        extra={"endpoints": [{"base_url": "http://node:8000",
                              "api_key": "", "model_api_name": ""}]},
    )
    _ep_counters.pop(m.id, None)
    eff = select_endpoint(m)
    assert eff["api_key"] == "model-key"
    assert eff["model_api_name"] == "RealName"


def test_select_endpoint_weighted_distribution():
    """权重决定流量配比：1:3 时 8 次分发里选中 A 2 次、B 6 次，且交错分布。"""
    m = ModelRegistryORM(
        id="weighted-1", name="weighted", provider="",
        extra={"endpoints": [
            {"base_url": "http://node-a:8000", "weight": 1},
            {"base_url": "http://node-b:8000", "weight": 3},
        ]},
    )
    _ep_counters.pop(m.id, None)
    seq = []
    for _ in range(8):
        eff = select_endpoint(m)
        seq.append("a" if eff["base_url"].startswith("http://node-a") else "b")
    assert seq.count("a") == 2 and seq.count("b") == 6  # 精确 1:3
    # 交错分布：4 个分发周期内的相对顺序 = [a, b, b, b]，不会连续打爆 A
    assert seq[:4] == ["a", "b", "b", "b"]


def test_select_endpoint_weight_defaults_to_one():
    """未配 weight 的旧节点按 1 处理，多个节点间仍均分（与原有轮询一致）。"""
    m = ModelRegistryORM(
        id="noweight-1", name="noweight", provider="",
        extra={"endpoints": [
            {"base_url": "http://node-a:8000"},
            {"base_url": "http://node-b:8000"},
        ]},
    )
    _ep_counters.pop(m.id, None)
    picks = [select_endpoint(m)["base_url"] for _ in range(4)]
    assert picks.count("http://node-a:8000") == 2
    assert picks.count("http://node-b:8000") == 2


def test_custom_endpoint_forwards_client_model_name_transparently():
    """custom 节点缺省透传客户端模型名，不继承主节点（openai）的模型名。

    一个 openai 节点 + 一个 custom（键值对）节点共存的模型里，轮询切到
    custom 节点时若硬塞主节点的模型名，异构上游会报「模型名不一致/找不到」。
    这里 custom 节点没填上游模型名 → 请求体保留客户端原始 model，上游看到
    的就是用户调用的那个名字。显式填了 model_api_name 的 custom 节点仍优先。
    """
    m = ModelRegistryORM(
        id="mixed-1", name="mixed", provider="",
        # 顶层镜像 primary（openai 节点）
        base_url="http://openai-a:8000/v1", api_key="key-a",
        model_api_name="Qwen-A", import_format="openai",
        extra={"endpoints": [
            {"base_url": "http://openai-a:8000/v1", "api_key": "key-a",
             "model_api_name": "Qwen-A", "import_format": "openai"},
            {"base_url": "http://forward-b:8080/v1/chat/completions",
             "import_format": "custom",
             "custom_headers": {"X-Tenant": "example-tenant"}},
        ]},
    )
    _ep_counters.pop(m.id, None)

    # 第一次轮询命中 openai 节点：改写为它自己的模型名
    eff0 = select_endpoint(m)
    assert eff0["import_format"] == "openai"
    assert eff0["model_api_name"] == "Qwen-A"
    # 第二次命中 custom 节点：透传客户端模型名
    eff1 = select_endpoint(m)
    assert eff1["import_format"] == "custom"
    assert eff1["model_api_name"] is None
    assert adapt_request({"model": "platform-sota"}, m, eff1)["model"] == "platform-sota"
    # custom 节点完整 URL 原样建连 + 携带自己的键值对头；且不继承主节点的
    # Bearer 密钥（异构上游不该平白拿到无关主节点的凭证）
    url, headers, _ = build_endpoint(m, "/chat/completions", eff1)
    assert url == "http://forward-b:8080/v1/chat/completions"
    assert headers["X-Tenant"] == "example-tenant"
    assert "Authorization" not in headers


def test_custom_endpoint_explicit_model_name_wins():
    """custom 节点显式填了上游模型名时仍然优先改写，不因透传规则失效。"""
    m = ModelRegistryORM(
        id="custexp-1", name="custexp", provider="",
        base_url="http://openai-a:8000/v1", model_api_name="Qwen-A",
        import_format="openai",
        extra={"endpoints": [
            {"base_url": "http://openai-a:8000/v1", "model_api_name": "Qwen-A",
             "import_format": "openai"},
            {"base_url": "http://forward-b:8080/chat",
             "import_format": "custom", "model_api_name": "custom-model"},
        ]},
    )
    _ep_counters.pop(m.id, None)
    _ = select_endpoint(m)  # 第一个分发周期选中 primary（openai）
    eff1 = select_endpoint(m)  # 第二个选中 custom 节点
    assert eff1["import_format"] == "custom"
    assert eff1["model_api_name"] == "custom-model"
    assert adapt_request({"model": "platform-sota"}, m, eff1)["model"] == "custom-model"


def test_multi_node_blank_path_inherits_primary_path():
    """多节点里缺 upstream_path 的节点回落模型级路径覆盖（镜像 primary）。

    否则 node-b 缺路径时会静默退回默认后缀（/ocr），而 node-a 用自定义路径
    /recognize——同一模型相邻两次请求上游路径不一致，OCR 之类非默认路径的
    模型会间歇 404。
    """
    m = ModelRegistryORM(
        id="path-1", name="path", provider="",
        base_url="http://node-a:8000", model_api_name="Qwen",
        extra={"upstream_path": "/recognize",
               "endpoints": [
                   {"base_url": "http://node-a:8000", "upstream_path": "/recognize"},
                   {"base_url": "http://node-b:8000"},
               ]},
    )
    _ep_counters.pop(m.id, None)
    _ = select_endpoint(m)  # 第一个分发周期选中 node-a
    eff_b = select_endpoint(m)  # node-b（缺 upstream_path）
    url, _, _ = build_endpoint(m, "/ocr", eff_b)
    assert url == "http://node-b:8000/recognize"


def test_custom_endpoint_body_passes_through():
    """custom 节点请求体原样透传：不做参数清理、不应用模型级覆盖。"""
    m = ModelRegistryORM(
        id="custbody-1", name="custbody", provider="",
        base_url="http://node:8000", model_api_name="Qwen-A",
        extra={"endpoints": [
            {"base_url": "http://fwd:8080/chat", "import_format": "custom"},
        ]},
    )
    _ep_counters.pop(m.id, None)
    eff = select_endpoint(m)
    body = adapt_request(
        {"model": "platform-sota", "user": "trace-1", "metadata": {"a": 1}}, m, eff)
    assert body == {"model": "platform-sota", "user": "trace-1", "metadata": {"a": 1}}


def test_openai_endpoint_preserves_caller_user_isolation_field():
    """OpenAI 的 user 是调用方隔离终端用户的标准字段，网关不得静默删除。"""
    m = ModelRegistryORM(
        id="oai-user-1", name="oai-user", provider="",
        base_url="http://node:8000", model_api_name="Qwen-A",
        import_format="openai",
    )
    body = adapt_request(
        {"model": "alias", "user": "tenant-user-42", "best_of": 2}, m,
    )
    assert body["user"] == "tenant-user-42"
    assert "best_of" not in body


def test_select_endpoint_bad_weight_falls_back_to_one():
    """非法/越界 weight（0、负数、非数字）在路由层按 1 兜底，不炸请求。"""
    m = ModelRegistryORM(
        id="badweight-1", name="badweight", provider="",
        extra={"endpoints": [
            {"base_url": "http://node-a:8000", "weight": 0},
            {"base_url": "http://node-b:8000", "weight": "abc"},
            {"base_url": "http://node-c:8000", "weight": 2},
        ]},
    )
    _ep_counters.pop(m.id, None)
    seq = [select_endpoint(m)["base_url"] for _ in range(8)]
    # 权重合计 1+1+2=4：A/B 各 2 次、C 4 次
    assert seq.count("http://node-a:8000") == 2
    assert seq.count("http://node-b:8000") == 2
    assert seq.count("http://node-c:8000") == 4
