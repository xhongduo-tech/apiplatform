import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow, BrainCircuit, Check, Cpu, Database,
  FileSearch, Loader2, Network, Plus, Server, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { API_BASE, authHeaders, ModalPortal } from "./admin-tab-utils";
import { ProviderIcon } from "./provider-logos";
import { ADMIN_EXPIRED_EVENT } from "../api/gateway";
import { useT, type TranslationKey } from "../i18n";

type NodeKind = "pool" | "server" | "model" | "application";

type TopologyNode = {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle: string;
  color: string;
  icon: LucideIcon;
  logoProvider?: string;
  logoSrc?: string;
  logoAlt?: string;
  registered?: boolean;
  sceneType?: string;
  sceneLabel?: string;
  /** 明确标识仓库内置的虚构演示节点。 */
  demo?: boolean;
};

type StaticNodeDef = Omit<TopologyNode, "title" | "subtitle"> & {
  title?: string;
  titleKey?: TranslationKey;
  subtitleKey: TranslationKey;
  demo?: boolean;
};

type RegisteredResource = {
  id: string;
  kind: Exclude<NodeKind, "pool">;
  name: string;
  subtitle: string;
  pool: "primary" | "secondary" | null;
  extra?: {
    scene_type?: string;
    model_id?: string;
    chip?: string;
    accelerator_count?: number;
    vram_gb?: number;
    node_count?: number;
  };
};

type RegistryLink = {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
};

type RegistryResponse = {
  resources: RegisteredResource[];
  links: RegistryLink[];
};

type TopProject = {
  id: string;
  project: string;
  scene_type: string;
  calls: number;
  model_ids: string[];
};

type LinkDef = {
  sourceId: string;
  targetId: string;
  color?: string;
  relation: "contains" | "deploys" | "serves";
};

const POOL_COLORS = {
  primary: "#6366f1",
  secondary: "#5b8def",
} as const;

type PoolId = keyof typeof POOL_COLORS;

const DEMO_SERVERS: StaticNodeDef[] = [
  { id: "demo-server-a", kind: "server", titleKey: "admin.infra.topology.server.demoA.title", subtitleKey: "admin.infra.topology.server.demoA.desc", color: POOL_COLORS.primary, icon: Server, demo: true },
  { id: "demo-server-b", kind: "server", titleKey: "admin.infra.topology.server.demoB.title", subtitleKey: "admin.infra.topology.server.demoB.desc", color: POOL_COLORS.secondary, icon: Cpu, demo: true },
];

const DEMO_MODELS: StaticNodeDef[] = [
  { id: "demo-model-chat", kind: "model", titleKey: "admin.infra.topology.model.demoChat.title", subtitleKey: "admin.infra.topology.model.demoChat.desc", color: POOL_COLORS.primary, icon: BrainCircuit, demo: true },
  { id: "demo-model-embedding", kind: "model", titleKey: "admin.infra.topology.model.demoEmbedding.title", subtitleKey: "admin.infra.topology.model.demoEmbedding.desc", color: POOL_COLORS.secondary, icon: FileSearch, demo: true },
];

const DEMO_APPLICATIONS: StaticNodeDef[] = [
  { id: "demo-app-chat", kind: "application", titleKey: "admin.infra.topology.app.demoChat.title", subtitleKey: "admin.infra.topology.app.demoChat.desc", color: "#8b5cf6", icon: AppWindow, demo: true },
  { id: "demo-app-search", kind: "application", titleKey: "admin.infra.topology.app.demoSearch.title", subtitleKey: "admin.infra.topology.app.demoSearch.desc", color: "#3b82f6", icon: FileSearch, demo: true },
];

const TOPOLOGY_ROW_PITCH = 86;
const TOPOLOGY_CARD_HEIGHT = 82;

// Runtime projects use their administrator-configured scene type only for color.
const SCENE_COLORS: Record<string, string> = {
  innovation: "#6366f1",
  explore: "#3b82f6",
};
const SCENE_COLOR_FALLBACK = "#64748b";

