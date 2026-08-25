"""stats_breakdown.query_breakdown 单测：搜索/排序/分页/汇总口径是否正确。

用真实 Postgres（requires_db），插入带唯一前缀的合成数据，跑完删除——不依赖
dev DB 里既有的历史数据，也不污染它。
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

TAG = f"pytest-bd-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def seeded(requires_db):
    from app.database import SessionLocal
    from app.models import ApiKeyORM, UsageLogORM

    db = SessionLocal()
    key_ids: list[str] = []
    log_ids: list[str] = []
    try:
        # 两个项目、两个模型，制造可区分的 calls/tokens/latency/success 组合
        specs = [
            # (project, model, calls, tokens_each, latency, status)
            (f"{TAG}-alpha", f"{TAG}-model-a", 3, 100, 200, "200"),
            (f"{TAG}-alpha", f"{TAG}-model-b", 1, 50, 400, "500"),
            (f"{TAG}-beta", f"{TAG}-model-a", 2, 300, 100, "200"),
        ]
        for project, model_id, calls, tokens_each, latency, status in specs:
            key = ApiKeyORM(
                name=f"{TAG}-key-{project}", auth_id=f"{TAG}-auth", project_name=project,
                department=f"{TAG}-dept",
            )
            db.add(key)
            db.flush()
            key_ids.append(key.id)
            for _ in range(calls):
                row = UsageLogORM(
                    api_key_id=key.id, model_id=model_id,
                    prompt_tokens=tokens_each // 2, completion_tokens=tokens_each // 2,
                    total_tokens=tokens_each, latency_ms=latency, status_code=status,
                    cache_hit_tokens=0, estimated_cost=0.01,
                )
                db.add(row)
                db.flush()
                log_ids.append(row.id)
        db.commit()
        yield
    finally:
        db.rollback()
        for lid in log_ids:
            db.execute(text("DELETE FROM usage_logs WHERE id = :id"), {"id": lid})
        for kid in key_ids:
            db.execute(text("DELETE FROM api_keys WHERE id = :id"), {"id": kid})
        db.commit()
        db.close()


def test_project_dimension_groups_and_sums(seeded):
    from app.database import SessionLocal
    from app.stats_breakdown import query_breakdown

    db = SessionLocal()
    try:
        result = query_breakdown(
            db, dimension="project", days=1, search=TAG,
            sort_field="calls", sort_dir="desc", limit=50, offset=0, include_cost=True,
        )
        rows = {r["label"]: r for r in result["rows"]}
        assert f"{TAG}-alpha" in rows and f"{TAG}-beta" in rows
        alpha = rows[f"{TAG}-alpha"]
        # alpha = 3 次 model-a(100 tok) + 1 次 model-b(50 tok)
        assert alpha["calls"] == 4
        assert alpha["tokens"] == 3 * 100 + 1 * 50
        # 3 次 200 成功 + 1 次 500 失败 → 成功率 75%
        assert alpha["success_rate"] == 75.0
        beta = rows[f"{TAG}-beta"]
        assert beta["calls"] == 2
        assert beta["tokens"] == 2 * 300
        assert beta["success_rate"] == 100.0
        assert result["total_groups"] == 2
        # totals 是搜索命中的全量汇总，不受分页影响
        assert result["totals"]["calls"] == alpha["calls"] + beta["calls"]
        assert result["totals"]["tokens"] == alpha["tokens"] + beta["tokens"]
    finally:
        db.close()


def test_search_filters_to_matching_group_only(seeded):
    from app.database import SessionLocal
    from app.stats_breakdown import query_breakdown

    db = SessionLocal()
    try:
        result = query_breakdown(
            db, dimension="project", days=1, search=f"{TAG}-beta",
            sort_field="calls", sort_dir="desc", limit=50, offset=0, include_cost=False,
        )
        assert result["total_groups"] == 1
        assert result["rows"][0]["label"] == f"{TAG}-beta"
        assert "cost" not in result["rows"][0]
        assert result["totals"]["calls"] == 2
    finally:
        db.close()


def test_pagination_does_not_shrink_totals(seeded):
    from app.database import SessionLocal
    from app.stats_breakdown import query_breakdown

    db = SessionLocal()
    try:
        full = query_breakdown(
            db, dimension="project", days=1, search=TAG,
            sort_field="calls", sort_dir="desc", limit=50, offset=0, include_cost=True,
        )
        page1 = query_breakdown(
            db, dimension="project", days=1, search=TAG,
            sort_field="calls", sort_dir="desc", limit=1, offset=0, include_cost=True,
        )
        assert len(page1["rows"]) == 1
        # 只拿第一页也不影响 total_groups / totals：两者反映的是全量命中结果
        assert page1["total_groups"] == full["total_groups"] == 2
        assert page1["totals"]["calls"] == full["totals"]["calls"]
    finally:
        db.close()


def test_model_dimension_and_avg_latency(seeded):
    from app.database import SessionLocal
    from app.stats_breakdown import query_breakdown

    db = SessionLocal()
    try:
        result = query_breakdown(
            db, dimension="model", days=1, search=f"{TAG}-model-a",
            sort_field="calls", sort_dir="desc", limit=50, offset=0, include_cost=False,
        )
        rows = {r["label"]: r for r in result["rows"]}
        model_a = rows[f"{TAG}-model-a"]
        # model-a 出现在 alpha(3 次, 200ms) 和 beta(2 次, 100ms) 里
        assert model_a["calls"] == 5
        assert model_a["avg_latency_ms"] == round((3 * 200 + 2 * 100) / 5)
    finally:
        db.close()


def test_unknown_dimension_raises():
    from app.database import SessionLocal
    from app.stats_breakdown import query_breakdown

    db = SessionLocal()
    try:
        with pytest.raises(ValueError):
            query_breakdown(
                db, dimension="not-a-real-dimension", days=1, search=None,
                sort_field="calls", sort_dir="desc", limit=10, offset=0, include_cost=False,
            )
    finally:
        db.close()
