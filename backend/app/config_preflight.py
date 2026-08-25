"""Side-effect-free production configuration validation.

The container entrypoint runs this module before it waits for PostgreSQL or
executes Alembic. Importing it must not create an engine, contact a service, or
modify persistent state.
"""
from __future__ import annotations

import logging
import os

from app.config import settings
from app.encrypted_types import data_encryption_key

log = logging.getLogger("apiplatform.config")


def validate_runtime_config() -> None:
    """Reject missing, sample, or internally inconsistent production config."""
    if settings.ENVIRONMENT not in {"development", "test", "production"}:
        raise RuntimeError("ENVIRONMENT 必须是 development、test 或 production")
    if settings.ENVIRONMENT != "production":
        return
    required = (
        "DATABASE_URL", "REDIS_URL", "REDIS_PASSWORD", "JWT_SECRET",
        "DATA_ENCRYPTION_KEY",
    )
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        raise RuntimeError(
            "生产环境缺少必要配置：" + "、".join(missing)
            + "。请从 .env.example 创建 .env 并为每项生成独立随机值。"
        )
    values = {name: os.getenv(name, "").strip() for name in required}
    unsafe_fragments = (
        "replace-with-",
        "change-me",
        "changeme",
        "platform_dev_",
        "platform-dev-only",
        "platform_ci_",
        "platform-test-",
    )
    unsafe = [
        name for name, value in values.items()
        if any(fragment in value.lower() for fragment in unsafe_fragments)
    ]
    if unsafe:
        raise RuntimeError(
            "生产环境检测到示例或开发凭据：" + "、".join(unsafe)
            + "。请为每个部署生成独立随机值。"
        )
    if len(values["JWT_SECRET"]) < 32:
        raise RuntimeError("JWT_SECRET 至少需要 32 个字符")
    # 同时校验 URL-safe base64 格式和解码后的 256-bit 长度。
    data_encryption_key()
    if not settings.ADMIN_BOOTSTRAP_TOKEN:
        log.warning(
            "生产环境未设置 ADMIN_BOOTSTRAP_TOKEN；首次管理员认领仅受回环/反向代理访问边界保护"
        )
    elif len(settings.ADMIN_BOOTSTRAP_TOKEN) < 32:
        raise RuntimeError("ADMIN_BOOTSTRAP_TOKEN 至少需要 32 个字符")
    if not settings.SESSION_COOKIE_SECURE:
        log.warning("SESSION_COOKIE_SECURE=false；接入 HTTPS 后应立即启用 Secure 会话 Cookie")
    if settings.HTTPX_MAX_CONNECTIONS < 1:
        raise RuntimeError("HTTPX_MAX_CONNECTIONS 必须大于 0")
    if not 0 <= settings.HTTPX_MAX_KEEPALIVE <= settings.HTTPX_MAX_CONNECTIONS:
        raise RuntimeError("HTTPX_MAX_KEEPALIVE 必须在 0 与 HTTPX_MAX_CONNECTIONS 之间")
    if not settings.USAGE_FAILOVER_DIR:
        raise RuntimeError("USAGE_FAILOVER_DIR 不能为空")
    if settings.PUBLIC_STATUS_CACHE_TTL_S < 0:
        raise RuntimeError("PUBLIC_STATUS_CACHE_TTL_S 不能为负数")
    if settings.PUBLIC_STATUS_QUERY_TIMEOUT_MS < 100:
        raise RuntimeError("PUBLIC_STATUS_QUERY_TIMEOUT_MS 不能小于 100ms")
    if settings.BACKUP_INTERVAL_S < 60:
        raise RuntimeError("BACKUP_INTERVAL_S 不能小于 60 秒")
    if not 60 <= settings.ADMIN_SENSITIVE_ACTION_MAX_AGE_S <= 3600:
        raise RuntimeError("ADMIN_SENSITIVE_ACTION_MAX_AGE_S 必须在 60–3600 秒之间")
    if not 1 <= settings.JWT_TTL_HOURS <= 24:
        raise RuntimeError("JWT_TTL_HOURS 必须在 1–24 小时之间")
    if not 1 <= settings.USER_JWT_TTL_HOURS <= 24:
        raise RuntimeError("USER_JWT_TTL_HOURS 必须在 1–24 小时之间")


def main() -> None:
    validate_runtime_config()
    print("runtime configuration preflight passed")


if __name__ == "__main__":
    main()
