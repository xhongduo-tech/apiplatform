#!/usr/bin/env python3
"""把旧库（apiplatform_old_import，迁移 003 时代 schema）的全量历史数据转换导入新平台
（openapi_platform，当前 schema）。

字段变换：
- api_keys   ：删 qps_tier/concurrency_cap/priority_weight/ip_whitelist/allowed_hours/
                monthly_token_limit；qps_tier→rpm_limit/tpm_limit（standard=平台默认，
                high=高并发预设）；scene_type='explore'；api_key 明文不落库（恒 None）。
- model_registry：以旧配置为准 upsert（COALESCE 保留目录展示字段）；旧→新目录重命名对
                （deepseek-v4-think→deepseek-v4-reasoner、glm-5.2-safety→glm-5.2）
                把旧配置复制到新目录 id；登记 catalog_seeded_ids。
- usage_logs ：删 queue_wait_ms/tier；补 request_id=NULL、usage_estimated=false、stream=false。
- applications：旧库为空表，跳过。
- users / forum_* / notifications / audit_logs / ops_reports / research_articles：列一致直拷。

用法：ENVIRONMENT=development 下执行（脚本用 127.0.0.1 连接，勿在生产直连）。
"""
from __future__ import annotations

import os
import sys

from sqlalchemy import create_engine, text

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("REDIS_REQUIRED_ON_STARTUP", "false")
OLD_URL = os.environ.get("OLD_DB_URL", "").strip()
NEW_URL = os.environ.get("DATABASE_URL", "").strip()
if not OLD_URL or not NEW_URL:
    raise SystemExit("必须显式设置 OLD_DB_URL 与 DATABASE_URL；脚本不再内置数据库凭据")

old = create_engine(OLD_URL)
new = create_engine(NEW_URL)

# 旧 qps_tier → 新 rpm/tpm（high 对齐新平台「高并发」预设，standard/空=平台默认）
_HIGH_RPM, _HIGH_TPM = 3000, 60_000_000
_RENAMES = {
    "deepseek-v4-reasoner": "deepseek-v4-think",
    "glm-5.2": "glm-5.2-safety",
}

# model_registry 配置类字段（旧为权威）；展示类字段用 COALESCE 保留目录内容
_MODEL_CFG_FIELDS = (
    "base_url", "api_key", "model_api_name", "import_format",
    "custom_headers", "extra", "pricing_input", "pricing_output", "resolve_to_model_id",
)
_MODEL_ALL_FIELDS = (
    "id", "name", "provider", "short_desc", "description", "readme", "context_window",
    "status", "category", "speed", "base_url", "api_key", "model_api_name", "import_format",
    "custom_headers", "extra", "pricing_input", "pricing_output", "resolve_to_model_id",
    "updated_at",
)


def _rows(engine, sql: str):
    with engine.connect() as c:
        yield from c.execute(text(sql)).mappings().all()


def load_users() -> None:
    rows = list(_rows(old, "SELECT id, auth_id, name, department, password_hash, created_at FROM users"))
    if not rows:
        print("users: 0 行，跳过")
        return
    with new.begin() as c:
        c.execute(
            text(
                "INSERT INTO users (id, auth_id, name, department, password_hash, created_at) "
                "VALUES (:id, :auth_id, :name, :department, :password_hash, :created_at) "
                "ON CONFLICT DO NOTHING"
            ),
            [dict(r) for r in rows],
        )
    print(f"users: 导入 {len(rows)} 行")


