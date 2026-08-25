"""Prometheus 指标：记录、渲染、容错。"""
from __future__ import annotations

from app import metrics


def test_record_relay_and_render():
    metrics.record_relay({
        "model_id": "m-test", "status_code": "200",
        "latency_ms": 120, "total_duration_ms": 950,
        "prompt_tokens": 10, "completion_tokens": 5,
    })
    metrics.record_relay({"model_id": "m-test", "status_code": "429"})
    data, ctype = metrics.render_metrics()
    text = data.decode()
    assert 'apiplatform_relay_requests_total{model="m-test",status="200"}' in text
    assert 'apiplatform_relay_requests_total{model="m-test",status="429"}' in text
    assert "apiplatform_relay_ttft_seconds_bucket" in text
    assert 'apiplatform_relay_tokens_total{kind="prompt",model="m-test"}' in text \
        or 'apiplatform_relay_tokens_total{model="m-test",kind="prompt"}' in text
    assert "text" in ctype


def test_record_relay_swallows_bad_input():
    metrics.record_relay({})  # 全缺省不炸
    metrics.record_relay({"model_id": None, "latency_ms": "not-a-number"})


def test_usage_writer_gauge_and_dropped():
    from app.usage_writer import UsageWriter

    w = UsageWriter()
    w.enqueue({"api_key_id": "k", "model_id": "m", "status_code": "200"})
    data, _ = metrics.render_metrics()
    assert b"apiplatform_usage_queue_depth" in data
    assert b"apiplatform_usage_failover_pending" in data
    assert b"apiplatform_usage_failover_persisted_total" in data
    assert b"apiplatform_usage_failover_recovery_failures_total" in data
    assert b"apiplatform_backup_age_seconds" in data
    assert b"apiplatform_backup_verified" in data
    assert b"apiplatform_backup_stale" in data
