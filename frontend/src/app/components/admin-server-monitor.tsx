import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cpu, HardDrive, Layers, Server, ChevronRight, BrainCircuit, Workflow, Box,
  ArrowDown, Sparkles, Network, Gauge, FileCode2, Boxes, CircuitBoard,
  ExternalLink, AppWindow,
} from "lucide-react";
import {
  clustersFromApi,
  computeFleetSummary,
  SYNTHETIC_DEMO_FLEET,
  type InfraFleetResponse,
} from "./infra-fleet-data";
import {
  APPLICATION_LAYER_ITEMS,
  HARDWARE_NODES,
  INFERENCE_TECH_IDS,
  MODEL_DEPLOYMENTS,
  RUNTIME_TECH_IDS,
} from "./infra-stack-data";
import { AdminInfraTopology } from "./admin-infra-topology";
import { InfraLayerDetailModal, type InfraLayerId } from "./infra-layer-detail-modal";
import { InfraStackIllustration } from "./infra-visuals";
import { useT, type TranslationKey } from "../i18n";
import { usePlatformConfig } from "../hooks/use-platform-config";
import { ADMIN_EXPIRED_EVENT } from "../api/gateway";
import { API_BASE, authHeaders } from "./admin-tab-utils";

const LAYER_ORDER: InfraLayerId[] = ["application", "model", "inference", "runtime", "hardware"];

const LAYER_META: Record<
  InfraLayerId,
  { level: string; titleKey: TranslationKey; shortKey: TranslationKey; accent: string; icon: typeof Server }
> = {
  application: {
    level: "L5",
    titleKey: "admin.infra.layer.application.title",
    shortKey: "admin.infra.layer.application.short",
    accent: "#8b5cf6",
    icon: AppWindow,
  },
  model: {
    level: "L4",
    titleKey: "admin.infra.layer.model.title",
    shortKey: "admin.infra.layer.model.short",
    accent: "#6366f1",
    icon: BrainCircuit,
  },
  inference: {
    level: "L3",
    titleKey: "admin.infra.layer.inference.title",
    shortKey: "admin.infra.layer.inference.short",
    accent: "#5B8DEF",
    icon: Workflow,
  },
  runtime: {
    level: "L2",
    titleKey: "admin.infra.layer.runtime.title",
    shortKey: "admin.infra.layer.runtime.short",
    accent: "#7BC47F",
    icon: Box,
  },
  hardware: {
    level: "L1",
    titleKey: "admin.infra.layer.hardware.title",
    shortKey: "admin.infra.layer.hardware.short",
    accent: "#9B8EC4",
    icon: Server,
  },
};

const LAYER_COUNT: Record<InfraLayerId, number> = {
  application: APPLICATION_LAYER_ITEMS.length,
  model: MODEL_DEPLOYMENTS.length,
  inference: INFERENCE_TECH_IDS.length,
  runtime: RUNTIME_TECH_IDS.length,
  hardware: HARDWARE_NODES.length,
};

function HeroMetric({
  label, value, sub, icon: Icon,
}: {
  label: string; value: string; sub?: string; icon: typeof Server;
}) {
  return (
    <div className="min-w-0 px-4 py-3 sm:border-l sm:border-white/10 sm:first:border-l-0 sm:first:pl-0">
      <div className="flex items-center gap-2 text-white/55">
        <Icon className="h-3.5 w-3.5" />
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.12em]">{label}</span>
      </div>
      <p className="mt-2 text-[24px] font-semibold leading-none tracking-[-0.03em] text-white tabular-nums">{value}</p>
      {sub && <p className="mt-1.5 truncate text-[10.5px] text-white/45" title={sub}>{sub}</p>}
    </div>
  );
}

function ChipBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 py-1.5 backdrop-blur-sm">
      <div className="relative flex h-5 w-7 items-center justify-center rounded border" style={{ borderColor: `${color}80`, background: `${color}25` }}>
        <CircuitBoard className="h-3.5 w-3.5" style={{ color }} />
        <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      </div>
      <span className="text-[11px] font-semibold text-white/85">{label}</span>
      <span className="text-[10.5px] tabular-nums text-white/45">×{count}</span>
    </div>
  );
}