def load_api_keys() -> None:
    sql = (
        "SELECT id, name, auth_id, project_name, project_desc, department, models, "
        "key_hash, key_prefix, granted_at, revoked, revoked_at, deleted_at, created_at, "
        "application_id, qps_tier FROM api_keys"
    )
    rows = list(_rows(old, sql))
    if not rows:
        print("api_keys: 0 行，跳过")
        return
    out = []
    for r in rows:
        tier = (r["qps_tier"] or "").strip().lower()
        out.append({
            "id": r["id"], "name": r["name"], "auth_id": r["auth_id"],
            "project_name": r["project_name"], "project_desc": r["project_desc"],
            "department": r["department"], "scene_type": "explore",
            "models": r["models"], "api_key": None,  # 明文绝不落库
            "key_hash": r["key_hash"], "key_prefix": r["key_prefix"],
            "granted_at": r["granted_at"], "revoked": r["revoked"],
            "revoked_at": r["revoked_at"], "deleted_at": r["deleted_at"],
            "created_at": r["created_at"], "application_id": r["application_id"],
            "rpm_limit": _HIGH_RPM if tier == "high" else None,
            "tpm_limit": _HIGH_TPM if tier == "high" else None,
        })
    with new.begin() as c:
        c.execute(
            text(
                "INSERT INTO api_keys (id, name, auth_id, project_name, project_desc, "
                "department, scene_type, models, api_key, key_hash, key_prefix, granted_at, "
                "revoked, revoked_at, deleted_at, created_at, application_id, rpm_limit, tpm_limit) "
                "VALUES (:id, :name, :auth_id, :project_name, :project_desc, :department, "
                ":scene_type, :models, :api_key, :key_hash, :key_prefix, :granted_at, :revoked, "
                ":revoked_at, :deleted_at, :created_at, :application_id, :rpm_limit, :tpm_limit) "
                "ON CONFLICT DO NOTHING"
            ),
            out,
        )
    print(f"api_keys: 导入 {len(out)} 行（high→{_HIGH_RPM}/{_HIGH_TPM}，standard→平台默认）")


def _upsert_models(rows: list[dict], *, config_only: bool = False) -> None:
    """把模型行 upsert 进新库。

    config_only=True 时（重命名对）只覆盖配置类字段、保留目标行的目录展示字段。
    """
    if not rows:
        return
    cols = list(_MODEL_ALL_FIELDS)
    set_clauses = []
    for col in cols:
        if col == "id":
            continue
        if config_only and col not in _MODEL_CFG_FIELDS:
            continue
        if col in _MODEL_CFG_FIELDS or col in ("name", "provider", "status", "category", "speed"):
            set_clauses.append(f"{col} = EXCLUDED.{col}")
        else:
            # 可空展示字段：旧有则用旧的，否则保留目录已有内容（readme/描述等）
            set_clauses.append(f"{col} = COALESCE(EXCLUDED.{col}, model_registry.{col})")
    placeholders = ", ".join(f":{col}" for col in cols)
    stmt = text(
        f"INSERT INTO model_registry ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT (id) DO UPDATE SET {', '.join(set_clauses)}"
    )
    with new.begin() as c:
        c.execute(stmt, [{col: r.get(col) for col in cols} for r in rows])


def load_model_registry() -> None:
    sql = "SELECT * FROM model_registry"
    old_rows = list(_rows(old, sql))
    # 1) 旧模型全量导入（含配置 + 展示；extra 已含 endpoints）
    _upsert_models(old_rows)
    print(f"model_registry: 导入旧模型 {len(old_rows)} 行")
    # 2) 重命名对：把旧配置复制到新目录 id（保留目标行目录展示字段）
    extra_rows = []
    for target, source in _RENAMES.items():
        src = next((r for r in old_rows if r["id"] == source), None)
        if src is None:
            print(f"  警告：重命名源 {source} 不存在，跳过 {target}")
            continue
        row = dict(src)
        row["id"] = target
        extra_rows.append(row)
    if extra_rows:
        _upsert_models(extra_rows, config_only=True)
        print(f"model_registry: 重命名对复制配置 {[r['id'] for r in extra_rows]}")
    # 3) 登记 catalog_seeded_ids（含全部导入 id），防止重启目录 seed 重复插入
    all_ids = {r["id"] for r in old_rows} | {r["id"] for r in extra_rows}
    with new.begin() as c:
        c.execute(
            text("INSERT INTO catalog_seeded_ids (model_id) VALUES (:id) ON CONFLICT DO NOTHING"),
            [{"id": i} for i in sorted(all_ids)],
        )
    print(f"catalog_seeded_ids: 登记 {len(all_ids)} 个模型 id")


