"""平台 API / 桥接层集成测试。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import settings


_DEV_AUTH_ID = settings.DEV_LOGIN_AUTH_ID


async def _noop_async(*_a, **_k):
    return None


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr("app.main._startup_db_work", lambda: None)
    monkeypatch.setattr("app.ops_scheduler.ops_scheduler.start", _noop_async)
    monkeypatch.setattr("app.ops_scheduler.ops_scheduler.stop", _noop_async)
    monkeypatch.setattr("app.usage_retention.usage_retention.start", _noop_async)
    monkeypatch.setattr("app.usage_retention.usage_retention.stop", _noop_async)
    monkeypatch.setattr("app.usage_writer.usage_writer.start", _noop_async)
    monkeypatch.setattr("app.usage_writer.usage_writer.stop", _noop_async)

    async def _ping():
        return True

    monkeypatch.setattr("app.redis_client.redis.ping", _ping)

    from app.main import app

    with TestClient(app) as c:
        yield c


def test_health_ok(client: TestClient):
    r = client.get("/health")
    assert r.status_code in (200, 503)
    body = r.json()
    assert "status" in body


def test_dev_login_issues_user_token(requires_db, client: TestClient):
    """开发环境（conftest 注入 ENVIRONMENT=development）：假登录直接换用户 JWT。"""
    from app.auth import decode_token

    r = client.post("/api/user/dev-login")
    assert r.status_code == 200
    body = r.json()
    assert body["authId"] == _DEV_AUTH_ID
    assert body["token"]
    claims = decode_token(body["token"])
    assert claims["role"] == "user"
    assert claims["sub"] == _DEV_AUTH_ID


def test_dev_login_disabled_in_production(client: TestClient, monkeypatch):
    """生产环境：dev-login 直接 404，防止测试账号漏进生产。"""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    r = client.post("/api/user/dev-login")
    assert r.status_code == 404


def test_config_exposes_dev_login_flag(requires_db, client: TestClient):
    """/api/public/config 下发 dev_login_enabled，前端据此显示/隐藏开发登录按钮。"""
    r = client.get("/api/public/config")
    assert r.status_code == 200
    assert r.json()["dev_login_enabled"] is True  # conftest 注入 development


def test_forum_posts_pagination(requires_db, client: TestClient):
    r = client.get("/api/forum/posts?limit=5&offset=0")
    assert r.status_code == 200
    body = r.json()
    assert "total" in body
    assert body["limit"] == 5
    assert body["offset"] == 0
    assert isinstance(body["data"], list)
    assert len(body["data"]) <= 5


def test_forum_overview(requires_db, client: TestClient):
    r = client.get("/api/forum/overview")
    assert r.status_code == 200
    body = r.json()
    assert "pending" in body
    assert "recent7_new" in body
    assert "avg_response_hours" in body
    assert "hot" in body
    assert isinstance(body["hot"], list)


def test_forum_posts_hot_sort(requires_db, client: TestClient):
    r = client.get("/api/forum/posts?sort=hot&limit=5")
    assert r.status_code == 200
    body = r.json()
    assert "total" in body
    assert isinstance(body["data"], list)
    assert len(body["data"]) <= 5


@pytest.mark.asyncio
async def test_async_validate_api_key_missing():
    from app.proxy.db_bridge import async_validate_api_key

    with pytest.raises(HTTPException) as exc:
        await async_validate_api_key(None)
    assert exc.value.status_code == 401


def test_platform_stats_initial_offset(monkeypatch):
    from app.platform_stats import build_platform_stats

    monkeypatch.setattr("app.platform_stats.get_initial_calls", lambda: 1_000_000)
    monkeypatch.setattr("app.platform_stats.get_initial_tokens", lambda: 500_000_000)
    stats = build_platform_stats(live_calls=42, live_tokens=9000, active_keys=3)
    assert stats["total_calls"] == 1_000_042
    assert stats["total_tokens"] == 500_009_000
    assert stats["active_keys"] == 3
    assert stats["live_calls"] == 42
    assert stats["initial_calls"] == 1_000_000


def test_yoy_growth_percentage():
    """同比：去年有数据时返回增长率百分比，去年无记录返回 None（前端显示 —）。"""
    from app.routers.public import _yoy

    assert _yoy(120, 100) == 20.0
    assert _yoy(80, 100) == -20.0
    assert _yoy(100, 0) is None
    assert _yoy(0, 0) is None


def test_platform_status_exposes_month_yoy_monthly_active(requires_db, client: TestClient):
    """状态接口下发顶部看板新字段：本月用量、三档同比、月活 Key 数。"""
    r = client.get("/api/public/platform-status")
    assert r.status_code == 200
    body = r.json()
    assert {"calls", "tokens"} <= set(body["month"])
    assert isinstance(body["monthly_active_keys"], int)
    assert set(body["yoy"]) == {"day", "month", "cumulative"}
    for key in ("day", "month", "cumulative"):
        assert {"calls", "tokens"} <= set(body["yoy"][key])
        for v in body["yoy"][key].values():
            # 去年同期没数据为 null；有数据则是增长率数值
            assert v is None or isinstance(v, (int, float))


def test_apply_stores_scene_type(requires_db, client: TestClient):
    """申请时选择的业务场景分类要落库。"""
    from sqlalchemy import delete

    from app.database import SessionLocal
    from app.models import ApplicationORM

    # 清理历史残留（同名项目重复申请会被场景名校验拒绝 → 400，测试需可重复）
    db0 = SessionLocal()
    try:
        db0.execute(delete(ApplicationORM).where(ApplicationORM.auth_id == _DEV_AUTH_ID))
        db0.commit()
    finally:
        db0.close()

    r = client.post("/api/user/dev-login")
    assert r.status_code == 200
    token = r.json()["token"]

    resp = client.post(
        "/api/apply",
        json={
            "name": "场景分类测试",
            "auth_id": _DEV_AUTH_ID,
            "department": "示例研发组",
            "project_name": "场景分类测试项目",
            "project_desc": "用于验证业务场景分类字段落库的申请，内容足够三十个字符以通过校验。",
            "scene_type": "innovation",
            "models": [],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    app_id = resp.json()["id"]
    db = SessionLocal()
    try:
        a = db.get(ApplicationORM, app_id)
        assert a is not None and a.scene_type == "innovation"
    finally:
        db.close()


def test_approve_copies_scene_type_to_key(requires_db, client: TestClient):
    """管理员审批只授权；申请用户首次访问时领取唯一一次明文。"""
    from app.auth import create_user_token, hash_key, require_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM, ApplicationORM

    db = SessionLocal()
    try:
        a = ApplicationORM(
            name="场景审批测试",
            auth_id=_DEV_AUTH_ID,
            department="示例研发组",
            project_name="场景审批测试项目",
            project_desc="用于验证审批复制业务场景分类的测试项目，内容足够长。",
            scene_type="labor_contest",
            models=[],
        )
        db.add(a)
        db.commit()
        app_id = a.id
    finally:
        db.close()

    app.dependency_overrides[require_admin] = lambda: None
    try:
        r = client.post(f"/api/admin/applications/{app_id}/approve", json={})
        assert r.status_code == 200
        assert "api_key" not in r.json()  # 管理员不应看到申请人的唯一一次明文
        db = SessionLocal()
        try:
            k = db.query(ApiKeyORM).filter(ApiKeyORM.application_id == app_id).first()
            assert k is not None and k.scene_type == "labor_contest"
            assert k.key_hash is None
            key_id = k.id
        finally:
            db.close()

        login = client.post("/api/user/dev-login")
        assert login.status_code == 200
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        listed = client.post("/api/user/keys", headers=headers)
        assert listed.status_code == 200
        row = next(x for x in listed.json()["data"] if x["id"] == key_id)
        assert row["needs_claim"] is True
        assert row["key_masked"] is None

        other_token = create_user_token("another-user", "其他用户", "UT")["token"]
        denied = client.post(
            f"/api/user/keys/{key_id}/claim",
            headers={"Authorization": f"Bearer {other_token}"},
        )
        # 服务端会校验账号是否真实存在，伪造的用户 JWT 不能进入资源查询。
        assert denied.status_code == 401

        claimed = client.post(f"/api/user/keys/{key_id}/claim", headers=headers)
        assert claimed.status_code == 200
        raw = claimed.json()["api_key"]
        assert raw.startswith("sk-platform-")
        db = SessionLocal()
        try:
            k = db.get(ApiKeyORM, key_id)
            assert k is not None
            assert k.key_hash == hash_key(raw)
            assert k.api_key is None
            assert k.user_claimed_at is not None
        finally:
            db.close()

        claimed_again = client.post(f"/api/user/keys/{key_id}/claim", headers=headers)
        assert claimed_again.status_code == 409
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_keys_filter_by_scene_type(requires_db, client: TestClient):
    """管理员密钥列表支持按 scene_type 筛选（场景分类页「查看密钥」，与 keyCount 同源）。"""
    import uuid

    from app.auth import require_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM

    db = SessionLocal()
    try:
        k1 = ApiKeyORM(
            name="筛选场景KeyA",
            auth_id="ut-scene-key-a",
            project_name="筛选场景KeyA项目",
            department="UT",
            scene_type="innovation",
            key_hash="scene_a_" + uuid.uuid4().hex,
            key_prefix="sk-sca",
        )
        k2 = ApiKeyORM(
            name="筛选场景KeyB",
            auth_id="ut-scene-key-b",
            project_name="筛选场景KeyB项目",
            department="UT",
            scene_type="explore",
            key_hash="scene_b_" + uuid.uuid4().hex,
            key_prefix="sk-scb",
        )
        db.add_all([k1, k2])
        db.commit()
        id_a, id_b = k1.id, k2.id
    finally:
        db.close()

    app.dependency_overrides[require_admin] = lambda: None
    try:
        r = client.get("/api/admin/keys", params={"scene_type": "innovation", "limit": 200})
        assert r.status_code == 200
        ids = {row["id"] for row in r.json()["data"]}
        assert id_a in ids
        assert id_b not in ids
        assert all(row.get("sceneType") == "innovation" for row in r.json()["data"])
    finally:
        app.dependency_overrides.pop(require_admin, None)
        db = SessionLocal()
        try:
            for key_id in (id_a, id_b):
                row = db.get(ApiKeyORM, key_id)
                if row is not None:
                    db.delete(row)
            db.commit()
        finally:
            db.close()


def test_platform_status_scene_fixed_categories(requires_db, client: TestClient):
    """场景分布按 scene_types 表顺序返回（含 0 桶），不按调用量排序；
    被删除分类仍被引用的残余 key 归入末尾「其他」桶。"""
    from sqlalchemy import text

    from app.database import SessionLocal

    db = SessionLocal()
    try:
        keys = [r[0] for r in db.execute(
            text("SELECT key FROM scene_types ORDER BY sort_order, key")
        ).all()]
    finally:
        db.close()

    r = client.get("/api/public/platform-status")
    assert r.status_code == 200
    by_scene = r.json()["by_scene"]
    assert [s["category"] for s in by_scene if s["category"] != "other"] == keys
    assert all(s["label"] for s in by_scene)


def test_public_breakdown_reads_summary(requires_db, client: TestClient):
    """「查看全部」从 usage_daily_summary 聚合——usage_logs 清理后仍有数据；
    summary 无 latency/success/cost 三列，这三项为 null（前端显示 —）。"""
    from sqlalchemy import delete

    from app.database import SessionLocal
    from app.models import ApiKeyORM, UsageDailySummaryORM
    from app.platform_time import today_local

    db = SessionLocal()
    try:
        # 自建数据：清库后本用例不再依赖库中历史用量
        db.execute(delete(UsageDailySummaryORM).where(UsageDailySummaryORM.api_key_id == "pytest-bd-key"))
        db.execute(delete(ApiKeyORM).where(ApiKeyORM.id == "pytest-bd-key"))
        db.commit()
        db.add(ApiKeyORM(
            id="pytest-bd-key", name="breakdown-key", auth_id="pytest-bd-user",
            project_name="breakdown项目", department="UT",
        ))
        db.add(UsageDailySummaryORM(
            day=today_local(), api_key_id="pytest-bd-key", model_id="pytest-bd-model",
            calls=5, prompt_tokens=100, completion_tokens=50, total_tokens=150,
        ))
        db.commit()
    finally:
        db.close()

    try:
        r = client.get(
            "/api/public/platform-status/breakdown"
            "?dimension=model&days=30&sort_field=calls&sort_dir=desc&limit=20&offset=0"
        )
        assert r.status_code == 200
        body = r.json()
        assert body["total_groups"] > 0
        assert body["rows"], "usage_logs 为空时公开 breakdown 仍应从汇总表出数据"
        first = body["rows"][0]
        assert first["calls"] > 0
        assert first["avg_latency_ms"] is None
        assert first["success_rate"] is None
        assert first["cost"] is None
    finally:
        db2 = SessionLocal()
        try:
            db2.execute(delete(UsageDailySummaryORM).where(UsageDailySummaryORM.api_key_id == "pytest-bd-key"))
            db2.execute(delete(ApiKeyORM).where(ApiKeyORM.id == "pytest-bd-key"))
            db2.commit()
        finally:
            db2.close()


def test_public_breakdown_project_requires_admin(requires_db, client: TestClient):
    """项目维度在公开端「查看全部」被拒绝（项目名需管理员权限，管理员在后台统计查看）。"""
    r = client.get("/api/public/platform-status/breakdown?dimension=project&days=30")
    assert r.status_code == 400


def test_platform_status_session_charts(requires_db, client: TestClient):
    """状态页 Session 分布：tool-calls / context-length 公开端点契约。"""
    from sqlalchemy import delete

    from app import platform_time
    from app.database import SessionLocal
    from app.models import ApiKeyORM, UsageRequestProfileORM, _uuid

    key_id = "pytest-tc-status-key"
    db = SessionLocal()
    try:
        db.execute(delete(UsageRequestProfileORM).where(UsageRequestProfileORM.api_key_id == key_id))
        db.execute(delete(ApiKeyORM).where(ApiKeyORM.id == key_id))
        db.add(ApiKeyORM(
            id=key_id, name="pytest-tc-status", auth_id="pytest-tc-user",
            project_name="tool分布测试", department="UT",
        ))
        now = platform_time.to_utc_naive(platform_time.now_local())
        for tc in (0, 2, 12):
            db.add(UsageRequestProfileORM(
                id=_uuid(), api_key_id=key_id, created_at=now,
                prompt_tokens=100, tool_calls_count=tc,
            ))
        db.commit()
    finally:
        db.close()

    try:
        tc = client.get("/api/public/platform-status/tool-calls?days=30")
        assert tc.status_code == 200
        tc_body = tc.json()
        assert "buckets" in tc_body and "total_sessions" in tc_body
        assert tc_body["days"] == 30
        by_label = {b["label"]: b for b in tc_body["buckets"]}
        assert by_label["0"]["count"] >= 1
        assert by_label["1–5"]["count"] >= 1
        assert by_label["11–25"]["count"] >= 1

        ctx = client.get("/api/public/platform-status/context-length?days=14")
        assert ctx.status_code == 200
        ctx_body = ctx.json()
        assert "buckets" in ctx_body and "p50" in ctx_body
        assert ctx_body["days"] == 14
    finally:
        db2 = SessionLocal()
        try:
            db2.execute(delete(UsageRequestProfileORM).where(UsageRequestProfileORM.api_key_id == key_id))
            db2.execute(delete(ApiKeyORM).where(ApiKeyORM.id == key_id))
            db2.commit()
        finally:
            db2.close()


def test_platform_status_heatmap_buckets_week(requires_db, client: TestClient):
    """周热力图：按锚点日期所在周（周一~周日、平台本地时区）分桶，返回 7×24 矩阵
    与自然日标签；矩阵下标 0=周一，PG dow(0=Sun..6=Sat) 与下标换算正确。"""
    from datetime import date, datetime, timedelta

    from sqlalchemy import text

    from app.database import SessionLocal
    from app.models import ApiKeyORM, UsageLogORM
    from app.platform_time import to_utc_naive

    # 使用远离演示/历史种子数据的月份，确保断言只覆盖本测试插入的三条记录。
    anchor = date(2038, 8, 5)
    monday = anchor - timedelta(days=anchor.weekday())

    db = SessionLocal()
    key_id = None
    log_ids = []
    try:
        key = ApiKeyORM(name="pytest-heatmap-key", auth_id="pytest-heatmap", project_name="热力图测试", department="示例研发组")
        db.add(key)
        db.flush()
        key_id = key.id
        # 周一 10 点、周三 15 点、周日 23 点各插一条（本地时区墙钟时间）
        for local_dt, _expected_row in [
            (datetime.combine(monday, datetime.min.time()).replace(hour=10), 0),
            (datetime.combine(monday + timedelta(days=2), datetime.min.time()).replace(hour=15), 2),
            (datetime.combine(monday + timedelta(days=6), datetime.min.time()).replace(hour=23), 6),
        ]:
            row = UsageLogORM(
                api_key_id=key_id, model_id="heatmap-model",
                total_tokens=10, status_code="200", created_at=to_utc_naive(local_dt),
            )
            db.add(row)
            db.flush()
            log_ids.append(row.id)
        db.commit()
    finally:
        db.rollback()

    try:
        r = client.get(f"/api/public/platform-status/heatmap?date={anchor.isoformat()}")
        assert r.status_code == 200
        body = r.json()
        assert body["mode"] == "week"
        assert body["x_axis"] == "hour"
        assert len(body["matrix"]) == 7 and all(len(r_) == 24 for r_ in body["matrix"])
        assert body["week_start"] == monday.isoformat()
        assert body["week_end"] == (monday + timedelta(days=6)).isoformat()
        assert body["dates"] == [(monday + timedelta(days=i)).isoformat() for i in range(7)]
        assert body["total"] == 3
        assert body["matrix"][0][10] == 1  # 周一 10 点
        assert body["matrix"][2][15] == 1  # 周三 15 点
        assert body["matrix"][6][23] == 1  # 周日 23 点
        assert body["max"] == 1

        # 非法日期 → 400
        bad = client.get("/api/public/platform-status/heatmap?date=not-a-date")
        assert bad.status_code == 400

        bad_mode = client.get("/api/public/platform-status/heatmap?mode=invalid")
        assert bad_mode.status_code == 400

        # 月模式：列数 = 当月天数，行数 = 7 时段带
        month_r = client.get(f"/api/public/platform-status/heatmap?mode=month&date={anchor.isoformat()}")
        assert month_r.status_code == 200
        month_body = month_r.json()
        assert month_body["mode"] == "month"
        assert month_body["x_axis"] == "day"
        assert len(month_body["matrix"]) == 7
        assert len(month_body["matrix"][0]) == 31  # 8 月有 31 天
        assert month_body["total"] == 3
        assert month_body["matrix"][3][monday.day - 1] == 1  # 周一 10 点 → 09–11 时段带

        # 累计模式
        cum_r = client.get("/api/public/platform-status/heatmap?mode=cumulative")
        assert cum_r.status_code == 200
        cum_body = cum_r.json()
        assert cum_body["mode"] == "cumulative"
        assert cum_body["x_axis"] == "day"
        assert len(cum_body["matrix"]) == 7

        # 不传 date：默认平台时区今天所在周，结构一致
        default = client.get("/api/public/platform-status/heatmap")
        assert default.status_code == 200
        d = default.json()
        assert len(d["matrix"]) == 7 and len(d["dates"]) == 7
        assert all(len(r_) == 24 for r_ in d["matrix"])
        assert d["week_start"] <= d["week_end"]
    finally:
        db = SessionLocal()
        try:
            for lid in log_ids:
                db.execute(text("DELETE FROM usage_logs WHERE id = :id"), {"id": lid})
            if key_id:
                db.execute(text("DELETE FROM api_keys WHERE id = :id"), {"id": key_id})
            db.commit()
        finally:
            db.close()


def test_user_heatmap_week_buckets(requires_db, client: TestClient):
    """用户侧周热力图：按锚点日期所在周（周一~周日）分桶，只聚合该用户自己的 Key，
    其他用户互不可见；非法日期 400、未登录 401。"""
    from datetime import date, datetime, timedelta

    from sqlalchemy import text

    from app.auth import create_user_token
    from app.database import SessionLocal
    from app.models import ApiKeyORM, UsageLogORM, UserORM
    from app.platform_time import to_utc_naive

    anchor = date(2026, 8, 5)  # 周三 → 所在周周一 2026-08-03
    monday = anchor - timedelta(days=anchor.weekday())
    auth_id = "pytest-heatmap-week-user"
    other_auth = "pytest-heatmap-week-other"

    db = SessionLocal()
    key_ids: list[str] = []
    log_ids: list[str] = []
    user_ids: list[str] = []
    try:
        primary_user = UserORM(auth_id=auth_id, name="周热力图", department="示例研发组")
        other_user = UserORM(auth_id=other_auth, name="他人", department="其他部门")
        db.add_all([primary_user, other_user])
        db.flush()
        user_ids.extend([primary_user.id, other_user.id])
        primary_version = primary_user.token_version
        other_version = other_user.token_version
        for name in ("pytest-week-key-a", "pytest-week-key-b"):
            key = ApiKeyORM(name=name, auth_id=auth_id, project_name="周热力图", department="示例研发组")
            db.add(key)
            db.flush()
            key_ids.append(key.id)
        for local_dt, _expected_row in [
            (datetime.combine(monday, datetime.min.time()).replace(hour=10), 0),
            (datetime.combine(monday + timedelta(days=2), datetime.min.time()).replace(hour=15), 2),
            (datetime.combine(monday + timedelta(days=6), datetime.min.time()).replace(hour=23), 6),
        ]:
            row = UsageLogORM(
                api_key_id=key_ids[0], model_id="heatmap-model",
                total_tokens=10, status_code="200", created_at=to_utc_naive(local_dt),
            )
            db.add(row)
            db.flush()
            log_ids.append(row.id)
        db.commit()
    finally:
        db.rollback()

    token = create_user_token(auth_id, "周热力图", "示例研发组", primary_version)["token"]
    try:
        r = client.get(
            f"/api/user/stats/heatmap/week?date={anchor.isoformat()}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body["matrix"]) == 7 and all(len(x) == 24 for x in body["matrix"])
        assert body["dates"] == [(monday + timedelta(days=i)).isoformat() for i in range(7)]
        assert body["week_start"] == monday.isoformat()
        assert body["week_end"] == (monday + timedelta(days=6)).isoformat()
        assert body["total"] == 3
        assert body["matrix"][0][10] == 1  # 周一 10 点
        assert body["matrix"][2][15] == 1  # 周三 15 点
        assert body["matrix"][6][23] == 1  # 周日 23 点
        assert body["max"] == 1

        # 非法日期 → 400
        bad = client.get(
            "/api/user/stats/heatmap/week?date=not-a-date",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert bad.status_code == 400

        # 未登录 → 401
        anon = client.get(f"/api/user/stats/heatmap/week?date={anchor.isoformat()}")
        assert anon.status_code == 401

        # 其他用户看不到本用户数据
        other_tok = create_user_token(other_auth, "他人", "其他部门", other_version)["token"]
        other = client.get(
            f"/api/user/stats/heatmap/week?date={anchor.isoformat()}",
            headers={"Authorization": f"Bearer {other_tok}"},
        )
        assert other.status_code == 200
        assert other.json()["total"] == 0

        month = client.get(
            f"/api/user/stats/heatmap/week?mode=month&date={anchor.isoformat()}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert month.status_code == 200
        mb = month.json()
        assert mb["mode"] == "month"
        assert mb["total"] == 3

        cum = client.get(
            "/api/user/stats/heatmap/week?mode=cumulative",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert cum.status_code == 200
        assert cum.json()["mode"] == "cumulative"
    finally:
        db = SessionLocal()
        try:
            for lid in log_ids:
                db.execute(text("DELETE FROM usage_logs WHERE id = :id"), {"id": lid})
            for kid in key_ids:
                db.execute(text("DELETE FROM api_keys WHERE id = :id"), {"id": kid})
            for uid in user_ids:
                db.execute(text("DELETE FROM users WHERE id = :id"), {"id": uid})
            db.commit()
        finally:
            db.close()


def test_public_scene_types_lists_categories(requires_db, client: TestClient):
    """申请表单用的公开场景分类列表接口。"""
    r = client.get("/api/public/scene-types")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) >= 5
    assert {"key", "label"} <= set(data[0])
    assert data[0]["key"] == "key"  # 默认按 sort_order 排序，中心重点场景排最前


def test_admin_scene_types_crud(requires_db, client: TestClient):
    """管理员可新增/修改/删除场景分类；被 key 引用的分类禁止删除。"""
    from app.auth import require_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM, SceneTypeORM

    app.dependency_overrides[require_admin] = lambda: None
    db = SessionLocal()
    try:
        # 清理历史残留（幂等）
        db.query(SceneTypeORM).filter(SceneTypeORM.key.like("ut_%")).delete()
        db.commit()

        # 新增
        r = client.post("/api/admin/scene-types", json={"key": "ut_scene", "label": "UT 场景", "sort_order": 99})
        assert r.status_code == 200
        assert db.get(SceneTypeORM, "ut_scene") is not None

        # 修改
        r = client.put("/api/admin/scene-types/ut_scene", json={"label": "UT 场景改", "sort_order": 98})
        assert r.status_code == 200
        assert db.get(SceneTypeORM, "ut_scene").label == "UT 场景改"

        # 删除（未引用 → 成功）
        r = client.delete("/api/admin/scene-types/ut_scene")
        assert r.status_code == 200
        assert db.get(SceneTypeORM, "ut_scene") is None

        # 被 key 引用 → 409
        k = ApiKeyORM(
            name="ut-key", auth_id="ut-auth", project_name="ut-project",
            department="UT", scene_type="explore",
        )
        db.add(k)
        db.commit()
        r = client.delete("/api/admin/scene-types/explore")
        assert r.status_code == 409
        db.delete(k)
        db.commit()
    finally:
        app.dependency_overrides.pop(require_admin, None)
        db.close()


def test_admin_update_key_meta(requires_db, client: TestClient):
    """管理员可 PATCH 修改密钥名称与描述；name 与 project_name 同步。"""
    import uuid

    from app.auth import require_admin, require_recent_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM

    app.dependency_overrides[require_admin] = lambda: None
    app.dependency_overrides[require_recent_admin] = lambda: None
    db = SessionLocal()
    key_id = None
    try:
        k = ApiKeyORM(
            name="旧场景名",
            auth_id="ut-meta-auth",
            project_name="旧场景名",
            project_desc="旧描述",
            department="UT",
            scene_type="explore",
            key_hash="meta_" + uuid.uuid4().hex,
            key_prefix="sk-meta",
        )
        db.add(k)
        db.commit()
        key_id = k.id

        new_name = f"新场景名-{uuid.uuid4().hex[:6]}"
        r = client.patch(
            f"/api/admin/keys/{key_id}",
            json={"name": new_name, "project_desc": "管理员更新后的描述"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["projectName"] == new_name
        assert body["name"] == new_name
        assert body["projectDesc"] == "管理员更新后的描述"

        db.refresh(k)
        assert k.name == new_name
        assert k.project_name == new_name
        assert k.project_desc == "管理员更新后的描述"
    finally:
        if key_id:
            row = db.get(ApiKeyORM, key_id)
            if row is not None:
                db.delete(row)
                db.commit()
        app.dependency_overrides.pop(require_admin, None)
        app.dependency_overrides.pop(require_recent_admin, None)
        db.close()


def test_admin_list_keys_tier_elevated(requires_db, client: TestClient):
    """tier=elevated 仅返回高并发 / 超高并发密钥，与 key_tier 判定一致。"""
    import uuid

    from app.auth import require_admin
    from app.config import settings
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM

    app.dependency_overrides[require_admin] = lambda: None
    db = SessionLocal()
    ids: list[str] = []
    try:
        suffix = uuid.uuid4().hex[:8]
        rows = [
            ApiKeyORM(
                name=f"def-{suffix}", auth_id="ut-tier", project_name=f"def-{suffix}",
                department="UT", key_hash=f"h_def_{suffix}", key_prefix="sk-def",
                rpm_limit=None, tpm_limit=None,
            ),
            ApiKeyORM(
                name=f"high-{suffix}", auth_id="ut-tier", project_name=f"high-{suffix}",
                department="UT", key_hash=f"h_high_{suffix}", key_prefix="sk-hi",
                rpm_limit=settings.RATE_LIMIT_HIGH_RPM,
                tpm_limit=settings.RATE_LIMIT_HIGH_TPM,
            ),
            ApiKeyORM(
                name=f"unl-{suffix}", auth_id="ut-tier", project_name=f"unl-{suffix}",
                department="UT", key_hash=f"h_unl_{suffix}", key_prefix="sk-ul",
                rpm_limit=-1, tpm_limit=-1,
            ),
        ]
        for k in rows:
            db.add(k)
        db.commit()
        ids = [k.id for k in rows]

        r = client.get("/api/admin/keys?tier=elevated&status=active&limit=200")
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        got = {row["id"]: row["tier"] for row in data if row["id"] in ids}
        assert ids[0] not in got
        assert got[ids[1]] == "high"
        assert got[ids[2]] == "unlimited"
    finally:
        for kid in ids:
            row = db.get(ApiKeyORM, kid)
            if row is not None:
                db.delete(row)
        db.commit()
        app.dependency_overrides.pop(require_admin, None)
        db.close()


def test_admin_regenerate_key(requires_db, client: TestClient):
    """管理员可更换新密钥：旧 hash 失效，明文仅本次返回且不落库。"""
    import uuid

    from app.auth import hash_key, require_admin, require_recent_admin
    from app.database import SessionLocal
    from app.main import app
    from app.models import ApiKeyORM

    app.dependency_overrides[require_admin] = lambda: None
    app.dependency_overrides[require_recent_admin] = lambda: None
    db = SessionLocal()
    key_id = None
    try:
        old_hash = "regen_old_" + uuid.uuid4().hex
        k = ApiKeyORM(
            name="轮换场景",
            auth_id="ut-regen-auth",
            project_name="轮换场景",
            department="UT",
            scene_type="explore",
            key_hash=old_hash,
            key_prefix="sk-old",
            api_key="should-be-cleared",
        )
        db.add(k)
        db.commit()
        key_id = k.id

        r = client.post(f"/api/admin/keys/{key_id}/regenerate")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["api_key"]
        assert body["api_key"].startswith("sk-platform-")

        db.refresh(k)
        assert k.key_hash != old_hash
        assert k.key_hash == hash_key(body["api_key"])
        assert k.api_key is None
        assert k.key_prefix
        assert body["api_key"].startswith(k.key_prefix)
    finally:
        if key_id:
            row = db.get(ApiKeyORM, key_id)
            if row is not None:
                db.delete(row)
                db.commit()
        app.dependency_overrides.pop(require_admin, None)
        app.dependency_overrides.pop(require_recent_admin, None)
        db.close()