function ExecutiveHero({
  summary,
  chipMix,
  isDemo,
}: {
  summary: ReturnType<typeof computeFleetSummary>;
  chipMix: string;
  isDemo: boolean;
}) {
  const { t } = useT();
  const { branding } = usePlatformConfig();
  return (
    <section className="relative overflow-hidden rounded-[24px] border border-slate-700/40 bg-slate-950 text-white shadow-[0_20px_60px_rgba(15,23,42,0.16)]">
      <div className="pointer-events-none absolute inset-0" style={{
        background:
          "radial-gradient(circle at 84% 8%, rgba(99,102,241,.25), transparent 32%), radial-gradient(circle at 12% 100%, rgba(14,165,233,.14), transparent 36%)",
      }} />
      <div className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{
        backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
        backgroundSize: "22px 22px",
      }} />

      <div className="relative grid gap-6 px-6 pb-5 pt-6 lg:grid-cols-[minmax(0,1fr)_250px] lg:px-8">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t(isDemo ? "admin.infra.hero.demoFixture" : "admin.infra.hero.registrySource")}
            </span>
            <span className="text-[11px] uppercase tracking-[0.16em] text-white/35">{branding.brand} INFRASTRUCTURE</span>
          </div>
          <h2 className="mt-4 font-serif text-[23px] font-medium tracking-normal text-white sm:text-[26px]">
            {t("admin.infra.hero.title")}
          </h2>
          <p className="mt-2 max-w-[68ch] text-[12px] leading-6 text-white/55">{t("admin.infra.introBrief")}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {Object.entries(summary.chipCounts).map(([chip, count], index) => (
              <ChipBadge
                key={chip}
                label={chip}
                count={count}
                color={["#818cf8", "#60a5fa", "#4ade80", "#fbbf24"][index % 4]}
              />
            ))}
          </div>
        </div>
        <div className="relative hidden items-center justify-center lg:flex">
          <div className="absolute h-48 w-48 rounded-full border border-white/5" />
          <div className="absolute h-36 w-36 rounded-full border border-white/10" />
          <InfraStackIllustration className="relative h-[190px] w-[220px] opacity-90" />
        </div>
      </div>

      <div className="relative grid grid-cols-2 border-t border-white/10 bg-white/[0.025] px-6 py-2 sm:grid-cols-4 lg:px-8">
        <HeroMetric label={t("admin.infra.summary.gpus")} value={String(summary.totalGpus)} sub={chipMix} icon={Cpu} />
        <HeroMetric label={t("admin.infra.summary.vram")} value={`${summary.totalVramTb} TB`} sub={t("admin.infra.summary.vramSub", { gb: summary.totalVramGb })} icon={HardDrive} />
        <HeroMetric label={t("admin.infra.summary.clusters")} value={String(summary.clusterCount)} sub={t("admin.infra.summary.clustersSub")} icon={Layers} />
        <HeroMetric label={t("admin.infra.summary.nodes")} value={String(summary.totalNodes)} sub={t("admin.infra.summary.nodesSub")} icon={Server} />
      </div>
    </section>
  );
}

