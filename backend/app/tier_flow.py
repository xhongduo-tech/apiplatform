"""密钥并发档位：三档 preset 的读写与升降级判定（default / high / unlimited）。"""
from __future__ import annotations

from app.config import settings
from app.models import ApiKeyORM

# 用户可见的三档 preset；custom 为历史混档数据的内部归并值，UI 按 default 展示。
USER_TIERS = frozenset({"default", "high", "unlimited"})
UPGRADE_TARGETS = frozenset({"high"})  # 超高并发须正式邮件申请，不走系统提交


def tier_rank(tier: str) -> int:
    return {"default": 0, "custom": 0, "high": 1, "unlimited": 2}.get(tier, 0)


def display_tier(tier: str | None) -> str:
    """前端展示用：仅 default / high / unlimited 三档。"""
    if tier in USER_TIERS:
        return tier
    return "default"


def apply_tier_preset(k: ApiKeyORM, tier: str) -> None:
    """把密钥写成某一 preset 档位（立即生效，调用方负责 commit）。"""
    if tier not in USER_TIERS:
        raise ValueError(f"未知档位 {tier}")
    if tier == "default":
        k.rpm_limit = None
        k.tpm_limit = None
    elif tier == "unlimited":
        k.rpm_limit = -1
        k.tpm_limit = -1
    else:
        k.rpm_limit = settings.RATE_LIMIT_HIGH_RPM
        k.tpm_limit = settings.RATE_LIMIT_HIGH_TPM


def can_downgrade_to(k: ApiKeyORM, target: str) -> tuple[bool, str]:
    if target not in USER_TIERS:
        return False, "目标档位无效"
    current = settings.key_tier(k.rpm_limit, k.tpm_limit)
    if tier_rank(target) >= tier_rank(current):
        return False, "仅支持降至更低档位"
    return True, ""


def can_upgrade_to(k: ApiKeyORM, target: str) -> tuple[bool, str]:
    if target not in UPGRADE_TARGETS:
        return False, "升级目标档位无效"
    current = settings.key_tier(k.rpm_limit, k.tpm_limit)
    if tier_rank(target) <= tier_rank(current):
        return False, "已是该档位或更高，无需升级"
    # 混档且任一维度已高于高并发 preset：升到 high 会把该维度拉低
    if target == "high" and (
        (k.rpm_limit is not None and k.rpm_limit > settings.RATE_LIMIT_HIGH_RPM)
        or (k.tpm_limit is not None and k.tpm_limit > settings.RATE_LIMIT_HIGH_TPM)
    ):
        return False, "该密钥限额已高于高并发预设，无法申请升级至高并发"
    return True, ""
