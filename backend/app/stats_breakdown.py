"""统计看板"查看全部"通用聚合：project/model/user/department/scene 五个维度共用一套
查询逻辑，支持搜索、排序、分页，并额外返回不受分页影响的全量汇总（用于前端"自动 sum"）。

被 app/routers/admin_stats.py（四个维度 + 成本）与 app/routers/public.py
（仅 project/model/scene，不含成本——与既有 platform-status 的公开口径一致）共用。
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.platform_time import sql_tz_param

# 场景分类不再在此硬编码：由 scene_types 表维护（admin 可增删改），public.py 的
# by_scene、申请表单与统计 scene 维度都从该表读取标签与顺序；本模块的 scene 维度
# 只负责按 api_keys.scene_type 分组，展示名由调用方查表补充。

# 维度 → SQL 片段。key 是白名单常量（不接受外部输入拼接），无注入风险；
# 调用方必须先校验 dimension in DIMENSIONS 再传入。
DIMENSIONS: dict[str, dict[str, str]] = {
    "project": {
        "join": "JOIN api_keys k ON l.api_key_id = k.id",
        "label": "COALESCE(k.project_name, '（未命名项目）')",
        "search": "COALESCE(k.project_name, '') ILIKE :q",
    },
    "model": {
        "join": "",
        "label": "l.model_id",
        "search": "l.model_id ILIKE :q",
    },
    "department": {
        "join": "JOIN api_keys k ON l.api_key_id = k.id",
        "label": "COALESCE(k.department, '（未分配部门）')",
        "search": "COALESCE(k.department, '') ILIKE :q",
    },
    "user": {
        "join": "JOIN api_keys k ON l.api_key_id = k.id",
        "label": "k.auth_id",
        "search": "k.auth_id ILIKE :q",
    },
    "scene": {
        "join": "JOIN api_keys k ON l.api_key_id = k.id",
        "label": "COALESCE(k.scene_type, 'explore')",
        "search": "COALESCE(k.scene_type, '') ILIKE :q",
    },
}

# 允许排序的字段 → 对应的 SQL 聚合表达式（与 SELECT 里的别名一致）
_SORT_COLS = {
    "calls", "tokens", "prompt_tokens", "completion_tokens",
    "cache_hit_tokens", "avg_latency", "cost",
}


def _row_dict(r, *, with_label: bool, include_cost: bool) -> dict:
    calls = r.calls or 0
    prompt_tokens = r.prompt_tokens or 0
    out = {
        "calls": calls,
        "tokens": int(r.tokens or 0),
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(r.completion_tokens or 0),
        "cache_hit_tokens": int(r.cache_hit_tokens or 0),
        "cache_hit_rate": round((r.cache_hit_tokens or 0) / prompt_tokens * 100, 1) if prompt_tokens else 0.0,
        "avg_latency_ms": round(r.avg_latency or 0),
        "success_rate": round((r.success_count or 0) / calls * 100, 1) if calls else 0.0,
    }
    if with_label:
        out["label"] = r.label
    if include_cost:
        out["cost"] = round(float(r.cost or 0), 6)
    return out


def query_breakdown(
    db: Session,
    *,
    dimension: str,
    days: int,
    search: str | None,
    sort_field: str,
    sort_dir: str,
    limit: int,
    offset: int,
    include_cost: bool,
) -> dict:
    """返回 {rows, total_groups, totals}。

    rows：当前页的维度分组明细（按 sort_field/sort_dir 排序）。
    total_groups：命中搜索条件的分组总数（用于分页 UI，"共 N 项"）。
    totals：命中搜索条件的全部分组汇总（不受 limit/offset 影响）——前端筛选/
    搜索后展示的"合计"必须来自这里，而不是对当前页 rows 求和，否则翻页或
    收窄搜索后合计数会跟着页码变，误导用户。
    """
    if dimension not in DIMENSIONS:
        raise ValueError(f"unknown dimension: {dimension}")
    cfg = DIMENSIONS[dimension]
    sort_col = sort_field if sort_field in _SORT_COLS else "calls"
    if sort_col == "cost" and not include_cost:
        sort_col = "calls"
    sort_dir_sql = "ASC" if str(sort_dir).lower() == "asc" else "DESC"
    cost_expr = "SUM(COALESCE(l.estimated_cost, 0))" if include_cost else "0"

    params: dict = {"interval": f"{days} days", "limit": limit, "offset": offset}
    search_clause = ""
    if search and search.strip():
        search_clause = f"AND {cfg['search']}"
        params["q"] = f"%{search.strip()}%"

    rows = db.execute(text(f"""
        SELECT {cfg['label']} AS label,
               COUNT(l.id) AS calls,
               SUM(COALESCE(l.total_tokens, 0)) AS tokens,
               SUM(COALESCE(l.prompt_tokens, 0)) AS prompt_tokens,
               SUM(COALESCE(l.completion_tokens, 0)) AS completion_tokens,
               SUM(COALESCE(l.cache_hit_tokens, 0)) AS cache_hit_tokens,
               AVG(COALESCE(l.latency_ms, 0)) AS avg_latency,
               COUNT(*) FILTER (WHERE l.status_code LIKE '2%') AS success_count,
               {cost_expr} AS cost
        FROM usage_logs l
        {cfg['join']}
        WHERE l.created_at >= now() - CAST(:interval AS INTERVAL)
        {search_clause}
        GROUP BY {cfg['label']}
        ORDER BY {sort_col} {sort_dir_sql} NULLS LAST, label ASC
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    totals_row = db.execute(text(f"""
        SELECT COUNT(DISTINCT {cfg['label']}) AS total_groups,
               COUNT(l.id) AS calls,
               SUM(COALESCE(l.total_tokens, 0)) AS tokens,
               SUM(COALESCE(l.prompt_tokens, 0)) AS prompt_tokens,
               SUM(COALESCE(l.completion_tokens, 0)) AS completion_tokens,
               SUM(COALESCE(l.cache_hit_tokens, 0)) AS cache_hit_tokens,
               AVG(COALESCE(l.latency_ms, 0)) AS avg_latency,
               COUNT(*) FILTER (WHERE l.status_code LIKE '2%') AS success_count,
               {cost_expr} AS cost
        FROM usage_logs l
        {cfg['join']}
        WHERE l.created_at >= now() - CAST(:interval AS INTERVAL)
        {search_clause}
    """), params).fetchone()

    return {
        "rows": [_row_dict(r, with_label=True, include_cost=include_cost) for r in rows],
        "total_groups": int(totals_row.total_groups or 0) if totals_row else 0,
        "totals": _row_dict(totals_row, with_label=False, include_cost=include_cost) if totals_row else None,
    }