function ArchitectureStack({ onLayerClick }: { onLayerClick: (layer: InfraLayerId) => void }) {
  const { t } = useT();

  return (
    <section className="rounded-[20px] border border-border/50 bg-card p-5 shadow-[0_8px_30px_rgba(15,23,42,0.04)] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Layers className="h-[18px] w-[18px] text-primary" />
          </div>
          <div>
            <h3 className="font-serif text-[17px] font-medium text-foreground">{t("admin.infra.map.title")}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t("admin.infra.stack.direction")}</p>
          </div>
        </div>
        <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
          {t("admin.infra.map.hint")} <ExternalLink className="h-3 w-3" />
        </span>
      </div>

      <div className="mt-5 space-y-2">
        {LAYER_ORDER.map((layerId, idx) => {
          const meta = LAYER_META[layerId];
          const Icon = meta.icon;
          return (
            <div key={layerId} className="flex flex-col items-center">
              <button
                type="button"
                onClick={() => onLayerClick(layerId)}
                className="group relative flex min-h-[74px] items-center gap-3 overflow-hidden rounded-xl border border-border/50 bg-background px-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
                style={{ width: `${100 - idx * 4}%` }}
              >
                <div className="pointer-events-none absolute inset-y-0 left-0 w-1" style={{ background: meta.accent }} />
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105"
                  style={{ background: `${meta.accent}14`, color: meta.accent }}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-bold tabular-nums" style={{ color: meta.accent }}>{meta.level}</span>
                    <span className="truncate font-serif text-[13px] font-medium text-foreground">{t(meta.titleKey)}</span>
                    <span className="rounded-full bg-secondary px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">
                      {t("admin.infra.layer.badge.units", { n: LAYER_COUNT[layerId] })}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{t(meta.shortKey)}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/35 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
              </button>
              {idx < LAYER_ORDER.length - 1 && (
                <div className="flex h-4 items-center justify-center" aria-hidden>
                  <ArrowDown className="h-3.5 w-3.5 text-muted-foreground/30" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const ROUTES = [
  {
    id: "demo-primary",
    color: "#818cf8",
    icon: Cpu,
    titleKey: "admin.infra.route.demoPrimary.title" as TranslationKey,
    descKey: "admin.infra.route.demoPrimary.desc" as TranslationKey,
    steps: ["DEMO-ACCEL-A", "Container", "Model Server", "demo-chat-model"],
    target: "runtime" as InfraLayerId,
  },
  {
    id: "demo-secondary",
    color: "#5b8def",
    icon: CircuitBoard,
    titleKey: "admin.infra.route.demoSecondary.title" as TranslationKey,
    descKey: "admin.infra.route.demoSecondary.desc" as TranslationKey,
    steps: ["DEMO-ACCEL-B", "Container", "Embedding Server", "demo-embedding-model"],
    target: "inference" as InfraLayerId,
  },
] as const;

function DeploymentRoutes({ onSelect }: { onSelect: (layer: InfraLayerId) => void }) {
  const { t } = useT();
  return (
    <section className="rounded-[20px] border border-border/50 bg-card p-5 shadow-[0_8px_30px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "rgba(91, 141, 239, 0.1)" }}>
          <Network className="h-[18px] w-[18px]" style={{ color: "var(--chart-3)" }} />
        </div>
        <div>
          <h3 className="font-serif text-[17px] font-medium text-foreground">{t("admin.infra.route.title")}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t("admin.infra.route.subtitle")}</p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {ROUTES.map((route) => {
          const Icon = route.icon;
          return (
            <button
              key={route.id}
              type="button"
              onClick={() => onSelect(route.target)}
              className="group w-full rounded-xl border border-border/45 bg-background p-3.5 text-left transition-all hover:border-border hover:shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `${route.color}15` }}>
                  <Icon className="h-4 w-4" style={{ color: route.color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-serif text-[13px] font-medium text-foreground">{t(route.titleKey)}</p>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/35 transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t(route.descKey)}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center overflow-hidden">
                {route.steps.map((step, i) => (
                  <div key={step} className="contents">
                    <span className="min-w-0 truncate rounded-md bg-secondary/60 px-1.5 py-1 text-[9.5px] font-medium text-muted-foreground">
                      {step}
                    </span>
                    {i < route.steps.length - 1 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/25" />}
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const CAPACITY_STEPS = [
  { icon: Boxes, key: "admin.infra.capacity.weight" as TranslationKey },
  { icon: Network, key: "admin.infra.capacity.topology" as TranslationKey },
  { icon: Gauge, key: "admin.infra.capacity.kv" as TranslationKey },
  { icon: Workflow, key: "admin.infra.capacity.service" as TranslationKey },
  { icon: FileCode2, key: "admin.infra.capacity.script" as TranslationKey },
] as const;

function CapacityPipeline({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full rounded-[20px] border border-border/50 bg-card p-5 text-left shadow-[0_8px_30px_rgba(15,23,42,0.04)] transition-colors hover:border-primary/20"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="min-w-[210px]">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="font-serif text-[17px] font-medium text-foreground">{t("admin.infra.capacity.title")}</h3>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{t("admin.infra.capacity.subtitle")}</p>
        </div>
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto pb-1">
          {CAPACITY_STEPS.map(({ icon: Icon, key }, i) => (
            <div key={key} className="contents">
              <div className="flex min-w-[88px] flex-1 flex-col items-center gap-1.5 rounded-lg bg-secondary/35 px-2 py-2.5">
                <Icon className="h-4 w-4 text-primary/75" />
                <span className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">{t(key)}</span>
              </div>
              {i < CAPACITY_STEPS.length - 1 && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/25" />}
            </div>
          ))}
        </div>
        <ExternalLink className="hidden h-4 w-4 shrink-0 text-muted-foreground/35 transition-colors group-hover:text-primary lg:block" />
      </div>
    </button>
  );
}

export function AdminServerMonitor({ token }: { token: string }) {
  const { t } = useT();
  const [activeLayer, setActiveLayer] = useState<InfraLayerId | null>(null);
  const [clusters, setClusters] = useState(SYNTHETIC_DEMO_FLEET);
  const [fleetSource, setFleetSource] = useState<InfraFleetResponse["source"]>("synthetic_demo");
  const loadFleet = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/admin/infra/fleet`, {
        headers: authHeaders(token),
      });
      if (response.status === 401) {
        window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
        return;
      }
      if (!response.ok) return;
      const payload = await response.json() as InfraFleetResponse;
      setClusters(clustersFromApi(payload));
      setFleetSource(payload.source === "registry" ? "registry" : "synthetic_demo");
    } catch {
      // Keep the clearly marked synthetic fallback while the API is unavailable.
    }
  }, [token]);
  useEffect(() => { void loadFleet(); }, [loadFleet]);

  const summary = useMemo(() => computeFleetSummary(clusters), [clusters]);
  const chipMix = useMemo(
    () => Object.entries(summary.chipCounts)
      .map(([chip, n]) => t("admin.infra.chipMixItem", { chip, n }))
      .join(" · "),
    [summary.chipCounts, t],
  );

  return (
    <div className="space-y-5">
      <ExecutiveHero summary={summary} chipMix={chipMix} isDemo={fleetSource === "synthetic_demo"} />

      <AdminInfraTopology token={token} onRegistryChanged={loadFleet} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.8fr)]">
        <ArchitectureStack onLayerClick={setActiveLayer} />
        <DeploymentRoutes onSelect={setActiveLayer} />
      </div>

      <CapacityPipeline onClick={() => setActiveLayer("model")} />

      <div className="rounded-xl border border-dashed border-border/50 bg-secondary/15 px-4 py-3 text-center text-[11.5px] leading-relaxed text-muted-foreground/80">
        {t("admin.infra.footnote")}
      </div>

      <InfraLayerDetailModal layer={activeLayer} onClose={() => setActiveLayer(null)} />
    </div>
  );
}
