"""抢先体验计划（Early Access）—— 授权名单与模型状态语义。

模型侧零 schema 改动：抢先体验模型就是 model_registry.status == "upcoming"
的模型（该取值原来叫「即将上线」，语义在 2026-07-21 改为「仅授权用户可调用」）。
运营状态因此收敛为三态：上线（online）/ 下线（offline）/ 抢先体验计划（upcoming）,
其余历史取值（maintenance/unstable/exclusive/…）保持原样不受影响。

授权只看 early_access_applications：status == "approved" 才放行。未申请 /
待审批 / 已驳回一律在代理入口被拒，错误文案统一由 DENIED_DETAIL 生成。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import EarlyAccessApplicationORM

#: 抢先体验模型的 model_registry.status 取值（沿用旧「即将上线」枚举，不加列）
EARLY_ACCESS_STATUS = "upcoming"

#: 申请行的状态机。revoked 与 rejected 在鉴权上等价（都不是 approved），
#: 分开只为如实告诉用户「授权被收回」而不是「申请没通过」。
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"
STATUS_REVOKED = "revoked"
#: 非终态：用户可以（重新）提交申请的状态
RESUBMITTABLE = (STATUS_REJECTED, STATUS_REVOKED)


def iso_utc(dt: datetime | None) -> str | None:
    """把库里的 naive UTC 时间序列化为带 Z 的 ISO 串。

    库里存的是 `datetime.now(timezone.utc).replace(tzinfo=None)`——naive UTC。
    直接 .isoformat() 得到的串没有时区后缀，JS `new Date(s)` 会按**本地时区**
    解析，整整差一个时区（admin 表格的 fmtTime 会补 Z 所以正确，用户弹窗直接
    new Date 就错了，同一条记录两个界面对不上）。统一在序列化处补 Z。
    """
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")

#: 用户可见的计划名（错误文案与前端展示保持同一说法）
PROGRAM_NAME = "抢先体验计划"

#: 用户须确认的使用规范/免责协议版本；正文变更时递增，留痕在申请行上
AGREEMENT_VERSION = "v1"


def denied_detail(model_ref: str) -> str:
    """非授权用户调用抢先体验模型时的 403 文案。"""
    return (
        f"模型 {model_ref} 属于{PROGRAM_NAME}，请先行在平台中申请："
        f"登录开放平台后点击右上角姓名 →「{PROGRAM_NAME}」提交申请，"
        "管理员审批通过后即可调用。"
    )


def is_approved(db: Session, auth_id: str | None) -> bool:
    """该账号 ID是否已获抢先体验计划授权。"""
    if not auth_id:
        return False
    status = db.execute(
        select(EarlyAccessApplicationORM.status)
        .where(EarlyAccessApplicationORM.auth_id == auth_id)
    ).scalar_one_or_none()
    return status == "approved"
