"""管理后台端点（/api/admin/*，需 admin JWT）。"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, Text, delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.auth import (
    PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PasswordPolicyError,
    clear_admin_session_cookie, generate_api_key, hash_key, hash_password,
    issue_token, require_admin, require_recent_admin, set_admin_session_cookie,
    validate_password, KEY_PREFIX,
)
from app.auth_rate_limit import client_identity, enforce_auth_rate
from app.admin_credentials import (
    ADMIN_PASSWORD_MAX_LENGTH,
    ADMIN_PASSWORD_MIN_LENGTH,
    AdminPasswordPolicyError,
    AdminSetupRequired,
    admin_password_is_initialized,
    authenticate_or_initialize_admin,
)
from app.database import get_db
from app.early_access import (
    EARLY_ACCESS_STATUS, STATUS_APPROVED, STATUS_PENDING, STATUS_REVOKED, iso_utc,
)
from app.models import (
    ApiKeyORM, ApplicationORM, AuditLogORM, EarlyAccessApplicationORM,
    DocFeedbackORM, ForumPostORM, ForumReactionORM, ForumReplyORM,
    InfraResourceORM, InfraTopologyLinkORM, ModelRegistryORM,
    NightBatchRegistrationORM, NotificationORM, OpsReportORM,
    SceneTypeORM, UpgradeApplicationORM, UsageLogORM, UserORM,
)
from app.config import settings
from app.backup_status import read_backup_status
from app.infra_fleet import get_top_projects
from app.migration_import import import_api_keys_csv, import_users_csv
from app.model_secrets import (
    MASKED_SECRET,
    mask_sensitive_headers,
    merge_masked_sensitive_headers,
    normalize_model_base_url,
    safe_model_base_url_for_output,
)
from app.ops_report import generate_period_report, generate_report
from app.proxy import fallback
from app.proxy.db_bridge import invalidate_prepare_cache
from app import platform_settings
from app.scenario_name import assert_scenario_name_available
from app.upgrade_flow import cancel_pending_upgrades, ensure_approved_upgrade_for_key
from app.platform_stats_baseline import get_baseline, save_baseline
from app.redis_client import redis
router = APIRouter(prefix="/admin")

_MODEL_SAFE_FIELDS = (
    "id", "name", "provider", "short_desc", "description", "readme", "context_window",
    "status", "category", "speed", "base_url", "model_api_name", "import_format",
    "custom_headers", "pricing_input", "pricing_output",
    "resolve_to_model_id", "updated_at",
)
# 运营状态仅五类（按生命周期排序）：在线 / 临时独占 / 抢先体验计划 / 即将下线 / 下线
_VALID_STATUS = frozenset({
    "online", "exclusive", "upcoming", "sunsetting", "offline",
})


def _merge_extra(existing: dict | None, updates: dict) -> dict:
    base = dict(existing) if isinstance(existing, dict) else {}
    for k, v in updates.items():
        if v is None:
            base.pop(k, None)
        else:
            base[k] = v
    return base


def _mask_secret(v: str | None) -> str | None:
    """管理端列表回显密钥掩码：只标记「已配置」，不泄露明文（防止库/备份泄露
    即全量泄露；真实值仅在保存接口写入，从不回读给前端）。"""
    return MASKED_SECRET if v else None


def _validate_base_url_scheme(url: str | None, *, where: str = "base_url") -> str | None:
    """Validate an upstream URL while continuing to allow private HTTP hosts."""
    try:
        return normalize_model_base_url(url, where=where)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _updated_custom_headers(raw, existing: dict | None, *, where: str) -> dict | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail=f"{where} 必须是 JSON 对象")
    return merge_masked_sensitive_headers(raw, existing) or None


def _model_admin_dict(r: ModelRegistryORM) -> dict:
    extra = r.extra if isinstance(r.extra, dict) else {}
    endpoints_raw = extra.get("endpoints")
    if isinstance(endpoints_raw, list):
        # 所有可用于上游鉴权的节点字段只回显掩码，安全 URL 仍可正常编辑。
        endpoints = []
        for ep in endpoints_raw:
            if isinstance(ep, dict):
                ep = dict(ep)
                for url_key in ("base_url", "baseUrl"):
                    if url_key in ep:
                        ep[url_key] = safe_model_base_url_for_output(ep[url_key])
                if ep.get("apiKey"):
                    ep["apiKey"] = _mask_secret(ep["apiKey"])
                if ep.get("api_key"):
                    ep["api_key"] = _mask_secret(ep["api_key"])
                for header_key in ("custom_headers", "customHeaders"):
                    if header_key in ep:
                        ep[header_key] = mask_sensitive_headers(ep[header_key])
            endpoints.append(ep)
    else:
        endpoints = None
    ep_count = len(endpoints) if endpoints else (1 if r.base_url else 0)
    return {
        "id": r.id,
        "name": r.name,
        "provider": r.provider,
        "status": r.status,
        "category": r.category,
        "contextWindow": r.context_window or "",
        "shortDescription": r.short_desc or "",
        "description": r.description or "",
        "readme": r.readme or "",
        "baseUrl": safe_model_base_url_for_output(r.base_url),
        "modelApiName": r.model_api_name,
        "apiKey": _mask_secret(r.api_key),
        "importFormat": r.import_format or "openai",
        "customHeaders": mask_sensitive_headers(r.custom_headers),
        "resolveToModelId": r.resolve_to_model_id,
        # 兜底配置 + 当前熔断态（circuit 为 None 表示未熔断；内存副本由 pub/sub
        # 跨 worker 同步，读取零往返）
        "fallback": extra.get("fallback"),
        "circuit": fallback.circuit_state(r.id),
        "endpoints": endpoints,
        "endpointCount": ep_count or None,
        "engineType": extra.get("engine_type") or "vllm",
        "upstreamPath": extra.get("upstream_path"),
        "scene": extra.get("scene"),
        "scenes": extra.get("scenes"),
        "autoApprove": extra.get("autoApprove"),
        "badge": extra.get("badge"),
        "tags": extra.get("tags"),
        "pricingInput": r.pricing_input,
        "pricingOutput": r.pricing_output,
        "speed": r.speed or "medium",
        # 平台接入日期（admin 可编辑，存 extra；未设置时回退最近更新日）
        "addedAt": extra.get("addedAt") or (r.updated_at.date().isoformat() if r.updated_at else ""),
        "releaseDate": extra.get("releaseDate"),
        "params": extra.get("params"),
        "callNames": _call_names_from_extra(extra),
        "updatedAt": r.updated_at.isoformat() if r.updated_at else "",
    }


def _call_names_from_extra(extra: dict | None) -> list[str]:
    if not isinstance(extra, dict):
        return []
    raw = extra.get("call_names") or extra.get("callNames") or []
    if not isinstance(raw, list):
        return []
    return [str(x).strip() for x in raw if str(x).strip()]


def _normalize_call_names(raw) -> list[str]:
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="call_names 必须是字符串数组")
    names: list[str] = []
    seen: set[str] = set()
    for item in raw:
        s = str(item).strip()
        if not s:
            continue
        if s in seen:
            raise HTTPException(status_code=400, detail=f"调用名称重复：{s}")
        seen.add(s)
        names.append(s)
    return names


def _assert_call_names_available(db: Session, model_id: str, names: list[str]) -> None:
    for row in db.execute(select(ModelRegistryORM)).scalars():
        if row.id == model_id or row.status == "offline":
            continue
        for name in names:
            if name == row.id:
                raise HTTPException(
                    status_code=400,
                    detail=f"调用名称 {name} 与模型 ID {row.id} 冲突",
                )
            if name in _call_names_from_extra(row.extra):
                raise HTTPException(
                    status_code=400,
                    detail=f"调用名称 {name} 已被模型 {row.id} 使用",
                )


def _key_admin_dict(k: ApiKeyORM) -> dict:
    display_key = k.api_key or (f"{k.key_prefix}…" if k.key_prefix else "")
    return {
        "id": k.id,
        "name": k.name,
        "authId": k.auth_id,
        "projectName": k.project_name,
        "projectDesc": k.project_desc,
        "department": k.department,
        "sceneType": k.scene_type,
        "apiKey": display_key,
        "grantedAt": k.granted_at.isoformat() if k.granted_at else "",
        "revoked": k.revoked,
        "rpmLimit": k.rpm_limit,
        "tpmLimit": k.tpm_limit,
        # 与密钥管理 / 用户侧 Keys 同源：default | high | unlimited | custom
        "tier": settings.key_tier(k.rpm_limit, k.tpm_limit),
    }


def _elevated_tier_filter():
    """高并发 / 超高并发：与 settings.key_tier 判定一致，供列表筛选复用。"""
    high_rpm = settings.RATE_LIMIT_HIGH_RPM
    high_tpm = settings.RATE_LIMIT_HIGH_TPM
    return or_(
        ApiKeyORM.rpm_limit == -1,
        ApiKeyORM.tpm_limit == -1,
        and_(
            ApiKeyORM.rpm_limit.is_not(None),
            ApiKeyORM.tpm_limit.is_not(None),
            ApiKeyORM.rpm_limit >= high_rpm,
            ApiKeyORM.tpm_limit >= high_tpm,
        ),
    )


# ── 登录 ─────────────────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=ADMIN_PASSWORD_MAX_LENGTH)
    password_confirmation: str | None = Field(default=None, max_length=ADMIN_PASSWORD_MAX_LENGTH)
    bootstrap_token: str | None = Field(default=None, max_length=512)


# 登录失败频控（2026-08 安全加固）：固定窗口计数 + 锁定，降低口令猜测风险。
# Redis 不可达时 fail-open（可用性优先），锁定仅在 Redis 正常时生效。
_ADMIN_LOGIN_MAX_FAILURES = 5
_ADMIN_LOGIN_WINDOW_S = 900      # 计数窗口：15 分钟
_ADMIN_LOGIN_LOCKOUT_S = 900     # 锁定时长：15 分钟


def _login_ip(request: Request) -> str:
    return client_identity(request)


@router.get("/login/status")
def admin_login_status(response: Response, db: Session = Depends(get_db)):
    """公开返回是否需要首次设密；不返回任何凭据或密码元数据。"""
    response.headers["Cache-Control"] = "no-store"
    initialized = admin_password_is_initialized(db)
    return {
        "initialized": initialized,
        "bootstrapRequired": not initialized and bool(settings.ADMIN_BOOTSTRAP_TOKEN),
        "passwordMinLength": ADMIN_PASSWORD_MIN_LENGTH,
        "passwordMaxLength": ADMIN_PASSWORD_MAX_LENGTH,
    }


@router.post("/login")
async def admin_login(
    payload: LoginIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    ip = _login_ip(request)
    await enforce_auth_rate(
        request, action="admin-login", account="admin",
        client_limit=20, account_limit=100, window_s=_ADMIN_LOGIN_WINDOW_S,
    )
    lock_key = f"alock:{ip}:lock"
    fail_key = f"alock:{ip}:fails"
    initialized = admin_password_is_initialized(db)
    if not initialized and settings.ADMIN_BOOTSTRAP_TOKEN:
        supplied = payload.bootstrap_token or ""
        if not secrets.compare_digest(supplied, settings.ADMIN_BOOTSTRAP_TOKEN):
            raise HTTPException(status_code=403, detail="首次管理员认领令牌无效")

    try:
        if await asyncio.wait_for(redis.get(lock_key), timeout=1.0):
            raise HTTPException(status_code=429, detail="失败次数过多，已临时锁定，请约 15 分钟后重试")
    except HTTPException:
        raise
    except Exception:
        pass  # Redis 异常 → 放行

    try:
        # 600k 轮 PBKDF2 属于 CPU 密集任务；移出事件循环，避免登录尝试拖慢
        # 同一 worker 的其它异步请求。该 Session 在此期间没有并发使用。
        auth_result = await asyncio.to_thread(
            authenticate_or_initialize_admin,
            db,
            payload.password,
            payload.password_confirmation,
        )
    except AdminSetupRequired as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except AdminPasswordPolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not auth_result.authenticated:
        try:
            pipe = redis.pipeline()
            pipe.incr(fail_key)
            pipe.expire(fail_key, _ADMIN_LOGIN_WINDOW_S)
            n = int((await asyncio.wait_for(pipe.execute(), timeout=1.0))[0])
            if n >= _ADMIN_LOGIN_MAX_FAILURES:
                await asyncio.wait_for(
                    redis.set(lock_key, "1", ex=_ADMIN_LOGIN_LOCKOUT_S), timeout=1.0,
                )
                await asyncio.wait_for(redis.delete(fail_key), timeout=1.0)
                raise HTTPException(status_code=429, detail="失败次数过多，已临时锁定，请约 15 分钟后重试")
        except HTTPException:
            raise
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="管理员密码错误")

    # 登录成功：清计数
    try:
        await asyncio.wait_for(redis.delete(fail_key), timeout=1.0)
    except Exception:
        pass
    token = issue_token("admin", "admin")
    set_admin_session_cookie(response, token)
    return {
        "token": token,
        "initializedNow": auth_result.initialized_now,
    }


@router.get("/session")
def admin_session(_=Depends(require_admin)):
    """用 HttpOnly cookie 恢复管理端会话。"""
    return {"ok": True}


@router.post("/logout")
def admin_logout(response: Response):
    clear_admin_session_cookie(response)
    return {"ok": True}


def _audit(db: Session, actor: str, action: str, target: str | None, detail: dict | None = None):
    db.add(AuditLogORM(actor=actor, action=action, target=target, detail=detail))


def _require_pending_application(a: ApplicationORM) -> None:
    if a.status != "pending":
        raise HTTPException(status_code=400, detail=f"该申请已处理，当前状态为 {a.status}")


# ── 模型管理 ─────────────────────────────────────────────────────────────────
class ModelUpsert(BaseModel):
    id: str
    name: str
    provider: str = ""
    short_desc: str | None = None
    description: str | None = None
    readme: str | None = None
    context_window: str | None = None
    status: str = "online"
    category: str = "chat"
    speed: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model_api_name: str | None = None
    import_format: str = "openai"
    custom_headers: dict | None = None
    pricing_input: float | None = None
    pricing_output: float | None = None
    resolve_to_model_id: str | None = None


@router.get("/models")
def list_models(db: Session = Depends(get_db), _=Depends(require_admin)):
    rows = db.execute(select(ModelRegistryORM)).scalars().all()
    return [_model_admin_dict(m) for m in rows]


def _validate_resolve_target(db: Session, model_id: str, target_id: str | None) -> None:
    if not target_id:
        return
    if target_id == model_id:
        raise HTTPException(status_code=400, detail="resolve_to_model_id 不能指向自身")
    if db.get(ModelRegistryORM, target_id) is None:
        raise HTTPException(status_code=400, detail=f"对齐目标模型不存在: {target_id}")


def _normalize_fallback(db: Session, model_id: str, record: ModelRegistryORM, raw) -> dict | None:
    """校验并规范化兜底配置。配错就直接 400——兜底是故障时的最后一道保障，
    宁可在保存时拦下，也不能等真出故障了才发现目标不可用。"""
    if not isinstance(raw, dict):
        return None
    enabled = bool(raw.get("enabled"))
    target_id = (raw.get("target_model_id") or "").strip() or None

    if enabled:
        if not target_id:
            raise HTTPException(status_code=400, detail="启用兜底必须指定兜底模型")
        if target_id == model_id:
            raise HTTPException(status_code=400, detail="兜底模型不能指向自身")
        target = db.get(ModelRegistryORM, target_id)
        if target is None:
            raise HTTPException(status_code=400, detail=f"兜底模型不存在: {target_id}")
        if target.category == "lts" or target.resolve_to_model_id:
            raise HTTPException(
                status_code=400,
                detail=f"兜底模型必须是实模型，不能指向虚拟模型 {target_id}（故障时多一层解析即多一层不确定性）",
            )
        if not _is_fallback_llm_category(target.category):
            raise HTTPException(
                status_code=400,
                detail=f"兜底模型须为大语言模型（不可为 embedding / reranker / ocr / 图片生成 / LTS）：{target_id}",
            )
        if not (target.base_url or "").strip() or not (target.model_api_name or "").strip():
            raise HTTPException(
                status_code=400, detail=f"兜底模型 {target_id} 尚未完成部署配置（base_url / model_api_name）",
            )
        t_extra = target.extra if isinstance(target.extra, dict) else {}
        t_fb = t_extra.get("fallback")
        if isinstance(t_fb, dict) and t_fb.get("enabled") and t_fb.get("target_model_id") == model_id:
            raise HTTPException(
                status_code=400, detail=f"{model_id} 与 {target_id} 互为兜底会形成环，请改指第三个模型",
            )

    cfg = {**fallback.DEFAULTS, **raw, "enabled": enabled, "target_model_id": target_id}
    for k in ("trip_fails", "window_s", "cooldown_s", "max_cooldown_s"):
        try:
            cfg[k] = max(1, int(cfg[k]))
        except (TypeError, ValueError):
            cfg[k] = fallback.DEFAULTS[k]
    try:
        cfg["trip_rate"] = min(1.0, max(0.0, float(cfg["trip_rate"])))
    except (TypeError, ValueError):
        cfg["trip_rate"] = fallback.DEFAULTS["trip_rate"]
    cfg["circuit_enabled"] = bool(cfg.get("circuit_enabled"))
    cfg["forced"] = bool(cfg.get("forced"))
    return cfg


_FALLBACK_ONLINE_STATUS = frozenset({"online", "exclusive", "unstable"})
# 兜底仅面向大语言模型；排除向量 / 重排 / OCR / 文生图 / LTS 虚拟接口
_FALLBACK_EXCLUDED_CATEGORIES = frozenset({
    "embedding", "reranker", "ocr", "image_generation", "lts",
})


def _is_fallback_llm_category(category: str | None) -> bool:
    return (category or "") not in _FALLBACK_EXCLUDED_CATEGORIES


def _is_fallback_source_candidate(m: ModelRegistryORM) -> bool:
    return (
        _is_fallback_llm_category(m.category)
        and not m.resolve_to_model_id
        and m.status in _FALLBACK_ONLINE_STATUS
    )


def _fallback_policy_to_body(policy: platform_settings.FallbackPolicy) -> dict:
    ids = policy.source_model_ids if isinstance(policy.source_model_ids, list) else []
    return {
        "enabled": bool(policy.enabled),
        "targetModelId": policy.target_model_id,
        "sourceModelIds": [str(x) for x in ids if str(x).strip()],
        "circuitEnabled": bool(policy.circuit_enabled),
        "tripFails": policy.trip_fails,
        "tripRate": policy.trip_rate,
        "windowS": policy.window_s,
        "cooldownS": policy.cooldown_s,
        "maxCooldownS": policy.max_cooldown_s,
        "forced": bool(policy.forced),
        "updatedAt": policy.updated_at.isoformat() if policy.updated_at else "",
    }


def _normalize_unified_fallback_body(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    enabled = bool(raw.get("enabled"))
    target_id = (raw.get("targetModelId") or raw.get("target_model_id") or "").strip() or None
    sources_raw = raw.get("sourceModelIds", raw.get("source_model_ids"))
    if not isinstance(sources_raw, list):
        sources_raw = []
    source_ids: list[str] = []
    seen: set[str] = set()
    for item in sources_raw:
        s = str(item).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        source_ids.append(s)
    cfg = {
        "enabled": enabled,
        "target_model_id": target_id,
        "source_model_ids": source_ids,
        "circuit_enabled": bool(raw.get("circuitEnabled", raw.get("circuit_enabled", False))),
        "trip_fails": raw.get("tripFails", raw.get("trip_fails", fallback.DEFAULTS["trip_fails"])),
        "trip_rate": raw.get("tripRate", raw.get("trip_rate", fallback.DEFAULTS["trip_rate"])),
        "window_s": raw.get("windowS", raw.get("window_s", fallback.DEFAULTS["window_s"])),
        "cooldown_s": raw.get("cooldownS", raw.get("cooldown_s", fallback.DEFAULTS["cooldown_s"])),
        "max_cooldown_s": raw.get("maxCooldownS", raw.get("max_cooldown_s", fallback.DEFAULTS["max_cooldown_s"])),
        "forced": bool(raw.get("forced")),
    }
    if enabled:
        if not target_id:
            raise HTTPException(status_code=400, detail="启用兜底必须指定兜底模型")
        if not source_ids:
            raise HTTPException(status_code=400, detail="请至少选择一个需要兜底的在线模型")
    return cfg


def _sync_unified_fallback_to_models(db: Session, cfg: dict) -> None:
    """将统一策略写入各源模型 extra.fallback，并清除未选中的模型配置。"""
    all_rows = list(db.execute(select(ModelRegistryORM)).scalars())
    source_set = set(cfg["source_model_ids"]) if cfg["enabled"] else set()
    per_model_payload = {
        "enabled": cfg["enabled"],
        "target_model_id": cfg["target_model_id"],
        "circuit_enabled": cfg["circuit_enabled"],
        "trip_fails": cfg["trip_fails"],
        "trip_rate": cfg["trip_rate"],
        "window_s": cfg["window_s"],
        "cooldown_s": cfg["cooldown_s"],
        "max_cooldown_s": cfg["max_cooldown_s"],
        "forced": cfg["forced"],
    }
    for m in all_rows:
        if not _is_fallback_llm_category(m.category) or m.resolve_to_model_id:
            continue
        if m.id in source_set:
            normalized = _normalize_fallback(db, m.id, m, {**per_model_payload, "enabled": True})
            m.extra = _merge_extra(m.extra, {"fallback": normalized})
        else:
            extra = dict(m.extra) if isinstance(m.extra, dict) else {}
            if extra.get("fallback"):
                m.extra = _merge_extra(m.extra, {"fallback": None})


@router.put("/models/{model_id}")
def upsert_model(model_id: str, payload: ModelUpsert, db: Session = Depends(get_db), admin=Depends(require_admin)):
    _validate_resolve_target(db, model_id, payload.resolve_to_model_id)
    safe_base_url = _validate_base_url_scheme(payload.base_url, where="base_url")
    if payload.status not in _VALID_STATUS:
        raise HTTPException(status_code=400, detail=f"非法状态值：{payload.status}")
    m = db.get(ModelRegistryORM, model_id)
    data = payload.model_dump()
    data["id"] = model_id
    data["base_url"] = safe_base_url
    if m is None:
        if data.get("api_key") == MASKED_SECRET:
            data["api_key"] = None
        data["custom_headers"] = _updated_custom_headers(
            data.get("custom_headers"), None, where="custom_headers",
        )
        m = ModelRegistryORM(**data)
        db.add(m)
    else:
        api_key = data.pop("api_key", None)
        custom_headers = data.pop("custom_headers", None)
        for k, v in data.items():
            if k == "id":
                continue
            setattr(m, k, v)
        m.custom_headers = _updated_custom_headers(
            custom_headers, m.custom_headers, where="custom_headers",
        )
        if api_key and api_key != MASKED_SECRET:
            m.api_key = api_key
    _audit(db, "admin", "model.upsert", model_id)
    db.commit()
    invalidate_prepare_cache()
    return {"ok": True, "id": model_id}


@router.patch("/models/{model_id}")
def patch_model(model_id: str, body: dict = Body(...), db: Session = Depends(get_db), _=Depends(require_admin)):
    """单模型更新（camelCase 与 snake_case 均兼容）。"""
    # 前端发送 snake_case，统一补充 camelCase 别名，使后续条件判断无需修改。
    # snake_case key 不覆盖已存在的 camelCase key（外部集成优先）。
    _S2C = {
        "base_url": "baseUrl", "model_api_name": "modelApiName",
        "import_format": "importFormat", "custom_headers": "customHeaders",
        "api_key": "apiKey",
        "context_window": "contextWindow", "resolve_to_model_id": "resolveToModelId",
        "pricing_input": "pricingInput", "pricing_output": "pricingOutput",
        "short_desc": "shortDesc",
        "readme": "readme",
    }
    for snake, camel in _S2C.items():
        if snake in body and camel not in body:
            body[camel] = body[snake]

    record = db.get(ModelRegistryORM, model_id)
    if record is None:
        record = ModelRegistryORM(
            id=model_id,
            name=body.get("name", model_id),
            provider=body.get("provider", ""),
            status=body.get("status", "online"),
            category=body.get("category", "chat"),
            import_format=body.get("importFormat", "openai"),
        )
        db.add(record)

    if "name" in body:
        record.name = body["name"]
    if "provider" in body:
        record.provider = body["provider"]
    if "description" in body:
        record.description = body["description"]
    if "shortDesc" in body:
        record.short_desc = body["shortDesc"] or None
    if "readme" in body:
        record.readme = body["readme"] or None
    if "speed" in body:
        record.speed = body["speed"] or None
    if "contextWindow" in body:
        record.context_window = body["contextWindow"]
    if "category" in body:
        record.category = body["category"]
    if "status" in body:
        if body["status"] in _VALID_STATUS:
            record.status = body["status"]
        else:
            raise HTTPException(status_code=400, detail=f"非法状态值：{body['status']}")
    if "baseUrl" in body:
        record.base_url = _validate_base_url_scheme(body["baseUrl"], where="base_url")
    if "modelApiName" in body:
        record.model_api_name = body["modelApiName"] or None
    if "importFormat" in body:
        record.import_format = body["importFormat"]
    if "customHeaders" in body:
        record.custom_headers = _updated_custom_headers(
            body["customHeaders"], record.custom_headers, where="custom_headers",
        )
    if body.get("apiKey") and body["apiKey"] != MASKED_SECRET:
        record.api_key = body["apiKey"]
    if "resolveToModelId" in body:
        record.resolve_to_model_id = body["resolveToModelId"] or None
    if "pricingInput" in body:
        record.pricing_input = body["pricingInput"]
    if "pricingOutput" in body:
        record.pricing_output = body["pricingOutput"]

    extra_updates: dict = {}
    if "badge" in body:
        extra_updates["badge"] = body["badge"] or None
    if "tags" in body:
        extra_updates["tags"] = body["tags"] if isinstance(body["tags"], list) else (body["tags"] or None)
    if "addedAt" in body:
        # 平台接入日期 YYYY-MM-DD（模型广场「最新」排序与卡片展示）
        extra_updates["addedAt"] = body["addedAt"] or None
    if "releaseDate" in body:
        # 模型原始发布日期 YYYY-MM
        extra_updates["releaseDate"] = body["releaseDate"] or None
    if "params" in body:
        extra_updates["params"] = body["params"] or None
    if "callNames" in body or "call_names" in body:
        names = _normalize_call_names(body.get("callNames", body.get("call_names")))
        _assert_call_names_available(db, model_id, names)
        extra_updates["call_names"] = names
    if "upstreamPath" in body:
        # 单节点模型的上游路径覆盖：留空则清除（回退到 suffix 默认值）
        extra_updates["upstream_path"] = body["upstreamPath"] or None
    if "engineType" in body:
        et = (body["engineType"] or "").strip().lower()
        extra_updates["engine_type"] = et if et in ("vllm", "llamacpp", "llama.cpp", "llama-cpp") else None
    if "fallback" in body:
        # None / 非 dict → 清除兜底配置（_merge_extra 对 None 值执行 pop）
        extra_updates["fallback"] = _normalize_fallback(db, model_id, record, body["fallback"])
    if extra_updates:
        record.extra = _merge_extra(record.extra, extra_updates)

    if "scenes" in body or "scene" in body or "autoApprove" in body:
        scenes = body.get("scenes") if "scenes" in body else None
        scene = body.get("scene") if "scene" in body else None
        if isinstance(scenes, list) and scenes:
            scene = scenes[0]
        record.extra = _merge_extra(record.extra, {
            "scenes": scenes,
            "scene": scene,
            "autoApprove": body.get("autoApprove") if "autoApprove" in body else None,
        })

    if "endpoints" in body:
        raw_eps = body.get("endpoints") or []
        extra = dict(record.extra) if isinstance(record.extra, dict) else {}
        # 编辑器出于安全不回显密钥原文，api_key 留空表示"保持不变"——
        # 按 base_url 匹配已存储节点，沿用其密钥，避免每次保存都清空。
        old_eps = extra.get("endpoints") if isinstance(extra.get("endpoints"), list) else []
        old_ep_by_url: dict[str, dict] = {}
        for oe in old_eps:
            if isinstance(oe, dict):
                u = str(oe.get("base_url") or oe.get("baseUrl") or "").strip()
                if u:
                    old_ep_by_url[u] = oe

        # 接受 camelCase / snake_case 两种 key，统一规范化为 snake_case 存储
        # 避免路由层 _valid_endpoints() 读取 base_url 时因 key 不一致而拿到空列表
        def _norm_ep(e: dict) -> dict:
            url = _validate_base_url_scheme(
                e.get("base_url") or e.get("baseUrl"),
                where="endpoint.base_url",
            ) or ""
            old_ep = old_ep_by_url.get(url, {})
            old_key = old_ep.get("api_key") or old_ep.get("apiKey")
            supplied_key = e.get("api_key") if "api_key" in e else e.get("apiKey")
            api_key = (
                old_key
                if supplied_key in (None, "", MASKED_SECRET)
                else supplied_key
            )
            has_headers = "custom_headers" in e or "customHeaders" in e
            old_headers = old_ep.get("custom_headers") or old_ep.get("customHeaders")
            raw_headers = e.get("custom_headers") if "custom_headers" in e else e.get("customHeaders")
            custom_headers = (
                _updated_custom_headers(
                    raw_headers, old_headers, where="endpoint.custom_headers",
                )
                if has_headers else old_headers
            )
            # 权重：控制该节点在加权轮询中的流量配比，缺失/非法回落 1（均分）
            try:
                weight = int(e.get("weight") or 1)
            except (TypeError, ValueError):
                weight = 1
            if weight < 1:
                weight = 1
            return {
                "label":           e.get("label") or None,
                "base_url":        url,
                "model_api_name":  e.get("model_api_name") or e.get("modelApiName") or None,
                "api_key":         api_key,
                "import_format":   e.get("import_format") or e.get("importFormat") or "openai",
                "custom_headers":  custom_headers,
                "upstream_path":   e.get("upstream_path") or e.get("upstreamPath") or None,
                "weight":          weight,
            }
        endpoints = [_norm_ep(e) for e in raw_eps if isinstance(e, dict)
                     and (e.get("base_url") or e.get("baseUrl") or "").strip()]
        if endpoints:
            extra["endpoints"] = endpoints
            primary = endpoints[0]
            record.base_url = primary["base_url"] or None
            record.model_api_name = primary["model_api_name"] or None
            record.import_format = primary["import_format"] or "openai"
            record.custom_headers = primary["custom_headers"] or None
            if primary["api_key"]:
                record.api_key = primary["api_key"]
            if primary["upstream_path"]:
                extra["upstream_path"] = primary["upstream_path"]
            else:
                extra.pop("upstream_path", None)
        else:
            extra.pop("endpoints", None)
        record.extra = extra

    _audit(db, "admin", "model.patch", model_id)
    db.commit()
    invalidate_prepare_cache()
    return {"ok": True}


@router.get("/models/circuits")
def list_circuits(_=Depends(require_admin)):
    """当前处于兜底熔断中的模型（纯内存读，不查库不查 Redis）。

    供 admin 列表轮询刷新状态用——内存副本由 pub/sub 跨 worker 同步，因此
    任一 worker 应答的结果都是全局一致的。
    """
    return {
        mid: state
        for mid in list(fallback._open_until)
        if (state := fallback.circuit_state(mid)) is not None
    }


@router.post("/models/{model_id}/circuit/close")
def close_circuit(model_id: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    """人工强制恢复：清熔断标记与退避计数，流量立即回到该模型。

    运维确认节点已修好、不想等冷却结束时用。人工强制熔断（fallback.forced）
    是库里的配置，不受此影响——要解除请改模型配置。
    """
    if db.get(ModelRegistryORM, model_id) is None:
        raise HTTPException(status_code=404, detail=f"模型不存在: {model_id}")
    # 本端点是同步的（跑在线程池里），Redis 清理投递到事件循环执行
    fallback.schedule_force_close(model_id)
    _audit(db, "admin", "model.circuit.close", model_id)
    db.commit()
    return {"ok": True, "id": model_id}


@router.get("/fallback/policy")
def get_fallback_policy(db: Session = Depends(get_db), _=Depends(require_admin)):
    """统一兜底策略 + 可选在线源模型列表。"""
    policy = platform_settings.get_fallback_policy(db)
    db.commit()
    source_set = set(_fallback_policy_to_body(policy)["sourceModelIds"])
    candidates = []
    targets = []
    for m in db.execute(select(ModelRegistryORM)).scalars():
        if not _is_fallback_llm_category(m.category) or m.resolve_to_model_id:
            continue
        entry = {
            "modelId": m.id,
            "modelName": m.name,
            "category": m.category,
            "status": m.status,
            "selected": m.id in source_set,
            "circuit": fallback.circuit_state(m.id),
        }
        if _is_fallback_source_candidate(m):
            candidates.append(entry)
        if m.status in _FALLBACK_ONLINE_STATUS:
            targets.append(entry)
    candidates.sort(key=lambda x: x["modelName"])
    targets.sort(key=lambda x: x["modelName"])
    return {**_fallback_policy_to_body(policy), "candidates": candidates, "targetCandidates": targets}


@router.put("/fallback/policy")
def upsert_fallback_policy(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """保存统一兜底策略，并同步到各源模型 extra.fallback。"""
    cfg = _normalize_unified_fallback_body(body)
    policy = platform_settings.FallbackPolicy(
        enabled=cfg["enabled"],
        target_model_id=cfg["target_model_id"],
        source_model_ids=cfg["source_model_ids"],
        circuit_enabled=bool(cfg["circuit_enabled"]),
        trip_fails=max(1, int(cfg["trip_fails"])),
        trip_rate=min(1.0, max(0.0, float(cfg["trip_rate"]))),
        window_s=max(1, int(cfg["window_s"])),
        cooldown_s=max(1, int(cfg["cooldown_s"])),
        max_cooldown_s=max(1, int(cfg["max_cooldown_s"])),
        forced=bool(cfg["forced"]),
    )
    if cfg["enabled"]:
        target = db.get(ModelRegistryORM, cfg["target_model_id"])
        if target is None:
            raise HTTPException(status_code=400, detail=f"兜底模型不存在: {cfg['target_model_id']}")
        if not _is_fallback_llm_category(target.category) or target.resolve_to_model_id:
            raise HTTPException(
                status_code=400,
                detail=f"兜底模型须为已部署的大语言模型（不可为 embedding / reranker / ocr / 图片生成 / LTS）: {cfg['target_model_id']}",
            )
        for sid in cfg["source_model_ids"]:
            if sid == cfg["target_model_id"]:
                raise HTTPException(status_code=400, detail="源模型不能包含兜底目标本身")
            src = db.get(ModelRegistryORM, sid)
            if src is None:
                raise HTTPException(status_code=400, detail=f"源模型不存在: {sid}")
            if not _is_fallback_source_candidate(src):
                raise HTTPException(status_code=400, detail=f"模型 {sid} 不是可兜底的在线大语言模型")
    try:
        _sync_unified_fallback_to_models(db, cfg)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    platform_settings.save_fallback_policy(db, policy)
    _audit(db, "admin", "fallback.policy.update", "default")
    db.commit()
    invalidate_prepare_cache()
    return {"ok": True, **_fallback_policy_to_body(policy)}


@router.get("/fallback/logs")
def list_fallback_logs(
    trigger: str = "circuit",
    model_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """兜底触发日志。默认仅被动熔断切流（fallback_trigger=circuit）。"""
    q = select(UsageLogORM).where(UsageLogORM.fallback_from.isnot(None))
    if trigger and trigger != "all":
        q = q.where(UsageLogORM.fallback_trigger == trigger)
    if model_id:
        q = q.where(
            or_(
                UsageLogORM.fallback_from == model_id,
                UsageLogORM.model_id == model_id,
            )
        )
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.execute(
        q.order_by(UsageLogORM.created_at.desc()).offset(max(0, offset)).limit(min(limit, 200))
    ).scalars().all()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "data": [
            {
                "id": r.id,
                "requestId": r.request_id,
                "apiKeyId": r.api_key_id,
                "modelId": r.model_id,
                "fallbackFrom": r.fallback_from,
                "fallbackTrigger": r.fallback_trigger,
                "statusCode": r.status_code,
                "latencyMs": r.latency_ms,
                "totalTokens": r.total_tokens,
                "errorDetail": r.error_detail,
                "createdAt": r.created_at.isoformat() if r.created_at else "",
            }
            for r in rows
        ],
    }


@router.post("/models/{model_id}/connectivity-test")
async def test_model_connectivity(
    model_id: str,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """逐接入探活：多节点模型分别测试每个 base_url 的连通性。"""
    from app.model_connectivity import run_connectivity_test, snapshot_model

    record = db.get(ModelRegistryORM, model_id)
    if record is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    if record.category == "lts" or record.resolve_to_model_id:
        raise HTTPException(status_code=400, detail="别名模型无独立接入，请测试路由目标模型")

    snapshot = snapshot_model(record)
    # 之后只等待外部 HTTP，先释放同步 SQLAlchemy Session/连接。
    db.close()
    results = await run_connectivity_test(snapshot)
    return {"model_id": model_id, "results": results}


_SYNC_EXTRA_SAFE_KEYS = frozenset({
    "tags", "badge", "scene", "scenes", "autoApprove", "arch", "params",
    "activatedParams", "dimension", "addedAt", "releaseDate", "upstreamPath",
    "engineType", "speed", "callNames", "call_names",
})


def _sync_extra_fields(m: dict) -> dict:
    """sync_models 建模型时只把非敏感展示字段放进 extra，剥离 apiKey 等密钥。"""
    out = {k: v for k, v in m.items() if k in _SYNC_EXTRA_SAFE_KEYS and v is not None}
    if "callNames" in out:
        out["call_names"] = out.pop("callNames")
    elif "call_names" in out:
        out["call_names"] = out.pop("call_names")
    return out


@router.post("/models/sync")
def sync_models(body: dict = Body(...), db: Session = Depends(get_db), _=Depends(require_admin)):
    """批量同步模型状态（llm_platform 兼容）。"""
    models: list = body.get("models", [])
    for m in models:
        existing = db.get(ModelRegistryORM, m.get("id"))
        if existing:
            new_status = m.get("status", existing.status)
            if new_status not in _VALID_STATUS:
                new_status = existing.status
            existing.status = new_status
            if "baseUrl" in m:
                existing.base_url = _validate_base_url_scheme(
                    m.get("baseUrl"), where="base_url",
                )
            if m.get("apiKey") and m.get("apiKey") != MASKED_SECRET:
                existing.api_key = m.get("apiKey")
            if "modelApiName" in m:
                existing.model_api_name = m.get("modelApiName", existing.model_api_name)
            if "importFormat" in m:
                existing.import_format = m.get("importFormat", existing.import_format)
            if "customHeaders" in m:
                existing.custom_headers = _updated_custom_headers(
                    m.get("customHeaders"), existing.custom_headers,
                    where="custom_headers",
                )
            if "resolveToModelId" in m:
                existing.resolve_to_model_id = m.get("resolveToModelId", existing.resolve_to_model_id)
            if "readme" in m:
                existing.readme = m["readme"]
        else:
            new_status = m.get("status", "online")
            if new_status not in _VALID_STATUS:
                new_status = "online"
            safe_base_url = _validate_base_url_scheme(m.get("baseUrl"), where="base_url")
            # 2026-08 修复：extra 不再原样塞整个请求体——apiKey/baseUrl/customHeaders
            # 等接入敏感字段已存独立列，重复进 extra 会在备份导出里冗余泄露。
            record = ModelRegistryORM(
                id=m["id"],
                name=m.get("name", m["id"]),
                provider=m.get("provider", ""),
                short_desc=m.get("shortDescription", ""),
                description=m.get("description", ""),
                context_window=m.get("contextWindow", ""),
                status=new_status,
                category=m.get("category", "chat"),
                speed=m.get("speed", "medium"),
                base_url=safe_base_url,
                api_key=(None if m.get("apiKey") == MASKED_SECRET else m.get("apiKey")),
                model_api_name=m.get("modelApiName"),
                import_format=m.get("importFormat", "openai"),
                custom_headers=_updated_custom_headers(
                    m.get("customHeaders"), None, where="custom_headers",
                ),
                resolve_to_model_id=m.get("resolveToModelId"),
                readme=m.get("readme"),
                extra=_sync_extra_fields(m),
            )
            db.add(record)
    db.commit()
    # 与 PATCH/PUT/DELETE 一致：变更立即失效鉴权/模型解析缓存（离线/上线切换、
    # 接入参数更新毫秒级全网关生效），而不是等到 AUTH_CACHE_TTL_S 过期。
    invalidate_prepare_cache()
    return {"ok": True, "count": len(models)}


@router.delete("/models/{model_id}")
def delete_model(model_id: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    m = db.get(ModelRegistryORM, model_id)
    if m is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    # 2026-08 修复：删除前检查悬空引用——对齐目标、兜底目标、已授权 Key 的模型列表。
    referrers = _find_model_references(db, model_id)
    if referrers:
        raise HTTPException(
            status_code=409,
            detail="该模型仍被以下配置引用，请先解除引用再删除：" + "、".join(referrers[:5]),
        )
    db.delete(m)
    _audit(db, "admin", "model.delete", model_id)
    db.commit()
    invalidate_prepare_cache()
    return {"ok": True}


def _find_model_references(db: Session, model_id: str) -> list[str]:
    """找出引用某个模型的位置，用于删除前的悬空引用防护。"""
    refs: list[str] = []
    # 1) 其它模型的 resolve_to_model_id 对齐目标
    for (mid,) in db.execute(
        select(ModelRegistryORM.id).where(ModelRegistryORM.resolve_to_model_id == model_id)
    ):
        refs.append(f"模型 {mid} 的 resolve 对齐目标")
    # 2) 兜底配置（extra.fallback 的 model 目标）
    for row in db.execute(select(ModelRegistryORM.id, ModelRegistryORM.extra)).all():
        extra = row[1] if isinstance(row[1], dict) else {}
        fb = extra.get("fallback")
        if isinstance(fb, dict) and fb.get("model") == model_id:
            refs.append(f"模型 {row[0]} 的兜底目标")
    # 3) 已授权 Key 的 models 白名单
    for (name,) in db.execute(
        select(ApiKeyORM.name).where(ApiKeyORM.models.cast(Text).contains(f'"{model_id}"'))
    ):
        refs.append(f"API Key「{name}」的模型白名单")
    return refs


def _require_deploy_config(m: ModelRegistryORM) -> None:
    """非虚拟别名模型上线前须配置上游地址与模型名。"""
    if m.category == "lts" or m.resolve_to_model_id:
        return
    if not (m.base_url or "").strip():
        raise HTTPException(status_code=400, detail="请先配置 base_url")
    if not (m.model_api_name or "").strip():
        raise HTTPException(status_code=400, detail="请先配置 model_api_name")


@router.post("/models/{model_id}/launch")
def launch_model(model_id: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    """将「抢先体验计划」模型转为正式上线，全量开放（须先完成部署配置）。"""
    m = db.get(ModelRegistryORM, model_id)
    if m is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    if m.status != EARLY_ACCESS_STATUS:
        raise HTTPException(status_code=400, detail=f"仅抢先体验计划模型可执行上线，当前状态为 {m.status}")
    _require_deploy_config(m)
    m.status = "online"
    _audit(db, "admin", "model.launch", model_id)
    db.commit()
    invalidate_prepare_cache()
    return {"ok": True, "id": model_id, "status": m.status}


# ── Key 管理 ─────────────────────────────────────────────────────────────────
class KeyCreate(BaseModel):
    name: str
    auth_id: str
    project_name: str
    department: str
    project_desc: str | None = None
    scene_type: str | None = None
    models: list[str] = []
    application_id: str | None = None


class KeyMetaUpdate(BaseModel):
    """管理员修改密钥展示元数据：名称（场景）与描述。"""
    name: str
    project_desc: str | None = None


_KEY_SORT_COLS = {
    "project_name": ApiKeyORM.project_name,
    "department": ApiKeyORM.department,
    "auth_id": ApiKeyORM.auth_id,
    "granted_at": ApiKeyORM.granted_at,
    "created_at": ApiKeyORM.created_at,
    "revoked": ApiKeyORM.revoked,
    "key_prefix": ApiKeyORM.key_prefix,
}


@router.get("/keys")
def list_keys(
    db: Session = Depends(get_db),
    _=Depends(require_admin),
    status: str | None = None,
    q: str | None = None,
    tier: str | None = None,
    department: str | None = None,
    scene_type: str | None = None,
    sort: str | None = None,
    order: str = "desc",
    limit: int = 50,
    offset: int = 0,
):
    """列出密钥，支持状态/档位/部门/场景筛选、关键词搜索、列排序与分页。

    tier=elevated：高并发 + 超高并发；另支持 default / high / unlimited / custom。
    scene_type：场景分类管理页「查看密钥」与 keyCount 同源。
    departments：可选部门列表，供表头筛选。
    """
    stmt = select(ApiKeyORM).where(ApiKeyORM.deleted_at.is_(None))
    count_stmt = select(func.count()).select_from(ApiKeyORM).where(ApiKeyORM.deleted_at.is_(None))
    if status == "active":
        stmt = stmt.where(ApiKeyORM.revoked.is_(False))
        count_stmt = count_stmt.where(ApiKeyORM.revoked.is_(False))
    elif status == "revoked":
        stmt = stmt.where(ApiKeyORM.revoked.is_(True))
        count_stmt = count_stmt.where(ApiKeyORM.revoked.is_(True))
    if department:
        stmt = stmt.where(ApiKeyORM.department == department)
        count_stmt = count_stmt.where(ApiKeyORM.department == department)
    if scene_type:
        stmt = stmt.where(ApiKeyORM.scene_type == scene_type)
        count_stmt = count_stmt.where(ApiKeyORM.scene_type == scene_type)
    if tier in ("elevated", "high", "unlimited", "default", "custom"):
        elevated = _elevated_tier_filter()
        default_tier = and_(ApiKeyORM.rpm_limit.is_(None), ApiKeyORM.tpm_limit.is_(None))
        unlimited_tier = or_(ApiKeyORM.rpm_limit == -1, ApiKeyORM.tpm_limit == -1)
        if tier == "elevated":
            stmt = stmt.where(elevated)
            count_stmt = count_stmt.where(elevated)
        elif tier == "unlimited":
            stmt = stmt.where(unlimited_tier)
            count_stmt = count_stmt.where(unlimited_tier)
        elif tier == "high":
            high_only = and_(
                elevated,
                ApiKeyORM.rpm_limit != -1,
                ApiKeyORM.tpm_limit != -1,
            )
            stmt = stmt.where(high_only)
            count_stmt = count_stmt.where(high_only)
        elif tier == "default":
            stmt = stmt.where(default_tier)
            count_stmt = count_stmt.where(default_tier)
        else:  # custom：非默认、非 elevated
            custom_only = and_(~default_tier, ~elevated)
            stmt = stmt.where(custom_only)
            count_stmt = count_stmt.where(custom_only)
    if q:
        like = f"%{q.strip()}%"
        q_filter = or_(
            ApiKeyORM.name.ilike(like),
            ApiKeyORM.auth_id.ilike(like),
            ApiKeyORM.project_name.ilike(like),
            ApiKeyORM.department.ilike(like),
            ApiKeyORM.key_prefix.ilike(like),
        )
        stmt = stmt.where(q_filter)
        count_stmt = count_stmt.where(q_filter)
    total = db.execute(count_stmt).scalar() or 0
    limit = max(1, min(200, int(limit or 50)))
    offset = max(0, int(offset or 0))
    sort_col = _KEY_SORT_COLS.get((sort or "").strip())
    descending = (order or "desc").lower() != "asc"
    if sort_col is not None:
        order_by = (sort_col.desc() if descending else sort_col.asc(), ApiKeyORM.created_at.desc())
    else:
        order_by = (ApiKeyORM.created_at.desc(),)
    rows = db.execute(
        stmt.order_by(*order_by).limit(limit).offset(offset)
    ).scalars().all()
    departments = [
        d for d in db.execute(
            select(ApiKeyORM.department)
            .where(ApiKeyORM.deleted_at.is_(None), ApiKeyORM.department != "")
            .distinct()
            .order_by(ApiKeyORM.department)
        ).scalars().all()
        if d
    ]
    return {
        "data": [_key_admin_dict(k) for k in rows],
        "total": total,
        "departments": departments,
        "limit": limit,
        "offset": offset,
    }


@router.post("/keys")
def create_key(payload: KeyCreate, db: Session = Depends(get_db), _=Depends(require_recent_admin)):
    raw = generate_api_key()
    k = ApiKeyORM(
        name=payload.name, auth_id=payload.auth_id, project_name=payload.project_name,
        department=payload.department, project_desc=payload.project_desc,
        scene_type=payload.scene_type or "explore", models=payload.models,
        key_hash=hash_key(raw), key_prefix=raw[: len(KEY_PREFIX) + 6],
        application_id=payload.application_id,
    )
    db.add(k)
    _audit(db, "admin", "key.create", k.id, {"project": payload.project_name})
    db.commit()
    return {"id": k.id, "api_key": raw}  # 仅创建时返回明文


@router.patch("/keys/{key_id}")
def update_key_meta(
    key_id: str,
    payload: KeyMetaUpdate,
    db: Session = Depends(get_db),
    _=Depends(require_recent_admin),
):
    """管理员修改密钥名称与描述（对齐用户侧 PATCH /user/keys/{id}）。

    name 同时写入 name / project_name，与用量统计「场景」维度保持一致；
    同一用户下场景名不可重复。
    """
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None:
        raise HTTPException(status_code=404, detail="key 不存在")
    try:
        name = assert_scenario_name_available(db, k.auth_id, payload.name, exclude_key_id=k.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    desc_raw = payload.project_desc
    project_desc = desc_raw.strip() if isinstance(desc_raw, str) and desc_raw.strip() else None
    k.name = name
    k.project_name = name
    k.project_desc = project_desc
    _audit(db, "admin", "key.update_meta", key_id, {"name": name})
    db.commit()
    return _key_admin_dict(k)


@router.post("/keys/{key_id}/regenerate")
def regenerate_key(key_id: str, db: Session = Depends(get_db), _=Depends(require_recent_admin)):
    """管理员更换新密钥：保留 id/名称/限额/历史用量，重新生成明文。

    旧 key_hash 立即失效；新明文仅本次返回。吊销状态不变（恢复须另点 restore）。
    """
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None:
        raise HTTPException(status_code=404, detail="key 不存在")
    raw = generate_api_key()
    k.key_hash = hash_key(raw)
    k.key_prefix = raw[: len(KEY_PREFIX) + 6]
    k.api_key = None  # 明文绝不落库
    k.granted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    _audit(db, "admin", "key.regenerate", key_id)
    db.commit()
    invalidate_prepare_cache()
    return {"id": k.id, "api_key": raw, "revoked": k.revoked}


# ── 场景分类管理（业务场景，申请表单与场景分布共用）─────────────────────────
class SceneTypeIn(BaseModel):
    key: str
    label: str
    sort_order: int = 0


class SceneTypeUpdate(BaseModel):
    label: str
    sort_order: int = 0


@router.get("/scene-types")
def list_scene_types(db: Session = Depends(get_db), _=Depends(require_admin)):
    """列出场景分类（按 sort_order 排序），附带各分类下未删除 Key 的数量。"""
    rows = db.execute(
        select(SceneTypeORM, func.count(ApiKeyORM.id))
        .outerjoin(ApiKeyORM, (ApiKeyORM.scene_type == SceneTypeORM.key) & (ApiKeyORM.deleted_at.is_(None)))
        .group_by(SceneTypeORM.key)
        .order_by(SceneTypeORM.sort_order, SceneTypeORM.key)
    ).all()
    return [
        {"key": st.key, "label": st.label, "sortOrder": st.sort_order, "keyCount": cnt}
        for st, cnt in rows
    ]


@router.post("/scene-types")
def create_scene_type(
    payload: SceneTypeIn,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    key = (payload.key or "").strip()
    label = (payload.label or "").strip()
    if not key or not label:
        raise HTTPException(status_code=400, detail="场景分类 key 与名称不能为空")
    if db.get(SceneTypeORM, key) is not None:
        raise HTTPException(status_code=400, detail="该 key 已存在，请勿重复创建")
    db.add(SceneTypeORM(key=key, label=label, sort_order=payload.sort_order))
    db.commit()
    return {"ok": True, "key": key}


@router.put("/scene-types/{key}")
def update_scene_type(
    key: str,
    payload: SceneTypeUpdate,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    st = db.get(SceneTypeORM, key)
    if st is None:
        raise HTTPException(status_code=404, detail="场景分类不存在")
    if not (payload.label or "").strip():
        raise HTTPException(status_code=400, detail="名称不能为空")
    st.label = payload.label.strip()
    st.sort_order = payload.sort_order
    db.commit()
    return {"ok": True}


@router.delete("/scene-types/{key}")
def delete_scene_type(
    key: str,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    st = db.get(SceneTypeORM, key)
    if st is None:
        raise HTTPException(status_code=404, detail="场景分类不存在")
    in_use = int(
        db.execute(
            select(func.count()).select_from(ApiKeyORM).where(
                ApiKeyORM.scene_type == key, ApiKeyORM.deleted_at.is_(None)
            )
        ).scalar()
        or 0
    )
    if in_use > 0:
        raise HTTPException(
            status_code=409,
            detail=f"该场景分类下仍有 {in_use} 个 API Key，无法删除",
        )
    db.delete(st)
    db.commit()
    return {"ok": True}


class KeyLimits(BaseModel):
    rpm_limit: int | None = None            # None=平台默认；负数=无限；>0=该值
    tpm_limit: int | None = None            # 同上
    # 一次性套用到该 Key 所属账号 ID（用户）的全部有效密钥
    apply_to_user_keys: bool = False


# 列宽上界：rpm_limit 是 int4，tpm_limit 在迁移 010 放宽为 int8。超界若不在此
# 拦下，会一路走到 commit 才被 Postgres 拒绝，返回 500 而不是 422。
_RPM_CEILING = 2_147_483_647
_TPM_CEILING = 9_223_372_036_854_775_807


def normalize_rate_limit(v: int | None, field: str, ceiling: int) -> int | None:
    """入参 → 落库值：负数 → -1（无限）；None → None（平台默认）；正数原样。

    0 与超界一律 422。0 必须显式拒绝：策略层 `effective_rate_limits` 里 0 表示
    "无限"，而写入层若把 0 当成"回落默认"，脚本按策略层语义传 0 就会被静默降级
    为平台默认限速——方向最坏的一类失败（以为不限速的大户日间会被 429）。
    """
    if v is None:
        return None
    if v < 0:
        return -1
    if v == 0:
        raise HTTPException(
            status_code=422,
            detail=f"{field} 不接受 0：用 -1 表示无限（超高并发），留空表示回落平台默认",
        )
    if v > ceiling:
        raise HTTPException(status_code=422, detail=f"{field} 超出可存储范围（最大 {ceiling}）")
    return v


@router.post("/keys/{key_id}/limits")
def set_key_limits(key_id: str, payload: KeyLimits, db: Session = Depends(get_db), _=Depends(require_recent_admin)):
    """设置密钥限额：单 Key RPM/TPM 覆盖（平台仅有这两种限额，月度配额已移除）。

    三态：留空(None)=回落平台默认；负数=无限（超高并发）；正数=该上限。
    RPM/TPM 各自独立取值，允许混档（如 RPM 无限 + TPM 限额）。
    生效即时（清鉴权缓存，不等 TTL）。
    apply_to_user_keys=true 时同步套用到该用户名下全部有效密钥。

    0 与超界报 422，理由见 `normalize_rate_limit`。"""
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None:
        raise HTTPException(status_code=404, detail="key 不存在")

    # 两个字段先全部校验再写入：避免 rpm 已写进 ORM、tpm 校验失败抛 422 的半应用状态
    rpm = normalize_rate_limit(payload.rpm_limit, "rpm_limit", _RPM_CEILING)
    tpm = normalize_rate_limit(payload.tpm_limit, "tpm_limit", _TPM_CEILING)

    def _apply(target: ApiKeyORM) -> None:
        target.rpm_limit = rpm
        target.tpm_limit = tpm

    _apply(k)
    touched = [k]
    if payload.apply_to_user_keys and k.auth_id:
        siblings = db.execute(
            select(ApiKeyORM).where(
                ApiKeyORM.auth_id == k.auth_id,
                ApiKeyORM.deleted_at.is_(None),
                ApiKeyORM.id != k.id,
            )
        ).scalars().all()
        for s in siblings:
            _apply(s)
            touched.append(s)
    # 调到高并发/超高并发时补齐已通过升级申请（与升级工单属性同源），
    # 否则密钥管理改档后「高并发升级」全部/已批准筛不到。
    for target in touched:
        ensure_approved_upgrade_for_key(db, target)
    applied = len(touched)
    _audit(db, "admin", "key.limits", k.id, {
        "rpm_limit": k.rpm_limit, "tpm_limit": k.tpm_limit,
        "applied_keys": applied,
    })
    db.commit()
    invalidate_prepare_cache()  # 让限额变更立即生效，不等鉴权缓存 TTL
    out = _key_admin_dict(k)
    out["appliedKeys"] = applied
    return out


@router.post("/keys/{key_id}/revoke")
def revoke_key(key_id: str, db: Session = Depends(get_db), _=Depends(require_recent_admin)):
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None:
        raise HTTPException(status_code=404, detail="key 不存在")
    if not k.revoked:
        k.revoked = True
        k.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        cancel_pending_upgrades(db, key_id)  # 吊销后无法审批升级，在途申请一并失效
        _audit(db, "admin", "key.revoke", key_id)
        db.commit()
        invalidate_prepare_cache()  # 吊销全网关即时生效
    return {"ok": True}


@router.post("/keys/{key_id}/restore")
def restore_key(key_id: str, db: Session = Depends(get_db), _=Depends(require_recent_admin)):
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None:
        raise HTTPException(status_code=404, detail="key 不存在")
    if k.revoked:
        k.revoked = False
        k.revoked_at = None
        _audit(db, "admin", "key.restore", key_id)
        db.commit()
        invalidate_prepare_cache()
    return {"ok": True}


@router.delete("/keys/{key_id}")
def delete_key(key_id: str, db: Session = Depends(get_db), _=Depends(require_recent_admin)):
    k = db.get(ApiKeyORM, key_id)
    if k is None or k.deleted_at is not None:
        raise HTTPException(status_code=404, detail="key 不存在")
    k.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    cancel_pending_upgrades(db, key_id)  # 密钥已删，在途升级申请一并失效
    _audit(db, "admin", "key.delete", key_id)
    db.commit()
    invalidate_prepare_cache()
    return {"ok": True}


# ── 申请审批 ─────────────────────────────────────────────────────────────────
def _application_dict(a: ApplicationORM) -> dict:
    return {
        "id": a.id,
        "authId": a.auth_id,
        "name": a.name,
        "department": a.department,
        "projectName": a.project_name,
        "projectDesc": a.project_desc,
        "sceneType": a.scene_type,
        "models": a.models,
        "reason": a.reason,
        "status": a.status,
        "note": a.note,
        "createdAt": iso_utc(a.created_at),
        "reviewedAt": iso_utc(a.reviewed_at),
        "reviewer": a.reviewer,
    }


@router.get("/applications")
def list_applications(
    limit: int = 50,
    offset: int = 0,
    status: str | None = None,
    scene_type: str | None = None,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """密钥申请分页列表（待审批在前，其余按创建时间倒序）。

    pendingTotal 独立统计、不受分页与 status / scene_type 筛选影响——管理员需要的是「还有
    多少待办」，不是「当前这页里有多少待办」（同 list_early_access 的设计）。
    scene_type 可按业务场景分类筛选（场景分类管理页「查看申请」用）。
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    base = select(ApplicationORM)
    if status:
        base = base.where(ApplicationORM.status == status)
    if scene_type:
        base = base.where(ApplicationORM.scene_type == scene_type)

    total = db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
    pending_total = db.execute(
        select(func.count()).select_from(ApplicationORM).where(ApplicationORM.status == "pending")
    ).scalar_one()

    rows = db.execute(
        base.order_by(
            (ApplicationORM.status != "pending"),
            ApplicationORM.created_at.desc(),
        ).limit(limit).offset(offset)
    ).scalars().all()

    return {
        "data": [_application_dict(a) for a in rows],
        "total": total,
        "pendingTotal": pending_total,
        "limit": limit,
        "offset": offset,
    }


