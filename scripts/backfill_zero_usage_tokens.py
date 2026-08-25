#!/usr/bin/env python3
"""回填 usage_logs 中 HTTP 200 但 token 全空的历史行。

背景：旧网关在上游 2xx 未回报 usage（尤其流式缺 include_usage）时落库 NULL/0；
新版本已由 finalize_stream_usage 兜底估算，但历史行未改。本脚本用「同项目 +
同模型」非零同行的中位数（或抽样）模拟填充，并标记 usage_estimated=true。

默认 dry-run；加 --apply 才写库。写库时同步：
  · usage_logs.prompt/completion/total_tokens + estimated_cost + usage_estimated
  · usage_daily_summary 对应 (本地日, key, model) 的 token 增量
  · usage_request_profile.prompt_tokens
  · usage_context_bucket_daily 分桶计数（原先 pt 为空未计入）

用法（开发库）：
  ENVIRONMENT=development python scripts/backfill_zero_usage_tokens.py
  ENVIRONMENT=development python scripts/backfill_zero_usage_tokens.py --apply
  ENVIRONMENT=development python scripts/backfill_zero_usage_tokens.py --apply --method sample --seed 42
"""
from __future__ import annotations

import argparse
import os
import random
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, text

# 保证可 import app.*（scripts/ 在仓库根，backend/ 才是包根）
_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("REDIS_REQUIRED_ON_STARTUP", "false")
if not os.environ.get("DATABASE_URL", "").strip():
    raise SystemExit("必须显式设置 DATABASE_URL；脚本不再内置数据库凭据")


ZERO_PRED = """
    status_code = '200'
    AND COALESCE(prompt_tokens, 0) = 0
    AND COALESCE(completion_tokens, 0) = 0
    AND COALESCE(total_tokens, 0) = 0
"""


@dataclass(frozen=True)
class PeerStat:
    prompt: int
    completion: int
    peers: int
    source: str  # project_model | model


def _engine():
    return create_engine(os.environ["DATABASE_URL"])


def _tz_name() -> str:
    from app import platform_time
    return platform_time.sql_tz_name()


def _load_peer_medians(conn, *, min_project: int, min_model: int) -> tuple[dict, dict]:
    """返回 (project_model → PeerStat, model → PeerStat)。"""
    pm: dict[tuple[str, str], PeerStat] = {}
    for r in conn.execute(text("""
        SELECT k.project_name, t.model_id,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.prompt_tokens))::int AS med_pt,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.completion_tokens))::int AS med_ct,
               COUNT(*)::int AS n
        FROM usage_logs t
        JOIN api_keys k ON k.id = t.api_key_id
        WHERE t.status_code = '200'
          AND COALESCE(t.total_tokens, 0) > 0
          AND t.prompt_tokens IS NOT NULL
          AND t.completion_tokens IS NOT NULL
        GROUP BY 1, 2
        HAVING COUNT(*) >= :min_n
    """), {"min_n": min_project}).mappings():
        pm[(r["project_name"], r["model_id"])] = PeerStat(
            int(r["med_pt"]), int(r["med_ct"]), int(r["n"]), "project_model",
        )

    m: dict[str, PeerStat] = {}
    for r in conn.execute(text("""
        SELECT t.model_id,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.prompt_tokens))::int AS med_pt,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.completion_tokens))::int AS med_ct,
               COUNT(*)::int AS n
        FROM usage_logs t
        WHERE t.status_code = '200'
          AND COALESCE(t.total_tokens, 0) > 0
          AND t.prompt_tokens IS NOT NULL
          AND t.completion_tokens IS NOT NULL
        GROUP BY 1
        HAVING COUNT(*) >= :min_n
    """), {"min_n": min_model}).mappings():
        m[r["model_id"]] = PeerStat(
            int(r["med_pt"]), int(r["med_ct"]), int(r["n"]), "model",
        )
    return pm, m


