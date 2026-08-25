"""单 Key 限额三态：写入层归一化 + 策略层解析 + 混档（RPM 无限 / TPM 限额）。

覆盖点在于「同一个数字在两层不能有两种含义」——写入层 0 报 422，策略层 0 才
是无限；以及 RPM/TPM 各自独立三态，混档必须原样保留。
"""
import pytest
from fastapi import HTTPException

from app.config import settings
from app.models import ApiKeyORM
from app.proxy.policy import effective_rate_limits
from app.routers.admin import _RPM_CEILING, _TPM_CEILING, normalize_rate_limit


def _key(rpm=None, tpm=None):
    k = ApiKeyORM(id="k1", name="t", auth_id="a", project_name="p", department="d", models=[])
    k.rpm_limit, k.tpm_limit = rpm, tpm
    return k


def test_normalize_three_states():
    assert normalize_rate_limit(None, "rpm_limit", _RPM_CEILING) is None      # 平台默认
    assert normalize_rate_limit(-1, "rpm_limit", _RPM_CEILING) == -1          # 无限
    assert normalize_rate_limit(-99, "rpm_limit", _RPM_CEILING) == -1         # 任意负数归一
    assert normalize_rate_limit(3_000, "rpm_limit", _RPM_CEILING) == 3_000    # 自定义


def test_normalize_rejects_zero():
    # 0 在策略层是「无限」，若写入层当成「默认」就会静默降速——必须报错而非猜意图
    with pytest.raises(HTTPException) as e:
        normalize_rate_limit(0, "rpm_limit", _RPM_CEILING)
    assert e.value.status_code == 422
    assert "-1" in e.value.detail


def test_normalize_rejects_overflow():
    # rpm_limit 是 int4：超界必须在入口报 422，而不是走到 commit 才 500
    with pytest.raises(HTTPException) as e:
        normalize_rate_limit(_RPM_CEILING + 1, "rpm_limit", _RPM_CEILING)
    assert e.value.status_code == 422
    assert normalize_rate_limit(_TPM_CEILING, "tpm_limit", _TPM_CEILING) == _TPM_CEILING


def test_presets_use_write_layer_semantics():
    # 预设值必须可直接作为 /limits 入参：无限档是 -1，不能是 0
    for p in settings.rate_limit_presets():
        for field in ("rpm", "tpm"):
            assert p[field] != 0, f"{p['key']}.{field} 不能用 0 表示无限"
            assert normalize_rate_limit(p[field], field, _TPM_CEILING) is not None
        if p["unlimited"]:
            assert p["rpm"] == -1 and p["tpm"] == -1


def test_effective_limits_mixed_tier(monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_RPM", 600)
    monkeypatch.setattr(settings, "RATE_LIMIT_TPM", 6_000_000)
    # 混档：RPM 无限（策略层 0=跳过）+ TPM 保留限额，两者互不影响
    assert effective_rate_limits(_key(rpm=-1, tpm=100_000)) == (0, 100_000)
    assert effective_rate_limits(_key(rpm=100, tpm=-1)) == (100, 0)
    assert effective_rate_limits(_key()) == (600, 6_000_000)
