#!/usr/bin/env python3
"""Open API Platform 容量标定 —— 测出某模型在当前引擎参数下的吞吐拐点。

原理：对模型按 1,2,4,8,… 逐档加并发，每档跑固定时长，记录达成吞吐(req/s)与
p95 延迟。吞吐进入"拐点"（再加并发吞吐基本不涨、延迟却快速上升）即为饱和点。

标定对象是**推理引擎自身的准入参数**（vLLM `--max-num-seqs` / SGLang
`--max-running-requests`），不是网关——网关侧不承担并发准入，流量会直接
移除，调度权归引擎（见 docs/scheduling.md）。拐点值宁低勿高：偏高会因 KV
抢占抖动拖垮所有人的 TTFT。

示例：
  python scripts/calibrate.py --base http://127.0.0.1:8021 --model platform-flash \\
      --key sk-platform-xxx --levels 1,2,4,8,16,32,64,128 --secs 6
依赖：httpx。
"""
from __future__ import annotations

import argparse
import asyncio
import time


async def _run_level(client, url, key, model, concurrency, secs):
    payload = {"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 16}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    latencies: list[float] = []
    errors = 0
    stop = time.monotonic() + secs

    async def w():
        nonlocal errors
        while time.monotonic() < stop:
            t0 = time.monotonic()
            try:
                r = await client.post(url, headers=headers, json=payload)
                if 200 <= r.status_code < 300:
                    latencies.append((time.monotonic() - t0) * 1000)
                else:
                    errors += 1
            except Exception:
                errors += 1

    t0 = time.monotonic()
    await asyncio.gather(*[w() for _ in range(concurrency)])
    elapsed = time.monotonic() - t0
    n = len(latencies)
    thr = n / elapsed if elapsed else 0.0
    p95 = sorted(latencies)[min(int(n * 0.95), n - 1)] if n else 0.0
    return {"concurrency": concurrency, "throughput": thr, "p95": p95, "ok": n, "errors": errors}


def _pick_knee(rows: list[dict]) -> int:
    """拐点：吞吐相对上一档增幅 < 10%，或出现错误，则上一档为安全 C。"""
    best = rows[0]["concurrency"]
    for i in range(1, len(rows)):
        prev, cur = rows[i - 1], rows[i]
        if cur["errors"] > 0:
            return prev["concurrency"]
        gain = (cur["throughput"] - prev["throughput"]) / prev["throughput"] if prev["throughput"] else 1.0
        if gain < 0.10:           # 吞吐基本不再增长 → 饱和
            return prev["concurrency"]
        best = cur["concurrency"]
    return best


async def main(args):
    import httpx
    url = f"{args.base.rstrip('/')}/v1/chat/completions"
    levels = [int(x) for x in args.levels.split(",")]
    rows = []
    async with httpx.AsyncClient(timeout=120) as client:
        print(f"模型 {args.model} 标定中（每档 {args.secs}s）…\n")
        print(f"{'并发':>6} {'吞吐(req/s)':>12} {'p95(ms)':>10} {'成功':>6} {'错误':>6}")
        for lv in levels:
            r = await _run_level(client, url, args.key, args.model, lv, args.secs)
            rows.append(r)
            print(f"{r['concurrency']:>6} {r['throughput']:>12.1f} {r['p95']:>10.0f} {r['ok']:>6} {r['errors']:>6}")
            if r["errors"] > 0:
                print("  （该档出现错误，停止加压）")
                break

    C = _pick_knee(rows)
    print("\n" + "=" * 56)
    print(f"吞吐拐点并发 = {C}")
    print("=" * 56)
    print("作为该节点引擎准入参数的上限参考：")
    print("  vLLM    --max-num-seqs <= %d" % C)
    print("  SGLang  --max-running-requests <= %d" % C)
    print("网关不设并发上限，无需在平台侧填任何数值。")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8021")
    ap.add_argument("--model", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--levels", default="1,2,4,8,16,32,64,128")
    ap.add_argument("--secs", type=int, default=6)
    asyncio.run(main(ap.parse_args()))
