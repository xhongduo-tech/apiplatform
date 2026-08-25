"""鉴权：API key 校验 + 用户/admin JWT。"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from urllib.parse import urlsplit

import jwt
from fastapi import Cookie, Depends, Header, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import ApiKeyORM, UserORM

_ALGO = "HS256"
KEY_PREFIX = settings.API_KEY_PREFIX
_PASSWORD_SCHEME = "pbkdf2_sha256"
_PASSWORD_ITERATIONS = 600_000
_LEGACY_PASSWORD_ITERATIONS = 100_000
_PASSWORD_SALT_BYTES = 16
_PASSWORD_DK_BYTES = 32
PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 128


class PasswordPolicyError(ValueError):
    """密码不满足全平台统一安全策略。"""


def validate_password(password: str) -> None:
    """统一密码规则：12–128 字符，且至少覆盖三类字符。"""
    if not isinstance(password, str):
        raise PasswordPolicyError("密码格式无效")
    if len(password) < PASSWORD_MIN_LENGTH:
        raise PasswordPolicyError(f"密码至少需要 {PASSWORD_MIN_LENGTH} 个字符")
    if len(password) > PASSWORD_MAX_LENGTH:
        raise PasswordPolicyError(f"密码不能超过 {PASSWORD_MAX_LENGTH} 个字符")
    if "\x00" in password:
        raise PasswordPolicyError("密码不能包含空字符")
    classes = sum((
        any(ch.islower() for ch in password),
        any(ch.isupper() for ch in password),
        any(ch.isdigit() for ch in password),
        any(not ch.isalnum() for ch in password),
        any(not ch.isascii() and ch.isalnum() for ch in password),
    ))
    if classes < 3:
        raise PasswordPolicyError(
            "密码需包含大写字母、小写字母、数字、符号、非拉丁文字中的至少三类"
        )


# ── API key ──────────────────────────────────────────────────────────────────
def generate_api_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(32)


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def mask_key_prefix(prefix: str | None) -> str:
    """密钥不落库，仅凭前缀生成掩码展示。"""
    return f"{prefix or KEY_PREFIX}{'•' * 24}"


def normalize_client_auth(authorization: str | None, x_api_key: str | None = None) -> str | None:
    """统一客户端鉴权：OpenAI 风格 Bearer 或 A社 风格 x-api-key。"""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization
    if x_api_key and str(x_api_key).strip():
        return f"Bearer {str(x_api_key).strip()}"
    return None


def validate_api_key(db: Session, authorization: str | None) -> ApiKeyORM:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="缺少 Authorization: Bearer <api_key>")
    raw = authorization.split(" ", 1)[1].strip()
    rec = db.execute(
        select(ApiKeyORM).where(ApiKeyORM.key_hash == hash_key(raw))
    ).scalar_one_or_none()
    if rec is None or rec.revoked or rec.deleted_at is not None:
        raise HTTPException(status_code=401, detail="API key 无效或已吊销")
    return rec


# ── JWT ──────────────────────────────────────────────────────────────────────
def _jwt_base(subject: str, role: str, token_type: str, ttl_hours: int) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "sub": subject,
        "role": role,
        "token_type": token_type,
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(hours=ttl_hours),
        "jti": uuid.uuid4().hex,
    }


def issue_token(subject: str, role: str, extra: dict | None = None) -> str:
    token_type = "admin_session" if role == "admin" else f"{role}_session"
    payload = _jwt_base(subject, role, token_type, settings.JWT_TTL_HOURS)
    reserved = {"sub", "role", "token_type", "iss", "aud", "iat", "exp", "jti"}
    payload.update({k: v for k, v in (extra or {}).items() if k not in reserved})
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=_ALGO)


def decode_token(token: str, expected_type: str | None = None) -> dict:
    try:
        claims = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=[_ALGO],
            audience=settings.JWT_AUDIENCE,
            issuer=settings.JWT_ISSUER,
            options={"require": ["sub", "role", "token_type", "iss", "aud", "iat", "exp", "jti"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="登录态无效或已过期") from exc
    if expected_type is not None and claims.get("token_type") != expected_type:
        raise HTTPException(status_code=401, detail="登录态类型无效")
    return claims


# ── 用户密码（PBKDF2，零额外依赖）─────────────────────────────────────────────
def hash_password(password: str) -> str:
    """生成带算法与迭代次数的密码哈希。

    旧版本只保存 ``base64(salt + digest)``，无法在提高迭代次数后继续验证。
    新格式自描述，后续可平滑升级；``verify_password`` 仍兼容旧格式。
    """
    salt = os.urandom(_PASSWORD_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, _PASSWORD_ITERATIONS,
        dklen=_PASSWORD_DK_BYTES,
    )
    salt_b64 = base64.b64encode(salt).decode("ascii")
    dk_b64 = base64.b64encode(dk).decode("ascii")
    return f"{_PASSWORD_SCHEME}${_PASSWORD_ITERATIONS}${salt_b64}${dk_b64}"


def password_needs_rehash(stored_hash: str | None) -> bool:
    """旧格式或低迭代哈希在下次成功登录时透明升级。"""
    if not stored_hash or not stored_hash.startswith(f"{_PASSWORD_SCHEME}$"):
        return True
    try:
        return int(stored_hash.split("$", 3)[1]) < _PASSWORD_ITERATIONS
    except (IndexError, TypeError, ValueError):
        return True


@lru_cache(maxsize=1)
def dummy_password_hash() -> str:
    """未知/停用账号仍执行同成本 PBKDF2，降低基于响应时延的账号枚举。"""
    return hash_password("Dummy-Password-Only-For-Timing-7!")


def verify_password(password: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    try:
        if stored_hash.startswith(f"{_PASSWORD_SCHEME}$"):
            scheme, iterations_raw, salt_raw, dk_raw = stored_hash.split("$", 3)
            if scheme != _PASSWORD_SCHEME:
                return False
            iterations = int(iterations_raw)
            # 避免恶意/损坏的库值触发超大 PBKDF2 计算造成拒绝服务。
            if not _LEGACY_PASSWORD_ITERATIONS <= iterations <= 5_000_000:
                return False
            salt = base64.b64decode(salt_raw.encode("ascii"), validate=True)
            stored_dk = base64.b64decode(dk_raw.encode("ascii"), validate=True)
            if len(salt) != _PASSWORD_SALT_BYTES or len(stored_dk) != _PASSWORD_DK_BYTES:
                return False
        else:
            # 兼容既有用户密码：base64(16-byte salt + 32-byte digest)，固定 100k 次。
            raw = base64.b64decode(stored_hash.encode("ascii"), validate=True)
            if len(raw) != _PASSWORD_SALT_BYTES + _PASSWORD_DK_BYTES:
                return False
            salt, stored_dk = raw[:_PASSWORD_SALT_BYTES], raw[_PASSWORD_SALT_BYTES:]
            iterations = _LEGACY_PASSWORD_ITERATIONS
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations,
            dklen=len(stored_dk),
        )
        return secrets.compare_digest(dk, stored_dk)
    except (ValueError, TypeError, binascii.Error):
        return False


# ── 用户登录态（账号 ID + 密码成功后签发本地 JWT，role=user）────────────────
def create_user_token(
    auth_id: str,
    name: str,
    department: str | None,
    token_version: int = 0,
) -> dict:
    payload = _jwt_base(auth_id, "user", "user_session", settings.USER_JWT_TTL_HOURS)
    payload.update({
        "name": name,
        "department": department or "",
        "ver": int(token_version),
    })
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=_ALGO)
    return {
        "token": token,
        "expiresIn": settings.USER_JWT_TTL_HOURS * 3600,
        "authId": auth_id,
        "name": name,
        "department": department or "",
    }


def set_user_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.USER_SESSION_COOKIE,
        value=token,
        max_age=settings.USER_JWT_TTL_HOURS * 3600,
        httponly=True,
        secure=settings.SESSION_COOKIE_SECURE,
        samesite="lax",
        path="/api",
    )


def clear_user_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.USER_SESSION_COOKIE,
        path="/api",
        secure=settings.SESSION_COOKIE_SECURE,
        httponly=True,
        samesite="lax",
    )


def set_admin_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.ADMIN_SESSION_COOKIE,
        value=token,
        max_age=settings.JWT_TTL_HOURS * 3600,
        httponly=True,
        secure=settings.SESSION_COOKIE_SECURE,
        samesite="lax",
        path="/api/admin",
    )


def clear_admin_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.ADMIN_SESSION_COOKIE,
        path="/api/admin",
        secure=settings.SESSION_COOKIE_SECURE,
        httponly=True,
        samesite="lax",
    )


def _request_token(authorization: object, session_cookie: object) -> str | None:
    if isinstance(authorization, str) and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    if isinstance(session_cookie, str) and session_cookie.strip():
        return session_cookie.strip()
    return None


def _enforce_cookie_request_origin(
    request: Request | None,
    authorization: object,
    session_cookie: object,
) -> None:
    """Cookie 会话的纵深 CSRF 防护；显式 Bearer 不属于浏览器环境凭据。

    SameSite=Lax 已阻止常规跨站 POST，这里再拒绝浏览器明确报告的跨站来源，
    同时允许未发送 Origin/Sec-Fetch-Site 的旧浏览器和非浏览器兼容客户端。
    """
    if isinstance(authorization, str) and authorization.lower().startswith("bearer "):
        return
    if not isinstance(session_cookie, str) or not session_cookie.strip():
        return
    if request is None or request.method.upper() in {"GET", "HEAD", "OPTIONS", "TRACE"}:
        return

    fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
    if fetch_site in {"cross-site", "same-site"}:
        raise HTTPException(status_code=403, detail="跨站 Cookie 请求已被拒绝")

    origin = request.headers.get("origin", "").strip()
    if origin:
        try:
            origin_host = urlsplit(origin).netloc.casefold()
        except ValueError:
            origin_host = ""
        request_host = request.headers.get("host", "").strip().casefold()
        if not origin_host or not request_host or origin_host != request_host:
            raise HTTPException(status_code=403, detail="跨站 Cookie 请求已被拒绝")


def require_admin(
    request: Request,
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=settings.ADMIN_SESSION_COOKIE),
) -> dict:
    _enforce_cookie_request_origin(request, authorization, session_cookie)
    token = _request_token(authorization, session_cookie)
    if not token:
        raise HTTPException(status_code=401, detail="需要管理员登录")
    claims = decode_token(token)
    if claims.get("role") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    if claims.get("token_type") != "admin_session":
        raise HTTPException(status_code=401, detail="登录态类型无效")
    return claims


def require_recent_admin(claims: dict = Depends(require_admin)) -> dict:
    """高风险动作只接受部署配置窗口内刚完成管理员验证的会话。"""
    try:
        issued_at = float(claims["iat"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="请重新验证管理员密码") from exc
    age = datetime.now(timezone.utc).timestamp() - issued_at
    if age < -60 or age > settings.ADMIN_SENSITIVE_ACTION_MAX_AGE_S:
        raise HTTPException(status_code=401, detail="此操作需要重新验证管理员密码")
    return claims


def validate_user_session(db: Session, token: str) -> dict:
    """JWT 之外再查服务端账号状态/版本，使改密、重置、删除即时失效。"""
    claims = decode_token(token)
    if claims.get("role") != "user":
        raise HTTPException(status_code=403, detail="需要用户登录态")
    if claims.get("token_type") != "user_session":
        raise HTTPException(status_code=401, detail="登录态类型无效")
    user = db.execute(
        select(UserORM).where(UserORM.auth_id == str(claims.get("sub", "")))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="账号已停用或不存在")
    try:
        token_version = int(claims.get("ver", -1))
    except (TypeError, ValueError):
        token_version = -1
    if token_version != int(user.token_version or 0):
        raise HTTPException(status_code=401, detail="登录态已失效，请重新登录")
    # 姓名/部门可能已由管理员修改；端点应看到服务端最新资料，而非旧 JWT 快照。
    claims["name"] = user.name
    claims["department"] = user.department or ""
    return claims


def optional_user_session(
    db: Session,
    authorization: object = None,
    session_cookie: object = None,
) -> dict | None:
    """公开读取端点可选识别登录用户；无效会话按匿名处理。"""
    token = _request_token(authorization, session_cookie)
    if not token:
        return None
    try:
        return validate_user_session(db, token)
    except HTTPException:
        return None


def require_user(
    request: Request,
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=settings.USER_SESSION_COOKIE),
    db: Session = Depends(get_db),
) -> dict:
    """用户登录态。校验 role=user——用户端点一律按 claims["sub"] 当作账号 ID
    去过滤数据，放行别的 role 等于让一个非账号 ID的 sub（如 admin token 的 "admin"）
    走进这套按账号 ID隔离的查询里。管理员要看数据走 /api/admin/*。"""
    _enforce_cookie_request_origin(request, authorization, session_cookie)
    token = _request_token(authorization, session_cookie)
    if not token:
        raise HTTPException(status_code=401, detail="需要登录")
    claims = validate_user_session(db, token)
    if claims.get("role") != "user":
        raise HTTPException(status_code=403, detail="需要用户登录态")
    return claims
