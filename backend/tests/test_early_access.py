"""抢先体验计划准入闸门单测。

status=upcoming 的模型对未授权用户一律 403（且文案要能指引去申请），对已授权
用户则完全等同普通在线模型；抢先体验模型不得被当成虚拟模型对齐目标或兜底目标
（否则等于绕过授权）。
"""
import pytest
from fastapi import HTTPException

from app.early_access import (
    EARLY_ACCESS_STATUS, RESUBMITTABLE, STATUS_APPROVED, STATUS_REJECTED,
    STATUS_REVOKED, denied_detail, iso_utc,
)
from app.models import ApiKeyORM, ModelRegistryORM
from app.proxy import db_bridge
from app.proxy.routing import (
    is_callable, is_early_access, resolve_fallback_target,
)


def _model(status: str = EARLY_ACCESS_STATUS) -> ModelRegistryORM:
    return ModelRegistryORM(
        id="glm-5.2", name="GLM-5.2", provider="智谱AI", status=status,
        category="flagship", base_url="http://cluster-a:8000",
        model_api_name="GLM-5.2", import_format="openai",
    )


@pytest.fixture
def gate(monkeypatch):
    """把 _prepare_sync 的外部依赖全部换成可控桩，只留闸门逻辑本身。"""
    state = {"approved": False, "model": _model()}
    key = ApiKeyORM(id="k1", name="k", auth_id="u001", project_name="p", department="d", models=[])

    monkeypatch.setattr(db_bridge, "SessionLocal", lambda: _FakeSession())
    monkeypatch.setattr(db_bridge, "validate_api_key", lambda db, auth: key)
    monkeypatch.setattr(db_bridge, "find_model_record", lambda db, ref: state["model"])
    monkeypatch.setattr(db_bridge, "is_approved", lambda db, auth_id: state["approved"])
    monkeypatch.setattr(db_bridge, "resolve_fallback_target", lambda db, m: None)
    return state


class _FakeSession:
    def close(self):
        pass


def test_unapproved_user_is_rejected(gate):
    with pytest.raises(HTTPException) as exc:
        db_bridge._prepare_sync("Bearer k", "glm-5.2")
    assert exc.value.status_code == 403
    assert "抢先体验计划" in exc.value.detail
    assert "申请" in exc.value.detail


def test_approved_user_passes(gate):
    gate["approved"] = True
    key, model, resolved_id, fb = db_bridge._prepare_sync("Bearer k", "glm-5.2")
    assert model.id == "glm-5.2"
    assert resolved_id is None and fb is None


def test_gate_precedes_deploy_config_check(gate):
    """未配置接入的抢先体验模型，未授权用户应看到「请先申请」而非平台内部 503。"""
    gate["model"] = _model()
    gate["model"].base_url = None
    with pytest.raises(HTTPException) as exc:
        db_bridge._prepare_sync("Bearer k", "glm-5.2")
    assert exc.value.status_code == 403


def test_online_model_untouched_by_gate(gate):
    gate["model"] = _model(status="online")
    _key, model, _rid, _fb = db_bridge._prepare_sync("Bearer k", "glm-5.2")
    assert model.status == "online"


def test_denied_detail_names_the_model():
    assert "glm-5.2" in denied_detail("glm-5.2")


def test_iso_utc_marks_the_zone():
    """naive UTC 不补 Z 的话，前端 new Date() 会按本地时区解析，整整差一个时区。"""
    from datetime import datetime

    assert iso_utc(datetime(2026, 7, 22, 0, 51, 57)) == "2026-07-22T00:51:57Z"
    assert iso_utc(None) is None


def test_revoked_is_not_approved():
    """撤销后鉴权必须立刻失效——revoked 与 rejected 在闸门前等价。"""
    assert STATUS_REVOKED != STATUS_REJECTED          # 但对用户是两种说法
    assert STATUS_REVOKED not in (STATUS_APPROVED,)
    assert STATUS_REVOKED in RESUBMITTABLE            # 被收回后可重新申请
    assert STATUS_REJECTED in RESUBMITTABLE


def test_status_predicates():
    assert is_early_access(_model()) and is_callable(_model())
    assert not is_early_access(_model(status="online"))
    assert not is_callable(_model(status="offline"))


def test_early_access_model_is_not_a_valid_fallback_target(monkeypatch):
    """兜底目标只认正式上线模型——否则未授权用户会经由兜底打进抢先体验模型。"""
    source = _model(status="online")
    source.id = "deepseek-v4"
    source.extra = {"fallback": {"target_model_id": "glm-5.2", "enabled": True}}
    monkeypatch.setattr(
        "app.proxy.routing._find_model_by_id", lambda db, mid: _model()
    )
    assert resolve_fallback_target(None, source) is None
