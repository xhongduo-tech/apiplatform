"""预装模型目录的写入语义：空库引导，而非每次启动强制对齐。

seed 若无条件重写已有行，管理员的后台改动和迁移导入的模型信息，
都会在下一次重启/版本更新时被静默还原。这里用假 Session 锁死该行为。

同时锁死另一条更容易被忽视的语义：管理员删除/改名过的模型不会被复活。
只看 "model_registry 里当前有没有这个 id" 不够；已删除的演示 id 不能在
下次启动时被重新插入。
"""
from __future__ import annotations

import pytest

from app import catalog_seed
from app.catalog_seed import seed_catalog_models


class _Row:
    """够用的 ModelRegistryORM 替身：只需支持属性读写。"""

    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakeSession:
    def __init__(self, existing: dict[str, _Row] | None = None, seeded_ids: set[str] | None = None):
        self.rows = dict(existing or {})
        self.seeded_ids = set(seeded_ids or ())
        self.added: list = []

    def get(self, _model, pk):
        return self.rows.get(pk)

    def add(self, obj):
        self.added.append(obj)

    def execute(self, _stmt):
        return [(mid,) for mid in self.seeded_ids]

    @property
    def added_model_ids(self) -> list[str]:
        """本次新插入 model_registry 的 id（排除 catalog_seeded_ids 标记行）。"""
        return [o.id for o in self.added if hasattr(o, "id")]

    @property
    def added_marker_ids(self) -> list[str]:
        """本次新增的 catalog_seeded_ids 标记（排除 model_registry 行）。"""
        return [o.model_id for o in self.added if hasattr(o, "model_id") and not hasattr(o, "id")]


@pytest.fixture
def one_model(monkeypatch):
    """把目录裁剪成单个模型，避免依赖完整演示目录。"""
    spec = {
        "id": "m1",
        "name": "代码里的名字",
        "short_desc": "代码里的描述",
        "context_window": "32K",
        "import_format": "openai",
        "status": "online",
    }
    monkeypatch.setattr(catalog_seed, "CATALOG_MODELS", [spec])
    return spec


def test_inserts_when_never_seeded_before(one_model):
    """空库引导：从未插过、库里也没有，才插入——这是 seed 唯一该做的写入。"""
    db = _FakeSession()
    seed_catalog_models(db)

    assert db.added_model_ids == ["m1"]
    assert db.added_marker_ids == ["m1"], "插入的同时必须登记到 catalog_seeded_ids"


def test_does_not_touch_existing_row(one_model):
    """已存在的行一律不动——库是权威来源。

    这正是生产导入场景：库里 context_window=256K 是真实值，
    代码常量里的 32K 不能把它盖掉。
    """
    row = _Row(id="m1", name="库里的名字", short_desc="库里的描述",
               context_window="256K", import_format="custom", status="offline")
    db = _FakeSession({"m1": row}, seeded_ids={"m1"})
    seed_catalog_models(db)

    assert db.added_model_ids == [], "已存在的模型不应被再次插入"
    assert row.name == "库里的名字"
    assert row.short_desc == "库里的描述"
    assert row.context_window == "256K"
    # import_format 被改会影响请求的协议转换，尤其不能动
    assert row.import_format == "custom"
    assert row.status == "offline"


def test_does_not_resurrect_deleted_or_renamed_model(one_model):
    """管理员删除/改名过的模型：id 缺失但历史上插过，不会被悄悄插回去。

    曾经 seed 过的 id 之后从 model_registry 消失（改名或删除），
    不该被下一次启动重新插入。
    """
    db = _FakeSession(existing={}, seeded_ids={"m1"})
    seed_catalog_models(db)

    assert db.added_model_ids == [], "历史上插过的 id 缺失时不应被复活"
    assert db.added_marker_ids == [], "已经登记过，不需要重复登记"


def test_backfills_marker_for_preexisting_unmarked_row(one_model):
    """老部署升级到本机制之前就已存在的行：只补登记，不碰行本身字段。"""
    row = _Row(id="m1", name="库里的名字", context_window="256K")
    db = _FakeSession({"m1": row}, seeded_ids=set())
    seed_catalog_models(db)

    assert db.added_model_ids == [], "行已存在，不应再插入一次"
    assert db.added_marker_ids == ["m1"], "缺失的历史标记要补上，否则以后删除/改名又会被误判为从未插过"
    assert row.name == "库里的名字", "补登记不应连带修改行内容"


def test_force_sync_opt_in_overwrites(one_model, monkeypatch):
    """显式 CATALOG_FORCE_SYNC=1 时才按代码目录对齐（目录随版本更新用）。"""
    monkeypatch.setenv("CATALOG_FORCE_SYNC", "1")
    row = _Row(id="m1", name="库里的名字", short_desc="库里的描述",
               context_window="256K", import_format="custom", status="offline",
               extra=None)
    db = _FakeSession({"m1": row}, seeded_ids={"m1"})
    seed_catalog_models(db)

    assert row.name == "代码里的名字"
    assert row.context_window == "32K"


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off"])
def test_force_sync_off_by_default_and_for_falsy_values(one_model, monkeypatch, value):
    """开关只认真值；空串或 0/false 一律按不覆盖处理，避免误开。"""
    monkeypatch.setenv("CATALOG_FORCE_SYNC", value)
    row = _Row(id="m1", name="库里的名字", context_window="256K")
    db = _FakeSession({"m1": row}, seeded_ids={"m1"})
    seed_catalog_models(db)
    assert row.name == "库里的名字"
    assert row.context_window == "256K"


def test_deployment_config_never_touched_even_when_forced(one_model, monkeypatch):
    """任何模式下都不动部署配置：base_url / api_key 不在 _CATALOG_FIELDS 里。"""
    monkeypatch.setenv("CATALOG_FORCE_SYNC", "1")
    row = _Row(id="m1", name="x", base_url="http://10.0.0.9:8000/v1",
               api_key="upstream-secret", model_api_name="real-name", extra=None)
    db = _FakeSession({"m1": row}, seeded_ids={"m1"})
    seed_catalog_models(db)

    assert row.base_url == "http://10.0.0.9:8000/v1"
    assert row.api_key == "upstream-secret"
    assert row.model_api_name == "real-name"


def test_default_catalog_is_explicitly_synthetic_and_has_no_upstream_secrets():
    specs = catalog_seed.CATALOG_MODELS
    ids = {spec["id"] for spec in specs}

    assert {"platform-sota", "platform-flash", "demo-chat-model"} <= ids
    assert all((spec.get("extra") or {}).get("synthetic") is True for spec in specs)
    assert all("虚构" in (spec.get("description") or "") for spec in specs)
    assert all(not {"base_url", "api_key", "custom_headers"} & set(spec) for spec in specs)

    for spec in specs:
        target = spec.get("resolve_to_model_id")
        assert target is None or target in ids


def test_default_scene_labels_are_neutral_examples():
    labels = {key: label for key, label, _ in catalog_seed.DEFAULT_SCENE_TYPES}
    assert labels == {
        "key": "重点业务",
        "labor_contest": "专项活动",
        "innovation": "创新实验",
        "explore": "概念验证",
        "dept_explore": "团队试用",
    }