def _load_peer_samples(
    conn, *, min_project: int, min_model: int, cap: int,
) -> tuple[dict, dict]:
    """每 cohort 最多保留 cap 条 (pt, ct) 供抽样。"""
    pm_rows: dict[tuple[str, str], list[tuple[int, int]]] = defaultdict(list)
    for r in conn.execute(text("""
        SELECT project_name, model_id, prompt_tokens, completion_tokens FROM (
            SELECT k.project_name, t.model_id, t.prompt_tokens, t.completion_tokens,
                   ROW_NUMBER() OVER (
                     PARTITION BY k.project_name, t.model_id ORDER BY random()
                   ) AS rn
            FROM usage_logs t
            JOIN api_keys k ON k.id = t.api_key_id
            WHERE t.status_code = '200'
              AND COALESCE(t.total_tokens, 0) > 0
              AND t.prompt_tokens IS NOT NULL
              AND t.completion_tokens IS NOT NULL
        ) x
        WHERE rn <= :cap
    """), {"cap": cap}).mappings():
        pm_rows[(r["project_name"], r["model_id"])].append(
            (int(r["prompt_tokens"]), int(r["completion_tokens"]))
        )
    pm = {
        k: v for k, v in pm_rows.items() if len(v) >= min_project
    }

    m_rows: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for r in conn.execute(text("""
        SELECT model_id, prompt_tokens, completion_tokens FROM (
            SELECT t.model_id, t.prompt_tokens, t.completion_tokens,
                   ROW_NUMBER() OVER (PARTITION BY t.model_id ORDER BY random()) AS rn
            FROM usage_logs t
            WHERE t.status_code = '200'
              AND COALESCE(t.total_tokens, 0) > 0
              AND t.prompt_tokens IS NOT NULL
              AND t.completion_tokens IS NOT NULL
        ) x
        WHERE rn <= :cap
    """), {"cap": cap}).mappings():
        m_rows[r["model_id"]].append(
            (int(r["prompt_tokens"]), int(r["completion_tokens"]))
        )
    m = {k: v for k, v in m_rows.items() if len(v) >= min_model}
    return pm, m


def _resolve_median(
    project: str, model: str, pm: dict, m: dict,
) -> PeerStat | None:
    hit = pm.get((project, model))
    if hit:
        return hit
    hit = m.get(model)
    return hit


def _resolve_sample(
    project: str, model: str, pm: dict, m: dict, rng: random.Random,
) -> PeerStat | None:
    rows = pm.get((project, model))
    source = "project_model"
    if not rows:
        rows = m.get(model)
        source = "model"
    if not rows:
        return None
    pt, ct = rng.choice(rows)
    return PeerStat(pt, ct, len(rows), source)


def _local_day(created_at: datetime, tz_name: str) -> str:
    """返回 ISO 日期字符串；SQL 侧用同一时区换算。"""
    from zoneinfo import ZoneInfo
    if created_at.tzinfo is None:
        utc = created_at.replace(tzinfo=ZoneInfo("UTC"))
    else:
        utc = created_at.astimezone(ZoneInfo("UTC"))
    return utc.astimezone(ZoneInfo(tz_name)).date().isoformat()


def _pricing_map(conn) -> dict[str, tuple[float | None, float | None]]:
    rows = conn.execute(text(
        "SELECT id, pricing_input, pricing_output FROM model_registry"
    )).mappings()
    return {r["id"]: (r["pricing_input"], r["pricing_output"]) for r in rows}


def _estimate_cost(model_id: str, pt: int, ct: int, pricing: dict) -> float:
    from app.industry_pricing import estimate_tokens_cost
    from types import SimpleNamespace
    pin, pout = pricing.get(model_id, (None, None))
    model = SimpleNamespace(id=model_id, pricing_input=pin, pricing_output=pout)
    return float(estimate_tokens_cost(pt, ct, model=model, model_id=model_id))