# 永久汇总表口径：公开页 / 用户看板 / 管理看板的「查看全部」共用。
# summary 无 status/latency/cost，avg_latency_ms / success_rate / cost 返回 None。
_SUMMARY_DIMENSIONS: dict[str, dict[str, str]] = {
    "model": {
        "label": "s.model_id",
        "search": "s.model_id ILIKE :q",
    },
    "scene": {
        "label": "COALESCE(k.scene_type, 'explore')",
        "search": "COALESCE(k.scene_type, '') ILIKE :q",
    },
    "project": {
        "label": "COALESCE(k.project_name, '（未命名项目）')",
        "search": "COALESCE(k.project_name, '') ILIKE :q",
    },
    "department": {
        "label": "COALESCE(k.department, '（未分配部门）')",
        "search": "COALESCE(k.department, '') ILIKE :q",
    },
    "user": {
        "label": "k.auth_id",
        "search": "k.auth_id ILIKE :q",
    },
}
_SUMMARY_SORT = {"calls", "tokens", "prompt_tokens", "completion_tokens", "cache_hit_tokens"}
_SUMMARY_FILTER: dict[str, str] = {
    "model": "s.model_id = :filter_value",
    "scene": "COALESCE(k.scene_type, 'explore') = :filter_value",
    "project": "COALESCE(k.project_name, '（未命名项目）') = :filter_value",
    "department": "COALESCE(k.department, '（未分配部门）') = :filter_value",
    "user": "k.auth_id = :filter_value",
}


def _summary_needs_key_join(dimension: str, filter_dimension: str | None) -> bool:
    if dimension in ("scene", "project", "department", "user"):
        return True
    if filter_dimension in ("scene", "project", "department", "user"):
        return True
    return False


