"""端点解析 + 请求适配 + 虚拟模型路由 + 多节点加权轮询。

多节点部署时，在 model.extra.endpoints[] 里列出各节点，网关在进程内做加权轮询
分发，不依赖外部 LB。支持异构接入：每个端点可有独立的 base_url / api_key /
model_api_name / import_format / custom_headers / upstream_path / weight ——
轮询到哪个节点，就完整使用该节点自身的凭证与参数（见 select_endpoint）。
weight 控制流量配比：权重 w 的节点在 total=Σw 的分发周期内被选中 w 次，
长线比例即 w/total；缺省 1（各节点均分）。同一请求务必先 select_endpoint()
选一次，再把 eff 传给 build_endpoint / adapt_request，避免分别选取导致建连
节点与鉴权/模型名不一致。

异构节点的语义：每个节点都**完整携带自己的接入参数**，轮询到哪个节点就
按哪个节点的凭证/格式/模型名转发（显式配置永远优先）。未显式配置的字段：
openai / anthropic 节点回落模型顶层（副本语义——"只填一个 URL 就复用主节点
的模型名与密钥"）；custom 节点（完整 URL + 键值对头的纯转发）是**完全独立
的资源**——模型名缺省透传客户端请求里的名字，密钥/自定义头只认节点自己的，
请求体原样透传，不做参数清理与模型级覆盖。这样"标准 openai 主节点 + 键值对
辅助节点"共存的模型里，轮询切到哪一节点都用哪一节点自己的整套参数，上游
不会再收到"主节点的模型名 / Bearer 密钥被硬塞过来"的请求。
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.early_access import EARLY_ACCESS_STATUS
from app.model_secrets import normalize_custom_headers
from app.models import ModelRegistryORM
from app.proxy.fallback import get_config as get_fallback_config
from app.request_context import with_upstream_request_headers

# 正式可调用状态：虚拟模型对齐目标与兜底目标只认这几个——抢先体验模型故意
# **不在**此列，避免绕过授权检查从别的模型 id 打进去。
_CALLABLE_STATUS = ("online", "exclusive", "unstable")

_STRIP_PARAMS = {
    "best_of", "echo",
    "service_tier", "store", "metadata",
}

_MODEL_OVERRIDES: dict[str, dict[str, Any]] = {}

# 进程内轮询计数器（asyncio 单线程，无需锁）
_ep_counters: dict[str, int] = {}


def _validated_custom_headers(value, *, model_id: str) -> dict[str, str] | None:
    """Fail closed for legacy rows written before header validation existed."""
    try:
        return normalize_custom_headers(value, where=f"model {model_id} custom_headers")
    except ValueError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"模型 {model_id} 的上游请求头配置无效",
        ) from exc


def normalize_model_ref(value: str) -> str:
    return str(value).strip().casefold()


def model_call_names(record: ModelRegistryORM) -> list[str]:
    """API 请求 model 字段允许的调用名称清单（大小写敏感）。"""
    extra = record.extra if isinstance(record.extra, dict) else {}
    raw = extra.get("call_names") or extra.get("callNames") or []
    if not isinstance(raw, list):
        return []
    return [str(x).strip() for x in raw if str(x).strip()]


def _find_model_record(db: Session, requested_id: str) -> ModelRegistryORM | None:
    if not requested_id or not str(requested_id).strip():
        return None
    raw = str(requested_id).strip()

    rec = db.get(ModelRegistryORM, raw)
    if rec is not None:
        return rec

    # 调用名称清单：大小写敏感精确匹配（已下线模型不参与占用）
    for row in db.execute(select(ModelRegistryORM)).scalars():
        if row.status == "offline":
            continue
        if raw in model_call_names(row):
            return row

    rec = db.execute(
        select(ModelRegistryORM).where(ModelRegistryORM.name == raw)
    ).scalar_one_or_none()
    if rec is not None:
        return rec

    needle = normalize_model_ref(raw)
    rec = db.execute(
        select(ModelRegistryORM).where(func.lower(ModelRegistryORM.id) == needle)
    ).scalar_one_or_none()
    if rec is not None:
        return rec

    return db.execute(
        select(ModelRegistryORM).where(func.lower(ModelRegistryORM.name) == needle)
    ).scalar_one_or_none()


def _find_model_by_id(db: Session, model_id: str) -> ModelRegistryORM | None:
    if not model_id:
        return None
    rec = db.get(ModelRegistryORM, model_id)
    if rec is not None:
        return rec
    needle = normalize_model_ref(model_id)
    return db.execute(
        select(ModelRegistryORM).where(func.lower(ModelRegistryORM.id) == needle)
    ).scalar_one_or_none()


def _deploy_ready(rec: ModelRegistryORM) -> bool:
    return bool((rec.base_url or "").strip() and (rec.model_api_name or "").strip())


def key_allows_model(
    key,
    canonical_model_id: str,
    requested: str,
    call_names: list[str] | None = None,
) -> bool:
    if not key.models:
        return True
    allowed = {normalize_model_ref(m) for m in key.models if m}
    if normalize_model_ref(canonical_model_id) in allowed:
        return True
    if normalize_model_ref(requested) in allowed:
        return True
    # 调用名称清单匹配时，Key 白名单仍按 canonical model id 判定
    if call_names and requested in call_names:
        return normalize_model_ref(canonical_model_id) in allowed
    return False


#: 按 id / 名称（大小写不敏感）定位模型记录。调用方若已解析过记录，可把它回传给
#: resolve_model 的 record 参数，避免热路径上重复查库。
find_model_record = _find_model_record


def resolve_model(
    db: Session, requested_id: str, record: ModelRegistryORM | None = None,
) -> tuple[ModelRegistryORM | None, str | None]:
    rec = record if record is not None else _find_model_record(db, requested_id)
    if rec is None:
        return None, None

    resolved_id: str | None = None
    is_virtual = rec.category == "lts" or bool(rec.resolve_to_model_id)

    if is_virtual:
        target_id = rec.resolve_to_model_id
        if not target_id:
            raise HTTPException(
                status_code=503,
                detail=f"虚拟模型 {rec.id} 尚未配置对齐目标（resolve_to_model_id），请联系管理员",
            )
        target = _find_model_by_id(db, target_id)
        if target is None or target.status not in _CALLABLE_STATUS:
            raise HTTPException(
                status_code=503,
                detail=f"虚拟模型 {rec.id} 的对齐目标 {target_id} 当前不可用",
            )
        if not _deploy_ready(target):
            raise HTTPException(
                status_code=503,
                detail=f"虚拟模型 {rec.id} 的对齐目标 {target_id} 尚未完成部署配置",
            )
        resolved_id = target.id
        rec = target
    elif not _deploy_ready(rec):
        raise HTTPException(
            status_code=503,
            detail=f"模型 {rec.id} 尚未完成部署配置（base_url / model_api_name）",
        )

    return rec, resolved_id


def is_early_access(rec: ModelRegistryORM) -> bool:
    """抢先体验计划模型：可被直接调用，但仅限已获授权的用户（见 early_access）。"""
    return rec.status == EARLY_ACCESS_STATUS


def is_callable(rec: ModelRegistryORM) -> bool:
    """模型本身是否处于可调用状态。抢先体验模型在此为 True，用户维度的授权
    检查由调用方（db_bridge._prepare_sync）单独完成。"""
    return rec.status in _CALLABLE_STATUS or is_early_access(rec)


def resolve_fallback_target(
    db: Session, model_record: ModelRegistryORM
) -> ModelRegistryORM | None:
    """解析模型的兜底目标；任一条件不满足即返回 None（静默降级为「无兜底」）。

    这里绝不抛异常：兜底配置写错不应该让正常请求失败，最坏退回到没有兜底。
    目标必须是可调用、已完成部署配置的**实模型**——指向虚拟模型会引入二次
    解析，故障时多一层不确定性，得不偿失。
    """
    cfg = get_fallback_config(model_record)
    if cfg is None:
        return None
    target_id = cfg["target_model_id"]
    if not target_id or normalize_model_ref(target_id) == normalize_model_ref(model_record.id):
        return None
    target = _find_model_by_id(db, target_id)
    if target is None or target.status not in _CALLABLE_STATUS or not _deploy_ready(target):
        return None
    if target.category == "lts" or target.resolve_to_model_id:
        return None
    return target


def _ep_url(ep: dict) -> str:
    """兼容 snake_case / camelCase 两种存储格式（Admin API 历史上两种均有可能）。"""
    return str(ep.get("base_url") or ep.get("baseUrl") or "").strip()


def _valid_endpoints(model_record: ModelRegistryORM) -> list[tuple[int, dict]]:
    """返回 extra.endpoints 中含有效 base_url 的 (原始下标, ep_dict) 列表。"""
    extra = model_record.extra if isinstance(model_record.extra, dict) else {}
    eps = extra.get("endpoints")
    if not isinstance(eps, list):
        return []
    return [(i, ep) for i, ep in enumerate(eps) if isinstance(ep, dict) and _ep_url(ep)]


def _ep_weight(ep: dict) -> int:
    """端点权重：流量分配比例。缺失/非法/≤0 一律回落 1（均分）。"""
    try:
        w = int(ep.get("weight") or 1)
    except (TypeError, ValueError):
        w = 1
    return w if w > 0 else 1


def _pick_weighted_round_robin(
    model_id: str, candidates: list[tuple[int, dict]]
) -> tuple[int, dict]:
    """进程内加权轮询：权重 w 的节点在 total=Σw 的分发周期内被选中 w 次，
    长线流量比例即 w/total，且相邻请求仍交错分布（不会连续打爆同一节点）。
    权重全为 1 时等价于原来的均匀轮询。计数器按 total 取模，改权重后自动对齐。
    """
    total = sum(_ep_weight(ep) for _, ep in candidates) or 1
    c = _ep_counters.get(model_id, 0) % total
    _ep_counters[model_id] = (c + 1) % total
    n = c
    for idx, ep in candidates:
        w = _ep_weight(ep)
        if n < w:
            return idx, ep
        n -= w
    return candidates[-1]


def select_endpoint(model_record: ModelRegistryORM) -> dict:
    """轮询选中一个上游端点，返回该端点自身的有效转发参数。

    异构接入：配置了 extra.endpoints[] 时，每个节点可拥有独立的
    base_url / api_key / model_api_name / import_format / custom_headers /
    upstream_path —— 全部随所选端点一起返回，而非恒取首节点（primary）。
    这样"同一模型部署在不同集群、各集群密钥/模型名/路径不同"时，轮询到哪个
    节点就用哪个节点的凭证与参数转发。未配置 endpoints[] 的旧单节点模型回退到
    模型顶层字段。返回值必须"选一次用到底"：同一请求的建连、鉴权、请求体改写
    共用同一个所选端点，切勿分别调用（会各自推进计数器而选中不同节点）。

    **端点只覆盖它自己显式填了的字段，其余一律回落模型顶层。** 早先的实现把
    未填字段直接当成 None（import_format 更是硬塞 "openai"），于是"加一个只填
    base_url 的节点"这一最常见操作会静默地：丢掉上游 api_key（转发变成不带
    鉴权）、丢掉 model_api_name（把用户请求的模型别名原样发给推理节点）、
    把 anthropic/custom 格式的模型误判成 openai 走转换路径。多节点轮询下同一
    模型的相邻两次请求因此走上完全不同的处理路径，表现就是"并发调用结果互相
    打架"。
    """
    valid = _valid_endpoints(model_record)
    if valid:
        idx, ep = _pick_weighted_round_robin(model_record.id, valid)

        def _pick(snake: str, camel: str, fallback):
            v = ep.get(snake)
            if v is None or v == "":
                v = ep.get(camel)
            return fallback if v is None or v == "" else v

        imp_fmt = _pick("import_format", "importFormat",
                        model_record.import_format or "openai")
        # custom 节点 = 完整 URL + 键值对头的「纯转发」，与主节点是完全独立的
        # 资源：模型名 / 密钥 / 自定义头一律只认节点自己显式配置的，**不继承
        # 主节点**——否则一个 openai 节点 + 一个 custom 节点共存时，轮询切到
        # custom 节点会把主节点的模型名与 Bearer 密钥一并塞给另一个异构上游，
        # 上游报「模型名不一致/找不到」，密钥也平白泄露给无关的第三方。显式
        # 配置永远优先。openai/anthropic 节点保留「未填回落模型顶层」的副本
        # 语义（同一模型多副本，只填 URL 即复用主节点的模型名与密钥）。
        if imp_fmt == "custom":
            model_api_name = _pick("model_api_name", "modelApiName", None)
            api_key = _pick("api_key", "apiKey", None)
            custom_headers = _pick("custom_headers", "customHeaders", None)
        else:
            model_api_name = _pick("model_api_name", "modelApiName",
                                   model_record.model_api_name)
            api_key = _pick("api_key", "apiKey", model_record.api_key)
            custom_headers = _pick("custom_headers", "customHeaders",
                                   model_record.custom_headers)

        return {
            "ep_idx": idx,
            "base_url": _ep_url(ep).rstrip("/"),
            "api_key": api_key,
            "model_api_name": model_api_name,
            "import_format": imp_fmt,
            "custom_headers": _validated_custom_headers(
                custom_headers, model_id=model_record.id,
            ),
            "upstream_path": _pick("upstream_path", "upstreamPath", None),
        }
    return {
        "ep_idx": 0,
        "base_url": (model_record.base_url or "").rstrip("/"),
        "api_key": model_record.api_key,
        "model_api_name": model_record.model_api_name,
        "import_format": model_record.import_format or "openai",
        "custom_headers": _validated_custom_headers(
            model_record.custom_headers, model_id=model_record.id,
        ),
        "upstream_path": None,  # 交给 _effective_path 回退 extra.upstream_path / 默认后缀
    }


def eff_from_endpoint_dict(model_record: ModelRegistryORM, ep_idx: int, ep: dict) -> dict:
    """将 extra.endpoints[] 中的单个节点展开为 eff 字典（供管理端逐节点探活）。"""

    def _pick(snake: str, camel: str, fallback):
        v = ep.get(snake)
        if v is None or v == "":
            v = ep.get(camel)
        return fallback if v is None or v == "" else v

    imp_fmt = _pick("import_format", "importFormat", model_record.import_format or "openai")
    if imp_fmt == "custom":
        model_api_name = _pick("model_api_name", "modelApiName", None)
        api_key = _pick("api_key", "apiKey", None)
        custom_headers = _pick("custom_headers", "customHeaders", None)
    else:
        model_api_name = _pick("model_api_name", "modelApiName", model_record.model_api_name)
        api_key = _pick("api_key", "apiKey", model_record.api_key)
        custom_headers = _pick("custom_headers", "customHeaders", model_record.custom_headers)

    return {
        "ep_idx": ep_idx,
        "base_url": _ep_url(ep).rstrip("/"),
        "api_key": api_key,
        "model_api_name": model_api_name,
        "import_format": imp_fmt,
        "custom_headers": _validated_custom_headers(
            custom_headers, model_id=model_record.id,
        ),
        "upstream_path": _pick("upstream_path", "upstreamPath", None),
    }


def list_all_endpoint_effs(model_record: ModelRegistryORM) -> list[dict]:
    """返回模型全部可用接入的 eff 配置（管理端连通性测试用，不做轮询）。"""
    valid = _valid_endpoints(model_record)
    if valid:
        return [eff_from_endpoint_dict(model_record, idx, ep) for idx, ep in valid]
    if (model_record.base_url or "").strip():
        return [select_endpoint(model_record)]
    return []


def adapt_request(body: dict, model_record: ModelRegistryORM, eff: dict | None = None) -> dict:
    out = dict(body)
    model_api_name = eff["model_api_name"] if eff else model_record.model_api_name
    if model_api_name:
        out["model"] = model_api_name
    if eff and eff.get("import_format") == "custom":
        # custom = 完整 URL + 键值对头的纯转发：除显式配置的上游模型名外，请求体
        # 原样透传——不做参数清理、不应用模型级覆盖、不动 max_tokens /
        # response_format。上游要什么就给它什么，避免"转发网关"掺入自己的策略。
        return out
    for p in _STRIP_PARAMS:
        out.pop(p, None)
    out.update(_MODEL_OVERRIDES.get(model_record.id, {}))
    if out.get("max_tokens") is None:
        out.pop("max_tokens", None)
    rf = out.get("response_format")
    if rf is not None and not isinstance(rf, dict):
        out.pop("response_format", None)
    return out


def resolve_upstream_path(model_record: ModelRegistryORM, default_suffix: str) -> str:
    """模型级上游路径覆盖（extra.upstream_path / upstreamPath），否则用端点默认后缀。"""
    extra = model_record.extra if isinstance(model_record.extra, dict) else {}
    override = extra.get("upstream_path") or extra.get("upstreamPath")
    if override:
        return override if str(override).startswith("/") else f"/{override}"
    endpoints = extra.get("endpoints")
    if isinstance(endpoints, list) and endpoints:
        ep0 = endpoints[0]
        if isinstance(ep0, dict):
            ep_path = ep0.get("upstreamPath") or ep0.get("upstream_path")
            if ep_path:
                return ep_path if str(ep_path).startswith("/") else f"/{ep_path}"
    return default_suffix


def _effective_path(eff: dict, model_record: ModelRegistryORM, default_suffix: str) -> str:
    """所选端点自身的 upstream_path 优先；节点没显式填时统一回落
    resolve_upstream_path：先查模型级路径覆盖（extra.upstream_path，保存时镜像
    primary），再退 primary 节点路径 / 默认后缀——与 api_key / 模型名等字段的
    「未填回落模型顶层」语义一致。否则多节点里某个节点缺路径时会静默丢掉
    primary 的自定义路径、退回默认后缀，同一模型相邻两次请求路径不一致。"""
    p = eff.get("upstream_path")
    if p:
        return p if str(p).startswith("/") else f"/{p}"
    return resolve_upstream_path(model_record, default_suffix)


def build_endpoint(
    model_record: ModelRegistryORM, path_suffix: str, eff: dict | None = None
) -> tuple[str, dict, int]:
    """返回 (url, headers, ep_idx)。ep_idx 为所选端点在 extra.endpoints 中的原始下标。

    eff 为 select_endpoint() 预选的端点；未传时内部自行轮询选取。鉴权、自定义头、
    上游模型名、import_format、上游路径一律取"所选端点"自身（异构接入），不再恒取 primary。
    """
    if eff is None:
        eff = select_endpoint(model_record)
    base = eff["base_url"]
    suffix = _effective_path(eff, model_record, path_suffix)
    url = base if eff["import_format"] == "custom" else f"{base}{suffix}"
    headers = {"Content-Type": "application/json"}
    if eff["api_key"]:
        headers["Authorization"] = f"Bearer {eff['api_key']}"
    if eff["custom_headers"]:
        headers.update(eff["custom_headers"])
    return url, with_upstream_request_headers(headers), eff["ep_idx"]
