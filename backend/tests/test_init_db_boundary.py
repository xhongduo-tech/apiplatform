"""启动时的表结构边界：生产只校验，绝不建表改表。

这条边界决定「表结构的权威来源是否唯一」。曾经生产也走 create_all() +
ALTER TABLE，后果是：漏写迁移时表会被悄悄建出来，迁移链留下空洞，直到有人
从零部署才发现少表——016 那次全新库起不来就是同一类问题。
"""
from __future__ import annotations

import pytest

from app import database


@pytest.fixture
def fake_inspect(monkeypatch):
    """替换 inspect(engine)，让用例自由指定库里有哪些表。"""
    def _set(tables: list[str]):
        class _Insp:
            def get_table_names(self):
                return list(tables)
        monkeypatch.setattr(database, "inspect", lambda _engine: _Insp())
    return _set


@pytest.fixture
def spy_ddl(monkeypatch):
    """记录是否发生了建表 / 改表。"""
    calls = {"create_all": 0, "ensure": 0}
    monkeypatch.setattr(database.Base.metadata, "create_all",
                        lambda **kw: calls.__setitem__("create_all", calls["create_all"] + 1))
    monkeypatch.setattr(database, "_ensure_api_keys_schema",
                        lambda: calls.__setitem__("ensure", calls["ensure"] + 1))
    return calls


def test_production_never_touches_schema(monkeypatch, fake_inspect, spy_ddl):
    """表齐全时：生产直接放行，且一次 DDL 都不执行。"""
    monkeypatch.setattr(database.settings, "ENVIRONMENT", "production")
    fake_inspect(list(database._REQUIRED_TABLES) + ["forum_posts"])

    database.init_db()

    assert spy_ddl == {"create_all": 0, "ensure": 0}, "生产环境不允许建表或改表"


def test_production_fails_loudly_when_tables_missing(monkeypatch, fake_inspect, spy_ddl):
    """缺表时启动失败，而不是自作主张补上——补上就掩盖了迁移没跑到位。"""
    monkeypatch.setattr(database.settings, "ENVIRONMENT", "production")
    fake_inspect(["users", "api_keys"])  # 少了 model_registry / usage_logs

    with pytest.raises(RuntimeError) as e:
        database.init_db()

    msg = str(e.value)
    assert "model_registry" in msg and "usage_logs" in msg, "必须点名缺了哪几张表"
    assert "alembic upgrade head" in msg, "必须给出可直接执行的修复命令"
    assert spy_ddl == {"create_all": 0, "ensure": 0}, "失败路径也不许偷偷建表"


def test_development_keeps_create_all_fallback(monkeypatch, fake_inspect, spy_ddl):
    """开发不跑 alembic（dev.sh 直接起 uvicorn），保留建表兜底。"""
    monkeypatch.setattr(database.settings, "ENVIRONMENT", "development")
    fake_inspect([])

    database.init_db()

    assert spy_ddl["create_all"] == 1
    assert spy_ddl["ensure"] == 1


def test_required_tables_are_actually_defined_in_orm():
    """校验清单里的表必须真的在 ORM 里，否则这道校验永远不可能通过。"""
    from app.database import Base

    known = set(Base.metadata.tables)
    assert set(database._REQUIRED_TABLES) <= known, (
        f"_REQUIRED_TABLES 含 ORM 未定义的表: {set(database._REQUIRED_TABLES) - known}"
    )