def plan_fills(
    conn,
    *,
    method: str,
    min_project: int,
    min_model: int,
    limit: int | None,
    seed: int,
    sample_cap: int,
) -> list[dict]:
    zeros = conn.execute(text(f"""
        SELECT u.id, u.api_key_id, u.model_id, u.created_at, k.project_name
        FROM usage_logs u
        JOIN api_keys k ON k.id = u.api_key_id
        WHERE {ZERO_PRED}
        ORDER BY u.created_at, u.id
        {"LIMIT :lim" if limit else ""}
    """), {"lim": limit} if limit else {}).mappings().all()

    rng = random.Random(seed)
    fills: list[dict] = []
    skipped = 0
    by_source: dict[str, int] = defaultdict(int)

    if method == "median":
        pm, m = _load_peer_medians(conn, min_project=min_project, min_model=min_model)
        for z in zeros:
            stat = _resolve_median(z["project_name"], z["model_id"], pm, m)
            if not stat:
                skipped += 1
                continue
            fills.append(_row_fill(z, stat.prompt, stat.completion, stat.source, stat.peers))
            by_source[stat.source] += 1
    else:
        pm, m = _load_peer_samples(
            conn, min_project=min_project, min_model=min_model, cap=sample_cap,
        )
        for z in zeros:
            stat = _resolve_sample(z["project_name"], z["model_id"], pm, m, rng)
            if not stat:
                skipped += 1
                continue
            fills.append(_row_fill(z, stat.prompt, stat.completion, stat.source, stat.peers))
            by_source[stat.source] += 1

    print(
        f"候选全空行: {len(zeros)}  可填充: {len(fills)}  无同行跳过: {skipped}  "
        f"来源={dict(by_source)}"
    )
    return fills


def _row_fill(z, pt: int, ct: int, source: str, peers: int) -> dict:
    pt = max(0, int(pt))
    ct = max(0, int(ct))
    return {
        "id": z["id"],
        "api_key_id": z["api_key_id"],
        "model_id": z["model_id"],
        "created_at": z["created_at"],
        "project_name": z["project_name"],
        "prompt_tokens": pt,
        "completion_tokens": ct,
        "total_tokens": pt + ct,
        "source": source,
        "peers": peers,
    }


def _print_preview(fills: list[dict], n: int = 8) -> None:
    if not fills:
        return
    print("预览（前几条）:")
    for f in fills[:n]:
        print(
            f"  {f['project_name'][:24]!r} / {f['model_id']}: "
            f"pt={f['prompt_tokens']} ct={f['completion_tokens']} "
            f"via={f['source']}(n={f['peers']})"
        )
    # cohort 汇总
    cohorts: dict[tuple[str, str], list[int]] = defaultdict(list)
    for f in fills:
        cohorts[(f["project_name"], f["model_id"])].append(f["total_tokens"])
    top = sorted(cohorts.items(), key=lambda kv: -len(kv[1]))[:8]
    print("按项目+模型填充规模（top）:")
    for (proj, mid), totals in top:
        avg = sum(totals) / len(totals)
        print(f"  {len(totals):5d} 行  avg_total≈{avg:.0f}  {proj[:28]!r} / {mid}")


