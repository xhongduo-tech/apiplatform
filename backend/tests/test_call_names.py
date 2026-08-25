"""调用名称清单路由测试。"""
import pytest
from fastapi import HTTPException

from app.models import ModelRegistryORM
from app.proxy.routing import _find_model_record, key_allows_model, model_call_names
from app.routers.admin import _assert_call_names_available


class _FakeKey:
    models: list[str] = []


class _ScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return iter(self._rows)


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows

    def execute(self, _query):
        return _ScalarResult(self._rows)

    def get(self, _cls, model_id: str):
        for row in self._rows:
            if row.id == model_id:
                return row
        return None


def test_model_call_names_reads_snake_and_camel():
    rec = ModelRegistryORM(id="m1", name="m1", provider="", extra={"callNames": ["A", "B"]})
    assert model_call_names(rec) == ["A", "B"]

    rec2 = ModelRegistryORM(id="m2", name="m2", provider="", extra={"call_names": ["X"]})
    assert model_call_names(rec2) == ["X"]


def test_key_allows_model_via_call_name():
    key = _FakeKey()
    key.models = ["qwen3-235b"]
    names = ["Qwen3-235B"]
    assert key_allows_model(key, "qwen3-235b", "Qwen3-235B", names) is True
    # Key 已授权模型 ID 时，任意调用名称均可
    assert key_allows_model(key, "qwen3-235b", "Qwen3-235b-alias", names) is True


def test_key_allows_model_call_name_in_whitelist():
    key = _FakeKey()
    key.models = ["Qwen3-235B"]
    names = ["Qwen3-235B"]
    assert key_allows_model(key, "qwen3-235b", "Qwen3-235B", names) is True


def test_key_allows_model_without_whitelist():
    key = _FakeKey()
    key.models = []
    assert key_allows_model(key, "any", "Any-Alias", ["Any-Alias"]) is True


def test_assert_call_names_ignores_offline_models():
    offline = ModelRegistryORM(
        id="legacy-id",
        name="legacy",
        provider="",
        status="offline",
        extra={"call_names": ["LegacyAlias", "legacy-id"]},
    )
    db = _FakeDB([offline])
    _assert_call_names_available(db, "new-model", ["LegacyAlias", "legacy-id"])


def test_assert_call_names_blocks_online_models():
    online = ModelRegistryORM(
        id="active",
        name="active",
        provider="",
        status="online",
        extra={"call_names": ["TakenAlias"]},
    )
    db = _FakeDB([online])
    with pytest.raises(HTTPException) as exc:
        _assert_call_names_available(db, "new-model", ["TakenAlias"])
    assert "已被模型 active 使用" in exc.value.detail


def test_find_model_record_skips_offline_call_names():
    offline = ModelRegistryORM(
        id="legacy",
        name="legacy",
        provider="",
        status="offline",
        extra={"call_names": ["SharedAlias"]},
    )
    online = ModelRegistryORM(
        id="current",
        name="current",
        provider="",
        status="online",
        extra={"call_names": ["SharedAlias"]},
    )
    db = _FakeDB([offline, online])
    assert _find_model_record(db, "SharedAlias") is online
