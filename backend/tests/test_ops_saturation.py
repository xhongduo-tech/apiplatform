"""容量饱和体检单测：_detect_anomalies 对 saturation 指标的判定规则。"""
from app.ops_report import _detect_anomalies


def _metrics(saturation: list[dict]) -> dict:
    """构造 _detect_anomalies 所需的最小指标结构（其余检查不触发）。"""
    return {
        "totals": {
            "requests": 100, "success": 100, "errors": 0, "error_rate": 0.0,
            "total_tokens": 1000, "avg_latency_ms": 500, "max_latency_ms": 2000,
            "prompt_tokens": 500, "completion_tokens": 500, "cost": 0.0,
        },
        "compare": {
            "requests_prev": 100, "requests_delta_pct": 0.0,
            "tokens_prev": 1000, "tokens_delta_pct": 0.0,
            "cost_prev": 0.0, "cost_delta_pct": 0.0, "error_rate_prev": 0.0,
        },
        "by_model": [],
        "by_project": [],
        "peak_hour": {"hour": 10, "label": "10:00", "requests": 10},
        "saturation": saturation,
    }


def test_inflation_over_threshold_warns_saturation():
    m = _metrics([{
        "model_id": "m1", "requests": 500, "baseline_ms": 400, "peak_ms": 8000,
        "peak_hour": 14, "inflation": 20.0,
    }])
    anomalies = _detect_anomalies(m)
    sat = [a for a in anomalies if a["code"] == "saturation_suspect"]
    assert len(sat) == 1
    assert sat[0]["level"] == "warning"
    assert "m1" in sat[0]["message"]
    assert "max_num_seqs" in sat[0]["message"]


def test_mild_inflation_stays_silent():
    m = _metrics([{
        "model_id": "m2", "requests": 500, "baseline_ms": 400, "peak_ms": 600,
        "peak_hour": 14, "inflation": 1.5,
    }])
    codes = {a["code"] for a in _detect_anomalies(m)}
    assert "saturation_suspect" not in codes


def test_no_signal_when_inflation_unknown():
    """样本不足（inflation=None）：不产生容量类告警。"""
    m = _metrics([{
        "model_id": "m3", "requests": 5, "baseline_ms": None, "peak_ms": None,
        "peak_hour": None, "inflation": None,
    }])
    codes = {a["code"] for a in _detect_anomalies(m)}
    assert "saturation_suspect" not in codes