def load_usage_logs() -> None:
    """89 万行：分块 executemany，避免一次性占内存。"""
    cols = (
        "id, api_key_id, model_id, prompt_tokens, completion_tokens, total_tokens, "
        "cache_hit_tokens, cache_miss_tokens, cache_write_tokens, latency_ms, "
        "total_duration_ms, status_code, created_at, error_detail, response_preview, "
        "estimated_cost, request_id, usage_estimated, stream"
    )
    ins = text(
        f"INSERT INTO usage_logs ({cols}) VALUES "
        f"(:id, :api_key_id, :model_id, :prompt_tokens, :completion_tokens, :total_tokens, "
        f":cache_hit_tokens, :cache_miss_tokens, :cache_write_tokens, :latency_ms, "
        f":total_duration_ms, :status_code, :created_at, :error_detail, :response_preview, "
        f":estimated_cost, :request_id, :usage_estimated, :stream) ON CONFLICT DO NOTHING"
    )
    chunk: list[dict] = []
    total = 0
    _CHUNK = 5000
    with old.connect() as oc, new.begin() as nc:
        for r in oc.execute(text(
            "SELECT id, api_key_id, model_id, prompt_tokens, completion_tokens, total_tokens, "
            "cache_hit_tokens, cache_miss_tokens, cache_write_tokens, latency_ms, "
            "total_duration_ms, status_code, created_at, error_detail, response_preview, "
            "estimated_cost FROM usage_logs"
        )):
            chunk.append({
                "id": r.id, "api_key_id": r.api_key_id, "model_id": r.model_id,
                "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
                "total_tokens": r.total_tokens, "cache_hit_tokens": r.cache_hit_tokens,
                "cache_miss_tokens": r.cache_miss_tokens, "cache_write_tokens": r.cache_write_tokens,
                "latency_ms": r.latency_ms, "total_duration_ms": r.total_duration_ms,
                "status_code": r.status_code, "created_at": r.created_at,
                "error_detail": r.error_detail, "response_preview": r.response_preview,
                "estimated_cost": r.estimated_cost,
                "request_id": None, "usage_estimated": False, "stream": False,
            })
            if len(chunk) >= _CHUNK:
                nc.execute(ins, chunk)
                total += len(chunk)
                chunk.clear()
        if chunk:
            nc.execute(ins, chunk)
            total += len(chunk)
    print(f"usage_logs: 导入 {total} 行")


# ── 小表直拷 ────────────────────────────────────────────────────────────────
_SIMPLE_TABLES = {
    "forum_posts": "id, author_auth_id, author_name, title, content, pinned, resolved, view_count, created_at",
    "forum_replies": "id, post_id, author_auth_id, author_name, is_admin, content, created_at",
    "forum_likes": "id, post_id, user_auth_id, created_at",
    "forum_follows": "id, post_id, user_auth_id, created_at",
    "notifications": "id, type, title, body, created_at",
    "audit_logs": "id, actor, action, target, detail, created_at",
    "ops_reports": "id, kind, period_start, period_end, label, health, summary_md, metrics, generated_at, created_at",
    "research_articles": "id, title, summary, body_md, tags, author, published, published_at, created_at",
}


def load_simple_tables() -> None:
    for table, cols in _SIMPLE_TABLES.items():
        try:
            rows = list(_rows(old, f"SELECT {cols} FROM {table}"))
        except Exception as exc:
            print(f"{table}: 读取失败，跳过（{exc}）")
            continue
        if not rows:
            print(f"{table}: 0 行")
            continue
        placeholders = ", ".join(f":{c.split(' ')[0]}" for c in cols.split(", "))
        stmt = text(
            f"INSERT INTO {table} ({cols}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
        )
        with new.begin() as c:
            c.execute(stmt, [dict(r) for r in rows])
        print(f"{table}: 导入 {len(rows)} 行")


def main() -> None:
    load_users()
    load_api_keys()
    load_model_registry()
    load_simple_tables()   # 小表先于 usage_logs 无依赖；forum 表顺序已在 dict 中保证 posts 在前
    load_usage_logs()
    print("✔ 全部导入完成")


if __name__ == "__main__":
    sys.exit(main())