const DEMO_LINKS: LinkDef[] = [
  { sourceId: "pool-primary", targetId: "demo-server-a", relation: "contains" },
  { sourceId: "pool-secondary", targetId: "demo-server-b", relation: "contains" },
  { sourceId: "demo-server-a", targetId: "demo-model-chat", relation: "deploys" },
  { sourceId: "demo-server-b", targetId: "demo-model-embedding", relation: "deploys" },
  { sourceId: "demo-model-chat", targetId: "demo-app-chat", relation: "serves" },
  { sourceId: "demo-model-embedding", targetId: "demo-app-search", relation: "serves" },
];

const SCENE_TYPES = ["innovation", "explore"] as const;

const COLUMN_X = {
  poolRight: 166,
  serverLeft: 236,
  serverRight: 444,
  modelLeft: 514,
  modelRight: 722,
  appLeft: 792,
} as const;

function nodeY(index: number, count: number, height: number) {
  return ((index + 0.5) / Math.max(count, 1)) * height;
}

function curve(x1: number, y1: number, x2: number, y2: number) {
  const dx = (x2 - x1) * 0.52;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function kindIcon(kind: RegisteredResource["kind"]): LucideIcon {
  if (kind === "server") return Server;
  if (kind === "model") return BrainCircuit;
  return AppWindow;
}

function kindColor(resource: RegisteredResource) {
  if (resource.kind === "server" && resource.pool && resource.pool in POOL_COLORS) {
    return POOL_COLORS[resource.pool as PoolId];
  }
  if (resource.kind === "server") return POOL_COLORS.primary;
  if (resource.kind === "model") return "#7c75d8";
  return "#8b5cf6";
}

function poolFromId(poolId: string): PoolId {
  return poolId === "pool-secondary" ? "secondary" : "primary";
}

function ColumnHeading({ icon: Icon, label, count }: { icon: LucideIcon; label: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-0.5">
      <div className="flex items-center gap-1.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold text-foreground">{label}</span>
      </div>
      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </div>
  );
}

function TopologyCard({ node }: { node: TopologyNode }) {
  const { t } = useT();
  const Icon = node.icon;

  return (
    <div
      className="absolute left-0 z-10 flex w-full gap-2 rounded-lg border border-border/55 bg-card px-2 py-1.5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"
      style={{ height: TOPOLOGY_CARD_HEIGHT }}
      title={[node.title, node.subtitle].filter(Boolean).join(" · ")}
    >
      <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full" style={{ background: node.color }} />
      <span className={`ml-0.5 flex shrink-0 self-center items-center justify-center rounded-lg ${node.logoSrc ? "h-9 w-11 px-1" : "h-9 w-9"}`} style={{ background: `${node.color}14` }}>
        {node.logoSrc
          ? (
              <img
                src={node.logoSrc}
                alt={node.logoAlt ?? ""}
                className={`h-[18px] w-full object-contain ${node.logoSrc.endsWith("nvidia.svg") ? "dark:invert" : ""}`}
              />
            )
          : node.logoProvider
          ? <ProviderIcon provider={node.logoProvider} size="sm" className="h-[18px] w-[18px]" />
          : <Icon className="h-4 w-4" style={{ color: node.color }} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-snug text-foreground">
          <span className="break-words font-serif font-medium">{node.title}</span>
          {node.sceneLabel && (
            <span className="inline-flex shrink-0 align-middle whitespace-nowrap rounded bg-violet-500/10 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-violet-600 dark:text-violet-300">
              {node.sceneLabel}
            </span>
          )}
          {node.demo && (
            <span className="inline-flex shrink-0 align-middle whitespace-nowrap rounded-md border border-indigo-200/90 bg-indigo-50 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-indigo-700 dark:border-indigo-500/35 dark:bg-indigo-500/20 dark:text-indigo-200">
              {t("admin.infra.topology.demoBadge")}
            </span>
          )}
          {node.registered && (
            <span className="inline-flex shrink-0 align-middle whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-primary">
              {t("admin.infra.topology.registered")}
            </span>
          )}
        </div>
        <span className="line-clamp-2 break-words text-[11.5px] leading-snug text-muted-foreground">
          {node.subtitle}
        </span>
      </div>
    </div>
  );
}

function RegistryDialog({
  open,
  token,
  servers,
  models,
  onClose,
  onSaved,
}: {
  open: boolean;
  token: string;
  servers: TopologyNode[];
  models: TopologyNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [kind, setKind] = useState<RegisteredResource["kind"]>("server");
  const [name, setName] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [pool, setPool] = useState<PoolId>("primary");
  const [chip, setChip] = useState("CUSTOM-ACCEL");
  const [acceleratorCount, setAcceleratorCount] = useState("1");
  const [vramGb, setVramGb] = useState("0");
  const [nodeCount, setNodeCount] = useState("1");
  const [modelId, setModelId] = useState("");
  const [sceneType, setSceneType] = useState<(typeof SCENE_TYPES)[number]>("explore");
  const [parentIds, setParentIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => setParentIds([]), [kind]);

  const parentOptions = kind === "server"
    ? [
        { id: "pool-primary", title: t("admin.infra.topology.pool.primary") },
        { id: "pool-secondary", title: t("admin.infra.topology.pool.secondary") },
      ]
    : kind === "model"
      ? servers.map((n) => ({ id: n.id, title: n.title }))
      : models.map((n) => ({ id: n.id, title: n.title }));

  function toggleParent(id: string) {
    if (kind === "server") {
      setParentIds([id]);
      setPool(poolFromId(id));
      return;
    }
    setParentIds((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }

  async function save() {
    if (!name.trim()) {
      toast.error(t("admin.infra.registry.nameRequired"));
      return;
    }
    if (parentIds.length === 0) {
      toast.error(t("admin.infra.registry.parentRequired"));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/api/admin/infra/resources`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name: name.trim(),
          subtitle: subtitle.trim(),
          pool: kind === "server" ? pool : null,
          parent_ids: parentIds,
          extra: kind === "server"
            ? {
                chip: chip.trim() || "UNSPECIFIED",
                accelerator_count: Math.max(0, Number(acceleratorCount) || 0),
                vram_gb: Math.max(0, Number(vramGb) || 0),
                node_count: Math.max(1, Number(nodeCount) || 1),
              }
            : kind === "model"
              ? { model_id: modelId.trim() }
              : { scene_type: sceneType },
        }),
      });
      if (response.status === 401) {
        window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${response.status}`);
      }
      toast.success(t("admin.infra.registry.saved"));
      setName("");
      setSubtitle("");
      setParentIds([]);
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.infra.registry.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalPortal open={open} onClose={onClose} zIndex={10080}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border/50 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border/40 px-5 py-4">
          <div>
            <h3 className="font-serif text-[16px] font-medium">{t("admin.infra.registry.title")}</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("admin.infra.registry.desc")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary" aria-label={t("docsPage.modal.close")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="grid grid-cols-3 gap-2">
            {(["server", "model", "application"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={`rounded-xl border px-3 py-2.5 text-[11px] font-medium transition-colors ${
                  kind === value ? "border-primary bg-primary/5 text-primary" : "border-border/50 text-muted-foreground hover:bg-secondary/40"
                }`}
              >
                {t(`admin.infra.registry.kind.${value}` as TranslationKey)}
              </button>
            ))}
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.name")}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("admin.infra.registry.namePlaceholder")}
              className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 font-serif text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
            />
          </label>

          {kind === "server" && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.chip")}</span>
                <input
                  value={chip}
                  onChange={(event) => setChip(event.target.value)}
                  placeholder="CUSTOM-ACCEL"
                  className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 font-serif text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.accelerators")}</span>
                <input type="number" min="0" value={acceleratorCount} onChange={(event) => setAcceleratorCount(event.target.value)} className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 text-[12px] outline-none focus:border-primary/50" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.vramGb")}</span>
                <input type="number" min="0" value={vramGb} onChange={(event) => setVramGb(event.target.value)} className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 text-[12px] outline-none focus:border-primary/50" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.nodeCount")}</span>
                <input type="number" min="1" value={nodeCount} onChange={(event) => setNodeCount(event.target.value)} className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 text-[12px] outline-none focus:border-primary/50" />
              </label>
            </div>
          )}

          {kind === "model" && (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.modelId")}</span>
              <input
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="vendor/model-id"
                className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 font-mono text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
              />
              <span className="mt-1 block text-[9px] text-muted-foreground">{t("admin.infra.registry.modelIdHint")}</span>
            </label>
          )}

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium text-foreground">{t("admin.infra.registry.subtitle")}</span>
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder={t("admin.infra.registry.subtitlePlaceholder")}
              className="w-full rounded-xl border border-border/60 bg-background px-3 py-2.5 font-serif text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
            />
          </label>

          {kind === "application" && (
            <div>
              <span className="mb-2 block text-[11px] font-medium text-foreground">
                {t("admin.infra.registry.sceneType")}
              </span>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {SCENE_TYPES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSceneType(value)}
                    className={`rounded-lg border px-2 py-2 text-[9.5px] transition-colors ${
                      sceneType === value ? "border-violet-400/50 bg-violet-500/10 text-violet-600" : "border-border/50 text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {t(`sceneType.${value}` as TranslationKey)}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] text-muted-foreground">{t("admin.infra.registry.sceneHint")}</p>
            </div>
          )}

          <div>
            <span className="mb-2 block text-[11px] font-medium text-foreground">
              {kind === "server"
                ? t("admin.infra.registry.selectPool")
                : kind === "model"
                  ? t("admin.infra.registry.selectServers")
                  : t("admin.infra.registry.selectModels")}
            </span>
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-border/50 bg-secondary/15 p-2">
              {parentOptions.map((option) => {
                const selected = parentIds.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleParent(option.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] ${
                      selected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    <span className={`flex h-4 w-4 items-center justify-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate font-serif font-medium">{option.title}</span>
                  </button>
                );
              })}
            </div>
            {kind !== "server" && (
              <p className="mt-1.5 text-[9px] text-muted-foreground">{t("admin.infra.registry.multiHint")}</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border/40 bg-secondary/15 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[11px] text-muted-foreground hover:bg-secondary">
            {t("admin.infra.registry.cancel")}
          </button>
          <button type="button" onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[11px] font-medium text-primary-foreground disabled:opacity-60">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? t("admin.infra.registry.saving") : t("admin.infra.registry.save")}
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}

export function AdminInfraTopology({
  token,
  onRegistryChanged,
}: {
  token: string;
  onRegistryChanged?: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [registry, setRegistry] = useState<RegistryResponse>({ resources: [], links: [] });
  const [registryOpen, setRegistryOpen] = useState(false);
  const [topProjects, setTopProjects] = useState<TopProject[]>([]);

  const loadRegistry = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/admin/infra/resources`, { headers: authHeaders(token) });
      if (response.status === 401) {
        window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
        return;
      }
      if (!response.ok) return;
      const body = await response.json();
      setRegistry({
        resources: Array.isArray(body.resources) ? body.resources : [],
        links: Array.isArray(body.links) ? body.links : [],
      });
    } catch {
      // API unavailable: keep the explicitly marked synthetic demo visible.
    }
  }, [token]);

  const loadTopProjects = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/admin/infra/top-projects?limit=5&days=90`, { headers: authHeaders(token) });
      if (response.status === 401) {
        window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
        return;
      }
      if (!response.ok) return;
      const body = await response.json();
      setTopProjects(Array.isArray(body.projects) ? body.projects : []);
    } catch {
      // Runtime projects are optional; the demo application remains labeled.
    }
  }, [token]);

  useEffect(() => { loadRegistry(); loadTopProjects(); }, [loadRegistry, loadTopProjects]);

  const pools = useMemo<TopologyNode[]>(() => [
    {
      id: "pool-primary",
      kind: "pool",
      title: t("admin.infra.topology.pool.primary"),
      subtitle: t("admin.infra.topology.pool.primaryDesc"),
      color: POOL_COLORS.primary,
      icon: Cpu,
    },
    {
      id: "pool-secondary",
      kind: "pool",
      title: t("admin.infra.topology.pool.secondary"),
      subtitle: t("admin.infra.topology.pool.secondaryDesc"),
      color: POOL_COLORS.secondary,
      icon: Database,
    },
  ], [t]);

  const demoServers = useMemo<TopologyNode[]>(
    () => DEMO_SERVERS.map((node) => ({
      ...node,
      title: node.title ?? t(node.titleKey!),
      subtitle: t(node.subtitleKey),
    })),
    [t],
  );
  const demoModels = useMemo<TopologyNode[]>(
    () => DEMO_MODELS.map((node) => ({
      ...node,
      title: node.title ?? t(node.titleKey!),
      subtitle: t(node.subtitleKey),
    })),
    [t],
  );
  const demoApplications = useMemo<TopologyNode[]>(
    () => DEMO_APPLICATIONS.map((node) => ({
      ...node,
      title: node.title ?? t(node.titleKey!),
      subtitle: t(node.subtitleKey),
    })),
    [t],
  );

  const registeredNodes = useMemo(
    () => registry.resources.map<TopologyNode>((resource) => {
      const sceneType = resource.kind === "application"
        && SCENE_TYPES.includes(resource.extra?.scene_type as (typeof SCENE_TYPES)[number])
        ? resource.extra?.scene_type
        : undefined;
      return {
        id: resource.id,
        kind: resource.kind,
        title: resource.name,
        subtitle: resource.subtitle || t("admin.infra.topology.registeredResource"),
        color: kindColor(resource),
        icon: kindIcon(resource.kind),
        registered: true,
        sceneType,
        sceneLabel: sceneType ? t(`sceneType.${sceneType}` as TranslationKey) : undefined,
      };
    }),
    [registry.resources, t],
  );
  const demoMode = registry.resources.length === 0;
  const registeredServers = useMemo(
    () => registeredNodes.filter((node) => node.kind === "server"),
    [registeredNodes],
  );
  const registeredModels = useMemo(
    () => registeredNodes.filter((node) => node.kind === "model"),
    [registeredNodes],
  );

  const servers = useMemo(
    () => demoMode ? demoServers : registeredServers,
    [demoMode, demoServers, registeredServers],
  );
  const models = useMemo(
    () => demoMode ? demoModels : registeredModels,
    [demoMode, demoModels, registeredModels],
  );
  const applications = useMemo<TopologyNode[]>(
    () => [
      ...(demoMode ? demoApplications : []),
      ...topProjects.map((project) => {
        const sceneKnown = SCENE_TYPES.includes(project.scene_type as (typeof SCENE_TYPES)[number]);
        return {
          id: project.id,
          kind: "application" as const,
          title: project.project,
          subtitle: t("admin.infra.topology.app.calls", { count: project.calls }),
          sceneType: project.scene_type,
          sceneLabel: sceneKnown ? t(`sceneType.${project.scene_type}` as TranslationKey) : project.scene_type,
          color: SCENE_COLORS[project.scene_type] ?? SCENE_COLOR_FALLBACK,
          icon: AppWindow,
        };
      }),
      ...registeredNodes.filter((node) => node.kind === "application"),
    ],
    [demoApplications, demoMode, registeredNodes, topProjects, t],
  );

  const links = useMemo<LinkDef[]>(
    () => [
      ...(demoMode ? DEMO_LINKS : []),
      ...topProjects.flatMap((project) =>
        project.model_ids.map((modelId) => ({
          sourceId: modelId,
          targetId: project.id,
          relation: "serves" as const,
        })),
      ),
      ...registry.links.map((link) => ({
        sourceId: link.source_id,
        targetId: link.target_id,
        relation: (["contains", "deploys", "serves"].includes(link.relation) ? link.relation : "serves") as LinkDef["relation"],
      })),
    ],
    [demoMode, registry.links, topProjects],
  );

  const columns = useMemo(() => [pools, servers, models, applications], [pools, servers, models, applications]);
  const graphHeight = Math.max(...columns.map((column) => column.length), 5) * TOPOLOGY_ROW_PITCH;
  const nodeMap = useMemo(() => new Map(columns.flat().map((node) => [node.id, node])), [columns]);

  function nodePosition(id: string): { x1: number; x2: number; y: number; column: number } | null {
    const column = columns.findIndex((items) => items.some((node) => node.id === id));
    if (column < 0) return null;
    const index = columns[column].findIndex((node) => node.id === id);
    const y = nodeY(index, columns[column].length, graphHeight);
    const edges = [
      [0, COLUMN_X.poolRight],
      [COLUMN_X.serverLeft, COLUMN_X.serverRight],
      [COLUMN_X.modelLeft, COLUMN_X.modelRight],
      [COLUMN_X.appLeft, 1000],
    ];
    return { x1: edges[column][0], x2: edges[column][1], y, column };
  }

  return (
    <section className="rounded-[20px] border border-border/50 bg-card p-5 shadow-[0_8px_30px_rgba(15,23,42,0.04)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Network className="h-[18px] w-[18px] text-primary" />
          </div>
          <div>
            <h3 className="font-serif text-[17px] font-medium text-foreground">{t("admin.infra.topology.title")}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t("admin.infra.topology.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
            <span className="flex items-center gap-1"><span className="w-4 border-t border-dashed border-slate-400" />{t("admin.infra.topology.legend.pool")}</span>
            <span className="flex items-center gap-1"><span className="h-0.5 w-4 rounded bg-blue-500" />{t("admin.infra.topology.legend.deployment")}</span>
            <span className="flex items-center gap-1"><span className="h-px w-4 bg-violet-400" />{t("admin.infra.topology.legend.service")}</span>
          </div>
          <button
            type="button"
            onClick={() => setRegistryOpen(true)}
            className="flex items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("admin.infra.registry.action")}
          </button>
        </div>
      </div>

      {/* 桌面端：算力池 → 服务器 → 模型 → 应用 */}
      <div className="mt-4 hidden lg:block">
        <div className="grid grid-cols-[0.8fr_1fr_1fr_1fr] gap-[5%]">
          <ColumnHeading icon={Database} label={t("admin.infra.topology.poolColumn")} count={pools.length} />
          <ColumnHeading icon={Server} label={t("admin.infra.topology.serverColumn")} count={servers.length} />
          <ColumnHeading icon={BrainCircuit} label={t("admin.infra.topology.modelColumn")} count={models.length} />
          <ColumnHeading icon={AppWindow} label={t("admin.infra.topology.appColumn")} count={applications.length} />
        </div>

        <div className="relative mt-2" style={{ height: graphHeight }}>
          <svg viewBox={`0 0 1000 ${graphHeight}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            {links.map((link, index) => {
              const source = nodePosition(link.sourceId);
              const target = nodePosition(link.targetId);
              if (!source || !target || target.column !== source.column + 1) return null;
              const sourceNode = nodeMap.get(link.sourceId);
              const color = sourceNode?.color ?? "#94a3b8";
              const path = curve(source.x2, source.y, target.x1, target.y);
              const width = link.relation === "deploys" ? 2.5 : link.relation === "serves" ? 1.8 : 1.6;
              const opacity = link.relation === "deploys" ? 0.9 : link.relation === "serves" ? 0.62 : 0.52;
              // curve() 的贝塞尔末端切线恒为水平方向（控制点与端点同 y），箭头固定指向 +x，
              // 手绘三角形而非 SVG marker：markerEnd 依赖 context-stroke 上色，Safari/Firefox 不支持。
              const arrowLen = link.relation === "deploys" ? 7 : 5.5;
              const arrowHalfWidth = link.relation === "deploys" ? 4 : 3.2;
              return (
                <g key={`${link.sourceId}-${link.targetId}-${index}`}>
                  <path
                    d={path}
                    fill="none"
                    stroke="var(--card)"
                    strokeWidth={width + 4}
                    strokeOpacity="0.96"
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={width}
                    strokeOpacity={opacity}
                    strokeDasharray={link.relation === "contains" ? "5 4" : "0"}
                    vectorEffect="non-scaling-stroke"
                  />
                  <polygon
                    points={`${target.x1},${target.y} ${target.x1 - arrowLen},${target.y - arrowHalfWidth} ${target.x1 - arrowLen},${target.y + arrowHalfWidth}`}
                    fill={color}
                    fillOpacity={opacity}
                  />
                  <circle cx={source.x2} cy={source.y} r={link.relation === "deploys" ? 3 : 2.4} fill="var(--card)" stroke={color} strokeWidth="1.5" />
                </g>
              );
            })}
          </svg>

          <div className="relative z-10 grid h-full grid-cols-[0.8fr_1fr_1fr_1fr] gap-[5%]">
            {columns.map((column, columnIndex) => (
              <div key={columnIndex} className="relative h-full">
                {columnIndex === 3 && column.length === 0 && (
                  <div
                    className="absolute inset-x-0 top-0 flex items-center justify-center rounded-lg border border-dashed border-border/50 px-3 text-center text-[12px] text-muted-foreground"
                    style={{ height: TOPOLOGY_CARD_HEIGHT }}
                  >
                    {t("admin.infra.topology.app.empty")}
                  </div>
                )}
                {column.map((node, index) => (
                  <div
                    key={node.id}
                    className="absolute inset-x-0"
                    style={{ top: nodeY(index, column.length, graphHeight) - TOPOLOGY_CARD_HEIGHT / 2 }}
                  >
                    <TopologyCard node={node} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-secondary/15 px-3 py-2.5">
          <Network className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-muted-foreground/25 to-transparent" />
          <span className="text-[11.5px] text-muted-foreground">{t("admin.infra.topology.fabric")}</span>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-muted-foreground/25 to-transparent" />
        </div>

      </div>

      {/* 窄屏：按算力池折叠呈现 */}
      <div className="mt-5 space-y-3 lg:hidden">
        {pools.map((pool) => {
          const poolServerIds = new Set(links.filter((link) => link.sourceId === pool.id).map((link) => link.targetId));
          const poolServers = servers.filter((server) => poolServerIds.has(server.id));
          return (
            <div key={pool.id} className="overflow-hidden rounded-xl border border-border/50 bg-background">
              <div className="flex items-center gap-2.5 border-b border-border/40 px-3 py-3">
                <span className="h-2 w-2 rounded-full" style={{ background: pool.color }} />
                <span className="font-serif text-[12px] font-medium">{pool.title}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground">
                  {t("admin.infra.topology.nodeCount", { count: poolServers.length })}
                </span>
              </div>
              <div className="space-y-1 p-2">
                {poolServers.map((server) => {
                  const modelIds = links.filter((link) => link.sourceId === server.id).map((link) => link.targetId);
                  return (
                    <div key={server.id} className="flex items-center gap-2 rounded-lg px-2 py-2 text-[11px]">
                      <Server className="h-3.5 w-3.5 shrink-0" style={{ color: server.color }} />
                      <span className="min-w-0 flex-1 truncate font-serif font-medium">{server.title}</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="min-w-0 flex-1 truncate font-serif font-medium">
                        {modelIds.map((id) => nodeMap.get(id)?.title).filter(Boolean).join(" / ") || "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <RegistryDialog
        open={registryOpen}
        token={token}
        servers={registeredServers}
        models={registeredModels}
        onClose={() => setRegistryOpen(false)}
        onSaved={() => {
          void loadRegistry();
          void onRegistryChanged?.();
        }}
      />
    </section>
  );
}
