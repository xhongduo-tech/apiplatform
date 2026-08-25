"""Synthetic fallback and administrator-owned infrastructure fleet tests."""
from unittest.mock import MagicMock

from app.infra_fleet import (
    SYNTHETIC_DEMO_CLUSTERS,
    _model_node_id,
    _resolve_to_physical_model_id,
    _topology_model_node,
    build_fleet,
)
from app.models import InfraResourceORM, ModelRegistryORM


def _db_with_resources(resources: list[InfraResourceORM]) -> MagicMock:
    db = MagicMock()
    db.execute.return_value.scalars.return_value.all.return_value = resources
    return db


def test_empty_install_uses_small_explicitly_synthetic_fleet():
    payload = build_fleet()

    assert payload["source"] == "synthetic_demo"
    assert payload["is_demo"] is True
    assert payload["clusters"] == list(SYNTHETIC_DEMO_CLUSTERS)
    assert len(payload["clusters"]) == 2
    assert all(cluster["synthetic"] is True for cluster in payload["clusters"])
    assert all(cluster["id"].startswith("demo-node-") for cluster in payload["clusters"])
    assert set(payload["summary"]["chip_counts"]) == {"DEMO-ACCEL-A", "DEMO-ACCEL-B"}


def test_registered_servers_are_authoritative_for_fleet_summary():
    server = InfraResourceORM(
        id="registered-server-1",
        kind="server",
        name="Administrator Node",
        subtitle="Registered workload",
        pool="primary",
        extra={
            "chip": "CUSTOM-ACCEL",
            "accelerator_count": 4,
            "vram_gb": 48,
            "node_count": 2,
            "accelerators_per_node": 2,
            "model_label": "custom-model",
        },
    )
    payload = build_fleet(_db_with_resources([server]))

    assert payload["source"] == "registry"
    assert payload["is_demo"] is False
    assert [cluster["id"] for cluster in payload["clusters"]] == ["registered-server-1"]
    assert payload["summary"] == {
        "cluster_count": 1,
        "total_gpus": 4,
        "total_vram_gb": 192,
        "total_vram_tb": 0.19,
        "total_nodes": 2,
        "chip_counts": {"CUSTOM-ACCEL": 4},
    }


def test_any_registry_data_disables_demo_fallback_even_without_server():
    model = InfraResourceORM(
        id="registered-model-1",
        kind="model",
        name="custom-model",
        subtitle="",
        extra={"model_id": "vendor/custom-model"},
    )
    payload = build_fleet(_db_with_resources([model]))

    assert payload["source"] == "registry"
    assert payload["clusters"] == []
    assert payload["summary"]["total_gpus"] == 0


def test_demo_model_mapping_does_not_encode_real_deployments():
    assert _model_node_id("demo-chat-model") == "demo-model-chat"
    assert _model_node_id("demo-embedding-model") == "demo-model-embedding"
    assert _model_node_id("vendor-production-model") is None
    assert _model_node_id("unrelated-model") is None
    assert _model_node_id("") is None


def _registry(records: dict[str, ModelRegistryORM]):
    def lookup(_db, model_id: str):
        record = records.get(model_id)
        if record is not None:
            return record
        needle = model_id.casefold()
        for item in records.values():
            if item.id.casefold() == needle or (item.name or "").casefold() == needle:
                return item
        return None

    return lookup


def test_resolve_generic_alias_to_physical_model(monkeypatch):
    db = MagicMock()
    models = {
        "platform-sota": ModelRegistryORM(
            id="platform-sota",
            name="platform-sota",
            category="lts",
            resolve_to_model_id="vendor/custom-model",
        ),
        "vendor/custom-model": ModelRegistryORM(
            id="vendor/custom-model",
            name="Custom Model",
        ),
    }
    monkeypatch.setattr("app.infra_fleet._find_model_record", _registry(models))

    assert _resolve_to_physical_model_id(db, "platform-sota") == "vendor/custom-model"


def test_registered_model_alias_is_authoritative(monkeypatch):
    resource = InfraResourceORM(
        id="registered-model-1",
        kind="model",
        name="Custom Model",
        subtitle="",
        extra={"model_id": "vendor/custom-model", "aliases": ["custom-alias"]},
    )
    db = _db_with_resources([resource])
    monkeypatch.setattr("app.infra_fleet._find_model_record", lambda _db, _model_id: None)

    assert _topology_model_node(db, "vendor/custom-model") == "registered-model-1"
    assert _topology_model_node(db, "custom-alias") == "registered-model-1"
    assert _topology_model_node(db, "unregistered-model") is None


def test_synthetic_alias_fallback_is_limited_to_demo_graph(monkeypatch):
    db = _db_with_resources([])
    monkeypatch.setattr("app.infra_fleet._find_model_record", lambda _db, _model_id: None)

    assert _topology_model_node(db, "platform-sota") == "demo-model-chat"
    assert _topology_model_node(db, "platform-flash") == "demo-model-chat"
    assert _topology_model_node(db, "vendor-production-model") is None