def apply_fills(conn, fills: list[dict], *, batch_size: int = 500) -> None:
    from app.session_stats import context_bucket_index

    tz_name = _tz_name()
    pricing = _pricing_map(conn)

    for f in fills:
        f["estimated_cost"] = _estimate_cost(
            f["model_id"], f["prompt_tokens"], f["completion_tokens"], pricing,
        )
        f["day"] = _local_day(f["created_at"], tz_name)
        bkt = context_bucket_index(f["prompt_tokens"])
        f["bucket"] = bkt if bkt >= 0 else None

    upd_log = text("""
        UPDATE usage_logs SET
            prompt_tokens = :prompt_tokens,
            completion_tokens = :completion_tokens,
            total_tokens = :total_tokens,
            estimated_cost = :estimated_cost,
            usage_estimated = true
        WHERE id = :id
          AND COALESCE(prompt_tokens, 0) = 0
          AND COALESCE(completion_tokens, 0) = 0
          AND COALESCE(total_tokens, 0) = 0
    """)
    upd_profile = text("""
        UPDATE usage_request_profile SET prompt_tokens = :prompt_tokens
        WHERE id = :id
    """)

    updated = 0
    for i in range(0, len(fills), batch_size):
        chunk = fills[i : i + batch_size]
        for f in chunk:
            r = conn.execute(upd_log, {
                "id": f["id"],
                "prompt_tokens": f["prompt_tokens"],
                "completion_tokens": f["completion_tokens"],
                "total_tokens": f["total_tokens"],
                "estimated_cost": f["estimated_cost"],
            })
            if r.rowcount:
                updated += 1
                conn.execute(upd_profile, {
                    "id": f["id"], "prompt_tokens": f["prompt_tokens"],
                })
        print(f"  usage_logs/profile: {min(i + batch_size, len(fills))}/{len(fills)}")

    # 日汇总：按 (day, key, model) 累加本次填入的 token（calls 本来已计入，不改）
    daily: dict[tuple[str, str, str], dict[str, int]] = defaultdict(
        lambda: {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    )
    for f in fills:
        a = daily[(f["day"], f["api_key_id"], f["model_id"])]
        a["prompt_tokens"] += f["prompt_tokens"]
        a["completion_tokens"] += f["completion_tokens"]
        a["total_tokens"] += f["total_tokens"]

    upsert_daily = text("""
        INSERT INTO usage_daily_summary
            (day, api_key_id, model_id, calls, prompt_tokens, completion_tokens,
             total_tokens, cache_hit_tokens)
        VALUES
            (CAST(:day AS date), :api_key_id, :model_id, 0,
             :prompt_tokens, :completion_tokens, :total_tokens, 0)
        ON CONFLICT (day, api_key_id, model_id) DO UPDATE SET
            prompt_tokens = usage_daily_summary.prompt_tokens + EXCLUDED.prompt_tokens,
            completion_tokens = usage_daily_summary.completion_tokens + EXCLUDED.completion_tokens,
            total_tokens = usage_daily_summary.total_tokens + EXCLUDED.total_tokens
    """)
    for (day, key_id, model_id), vals in daily.items():
        conn.execute(upsert_daily, {
            "day": day, "api_key_id": key_id, "model_id": model_id, **vals,
        })
    print(f"  usage_daily_summary: 更新/插入 {len(daily)} 个 (day,key,model)")

    # 上下文分桶：原先 pt 为空未计入，这里补上
    buckets: dict[tuple[str, str, int], int] = defaultdict(int)
    for f in fills:
        if f["bucket"] is None:
            continue
        buckets[(f["day"], f["api_key_id"], f["bucket"])] += 1
    upsert_bkt = text("""
        INSERT INTO usage_context_bucket_daily (day, api_key_id, bucket, count)
        VALUES (CAST(:day AS date), :api_key_id, :bucket, :count)
        ON CONFLICT (day, api_key_id, bucket) DO UPDATE SET
            count = usage_context_bucket_daily.count + EXCLUDED.count
    """)
    for (day, key_id, bkt), cnt in buckets.items():
        conn.execute(upsert_bkt, {
            "day": day, "api_key_id": key_id, "bucket": bkt, "count": cnt,
        })
    print(f"  usage_context_bucket_daily: 更新/插入 {len(buckets)} 个桶")
    print(f"实际更新 usage_logs 行数: {updated}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="回填 200 且 token 全空的历史用量")
    p.add_argument("--apply", action="store_true", help="真正写库（默认仅 dry-run）")
    p.add_argument(
        "--method", choices=("median", "sample"), default="median",
        help="median=同 cohort 中位数（默认，稳健）；sample=从同行抽样（更「模拟」）",
    )
    p.add_argument("--min-peers-project", type=int, default=5,
                   help="同项目+同模型最少非零同行数（默认 5）")
    p.add_argument("--min-peers-model", type=int, default=20,
                   help="降级到同模型时最少非零同行数（默认 20）")
    p.add_argument("--sample-cap", type=int, default=500,
                   help="sample 模式下每个 cohort 缓存的同行上限")
    p.add_argument("--limit", type=int, default=None, help="最多处理 N 条（调试用）")
    p.add_argument("--seed", type=int, default=42, help="sample 随机种子")
    args = p.parse_args(argv)

    eng = _engine()
    with eng.connect() as conn:
        before = conn.execute(text(f"SELECT COUNT(*) FROM usage_logs WHERE {ZERO_PRED}")).scalar()
        print(f"当前全空 200 行: {before}")
        fills = plan_fills(
            conn,
            method=args.method,
            min_project=args.min_peers_project,
            min_model=args.min_peers_model,
            limit=args.limit,
            seed=args.seed,
            sample_cap=args.sample_cap,
        )
        _print_preview(fills)
        if not fills:
            print("无可填充行，退出")
            return 0
        if not args.apply:
            print("dry-run 结束（加 --apply 才会写库）")
            return 0

    with eng.begin() as conn:
        print("开始写库…")
        apply_fills(conn, fills)
        after = conn.execute(text(f"SELECT COUNT(*) FROM usage_logs WHERE {ZERO_PRED}")).scalar()
        print(f"写库完成。剩余全空 200 行: {after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
