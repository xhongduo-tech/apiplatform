/**
 * Empty-install infrastructure preview.
 *
 * These two fictional nodes are deliberately small and unmistakably synthetic.
 * The admin API replaces them with InfraResourceORM data as soon as any resource
 * is registered.
 */
export type InfraCluster = {
  id: string;
  pool: string;
  tier: "demo" | "registered";
  chip: string;
  vramGb: number;
  gpuCount: number;
  nodeCount: number;
  gpusPerNode: number;
  modelLabel: string;
  synthetic: boolean;
};

export type InfraFleetResponse = {
  source: "synthetic_demo" | "registry";
  is_demo: boolean;
  clusters: Array<{
    id: string;
    pool: string;
    tier: "demo" | "registered";
    chip: string;
    vram_gb: number;
    gpu_count: number;
    node_count: number;
    gpus_per_node: number;
    model_label: string;
    synthetic: boolean;
  }>;
};

export const SYNTHETIC_DEMO_FLEET: InfraCluster[] = [
  {
    id: "demo-node-a",
    pool: "primary",
    tier: "demo",
    chip: "DEMO-ACCEL-A",
    vramGb: 24,
    gpuCount: 2,
    nodeCount: 1,
    gpusPerNode: 2,
    modelLabel: "demo-chat-model",
    synthetic: true,
  },
  {
    id: "demo-node-b",
    pool: "secondary",
    tier: "demo",
    chip: "DEMO-ACCEL-B",
    vramGb: 16,
    gpuCount: 1,
    nodeCount: 1,
    gpusPerNode: 1,
    modelLabel: "demo-embedding-model",
    synthetic: true,
  },
];

export function clustersFromApi(payload: InfraFleetResponse): InfraCluster[] {
  if (!payload || !Array.isArray(payload.clusters)) return [];
  return payload.clusters.map((cluster) => ({
    id: String(cluster.id),
    pool: String(cluster.pool),
    tier: cluster.tier === "registered" ? "registered" : "demo",
    chip: String(cluster.chip),
    vramGb: Number(cluster.vram_gb) || 0,
    gpuCount: Number(cluster.gpu_count) || 0,
    nodeCount: Number(cluster.node_count) || 0,
    gpusPerNode: Number(cluster.gpus_per_node) || 0,
    modelLabel: String(cluster.model_label || ""),
    synthetic: Boolean(cluster.synthetic),
  }));
}

export function computeFleetSummary(clusters: InfraCluster[]) {
  const totalGpus = clusters.reduce((sum, cluster) => sum + cluster.gpuCount, 0);
  const totalVramGb = clusters.reduce(
    (sum, cluster) => sum + cluster.gpuCount * cluster.vramGb,
    0,
  );
  const totalNodes = clusters.reduce((sum, cluster) => sum + cluster.nodeCount, 0);
  const chipCounts: Record<string, number> = {};
  for (const cluster of clusters) {
    chipCounts[cluster.chip] = (chipCounts[cluster.chip] || 0) + cluster.gpuCount;
  }
  return {
    clusterCount: clusters.length,
    totalGpus,
    totalVramGb,
    totalVramTb: Math.round((totalVramGb / 1024) * 100) / 100,
    totalNodes,
    chipCounts,
  };
}
