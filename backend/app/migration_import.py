"""从 CSV 导入 users / api_keys（旧版 llm_platform → 新版 api_platform，不改表结构）。"""
from __future__ import annotations

import csv
import io
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import KEY_PREFIX, hash_key
from app.models import ApiKeyORM, UserORM

_USER_HEADERS = {
    "id": "id",
    "auth_id": "auth_id",
    "authid": "auth_id",
    "账号 ID": "auth_id",
    "认证号": "auth_id",
    "name": "name",
    "姓名": "name",
    "department": "department",
    "部门": "department",
    "password_hash": "password_hash",
    "passwordhash": "password_hash",
    "密码哈希": "password_hash",
    "created_at": "created_at",
    "createdat": "created_at",
    "创建时间": "created_at",
}

_KEY_HEADERS = {
    "id": "id",
    "name": "name",
    "姓名": "name",
    "auth_id": "auth_id",
    "authid": "auth_id",
    "账号 ID": "auth_id",
    "认证号": "auth_id",
    "project_name": "project_name",
    "projectname": "project_name",
    "项目名称": "project_name",
    "项目": "project_name",
    "project_desc": "project_desc",
    "projectdesc": "project_desc",
    "需求描述": "project_desc",
    "department": "department",
    "部门": "department",
    "models": "models",
    "api_key": "api_key",
    "apikey": "api_key",
    "key_hash": "key_hash",
    "keyhash": "key_hash",
    "key_prefix": "key_prefix",
    "keyprefix": "key_prefix",
    "granted_at": "granted_at",
    "grantedat": "granted_at",
    "授权日期": "granted_at",
    "授权时间": "granted_at",
    "revoked": "revoked",
    "revoked_at": "revoked_at",
    "revokedat": "revoked_at",
    "created_at": "created_at",
    "createdat": "created_at",
    "application_id": "application_id",
    "applicationid": "application_id",
    # ip_whitelist / allowed_hours 已整体移除（改由 RPM/TPM 数值预设 + 夜间不限流窗口覆盖）；
    # 旧 CSV 中该列会被自动忽略
    # monthly_token_limit 已随月度配额移除；旧 CSV 中该列会被自动忽略
    # 限额与场景分类：None=平台默认，-1=无限，>0=该值；0 按写入层语义回落平台默认
    "rpm_limit": "rpm_limit",
    "rpm": "rpm_limit",
    "每分钟请求数": "rpm_limit",
    "tpm_limit": "tpm_limit",
    "tpm": "tpm_limit",
    "每分钟token数": "tpm_limit",
    "每分钟Token数": "tpm_limit",
    "scene_type": "scene_type",
    "scenetype": "scene_type",
    "业务场景": "scene_type",
    "场景": "scene_type",
    "deleted_at": "deleted_at",
    "deletedat": "deleted_at",
    "状态": "revoked",
    "status": "revoked",
}


def _norm_header(raw: str) -> str:
    key = (raw or "").strip().lower().replace("\ufeff", "")
    key = key.replace(" ", "_")
    return key


