"""Infrastructure fleet summaries backed by the administrator registry.

The repository ships only a tiny, explicitly fictional topology so a fresh
installation does not render an empty screen. As soon as an administrator
registers any infrastructure resource, ``InfraResourceORM`` becomes the sole
source of truth and the demo fixture is no longer returned.
"""
from __future__ import annotations

from math import ceil

from sqlalchemy import bindparam, select, text
from sqlalchemy.orm import Session

from app.models import InfraResourceORM
from app.proxy.routing import _find_model_record


SYNTHETIC_DEMO_CLUSTERS: tuple[dict, ...] = (
    {
        "id": "demo-node-a",
        "pool": "primary",
        "tier": "demo",
        "chip": "DEMO-ACCEL-A",
        "vram_gb": 24,
        "gpu_count": 2,
        "node_count": 1,
        "gpus_per_node": 2,
        "model_label": "demo-chat-model",
        "synthetic": True,
    },
    {
        "id": "demo-node-b",
        "pool": "secondary",
        "tier": "demo",
        "chip": "DEMO-ACCEL-B",
        "vram_gb": 16,
        "gpu_count": 1,
        "node_count": 1,
        "gpus_per_node": 1,
        "model_label": "demo-embedding-model",
        "synthetic": True,
    },
)


def _non_negative_int(value: object, default: int = 0) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0, parsed)


def _registered_clusters(resources: list[InfraResourceORM]) -> list[dict]:
    clusters: list[dict] = []
    for resource in resources:
        if resource.kind != "server":
            continue
        extra = resource.extra if isinstance(resource.extra, dict) else {}
        accelerator_count = _non_negative_int(
            extra.get("accelerator_count", extra.get("gpu_count")),
        )
        node_count = _non_negative_int(extra.get("node_count"), 1) or 1
        per_node_default = ceil(accelerator_count / node_count) if accelerator_count else 0
        clusters.append({
            "id": resource.id,
            "pool": resource.pool or "registered",
            "tier": "registered",
            "chip": str(extra.get("chip") or "UNSPECIFIED").strip() or "UNSPECIFIED",
            "vram_gb": _non_negative_int(extra.get("vram_gb")),
            "gpu_count": accelerator_count,
            "node_count": node_count,
            "gpus_per_node": _non_negative_int(extra.get("accelerators_per_node"), per_node_default),
            "model_label": str(extra.get("model_label") or resource.subtitle or "Registered workload").strip(),
            "synthetic": False,
        })
    return clusters


def _fleet_payload(clusters: list[dict], *, source: str) -> dict:
    total_gpus = sum(cluster["gpu_count"] for cluster in clusters)
    total_vram_gb = sum(cluster["gpu_count"] * cluster["vram_gb"] for cluster in clusters)
    chip_counts: dict[str, int] = {}
    for cluster in clusters:
        chip = cluster["chip"]
        chip_counts[chip] = chip_counts.get(chip, 0) + cluster["gpu_count"]
    return {
        "source": source,
        "is_demo": source == "synthetic_demo",
        "summary": {
            "cluster_count": len(clusters),
            "total_gpus": total_gpus,
            "total_vram_gb": total_vram_gb,
            "total_vram_tb": round(total_vram_gb / 1024, 2),
            "total_nodes": sum(cluster["node_count"] for cluster in clusters),
            "chip_counts": chip_counts,
        },
        "clusters": clusters,
    }


def build_fleet(db: Session | None = None) -> dict:
    """Build a fleet summary, preferring administrator-registered resources.

    ``db=None`` is reserved for tests and documentation previews and always
    returns the fictional fixture. A database containing any infrastructure
    row never falls back to demo hardware, even if no server exists yet.
    """
    if db is None:
        return _fleet_payload([dict(cluster) for cluster in SYNTHETIC_DEMO_CLUSTERS], source="synthetic_demo")

    resources = db.execute(
        select(InfraResourceORM).order_by(InfraResourceORM.created_at, InfraResourceORM.name)
    ).scalars().all()
    if resources:
        return _fleet_payload(_registered_clusters(resources), source="registry")
    return _fleet_payload([dict(cluster) for cluster in SYNTHETIC_DEMO_CLUSTERS], source="synthetic_demo")


def build_static_fleet() -> dict:
    """Backward-compatible demo preview; production endpoints use ``build_fleet``."""
    return build_fleet()


DEMO_TOPOLOGY_MODEL_NODES: frozenset[str] = frozenset({
    "demo-model-chat",
    "demo-model-embedding",
})

