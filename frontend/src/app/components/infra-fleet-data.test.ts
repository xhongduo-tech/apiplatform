import { describe, expect, it } from "vitest";

import {
  clustersFromApi,
  computeFleetSummary,
  SYNTHETIC_DEMO_FLEET,
  type InfraFleetResponse,
} from "./infra-fleet-data";

describe("infrastructure fleet data", () => {
  it("ships only a small, unmistakably synthetic fallback", () => {
    expect(SYNTHETIC_DEMO_FLEET).toHaveLength(2);
    expect(SYNTHETIC_DEMO_FLEET.every((cluster) => cluster.synthetic)).toBe(true);
    expect(SYNTHETIC_DEMO_FLEET.map((cluster) => cluster.id)).toEqual([
      "demo-node-a",
      "demo-node-b",
    ]);
  });

  it("normalizes administrator registry payloads and computes their totals", () => {
    const payload: InfraFleetResponse = {
      source: "registry",
      is_demo: false,
      clusters: [{
        id: "registered-server",
        pool: "primary",
        tier: "registered",
        chip: "CUSTOM-ACCEL",
        vram_gb: 48,
        gpu_count: 4,
        node_count: 2,
        gpus_per_node: 2,
        model_label: "custom-model",
        synthetic: false,
      }],
    };

    const clusters = clustersFromApi(payload);
    expect(clusters[0]).toMatchObject({
      id: "registered-server",
      chip: "CUSTOM-ACCEL",
      gpuCount: 4,
      synthetic: false,
    });
    expect(computeFleetSummary(clusters)).toEqual({
      clusterCount: 1,
      totalGpus: 4,
      totalVramGb: 192,
      totalVramTb: 0.19,
      totalNodes: 2,
      chipCounts: { "CUSTOM-ACCEL": 4 },
    });
  });
});