def _map_row(raw_row: dict[str, str], mapping: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in raw_row.items():
        canon = mapping.get(_norm_header(k))
        if canon:
            out[canon] = (v or "").strip()
    return out


def _parse_bool(val: str | None) -> bool:
    if val is None or val == "":
        return False
    return val.strip().lower() in ("1", "true", "t", "yes", "y", "已吊销", "已撤销", "是", "revoked")


def _parse_int(val: str | None) -> int | None:
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return None


def _parse_dt(val: str | None) -> datetime | None:
    """解析时间戳；支持 ISO8601 带时区（Z / ±HH:MM / ±HHMM）与裸日期。

    统一转为 **UTC naive** 存库（与 ORM 的 _now() 口径一致）。旧实现把字符串
    截到 26 字符，`+00:00`/`+08:00` 后缀被截掉导致 strptime 恒失败、历史时间
    被静默丢弃回落到「现在」——这里先走 fromisoformat 吃掉时区，再回落裸格式。
    """
    if not val or not val.strip():
        return None
    text = val.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        dt = None
    if dt is None:
        # 空格分隔的裸格式（Excel 常见）；微秒位数不限，取前 19 字符即可
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(text[:19], fmt)
                break
            except ValueError:
                continue
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _is_sha256_hex(val: str) -> bool:
    """key_hash 必须是 sha256 的 64 位十六进制，否则鉴权（hash_key=sha256 明文）
    永远对不上，导入的 key 会变成报表显示 inserted、实际全部 401 的死 key。"""
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", val))


def _parse_json_list(val: str | None) -> list:
    if val is None or val == "" or val.strip() in ("[]", "null", "NULL"):
        return []
    text = val.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return [p.strip() for p in text.split(",") if p.strip()]


def _read_csv_rows(content: bytes) -> list[dict[str, str]]:
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return []
    return [dict(row) for row in reader]


def import_users_csv(db: Session, content: bytes, *, skip_existing: bool = True) -> dict[str, Any]:
    rows = _read_csv_rows(content)
    inserted = skipped = errors = 0
    error_samples: list[str] = []

    for i, raw in enumerate(rows, start=2):
        row = _map_row(raw, _USER_HEADERS)
        auth_id = row.get("auth_id", "")
        name = row.get("name", "")
        if not auth_id or not name:
            errors += 1
            if len(error_samples) < 5:
                error_samples.append(f"第 {i} 行：缺少 auth_id 或 name")
            continue

        existing = db.execute(
            select(UserORM).where(UserORM.auth_id == auth_id)
        ).scalar_one_or_none()
        if existing:
            if skip_existing:
                skipped += 1
                continue
            existing.name = name
            existing.department = row.get("department") or existing.department
            if row.get("password_hash"):
                if existing.password_hash != row["password_hash"]:
                    existing.password_hash = row["password_hash"]
                    existing.token_version = int(existing.token_version or 0) + 1
            continue

        uid = row.get("id") or None
        if uid and db.get(UserORM, uid):
            skipped += 1
            continue

        user = UserORM(
            id=uid or str(uuid.uuid4()),
            auth_id=auth_id,
            name=name,
            department=row.get("department") or None,
            password_hash=row.get("password_hash") or None,
        )
        created = _parse_dt(row.get("created_at"))
        if created:
            user.created_at = created
        db.add(user)
        inserted += 1

    return {
        "table": "users",
        "total_rows": len(rows),
        "inserted": inserted,
        "skipped": skipped,
        "errors": errors,
        "error_samples": error_samples,
    }


def import_api_keys_csv(db: Session, content: bytes, *, skip_existing: bool = True) -> dict[str, Any]:
    """导入 api_keys CSV。

    修复要点（2026-08 审计）：
    - rpm_limit / tpm_limit / scene_type 三个字段此前被静默丢弃，导入后所有 key
      都回落平台默认档 + 场景全变 explore。现在正确映射：None=平台默认、-1=无限、
      >0=该值、0 按写入层语义回落默认。
    - 明文密钥绝不落库（api_key 列恒为 None，与「明文仅创建时一次性返回」的设计
      一致），只存 sha256 key_hash 与前缀；库/备份泄露不再等于全量密钥泄露。
    - key_hash 必须校验为 sha256 的 64 位十六进制：旧平台若用 MD5/自定义哈希，
      导入后鉴权（sha256(明文)）永远对不上，报表显示 inserted 实际全是死 key。
      优先用明文推导哈希（鉴权同源），CSV 自带哈希只在无明文且确为 sha256 时采用。
    - 时区时间戳（Z / ±HH:MM）经 _parse_dt 正常解析为 UTC，历史时间不再丢失。
    - skip_existing 参数此前是死代码（已存在 key 一律跳过），现在按语义生效：
      True=跳过，False=更新已存在 key 的展示/限额/吊销字段。
    """
    rows = _read_csv_rows(content)
    inserted = updated = skipped = errors = 0
    error_samples: list[str] = []

    for i, raw in enumerate(rows, start=2):
        row = _map_row(raw, _KEY_HEADERS)
        auth_id = row.get("auth_id", "")
        project_name = row.get("project_name", "")
        department = row.get("department", "")
        name = row.get("name") or project_name or auth_id
        if not auth_id or not project_name:
            errors += 1
            if len(error_samples) < 5:
                error_samples.append(f"第 {i} 行：缺少 auth_id 或 project_name")
            continue

        key_id = row.get("id") or None
        api_key_val = row.get("api_key") or None
        hash_from_csv = row.get("key_hash") or None

        # 鉴权恒为 sha256(明文)：有明文就用明文推导（最可靠），仅无明文时才采信
        # CSV 自带哈希，且该哈希必须确实是 sha256，否则是旧格式死 key，直接报错。
        if api_key_val:
            key_hash_val = hash_key(api_key_val)
        elif hash_from_csv and _is_sha256_hex(hash_from_csv):
            key_hash_val = hash_from_csv
        elif hash_from_csv:
            errors += 1
            if len(error_samples) < 5:
                error_samples.append(
                    f"第 {i} 行：key_hash 不是 sha256（64 位十六进制），导入后密钥无法鉴权。"
                    f" 请提供明文 api_key，或导出 sha256 key_hash"
                )
            continue
        else:
            errors += 1
            if len(error_samples) < 5:
                error_samples.append(f"第 {i} 行：缺少 api_key 或合法 sha256 key_hash")
            continue

        existing_by_hash = db.execute(
            select(ApiKeyORM).where(ApiKeyORM.key_hash == key_hash_val)
        ).scalar_one_or_none()

        # skip_existing=False：按 hash 命中已存在 key → 就地更新，不重复插入
        if existing_by_hash is not None:
            if skip_existing:
                skipped += 1
                continue
            _apply_key_fields(existing_by_hash, row, name, department, project_name)
            updated += 1
            continue

        if key_id:
            existing_by_id = db.get(ApiKeyORM, key_id)
            if existing_by_id is not None:
                # id 冲突但 hash 不同（同 id 不同密钥）：无法归并，跳过
                skipped += 1
                continue

        prefix = row.get("key_prefix") or None
        if not prefix and api_key_val:
            prefix = api_key_val[: len(KEY_PREFIX) + 6]

        models = _parse_json_list(row.get("models"))
        scene_type = row.get("scene_type") or "explore"

        key = ApiKeyORM(
            name=name,
            auth_id=auth_id,
            project_name=project_name,
            project_desc=row.get("project_desc") or None,
            department=department or "",
            scene_type=scene_type,
            models=models,
            api_key=None,  # 明文绝不落库
            key_hash=key_hash_val,
            key_prefix=prefix,
            rpm_limit=_parse_limit(row.get("rpm_limit")),
            tpm_limit=_parse_limit(row.get("tpm_limit")),
            revoked=_parse_bool(row.get("revoked")),
            application_id=row.get("application_id") or None,
        )
        if key_id:
            key.id = key_id
        granted = _parse_dt(row.get("granted_at"))
        if granted:
            key.granted_at = granted
        revoked_at = _parse_dt(row.get("revoked_at"))
        if revoked_at:
            key.revoked_at = revoked_at
        created = _parse_dt(row.get("created_at"))
        if created:
            key.created_at = created
        deleted = _parse_dt(row.get("deleted_at"))
        if deleted:
            key.deleted_at = deleted

        db.add(key)
        inserted += 1

    return {
        "table": "api_keys",
        "total_rows": len(rows),
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "error_samples": error_samples,
    }


def _parse_limit(val: str | None) -> int | None:
    """限额列解析：空/0 回落平台默认(None)；-1 保留为无限；其余取正整数值。

    与 config.py rate_limit_presets 的写入层语义一致：0 在旧 UI 曾表示无限，
    但写入层 0=回落默认，照字面导入会把「无限」静默降成默认档，故统一归 None。
    """
    n = _parse_int(val)
    if n is None or n == 0:
        return None
    return n


def _apply_key_fields(
    key: ApiKeyORM, row: dict[str, str], name: str, department: str, project_name: str
) -> None:
    """skip_existing=False 时按 CSV 行就地更新已存在 key 的业务字段。"""
    key.name = name
    key.project_name = project_name
    key.department = department or key.department
    key.project_desc = row.get("project_desc") or key.project_desc
    models = _parse_json_list(row.get("models"))
    if models:
        key.models = models
    scene_type = row.get("scene_type")
    if scene_type:
        key.scene_type = scene_type
    rpm = _parse_limit(row.get("rpm_limit"))
    tpm = _parse_limit(row.get("tpm_limit"))
    if rpm is not None:
        key.rpm_limit = rpm
    if tpm is not None:
        key.tpm_limit = tpm
    key.revoked = _parse_bool(row.get("revoked"))
    for col in ("granted_at", "revoked_at", "created_at", "deleted_at"):
        parsed = _parse_dt(row.get(col))
        if parsed:
            setattr(key, col, parsed)