_SYNTHETIC_ALIAS_RESOLVE: dict[str, str] = {
    "platform-sota": "demo-chat-model",
    "platform-flash": "demo-chat-model",
}

_DEMO_MODEL_ID_TO_NODE: tuple[tuple[str, str], ...] = (
    ("demo-embedding", "demo-model-embedding"),
    ("demo-chat", "demo-model-chat"),
)


def _model_node_id(model_id: str) -> str | None:
    """Map only explicitly synthetic model IDs to the empty-install graph."""
    lowered = (model_id or "").casefold()
    for needle, node_id in _DEMO_MODEL_ID_TO_NODE:
        if needle in lowered:
            return node_id
    return None


def _resolve_to_physical_model_id(db: Session, model_id: str) -> str:
    """Follow ``model_registry.resolve_to_model_id`` without deployment guesses."""
    current = (model_id or "").strip()
    if not current:
        return current

    seen: set[str] = set()
    for _ in range(5):
        key = current.casefold()
        if key in seen:
            break
        seen.add(key)

        record = _find_model_record(db, current)
        if record is None:
            return _SYNTHETIC_ALIAS_RESOLVE.get(key, current)
        if not record.resolve_to_model_id:
            return record.id
        current = record.resolve_to_model_id.strip()

    return current


def _resource_model_aliases(resource: InfraResourceORM) -> set[str]:
    extra = resource.extra if isinstance(resource.extra, dict) else {}
    aliases: list[object] = [resource.id, resource.name, extra.get("model_id")]
    for key in ("model_ids", "aliases"):
        value = extra.get(key)
        if isinstance(value, list):
            aliases.extend(value)
    return {
        str(alias).strip().casefold()
        for alias in aliases
        if alias is not None and str(alias).strip()
    }


def _topology_model_node(db: Session, model_id: str) -> str | None:
    """Resolve usage to a registered model node, or to the empty-install demo."""
    registered_models = db.execute(
        select(InfraResourceORM).where(InfraResourceORM.kind == "model")
    ).scalars().all()
    physical = _resolve_to_physical_model_id(db, model_id)
    candidates = {physical.casefold(), (model_id or "").strip().casefold()}
    if registered_models:
        for resource in registered_models:
            if candidates & _resource_model_aliases(resource):
                return resource.id
        return None

    node_id = _model_node_id(physical) or _model_node_id(model_id)
    return node_id if node_id in DEMO_TOPOLOGY_MODEL_NODES else None


def get_top_projects(db: Session, *, limit: int = 5, days: int = 90) -> list[dict]:
    """Return the highest-volume runtime projects for the admin-only topology."""
    rows = db.execute(text("""
        SELECT k.project_name AS project,
               MAX(k.scene_type) AS scene_type,
               SUM(s.calls) AS calls
        FROM usage_daily_summary s
        JOIN api_keys k ON s.api_key_id = k.id
        WHERE s.day >= current_date - CAST(:interval AS INTERVAL)
          AND COALESCE(k.project_name, '') <> ''
        GROUP BY k.project_name
        ORDER BY calls DESC
        LIMIT :limit
    """), {"interval": f"{days} days", "limit": limit}).fetchall()

    if not rows:
        return []

    projects = {
        row.project: {
            "project": row.project,
            "scene_type": row.scene_type or "explore",
            "calls": int(row.calls or 0),
            "model_ids": set(),
        }
        for row in rows
    }

    model_stmt = text("""
        SELECT k.project_name AS project, s.model_id AS model_id, SUM(s.calls) AS calls
        FROM usage_daily_summary s
        JOIN api_keys k ON s.api_key_id = k.id
        WHERE s.day >= current_date - CAST(:interval AS INTERVAL)
          AND k.project_name IN :projects
        GROUP BY k.project_name, s.model_id
    """).bindparams(bindparam("projects", expanding=True))
    model_rows = db.execute(
        model_stmt,
        {"interval": f"{days} days", "projects": list(projects.keys())},
    ).fetchall()
    for row in model_rows:
        node_id = _topology_model_node(db, row.model_id)
        if node_id:
            projects[row.project]["model_ids"].add(node_id)

    ordered = sorted(projects.values(), key=lambda project: project["calls"], reverse=True)
    return [
        {
            "id": f"proj-{index}",
            "project": project["project"],
            "scene_type": project["scene_type"],
            "calls": project["calls"],
            "model_ids": sorted(project["model_ids"]),
        }
        for index, project in enumerate(ordered)
    ]