class RejectIn(BaseModel):
    note: str | None = None


def _mark_reviewed(a: ApplicationORM | UpgradeApplicationORM, status: str, note: str | None) -> None:
    a.status = status
    a.note = note
    a.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    a.reviewer = "admin"


@router.post("/applications/{app_id}/approve")
def approve_application(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    # FOR UPDATE 行锁：并发/双击审批时串行化，避免「existing 检查 → 插 key」之间
    # 双发竞态给同一申请发两把密钥。后到的请求拿到锁后 status 已非 pending，被拦下。
    a = db.execute(
        select(ApplicationORM).where(ApplicationORM.id == app_id).with_for_update()
    ).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    _require_pending_application(a)
    existing = db.execute(
        select(ApiKeyORM).where(ApiKeyORM.application_id == app_id, ApiKeyORM.deleted_at.is_(None))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=400, detail="该申请已发放密钥，请勿重复审批")
    k = ApiKeyORM(
        name=a.project_name, auth_id=a.auth_id, project_name=a.project_name,
        department=a.department, project_desc=a.project_desc,
        scene_type=a.scene_type or "explore", models=a.models,
        # 审批只授予资格，不在管理员会话里生成/展示用户凭据。申请人首次访问
        # API Keys 页时通过 /user/keys/{id}/claim 领取，明文仍然只出现一次。
        key_hash=None, key_prefix=None,
        application_id=a.id,
    )
    db.add(k)
    _mark_reviewed(a, "approved", payload.note)
    _audit(db, "admin", "application.approve", app_id, {"note": payload.note} if payload.note else None)
    db.commit()
    return {"ok": True, "key_id": k.id, "status": "approved"}


@router.post("/applications/{app_id}/reject")
def reject_application(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    a = db.get(ApplicationORM, app_id)
    if a is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    _require_pending_application(a)
    _mark_reviewed(a, "rejected", payload.note)
    _audit(db, "admin", "application.reject", app_id, {"note": payload.note} if payload.note else None)
    db.commit()
    return {"ok": True, "status": a.status}


# ── 高并发升级申请审批 ─────────────────────────────────────────────────────────
def _require_pending_upgrade(a: UpgradeApplicationORM) -> None:
    if a.status != "pending":
        raise HTTPException(status_code=400, detail=f"该申请已处理，当前状态为 {a.status}")


def _upgrade_app_admin_dict(
    a: UpgradeApplicationORM,
    key: ApiKeyORM | None = None,
) -> dict:
    tier = settings.key_tier(key.rpm_limit, key.tpm_limit) if key is not None else None
    return {
        "id": a.id,
        "authId": a.auth_id,
        "name": a.name,
        "department": a.department,
        "keyId": a.key_id,
        "keyName": a.key_name,
        "projectName": a.project_name,
        "reason": a.reason,
        "targetTier": a.target_tier,
        "status": a.status,
        "note": a.note,
        "createdAt": iso_utc(a.created_at),
        "reviewedAt": iso_utc(a.reviewed_at),
        "reviewer": a.reviewer,
        # 关联密钥当前档位（与密钥管理同源）；密钥已删则为 null
        "currentTier": tier,
        "rpmLimit": key.rpm_limit if key is not None else None,
        "tpmLimit": key.tpm_limit if key is not None else None,
    }


_UPGRADE_SORT_COLS = {
    "created_at": UpgradeApplicationORM.created_at,
    "key_name": UpgradeApplicationORM.key_name,
    "department": UpgradeApplicationORM.department,
    "status": UpgradeApplicationORM.status,
    "target_tier": UpgradeApplicationORM.target_tier,
    "auth_id": UpgradeApplicationORM.auth_id,
}


@router.get("/upgrade-applications")
def list_upgrade_applications(
    limit: int = 50,
    offset: int = 0,
    status: str | None = None,
    department: str | None = None,
    tier: str | None = None,
    q: str | None = None,
    sort: str | None = None,
    order: str = "desc",
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """高并发升级申请分页列表。

    默认：待审批在前，其余按提交时间倒序。
    指定 sort 后按该列排序（order=asc|desc）。
    pendingTotal / approvedTotal 独立统计、不受分页与筛选影响。
    departments 返回可选部门列表，供表头筛选。
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    base = select(UpgradeApplicationORM)
    if status:
        base = base.where(UpgradeApplicationORM.status == status)
    if department:
        base = base.where(UpgradeApplicationORM.department == department)
    if tier:
        base = base.where(UpgradeApplicationORM.target_tier == tier)
    q_raw = (q or "").strip()
    if q_raw:
        like = f"%{q_raw}%"
        base = base.where(or_(
            UpgradeApplicationORM.key_name.ilike(like),
            UpgradeApplicationORM.project_name.ilike(like),
            UpgradeApplicationORM.name.ilike(like),
            UpgradeApplicationORM.auth_id.ilike(like),
        ))

    total = db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
    pending_total = db.execute(
        select(func.count()).select_from(UpgradeApplicationORM).where(
            UpgradeApplicationORM.status == "pending"
        )
    ).scalar_one()
    approved_total = db.execute(
        select(func.count()).select_from(UpgradeApplicationORM).where(
            UpgradeApplicationORM.status == "approved"
        )
    ).scalar_one()

    sort_col = _UPGRADE_SORT_COLS.get((sort or "").strip())
    descending = (order or "desc").lower() != "asc"
    if sort_col is not None:
        order_by = (sort_col.desc() if descending else sort_col.asc(),)
    else:
        # 默认：待审批优先，再按提交时间倒序
        order_by = (
            (UpgradeApplicationORM.status != "pending"),
            UpgradeApplicationORM.created_at.desc(),
        )

    rows = db.execute(
        base.order_by(*order_by).limit(limit).offset(offset)
    ).scalars().all()

    key_ids = [a.key_id for a in rows if a.key_id]
    key_map: dict[str, ApiKeyORM] = {}
    if key_ids:
        for k in db.execute(select(ApiKeyORM).where(ApiKeyORM.id.in_(key_ids))).scalars():
            key_map[k.id] = k

    departments = [
        d for d in db.execute(
            select(UpgradeApplicationORM.department)
            .where(UpgradeApplicationORM.department != "")
            .distinct()
            .order_by(UpgradeApplicationORM.department)
        ).scalars().all()
        if d
    ]

    return {
        "data": [_upgrade_app_admin_dict(a, key_map.get(a.key_id) if a.key_id else None) for a in rows],
        "total": total,
        "pendingTotal": pending_total,
        "approvedTotal": approved_total,
        "departments": departments,
        "limit": limit,
        "offset": offset,
    }


@router.post("/upgrade-applications/{app_id}/approve")
def approve_upgrade_application(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """审批通过：把对应密钥套用「高并发」预设档位（写 rpm_limit/tpm_limit，立即生效）。"""
    a = db.get(UpgradeApplicationORM, app_id)
    if a is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    _require_pending_upgrade(a)
    if a.key_id is None:
        raise HTTPException(status_code=400, detail="对应密钥已删除，无法审批")
    k = db.get(ApiKeyORM, a.key_id)
    if k is None or k.deleted_at is not None or k.revoked:
        raise HTTPException(status_code=400, detail="对应密钥已删除或已吊销，无法审批")
    # 2026-08 修复：审批路径不复检档位，会把提交后被手动调到更高档位的 key 静默降档。
    # 当前档位已不低于申请档位 → 拒绝，避免「升级」反而拉低限额。
    current_tier = settings.key_tier(k.rpm_limit, k.tpm_limit)
    if current_tier in ("unlimited", "high"):
        raise HTTPException(
            status_code=400,
            detail=f"该密钥当前档位已为「{current_tier}」，不低于申请档位，无需升级",
        )
    presets = {p["key"]: p for p in settings.rate_limit_presets()}
    high = presets.get(a.target_tier) or presets.get("high")
    if high is None:
        raise HTTPException(status_code=400, detail=f"未知升级档位 {a.target_tier}")
    k.rpm_limit = high["rpm"]
    k.tpm_limit = high["tpm"]
    _mark_reviewed(a, "approved", payload.note)
    _audit(db, "admin", "upgrade.approve", app_id, {
        "key_id": k.id,
        "rpm_limit": k.rpm_limit,
        "tpm_limit": k.tpm_limit,
    })
    db.commit()
    invalidate_prepare_cache()  # 档位变更立即生效，不等鉴权缓存 TTL
    return {"ok": True, "keyId": k.id, "rpmLimit": k.rpm_limit, "tpmLimit": k.tpm_limit}


@router.post("/upgrade-applications/{app_id}/reject")
def reject_upgrade_application(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    a = db.get(UpgradeApplicationORM, app_id)
    if a is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    _require_pending_upgrade(a)
    _mark_reviewed(a, "rejected", payload.note)
    _audit(db, "admin", "upgrade.reject", app_id, {"note": payload.note} if payload.note else None)
    db.commit()
    return {"ok": True, "status": a.status}


# ── 抢先体验计划审批 ──────────────────────────────────────────────────────────
def _early_access_dict(a: EarlyAccessApplicationORM) -> dict:
    return {
        "id": a.id,
        "authId": a.auth_id,
        "name": a.name,
        "department": a.department,
        "status": a.status,
        "agreementVersion": a.agreement_version,
        "note": a.note,
        "submittedAt": iso_utc(a.submitted_at),
        "reviewedAt": iso_utc(a.reviewed_at),
        "reviewer": a.reviewer,
    }


@router.get("/early-access")
def list_early_access(
    limit: int = 50,
    offset: int = 0,
    status: str | None = None,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """抢先体验计划申请分页列表（待审批在前，其余按提交时间倒序）。

    pendingTotal 独立统计、不受分页与 status 筛选影响——管理员需要的是「还有多少
    待办」，不是「当前这页里有多少待办」。
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    base = select(EarlyAccessApplicationORM)
    if status:
        base = base.where(EarlyAccessApplicationORM.status == status)

    total = db.execute(
        select(func.count()).select_from(base.subquery())
    ).scalar_one()
    pending_total = db.execute(
        select(func.count()).select_from(EarlyAccessApplicationORM)
        .where(EarlyAccessApplicationORM.status == STATUS_PENDING)
    ).scalar_one()
    approved_total = db.execute(
        select(func.count()).select_from(EarlyAccessApplicationORM)
        .where(EarlyAccessApplicationORM.status == STATUS_APPROVED)
    ).scalar_one()

    rows = db.execute(
        base.order_by(
            (EarlyAccessApplicationORM.status != STATUS_PENDING),
            EarlyAccessApplicationORM.submitted_at.desc(),
        ).limit(limit).offset(offset)
    ).scalars().all()

    models = db.execute(
        select(ModelRegistryORM.id, ModelRegistryORM.name)
        .where(ModelRegistryORM.status == EARLY_ACCESS_STATUS)
        .order_by(ModelRegistryORM.name)
    ).all()
    return {
        "data": [_early_access_dict(a) for a in rows],
        "total": total,
        "pendingTotal": pending_total,
        "approvedTotal": approved_total,
        "limit": limit,
        "offset": offset,
        "models": [{"id": m[0], "name": m[1]} for m in models],
    }


def _review_early_access(
    db: Session, app_id: str, status: str, note: str | None,
) -> EarlyAccessApplicationORM:
    a = db.get(EarlyAccessApplicationORM, app_id)
    if a is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if a.status == status:
        raise HTTPException(status_code=400, detail=f"该申请已是 {status} 状态")
    a.status = status
    a.note = note
    a.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    a.reviewer = "admin"
    _audit(db, "admin", f"early_access.{status}", app_id, {"authId": a.auth_id})
    db.commit()
    # 授权变更立刻全网关生效，不等 AUTH_CACHE_TTL_S 过期
    invalidate_prepare_cache()
    return a


@router.post("/early-access/{app_id}/approve")
def approve_early_access(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    return {"ok": True, **_early_access_dict(_review_early_access(db, app_id, "approved", payload.note))}


@router.post("/early-access/{app_id}/reject")
def reject_early_access(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    return {"ok": True, **_early_access_dict(_review_early_access(db, app_id, "rejected", payload.note))}


@router.post("/early-access/{app_id}/revoke")
def revoke_early_access(
    app_id: str,
    payload: RejectIn = Body(default=RejectIn()),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """撤销已通过的授权。

    落 revoked 而不是 rejected：鉴权上两者等价（都不是 approved），但用户看到的
    该是「授权已被收回」，不是「你的申请没通过」。用户可重新申请。
    """
    a = db.get(EarlyAccessApplicationORM, app_id)
    if a is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if a.status != STATUS_APPROVED:
        raise HTTPException(status_code=400, detail="仅已通过的授权可撤销")
    return {"ok": True, **_early_access_dict(_review_early_access(db, app_id, STATUS_REVOKED, payload.note))}


# ── 审计日志 ─────────────────────────────────────────────────────────────────
@router.get("/audit-logs")
def list_audit_logs(
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    limit = min(max(1, limit), 500)
    offset = max(0, offset)
    total = db.execute(select(func.count()).select_from(AuditLogORM)).scalar_one()
    rows = db.execute(
        select(AuditLogORM).order_by(AuditLogORM.created_at.desc()).offset(offset).limit(limit)
    ).scalars().all()
    return {
        "total": total,
        "data": [
            {"id": r.id, "actor": r.actor, "action": r.action, "target": r.target,
             "detail": r.detail, "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ],
    }


# ── 用量统计 ─────────────────────────────────────────────────────────────────
@router.get("/usage/stats")
def usage_stats(days: int = 30, db: Session = Depends(get_db), _=Depends(require_admin)):
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    rows = db.execute(
        select(
            UsageLogORM.model_id,
            func.count().label("requests"),
            func.coalesce(func.sum(UsageLogORM.total_tokens), 0).label("tokens"),
            func.coalesce(func.sum(UsageLogORM.estimated_cost), 0).label("cost"),
        ).where(UsageLogORM.created_at >= since).group_by(UsageLogORM.model_id)
    ).all()
    return {"data": [{"model_id": r.model_id, "requests": r.requests,
                      "tokens": int(r.tokens), "cost": float(r.cost)} for r in rows]}


# ── 算力拓扑资源登记 ─────────────────────────────────────────────────────────
class InfraResourceIn(BaseModel):
    kind: str
    name: str
    subtitle: str = ""
    pool: str | None = None
    parent_ids: list[str] = Field(default_factory=list)
    extra: dict = Field(default_factory=dict)


_INFRA_POOL_IDS = frozenset({"primary", "secondary"})


def _infra_resource_dict(r: InfraResourceORM) -> dict:
    return {
        "id": r.id,
        "kind": r.kind,
        "name": r.name,
        "subtitle": r.subtitle,
        "pool": r.pool,
        "extra": r.extra or {},
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("/infra/top-projects")
def infra_top_projects(
    limit: int = 5,
    days: int = 90,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """算力拓扑「平台应用」列：按调用量取 TOP N 运行时项目。"""
    limit = max(1, min(limit, 20))
    days = max(1, min(days, 365))
    return {"projects": get_top_projects(db, limit=limit, days=days)}


@router.get("/infra/resources")
def list_infra_resources(db: Session = Depends(get_db), _=Depends(require_admin)):
    resources = db.execute(
        select(InfraResourceORM).order_by(InfraResourceORM.created_at, InfraResourceORM.name)
    ).scalars().all()
    links = db.execute(
        select(InfraTopologyLinkORM).order_by(InfraTopologyLinkORM.created_at)
    ).scalars().all()
    return {
        "resources": [_infra_resource_dict(r) for r in resources],
        "links": [{
            "id": link.id,
            "source_id": link.source_id,
            "target_id": link.target_id,
            "relation": link.relation,
        } for link in links],
    }


@router.post("/infra/resources")
def create_infra_resource(
    payload: InfraResourceIn,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    kind = payload.kind.strip().lower()
    if kind not in {"server", "model", "application"}:
        raise HTTPException(status_code=400, detail="资源类型仅支持 server、model、application")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="资源名称不能为空")
    if len(name) > 120 or len(payload.subtitle) > 240:
        raise HTTPException(status_code=400, detail="资源名称或说明过长")
    pool = payload.pool.strip().lower() if payload.pool else None
    if kind == "server" and pool not in _INFRA_POOL_IDS:
        raise HTTPException(status_code=400, detail="服务器必须归属一个可用算力池")
    parent_ids = list(dict.fromkeys(x.strip() for x in payload.parent_ids if x.strip()))
    if not parent_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个关联节点")

    if kind == "server":
        expected_pool_id = f"pool-{pool}"
        if parent_ids != [expected_pool_id]:
            raise HTTPException(status_code=400, detail="服务器与算力池归属不一致")
    else:
        expected_parent_kind = "server" if kind == "model" else "model"
        registered_parent_ids = set(db.execute(
            select(InfraResourceORM.id).where(
                InfraResourceORM.kind == expected_parent_kind,
                InfraResourceORM.id.in_(parent_ids),
            )
        ).scalars().all())
        invalid_parent_ids = set(parent_ids) - registered_parent_ids
        if invalid_parent_ids:
            raise HTTPException(status_code=400, detail="关联节点不存在或类型不匹配")

    extra = payload.extra if isinstance(payload.extra, dict) else {}
    if kind == "server":
        chip = str(extra.get("chip") or "UNSPECIFIED").strip()
        try:
            accelerator_count = int(extra.get("accelerator_count", 0))
            vram_gb = int(extra.get("vram_gb", 0))
            node_count = int(extra.get("node_count", 1))
        except (TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(
                status_code=400, detail="服务器容量字段必须为整数",
            ) from exc
        if not chip or len(chip) > 80:
            raise HTTPException(status_code=400, detail="加速器型号不能为空且不能超过 80 字符")
        if not (0 <= accelerator_count <= 100_000 and 0 <= vram_gb <= 1_000_000 and 1 <= node_count <= 100_000):
            raise HTTPException(status_code=400, detail="服务器容量字段超出允许范围")
        extra = {
            **extra,
            "chip": chip,
            "accelerator_count": accelerator_count,
            "vram_gb": vram_gb,
            "node_count": node_count,
        }
    elif kind == "model":
        model_id = str(extra.get("model_id") or "").strip()
        if len(model_id) > 160:
            raise HTTPException(status_code=400, detail="调用模型 ID 不能超过 160 字符")
        extra = {**extra, "model_id": model_id}
    elif kind == "application":
        scene_type = str(extra.get("scene_type") or "explore").strip()
        if db.get(SceneTypeORM, scene_type) is None:
            raise HTTPException(status_code=400, detail="应用场景分类不存在")
        extra = {**extra, "scene_type": scene_type}

    resource = InfraResourceORM(
        kind=kind,
        name=name,
        subtitle=payload.subtitle.strip(),
        pool=pool,
        extra=extra,
    )
    db.add(resource)
    db.flush()

    for parent_id in parent_ids:
        db.add(InfraTopologyLinkORM(
            source_id=parent_id,
            target_id=resource.id,
            relation={"server": "contains", "model": "deploys", "application": "serves"}[kind],
        ))
    _audit(db, "admin", "infra_resource.create", resource.id, {
        "kind": kind, "name": name, "parent_ids": parent_ids,
    })
    db.commit()
    db.refresh(resource)
    return _infra_resource_dict(resource)


@router.delete("/infra/resources/{resource_id}")
def delete_infra_resource(
    resource_id: str,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    resource = db.get(InfraResourceORM, resource_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="算力拓扑资源不存在")
    db.execute(delete(InfraTopologyLinkORM).where(or_(
        InfraTopologyLinkORM.source_id == resource_id,
        InfraTopologyLinkORM.target_id == resource_id,
    )))
    db.delete(resource)
    _audit(db, "admin", "infra_resource.delete", resource_id, {
        "kind": resource.kind, "name": resource.name,
    })
    db.commit()
    return {"ok": True}


# ── 运营巡检报告 ─────────────────────────────────────────────────────────────
def _report_brief(r: OpsReportORM) -> dict:
    t = (r.metrics or {}).get("totals", {})
    c = (r.metrics or {}).get("compare", {})
    anomalies = (r.metrics or {}).get("anomalies", [])
    return {
        "id": r.id,
        "kind": r.kind,
        "label": r.label,
        "health": r.health,
        "period_start": r.period_start.isoformat() if r.period_start else None,
        "period_end": r.period_end.isoformat() if r.period_end else None,
        "generated_at": r.generated_at.isoformat() if r.generated_at else None,
        "requests": t.get("requests", 0),
        "error_rate": t.get("error_rate", 0.0),
        "total_tokens": t.get("total_tokens", 0),
        "cost": t.get("cost", 0.0),
        "requests_delta_pct": c.get("requests_delta_pct"),
        "anomaly_count": len(anomalies),
        "health_score": (r.metrics or {}).get("health_score"),
    }


def _report_full(r: OpsReportORM) -> dict:
    return {
        **_report_brief(r),
        "summary_md": r.summary_md,
        "metrics": r.metrics,
    }


@router.get("/reports")
def list_reports(limit: int = 60, kind: str | None = None,
                 db: Session = Depends(get_db), _=Depends(require_admin)):
    limit = max(1, min(limit, 365))
    stmt = select(OpsReportORM).order_by(OpsReportORM.period_start.desc()).limit(limit)
    if kind:
        stmt = select(OpsReportORM).where(OpsReportORM.kind == kind) \
            .order_by(OpsReportORM.period_start.desc()).limit(limit)
    rows = db.execute(stmt).scalars().all()
    return {"data": [_report_brief(r) for r in rows]}


@router.get("/reports/{report_id}")
def get_report(report_id: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    r = db.get(OpsReportORM, report_id)
    if r is None:
        raise HTTPException(status_code=404, detail="报告不存在")
    return _report_full(r)


class GenerateReportIn(BaseModel):
    kind: str = "daily"          # daily|weekly|monthly|quarterly|yearly|cumulative|custom
    date: str | None = None      # 锚定自然日 YYYY-MM-DD（默认按各类型取上一完整周期）
    start: str | None = None     # custom：窗口起 ISO
    end: str | None = None       # custom：窗口止 ISO


@router.post("/reports/generate")
def generate_report_now(payload: GenerateReportIn = Body(default=GenerateReportIn()),
                        db: Session = Depends(get_db), _=Depends(require_admin)):
    """手动触发巡检并生成报告（force 刷新已存在的同周期报告）。"""
    anchor = None
    if payload.date:
        try:
            anchor = datetime.fromisoformat(payload.date)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="date 格式无效（应为 YYYY-MM-DD）") from exc

    if payload.kind == "custom":
        if not payload.start or not payload.end:
            raise HTTPException(status_code=400, detail="custom 报告需提供 start 与 end")
        try:
            start = datetime.fromisoformat(payload.start)
            end = datetime.fromisoformat(payload.end)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="start/end 时间格式无效") from exc
        if end <= start:
            raise HTTPException(status_code=400, detail="end 必须晚于 start")
        r = generate_report(db, start, end, kind="manual", force=True)
    elif payload.kind in ("daily", "weekly", "monthly", "quarterly", "yearly", "cumulative"):
        try:
            r = generate_period_report(db, payload.kind, anchor, force=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        raise HTTPException(status_code=400, detail=f"不支持的报告类型: {payload.kind}")
    _audit(db, "admin", "ops_report.generate", r.id, {"kind": r.kind, "label": r.label})
    db.commit()
    return _report_full(r)



@router.get("/notifications")
def list_notifications(db: Session = Depends(get_db), _=Depends(require_admin)):
    rows = db.execute(
        select(NotificationORM).order_by(NotificationORM.created_at.desc())
    ).scalars().all()
    return {"data": [
        {"id": n.id, "type": n.type, "title": n.title, "body": n.body,
         "created_at": n.created_at.isoformat() if n.created_at else None}
        for n in rows
    ]}


@router.post("/notifications")
def create_notification(payload: dict = Body(...), db: Session = Depends(get_db), _=Depends(require_admin)):
    title = (payload.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="公告标题不能为空")
    n = NotificationORM(type=payload.get("type", "info"), title=title, body=payload.get("body"))
    db.add(n)
    _audit(db, "admin", "notification.create", n.id, {"title": n.title})
    db.commit()
    return {"id": n.id}


@router.delete("/notifications/{notification_id}")
def delete_notification(notification_id: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    n = db.get(NotificationORM, notification_id)
    if n is None:
        raise HTTPException(status_code=404, detail="公告不存在")
    db.delete(n)
    _audit(db, "admin", "notification.delete", notification_id)
    db.commit()
    return {"ok": True}


# ── 平台备份（一键导出全库 CSV 打包）──────────────────────────────────────────
def _csv_cell(v):
    from app.csv_export import safe_csv_cell

    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return safe_csv_cell(json.dumps(_redact_export_value(v), ensure_ascii=False))
    if hasattr(v, "isoformat"):  # datetime / date
        return v.isoformat()
    return safe_csv_cell(v)


# 短期调用明细与物理基础设施拓扑默认不进入可读迁移包。后两者即使没有凭据，
# 也足以暴露内网资产规模、命名和关系，不能以“脱敏”为由公开分发。
_BACKUP_SKIP_TABLES = {"usage_logs", "infra_resources", "infra_topology_links"}
_BACKUP_SECRET_COLUMNS = {
    "api_key", "key_hash", "password_hash", "custom_headers", "base_url",
    "secret", "token", "authorization",
}
_BACKUP_SECRET_JSON_KEYS = {
    "api_key", "apikey", "password", "password_hash", "secret", "token",
    "authorization", "client_secret", "custom_headers", "base_url", "baseurl",
}
_SANITIZED_EXPORT_NOTICE = """SECURITY NOTICE / 安全提示

This is a sanitized migration/review export, not a public dataset and not a
disaster-recovery backup. Credentials, model base URLs, transient usage logs,
and infrastructure topology tables are excluded or redacted by default.

The remaining CSV files can still contain personal and business information,
including account identifiers, names, departments, project descriptions,
applications, forum content, audit records and aggregated usage. Keep the
archive access-controlled and encrypted at rest. Do not publish, commit to a
source repository, or share it publicly without an additional data review.

本包是用于迁移/审阅的脱敏导出，不是公开数据集，也不是灾难恢复备份。凭据、模型
接入地址、调用明细和基础设施拓扑已默认排除或遮盖，但其余 CSV 仍可能包含账号标识、
姓名、部门、项目描述、申请、论坛内容、审计记录及聚合用量等个人或业务数据。请限制
访问并使用加密存储；未经再次数据审查，不得公开分享、上传代码仓库或纳入发行包。
"""


def _redact_export_value(value):
    """Recursively remove credentials from the human-readable export."""
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            if str(key).lower() in _BACKUP_SECRET_JSON_KEYS:
                redacted[key] = "[REDACTED]" if item else item
            else:
                redacted[key] = _redact_export_value(item)
        return redacted
    if isinstance(value, list):
        return [_redact_export_value(item) for item in value]
    return value


@router.get("/backup/export")
def backup_export(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _=Depends(require_recent_admin),
):
    """Generate a streamed, sanitized CSV archive for review/migration.

    This archive deliberately excludes credentials, upstream URLs, transient
    response logs and infrastructure topology. It still contains personal and
    business data and must not be publicly shared. Operator-controlled raw
    PostgreSQL snapshots remain the disaster-recovery authority; compression
    and checksum verification do not encrypt those snapshots.
    """
    from app.database import Base

    fd, tmp_name = tempfile.mkstemp(prefix="platform_sanitized_", suffix=".zip")
    os.close(fd)
    tmp_path = Path(tmp_name)
    table_names: list[str] = []
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("EXPORT_SECURITY_NOTICE.txt", _SANITIZED_EXPORT_NOTICE)
            for table in Base.metadata.sorted_tables:
                if table.name in _BACKUP_SKIP_TABLES:
                    continue
                columns = [
                    column for column in table.columns
                    if column.name.lower() not in _BACKUP_SECRET_COLUMNS
                ]
                stmt = select(*columns).execution_options(
                    stream_results=True, yield_per=1000,
                )
                with zf.open(f"{table.name}.csv", "w") as raw:
                    out = io.TextIOWrapper(
                        raw, encoding="utf-8", newline="", write_through=True,
                    )
                    out.write("\ufeff")
                    writer = csv.writer(out)
                    writer.writerow([column.name for column in columns])
                    for row in db.execute(stmt):
                        writer.writerow([_csv_cell(value) for value in row])
                    out.flush()
                    out.detach()
                table_names.append(table.name)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    _audit(db, "admin", "backup.export", None, {"tables": table_names})
    db.commit()
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    background_tasks.add_task(tmp_path.unlink, missing_ok=True)
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=f"platform_sanitized_export_{ts}.zip",
        headers={
            "Cache-Control": "no-store",
            "X-Export-Contains-Sensitive-Data": "true",
            "X-Export-Sharing": "private-only",
        },
    )


@router.get("/backup/status")
def backup_status(_=Depends(require_admin)):
    """Report verified sidecar snapshot integrity and freshness."""
    status = read_backup_status(
        settings.BACKUP_DIR,
        interval_s=settings.BACKUP_INTERVAL_S,
        latest_name=settings.BACKUP_DUMP_FILE,
    )
    return {
        **status,
        "on_demand": settings.ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD,
    }


@router.get("/backup/dump")
def backup_dump(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _=Depends(require_recent_admin),
):
    """Generate a verified full database snapshot for disaster recovery."""
    if not settings.ALLOW_ADMIN_RAW_BACKUP_DOWNLOAD:
        raise HTTPException(
            status_code=403,
            detail="原始数据库备份下载默认关闭；请使用脱敏导出或由运维从备份存储恢复",
        )
    from app.db_backup import create_sql_dump

    try:
        path = create_sql_dump()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    download_name = f"openapi_platform_{ts}.dump"
    size_bytes = path.stat().st_size
    _audit(db, "admin", "backup.dump_export", None, {
        "download_name": download_name,
        "size_bytes": size_bytes,
        "on_demand": True,
    })
    db.commit()
    background_tasks.add_task(path.unlink, missing_ok=True)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=download_name,
    )


@router.get("/doc-feedback")
def list_doc_feedback(limit: int = 100, offset: int = 0, vote: str | None = None,
                      db: Session = Depends(get_db), _=Depends(require_admin)):
    """接口文档的赞踩与意见。此前这份数据只进浏览器 localStorage，从未落库。"""
    limit = min(max(1, limit), 500)
    base = select(DocFeedbackORM)
    if vote in ("up", "down"):
        base = base.where(DocFeedbackORM.vote == vote)
    rows = db.execute(
        base.order_by(DocFeedbackORM.created_at.desc()).offset(max(0, offset)).limit(limit)
    ).scalars().all()
    up = db.execute(select(func.count()).select_from(DocFeedbackORM)
                    .where(DocFeedbackORM.vote == "up")).scalar_one()
    down = db.execute(select(func.count()).select_from(DocFeedbackORM)
                      .where(DocFeedbackORM.vote == "down")).scalar_one()
    return {
        "summary": {"up": up, "down": down, "total": up + down},
        "data": [{
            "id": r.id, "section": r.section, "vote": r.vote, "comment": r.comment,
            "auth_id": r.auth_id, "lang": r.lang,
            "created_at": r.created_at.isoformat() if r.created_at else "",
        } for r in rows],
    }


# ── 数据迁移（累计基线 + CSV 导入 API 保留）──────────────────────────────────
class PlatformBaselineIn(BaseModel):
    initial_calls: int = 0
    initial_tokens: int = 0
    initial_cost: float = 0.0  # 历史累计 Token 成本估算，单位 ¥


@router.get("/migration/baseline")
def get_migration_baseline(db: Session = Depends(get_db), _=Depends(require_admin)):
    return get_baseline(db)


@router.put("/migration/baseline")
def put_migration_baseline(payload: PlatformBaselineIn, db: Session = Depends(get_db), _=Depends(require_admin)):
    result = save_baseline(db, payload.initial_calls, payload.initial_tokens, payload.initial_cost)
    _audit(db, "admin", "migration.baseline", None, {
        "initial_calls": result["initial_calls"],
        "initial_tokens": result["initial_tokens"],
        "initial_cost": result["initial_cost"],
    })
    db.commit()
    return result


@router.post("/migration/import/users")
async def migration_import_users(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _=Depends(require_recent_admin),
):
    content = await file.read()
    if not content.strip():
        raise HTTPException(status_code=400, detail="CSV 文件为空")
    result = import_users_csv(db, content)
    _audit(db, "admin", "migration.import.users", None, result)
    db.commit()
    return result


@router.post("/migration/import/keys")
async def migration_import_keys(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _=Depends(require_recent_admin),
):
    content = await file.read()
    if not content.strip():
        raise HTTPException(status_code=400, detail="CSV 文件为空")
    result = import_api_keys_csv(db, content)
    _audit(db, "admin", "migration.import.keys", None, result)
    db.commit()
    return result


@router.post("/migration/import")
async def migration_import_all(
    users_file: UploadFile | None = File(default=None),
    keys_file: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
    _=Depends(require_recent_admin),
):
    """一键导入：至少上传 users 或 keys 之一；先用户后密钥。"""
    if users_file is None and keys_file is None:
        raise HTTPException(status_code=400, detail="请至少上传 users.csv 或 api_keys.csv")
    out: dict = {"users": None, "keys": None}
    if users_file is not None:
        content = await users_file.read()
        if content.strip():
            out["users"] = import_users_csv(db, content)
    if keys_file is not None:
        content = await keys_file.read()
        if content.strip():
            out["keys"] = import_api_keys_csv(db, content)
    _audit(db, "admin", "migration.import", None, {
        "users_inserted": (out["users"] or {}).get("inserted"),
        "keys_inserted": (out["keys"] or {}).get("inserted"),
    })
    db.commit()
    return out


# ── 用户管理 ─────────────────────────────────────────────────────────────────
def _user_admin_dict(u: UserORM) -> dict:
    return {
        "id": u.id,
        "auth_id": u.auth_id,
        "name": u.name,
        "department": u.department or "",
        "has_password": bool(u.password_hash),
        "is_active": bool(u.is_active),
        "created_at": u.created_at.isoformat() if u.created_at else "",
    }


@router.get("/users")
def list_users(db: Session = Depends(get_db), _=Depends(require_admin)):
    rows = db.execute(
        select(UserORM).where(UserORM.is_active.is_(True)).order_by(UserORM.created_at.desc())
    ).scalars().all()
    return {"data": [_user_admin_dict(u) for u in rows]}


class UserCreate(BaseModel):
    auth_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    department: str | None = Field(default=None, max_length=200)
    password: str | None = Field(
        default=None, min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH,
    )


@router.post("/users")
def create_user(payload: UserCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    auth_id = payload.auth_id.strip()
    name = payload.name.strip()
    if not auth_id or not name:
        raise HTTPException(status_code=400, detail="账号 ID 和姓名不能为空")
    if payload.password is not None:
        try:
            validate_password(payload.password)
        except PasswordPolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    existing = db.execute(
        select(UserORM).where(UserORM.auth_id == auth_id)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail=f"账号 ID {auth_id} 已存在")
    u = UserORM(
        auth_id=auth_id,
        name=name,
        department=payload.department,
        password_hash=hash_password(payload.password) if payload.password else None,
    )
    db.add(u)
    _audit(db, "admin", "user.create", u.id, {"auth_id": auth_id, "name": name})
    db.commit()
    return _user_admin_dict(u)


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    department: str | None = Field(default=None, max_length=200)


@router.put("/users/{user_id}")
def update_user(user_id: str, payload: UserUpdate, db: Session = Depends(get_db), _=Depends(require_admin)):
    u = db.get(UserORM, user_id)
    if u is None or not u.is_active:
        raise HTTPException(status_code=404, detail="用户不存在")
    if payload.name is not None:
        u.name = payload.name
    if payload.department is not None:
        u.department = payload.department
    _audit(db, "admin", "user.update", user_id, payload.model_dump(exclude_none=True))
    db.commit()
    return _user_admin_dict(u)


class UserResetPassword(BaseModel):
    password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH)


@router.post("/users/{user_id}/reset-password")
def reset_user_password(user_id: str, payload: UserResetPassword, db: Session = Depends(get_db), _=Depends(require_admin)):
    u = db.get(UserORM, user_id)
    if u is None or not u.is_active:
        raise HTTPException(status_code=404, detail="用户不存在")
    try:
        validate_password(payload.password)
    except PasswordPolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    u.password_hash = hash_password(payload.password)
    u.token_version = int(u.token_version or 0) + 1
    _audit(db, "admin", "user.reset_password", user_id)
    db.commit()
    return {"ok": True}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, db: Session = Depends(get_db), _=Depends(require_admin)):
    u = db.get(UserORM, user_id)
    if u is None or not u.is_active:
        raise HTTPException(status_code=404, detail="用户不存在")
    auth_id = u.auth_id
    tombstone = "deleted-" + hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        f"{u.id}:{auth_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:24]

    # 保留不可归属到个人的历史用量，但先吊销密钥并清掉所有姓名/部门/项目快照。
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    key_ids = list(db.execute(
        select(ApiKeyORM.id).where(ApiKeyORM.auth_id == auth_id)
    ).scalars())
    revoked_keys = db.execute(
        update(ApiKeyORM)
        .where(ApiKeyORM.auth_id == auth_id)
        .values(
            auth_id=tombstone,
            name="已注销用户密钥",
            department="",
            project_name="已注销项目",
            project_desc=None,
            revoked=True,
            revoked_at=now,
            application_id=None,
        )
    ).rowcount

    # 明细统计继续保留，但错误详情/响应预览可能含姓名、部门或用户输入内容。
    removed: dict[str, int] = {
        "usageLogContentScrubbed": int(db.execute(
            update(UsageLogORM)
            .where(UsageLogORM.api_key_id.in_(key_ids))
            .values(error_detail=None, response_preview=None)
        ).rowcount or 0) if key_ids else 0,
    }
    for key, model in (
        ("applications", ApplicationORM),
        ("earlyAccess", EarlyAccessApplicationORM),
        ("upgrades", UpgradeApplicationORM),
        ("nightBatches", NightBatchRegistrationORM),
        ("docFeedback", DocFeedbackORM),
    ):
        column = model.creator_auth_id if model is NightBatchRegistrationORM else model.auth_id
        removed[key] = int(db.execute(delete(model).where(column == auth_id)).rowcount or 0)

    # 社区内容可能直接包含个人信息：删除本人帖子/回复/互动。显式清子表，兼容
    # 未启用外键级联的开发 SQLite 与历史数据库。
    post_ids = list(db.execute(
        select(ForumPostORM.id).where(ForumPostORM.author_auth_id == auth_id)
    ).scalars())
    reaction_filter = ForumReactionORM.user_auth_id == auth_id
    reply_filter = ForumReplyORM.author_auth_id == auth_id
    if post_ids:
        reaction_filter = or_(reaction_filter, ForumReactionORM.post_id.in_(post_ids))
        reply_filter = or_(reply_filter, ForumReplyORM.post_id.in_(post_ids))
    removed["forumReactions"] = int(db.execute(
        delete(ForumReactionORM).where(reaction_filter)
    ).rowcount or 0)
    removed["forumReplies"] = int(db.execute(
        delete(ForumReplyORM).where(reply_filter)
    ).rowcount or 0)
    removed["forumPosts"] = int(db.execute(
        delete(ForumPostORM).where(ForumPostORM.author_auth_id == auth_id)
    ).rowcount or 0)

    # 历史审计保留动作语义，但清除用户 ID、姓名与部门。只选中可能相关的行，
    # 避免删除一个用户时扫描并重写整张审计表。
    audit_rows = db.execute(
        select(AuditLogORM).where(or_(
            AuditLogORM.actor == auth_id,
            AuditLogORM.target == user_id,
            AuditLogORM.detail.cast(Text).contains(auth_id),
        ))
    ).scalars().all()
    sensitive = tuple(v for v in (auth_id, u.name, u.department, user_id) if v)

    def _scrub(value):
        if isinstance(value, dict):
            return {k: _scrub(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_scrub(v) for v in value]
        if isinstance(value, str):
            out = value
            for secret_value in sensitive:
                out = out.replace(secret_value, tombstone)
            return out
        return value

    for row in audit_rows:
        if row.actor == auth_id:
            row.actor = tombstone
        if row.target == user_id:
            row.target = tombstone
        row.detail = _scrub(row.detail)

    report_rows = db.execute(
        select(OpsReportORM).where(or_(
            OpsReportORM.summary_md.contains(auth_id),
            OpsReportORM.summary_md.contains(u.name),
            OpsReportORM.metrics.cast(Text).contains(auth_id),
            OpsReportORM.metrics.cast(Text).contains(u.name),
        ))
    ).scalars().all()
    for report in report_rows:
        report.summary_md = _scrub(report.summary_md)
        report.metrics = _scrub(report.metrics)

    # 用户行变成不可逆墓碑：既不会出现在列表，也不保留原账号/姓名/部门；旧 JWT
    # 因原 sub 无法命中活动账号而立即失效。
    u.auth_id = tombstone
    u.name = "已注销用户"
    u.department = None
    u.password_hash = None
    u.is_active = False
    u.token_version = int(u.token_version or 0) + 1
    _audit(db, "admin", "user.delete", tombstone, {"removed": removed, "keysRevoked": revoked_keys})
    db.commit()
    if removed.get("earlyAccess") or revoked_keys:
        invalidate_prepare_cache()  # 名下密钥立刻失去抢先体验准入 / 立刻失效
    return {"ok": True, "keysRevoked": revoked_keys, "removed": removed}


# ── 品牌与组织设置 ─────────────────────────────────────────────────────────

class BrandingConfigIn(BaseModel):
    brand_name: str = Field(min_length=1, max_length=80)
    platform_name: str = Field(min_length=1, max_length=80)
    browser_title: str = Field(min_length=1, max_length=120)
    hero_title: str = Field(min_length=1, max_length=200)
    slogan: str = Field(min_length=1, max_length=200)
    organization_name: str = Field(min_length=1, max_length=120)
    footer_text: str = Field(min_length=1, max_length=200)
    support_department: str = Field(min_length=1, max_length=120)
    support_contact: str = Field(min_length=1, max_length=80)
    support_email: str = Field(min_length=3, max_length=200)
    approval_department: str = Field(min_length=1, max_length=120)
    approval_contact: str = Field(min_length=1, max_length=80)
    approval_email: str = Field(min_length=3, max_length=200)

    @field_validator("*")
    @classmethod
    def validate_display_text(cls, value: str) -> str:
        value = value.strip()
        # 部分品牌字段会进入带内联 HTML 的多语文案，禁止标签边界字符
        # 可以从源头避免管理员误粘贴 HTML 造成存储型 XSS。
        if "<" in value or ">" in value:
            raise ValueError("品牌设置不允许包含 HTML 标签")
        return value

    @field_validator("support_email", "approval_email")
    @classmethod
    def validate_contact_email(cls, value: str) -> str:
        local, sep, domain = value.partition("@")
        if not sep or not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("请填写有效的联系邮箱")
        return value


def _branding_config_dict(c: platform_settings.BrandingConfig) -> dict:
    return {
        "brandName": c.brand_name,
        "platformName": c.platform_name,
        "browserTitle": c.browser_title,
        "heroTitle": c.hero_title,
        "slogan": c.slogan,
        "organizationName": c.organization_name,
        "footerText": c.footer_text,
        "supportDepartment": c.support_department,
        "supportContact": c.support_contact,
        "supportEmail": c.support_email,
        "approvalDepartment": c.approval_department,
        "approvalContact": c.approval_contact,
        "approvalEmail": c.approval_email,
        "updatedAt": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.get("/branding-config")
def get_branding_config(db: Session = Depends(get_db), _=Depends(require_admin)):
    return {"config": _branding_config_dict(platform_settings.get_branding_config(db))}


@router.put("/branding-config")
def upsert_branding_config(
    body: BrandingConfigIn,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    config = platform_settings.BrandingConfig(**body.model_dump())
    platform_settings.save_branding_config(db, config)
    _audit(db, "admin", "branding_config.upsert", "default")
    db.commit()
    return {"config": _branding_config_dict(config)}


# ── Ask Docs 配置 ───────────────────────────────────────────────────────────────────

class AskDocsConfigIn(BaseModel):
    provider: str = "openai"
    model: str = "gpt-4o"
    api_base: str | None = None
    api_key: str | None = None
    system_prompt: str | None = None
    max_tokens: int = 4096
    temperature: float = 0.3
    enabled: bool = False


def _ask_docs_config_dict(c: platform_settings.AskDocsConfig) -> dict:
    return {
        "id": c.id,
        "provider": c.provider,
        "model": c.model,
        "apiBase": c.api_base,
        # 不回传明文密钥：管理端仅需知道是否已配置，凭证以模型注册表为准
        "apiKey": "",
        "systemPrompt": c.system_prompt,
        "maxTokens": c.max_tokens,
        "temperature": c.temperature,
        "enabled": c.enabled,
        "createdAt": c.created_at.isoformat() if c.created_at else None,
        "updatedAt": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.get("/ask-docs-config")
def get_ask_docs_config(db: Session = Depends(get_db), _=Depends(require_admin)):
    config = platform_settings.get_ask_docs_config(db)
    if config is None:
        return {"config": None}
    return {"config": _ask_docs_config_dict(config)}


@router.put("/ask-docs-config")
def upsert_ask_docs_config(body: AskDocsConfigIn, db: Session = Depends(get_db), _=Depends(require_admin)):
    _validate_base_url_scheme(body.api_base, where="api_base")
    existing = platform_settings.get_ask_docs_config(db)
    config = platform_settings.AskDocsConfig(
        **({"id": existing.id} if existing else {}),
        provider=body.provider,
        model=body.model,
        api_base=body.api_base,
        api_key=body.api_key,
        system_prompt=body.system_prompt,
        max_tokens=body.max_tokens,
        temperature=body.temperature,
        enabled=body.enabled,
    )
    platform_settings.save_ask_docs_config(db, config)
    _audit(db, "admin", "ask_docs_config.upsert", config.id)
    db.commit()
    return {"config": _ask_docs_config_dict(config)}
