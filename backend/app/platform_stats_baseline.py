"""Persistent platform cumulative-statistics baseline.

Administrators store overrides in ``platform_settings`` so values survive
container replacement and work with a read-only application filesystem. The
environment variables remain immutable deployment defaults until an override
is saved.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.config import settings
from app.models import PlatformSettingORM

PLATFORM_STATS_BASELINE_KEY = "platform_stats_baseline"


def _nonneg_int(value) -> int | None:
    if value is None:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _nonneg_float(value) -> float | None:
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def _stored(db: Session | None) -> dict:
    if db is None:
        return {}
    row = db.get(PlatformSettingORM, PLATFORM_STATS_BASELINE_KEY)
    return row.value if row is not None and isinstance(row.value, dict) else {}


def get_initial_calls(db: Session | None = None) -> int:
    stored = _nonneg_int(_stored(db).get("initial_calls"))
    return stored if stored is not None else max(0, settings.PLATFORM_STATS_INITIAL_CALLS)


def get_initial_tokens(db: Session | None = None) -> int:
    stored = _nonneg_int(_stored(db).get("initial_tokens"))
    return stored if stored is not None else max(0, settings.PLATFORM_STATS_INITIAL_TOKENS)


def get_initial_cost(db: Session | None = None) -> float:
    stored = _nonneg_float(_stored(db).get("initial_cost"))
    return stored if stored is not None else max(0.0, float(settings.PLATFORM_STATS_INITIAL_COST))


def get_baseline(db: Session | None = None) -> dict:
    stored = _stored(db)
    return {
        "initial_calls": get_initial_calls(db),
        "initial_tokens": get_initial_tokens(db),
        "initial_cost": round(get_initial_cost(db), 4),
        "source_env_calls": max(0, settings.PLATFORM_STATS_INITIAL_CALLS),
        "source_env_tokens": max(0, settings.PLATFORM_STATS_INITIAL_TOKENS),
        "source_env_cost": max(0.0, float(settings.PLATFORM_STATS_INITIAL_COST)),
        "source": "database" if stored else "environment",
    }


def save_baseline(
    db: Session,
    initial_calls: int,
    initial_tokens: int,
    initial_cost: float = 0.0,
) -> dict:
    payload = {
        "initial_calls": max(0, int(initial_calls)),
        "initial_tokens": max(0, int(initial_tokens)),
        "initial_cost": round(max(0.0, float(initial_cost)), 4),
    }
    row = db.get(PlatformSettingORM, PLATFORM_STATS_BASELINE_KEY)
    if row is None:
        row = PlatformSettingORM(key=PLATFORM_STATS_BASELINE_KEY, value=payload)
        db.add(row)
    else:
        row.value = payload
    db.flush()
    return get_baseline(db)
