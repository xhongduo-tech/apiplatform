"""管理员首次设密与密码验证。

管理员密码不再来自源码或环境变量。平台首次打开管理页时，管理员输入并确认
一个新密码；这里只持久化不可逆的版本化 PBKDF2 哈希。``platform_settings.key``
的唯一约束同时充当并发初始化的仲裁：多个 worker 同时收到首次登录时，只有一个
写入能成功，其余请求回读胜出的哈希后再按普通登录处理。
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PasswordPolicyError,
    hash_password,
    validate_password,
    verify_password,
)
from app.models import PlatformSettingORM

ADMIN_CREDENTIALS_KEY = "admin_credentials"
ADMIN_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH
ADMIN_PASSWORD_MAX_LENGTH = PASSWORD_MAX_LENGTH


class AdminSetupRequired(ValueError):
    """尚未设置管理员密码，调用方必须提供二次确认。"""


class AdminPasswordPolicyError(ValueError):
    """首次设置的密码不符合安全要求。"""


@dataclass(frozen=True)
class AdminAuthentication:
    authenticated: bool
    initialized_now: bool = False


def _credential_row(db: Session) -> PlatformSettingORM | None:
    return db.get(PlatformSettingORM, ADMIN_CREDENTIALS_KEY)


def _stored_password_hash(row: PlatformSettingORM | None) -> str | None:
    if row is None or not isinstance(row.value, dict):
        return None
    stored_hash = row.value.get("password_hash")
    return stored_hash if isinstance(stored_hash, str) and stored_hash else None


def admin_password_is_initialized(db: Session) -> bool:
    return _stored_password_hash(_credential_row(db)) is not None


def validate_admin_password(password: str) -> None:
    """管理员与普通用户复用同一套密码策略，保留原异常类型供调用方使用。"""
    try:
        validate_password(password)
    except PasswordPolicyError as exc:
        raise AdminPasswordPolicyError(f"管理员{exc}") from exc


def authenticate_or_initialize_admin(
    db: Session,
    password: str,
    password_confirmation: str | None = None,
) -> AdminAuthentication:
    """验证管理员密码；尚未初始化时安全地记录首次输入的密码。

    ``password_confirmation`` 只在首次初始化时需要。若调用方看到的初始化状态已
    过期（另一 worker 刚完成设置），本函数会自动退化为普通密码验证。
    """
    row = _credential_row(db)
    stored_hash = _stored_password_hash(row)
    if stored_hash is not None:
        return AdminAuthentication(verify_password(password, stored_hash))

    if password_confirmation is None:
        raise AdminSetupRequired("管理员尚未初始化，请确认首次设置的密码")
    if not isinstance(password_confirmation, str) or password != password_confirmation:
        raise AdminPasswordPolicyError("两次输入的管理员密码不一致")
    validate_admin_password(password)
    password_hash = hash_password(password)

    # 兼容迁移/异常退出留下的空占位行。加行锁后必须再读一次：等待锁期间另一
    # worker 可能已经完成设置，此时绝不能覆盖胜出的密码。
    if row is not None:
        locked = db.execute(
            select(PlatformSettingORM)
            .where(PlatformSettingORM.key == ADMIN_CREDENTIALS_KEY)
            .with_for_update()
        ).scalar_one()
        winner_hash = _stored_password_hash(locked)
        if winner_hash is not None:
            return AdminAuthentication(verify_password(password, winner_hash))
        locked.value = {"version": 1, "password_hash": password_hash}
        db.commit()
        return AdminAuthentication(authenticated=True, initialized_now=True)

    candidate = PlatformSettingORM(
        key=ADMIN_CREDENTIALS_KEY,
        value={"version": 1, "password_hash": password_hash},
    )
    try:
        # SAVEPOINT 将唯一键竞争限制在局部；失败后 session 仍可回读胜出的记录。
        with db.begin_nested():
            db.add(candidate)
            db.flush()
        db.commit()
        return AdminAuthentication(authenticated=True, initialized_now=True)
    except IntegrityError:
        db.expire_all()
        winner = _credential_row(db)
        stored_hash = _stored_password_hash(winner)
        return AdminAuthentication(
            authenticated=stored_hash is not None and verify_password(password, stored_hash),
        )