def query_summary_breakdown(
    db: Session,
    *,
    dimension: str,
    days: int,
    search: str | None,
    sort_field: str,
    sort_dir: str,
    limit: int,
    offset: int,
    key_ids: list[str] | None = None,
    filter_dimension: str | None = None,
    filter_value: str | None = None,
) -> dict:
    """usage_daily_summary 口径的分页明细；可选限定密钥集合与交叉维度筛选。"""
    if dimension not in _SUMMARY_DIMENSIONS:
        raise ValueError(f"unknown dimension: {dimension}")
    if filter_dimension and filter_dimension not in _SUMMARY_FILTER:
        raise ValueError(f"unknown filter dimension: {filter_dimension}")

    cfg = _SUMMARY_DIMENSIONS[dimension]
    sort_col = sort_field if sort_field in _SUMMARY_SORT else "calls"
    sort_dir_sql = "ASC" if str(sort_dir).lower() == "asc" else "DESC"

    params: dict = {"interval": f"{days} days", "limit": limit, "offset": offset}
    params.update(sql_tz_param())

    search_clause = ""
    if search and search.strip():
        search_clause = f"AND {cfg['search']}"
        params["q"] = f"%{search.strip()}%"

    key_clause = ""
    if key_ids:
        key_clause = "AND s.api_key_id = ANY(:key_ids)"
        params["key_ids"] = key_ids

    cross_clause = ""
    if filter_dimension and filter_value and filter_value.strip():
        cross_clause = f"AND {_SUMMARY_FILTER[filter_dimension]}"
        params["filter_value"] = filter_value.strip()

    join_clause = ""
    if _summary_needs_key_join(dimension, filter_dimension) or key_ids:
        join_clause = "LEFT JOIN api_keys k ON s.api_key_id = k.id"

    label_expr = cfg["label"]
    base_from = f"""
        FROM usage_daily_summary s
        {join_clause}
        WHERE s.day >= date((now() AT TIME ZONE :tz)) - CAST(:interval AS INTERVAL)
        {key_clause}
        {cross_clause}
        {search_clause}
    """

    rows = db.execute(text(f"""
        SELECT {label_expr} AS label,
               SUM(s.calls) AS calls,
               SUM(s.total_tokens) AS tokens,
               SUM(s.prompt_tokens) AS prompt_tokens,
               SUM(s.completion_tokens) AS completion_tokens,
               SUM(s.cache_hit_tokens) AS cache_hit_tokens
        {base_from}
        GROUP BY {label_expr}
        ORDER BY {sort_col} {sort_dir_sql} NULLS LAST, label ASC
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    totals_row = db.execute(text(f"""
        SELECT COUNT(DISTINCT {label_expr}) AS total_groups,
               SUM(s.calls) AS calls,
               SUM(s.total_tokens) AS tokens,
               SUM(s.prompt_tokens) AS prompt_tokens,
               SUM(s.completion_tokens) AS completion_tokens,
               SUM(s.cache_hit_tokens) AS cache_hit_tokens
        {base_from}
    """), params).fetchone()

    def _fmt(r, *, with_label: bool):
        calls = r.calls or 0
        prompt = r.prompt_tokens or 0
        out = {
            "calls": calls,
            "tokens": int(r.tokens or 0),
            "prompt_tokens": int(prompt),
            "completion_tokens": int(r.completion_tokens or 0),
            "cache_hit_tokens": int(r.cache_hit_tokens or 0),
            "cache_hit_rate": round((r.cache_hit_tokens or 0) / prompt * 100, 1) if prompt else 0.0,
            "avg_latency_ms": None,
            "success_rate": None,
            "cost": None,
        }
        if with_label:
            out["label"] = r.label
        return out

    return {
        "rows": [_fmt(r, with_label=True) for r in rows],
        "total_groups": int(totals_row.total_groups or 0) if totals_row else 0,
        "totals": _fmt(totals_row, with_label=False) if totals_row else None,
    }


def query_public_breakdown(
    db: Session,
    *,
    dimension: str,
    days: int,
    search: str | None,
    sort_field: str,
    sort_dir: str,
    limit: int,
    offset: int,
    filter_dimension: str | None = None,
    filter_value: str | None = None,
) -> dict:
    """公开页 model/scene 两个维度的汇总口径明细。"""
    return query_summary_breakdown(
        db, dimension=dimension, days=days, search=search,
        sort_field=sort_field, sort_dir=sort_dir, limit=limit, offset=offset,
        filter_dimension=filter_dimension, filter_value=filter_value,
    )
