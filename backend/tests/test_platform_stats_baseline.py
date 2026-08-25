"""平台统计基线持久化与累计口径测试。"""
from __future__ import annotations

def test_platform_stats_baseline_database(requires_db, monkeypatch):
    monkeypatch.setattr("app.platform_stats_baseline.settings.PLATFORM_STATS_INITIAL_CALLS", 0)
    monkeypatch.setattr("app.platform_stats_baseline.settings.PLATFORM_STATS_INITIAL_TOKENS", 0)
    monkeypatch.setattr("app.platform_stats_baseline.settings.PLATFORM_STATS_INITIAL_COST", 0.0)

    from app.platform_stats_baseline import get_baseline, save_baseline
    from app.database import SessionLocal
    from app.models import PlatformSettingORM

    with SessionLocal() as db:
        db.query(PlatformSettingORM).filter_by(key="platform_stats_baseline").delete()
        db.commit()
        assert get_baseline(db)["initial_calls"] == 0
        assert get_baseline(db)["source"] == "environment"
        saved = save_baseline(db, 2_500_000, 10_000_000_000, 15_000.0)
        db.commit()
        assert saved["initial_calls"] == 2_500_000
        assert saved["initial_tokens"] == 10_000_000_000
        assert saved["initial_cost"] == 15_000.0
        assert saved["source"] == "database"
        db.query(PlatformSettingORM).filter_by(key="platform_stats_baseline").delete()
        db.commit()

    from app.platform_stats import build_platform_stats

    monkeypatch.setattr("app.platform_stats.get_initial_calls", lambda: 2_500_000)
    monkeypatch.setattr("app.platform_stats.get_initial_tokens", lambda: 10_000_000_000)
    stats = build_platform_stats(live_calls=10, live_tokens=100, active_keys=2)
    assert stats["total_calls"] == 2_500_010
    assert stats["total_tokens"] == 10_000_000_100


def test_admin_stats_summary_includes_baseline(monkeypatch):
    """数据看板累计 KPI 与首页一致：all_time = 日汇总 + 历史基线。"""
    monkeypatch.setattr(
        "app.routers.admin_stats.build_summary",
        lambda db, year: {
            "year": year,
            "monthly": [],
            "total_calls": 100,
            "total_tokens": 1000,
            "all_time_calls": 100,
            "all_time_tokens": 1000,
        },
    )
    monkeypatch.setattr("app.routers.admin_stats.get_initial_calls", lambda _db=None: 2_500_000)
    monkeypatch.setattr("app.routers.admin_stats.get_initial_tokens", lambda _db=None: 10_000_000_000)
    monkeypatch.setattr("app.routers.admin_stats.now_local", lambda: type("N", (), {"year": 2026})())

    from app.routers.admin_stats import admin_stats_summary

    out = admin_stats_summary(year=2026, db=None, _=None)
    assert out["live_all_time_calls"] == 100
    assert out["live_all_time_tokens"] == 1000
    assert out["initial_calls"] == 2_500_000
    assert out["initial_tokens"] == 10_000_000_000
    assert out["all_time_calls"] == 2_500_100
    assert out["all_time_tokens"] == 10_000_001_000
