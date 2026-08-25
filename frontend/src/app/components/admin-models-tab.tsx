import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Plus, Trash2, Power, PowerOff, X, Loader2, Search,
  Edit2, Check, Activity, Zap, RotateCcw,
  ArrowUpDown, ArrowUp, ArrowDown, Filter,
} from "lucide-react";
import { type Model, type ModelEndpoint, categoryLabels, statusLabels } from "./model-data";
import { displayCategoryForModel, findCatalogPreset } from "./catalog-models";
import { getModelMetadata } from "./model-metadata";
import { useModels } from "./model-context";
import { toast } from "sonner";
import { ProviderIcon } from "./provider-logos";
import {
  API_BASE, authHeaders, ModalPortal, requireOk,
} from "./admin-tab-utils";
import { PageHeader } from "./ui/page-header";
import { useT } from "../i18n";
import { DEFAULT_STATUS_FILTER } from "./model-plaza/plaza-constants";
import { sortModelsPlaza } from "./model-plaza/plaza-sort";


function resolveReleaseDate(id: string, fromApi?: string): string | undefined {
  const preset = findCatalogPreset(id);
  const meta = getModelMetadata(id);
  return preset?.releaseDate ?? fromApi ?? meta?.releaseDate;
}

type SortField = "id" | "category" | "status";

type ConnectivityResult = {
  index: number;
  label: string;
  base_url: string;
  ok: boolean;
  latency_ms: number;
  message: string;
  status_code?: number;
};

type ConnectivityCacheEntry = {
  results: ConnectivityResult[];
  ok: boolean;
  latency_ms: number;
  message: string;
};

const CONNECTIVITY_FAST_MS = 800;
const CONNECTIVITY_SLOW_MS = 2000;

function isConnectivityTestable(m: Model): boolean {
  return m.category !== "lts" && !m.resolveToModelId;
}

function summarizeConnectivity(results: ConnectivityResult[]): ConnectivityCacheEntry {
  if (!results.length) {
    return { results, ok: false, latency_ms: 0, message: "" };
  }
  const failed = results.find((r) => !r.ok);
  if (failed) {
    return {
      results,
      ok: false,
      latency_ms: failed.latency_ms,
      message: failed.message,
    };
  }
  return {
    results,
    ok: true,
    latency_ms: Math.max(...results.map((r) => r.latency_ms)),
    message: "",
  };
}

function connectivityLatencyClass(ok: boolean, latencyMs: number): string {
  if (!ok) return "text-red-600";
  if (latencyMs <= CONNECTIVITY_FAST_MS) return "text-green-700";
  if (latencyMs <= CONNECTIVITY_SLOW_MS) return "text-amber-600";
  return "text-amber-700";
}

function compareModels(
  a: Model,
  b: Model,
  field: SortField,
  dir: "asc" | "desc",
  categoryLabel: (cat: Model["category"]) => string,
): number {
  let r = 0;
  switch (field) {
    case "id":
      r = a.id.localeCompare(b.id);
      break;
    case "category":
      r = categoryLabel(a.category).localeCompare(categoryLabel(b.category), "zh");
      break;
    case "status":
      r = a.status.localeCompare(b.status);
      break;
  }
  return dir === "asc" ? r : -r;
}

function ModelsTh({
  children,
  active,
  className = "",
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-3 text-left text-[11px] font-medium whitespace-nowrap ${
        active ? "text-primary" : "text-muted-foreground"
      } ${className}`}
    >
      {children}
    </th>
  );
}

function HeaderFilter({
  active,
  open,
  onOpen,
  onClose,
  children,
  width = 260,
}: {
  active: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) { onClose(); return; }
          if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: rect.left });
          }
          onOpen();
        }}
        className="inline-flex items-center justify-center p-0.5 rounded transition-colors"
        style={{
          color: active ? "var(--primary)" : "var(--muted-foreground)",
          background: active ? "var(--primary-tint-12)" : "transparent",
        }}
        aria-expanded={open}
      >
        <Filter className="w-3 h-3" strokeWidth={2} />
      </button>
      {open && pos && createPortal(
        <div
          ref={boxRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: Math.max(8, Math.min(pos.left, window.innerWidth - width - 8)),
            zIndex: 50,
            width,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 10,
            boxShadow: "0 12px 40px rgba(0,0,0,0.15)",
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

function HeaderMultiList({
  options,
  selected,
  onToggle,
  searchPlaceholder,
  emptyText,
  labelFor,
}: {
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  searchPlaceholder: string;
  emptyText: string;
  labelFor?: (v: string) => string;
}) {
  const [kw, setKw] = useState("");
  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return k
      ? options.filter((o) => (labelFor ? labelFor(o) : o).toLowerCase().includes(k) || o.toLowerCase().includes(k))
      : options;
  }, [options, kw, labelFor]);

  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-border bg-background mb-2">
        <Search className="w-3 h-3 text-muted-foreground shrink-0" />
        <input
          autoFocus
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder={searchPlaceholder}
          className="bg-transparent text-[12px] flex-1 focus:outline-none"
        />
      </div>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {shown.length === 0 ? (
          <p className="text-[12px] text-muted-foreground text-center py-3">{emptyText}</p>
        ) : shown.map((o) => {
          const checked = selected.includes(o);
          return (
            <button
              key={o}
              type="button"
              onClick={() => onToggle(o)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] text-left hover:bg-secondary transition-colors"
            >
              <span
                className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center ${
                  checked ? "bg-primary border-primary" : "border-border"
                }`}
              >
                {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
              </span>
              <span className="truncate">{labelFor ? labelFor(o) : o}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}


function resolveCallNames(id: string, modelApiName: string | undefined, stored?: string[]): string[] {
  if (stored && stored.length > 0) return stored;
  return [id, modelApiName].filter((x): x is string => Boolean(x && x.trim()));
}

function CallNamesEditor({
  names,
  onChange,
  inputClass,
  t,
}: {
  names: string[];
  onChange: (names: string[]) => void;
  inputClass: string;
  t: ReturnType<typeof useT>["t"];
}) {
  const [draft, setDraft] = useState("");

  const addName = () => {
    const value = draft.trim();
    if (!value) return;
    if (names.includes(value)) {
      toast.error(t("admin.models.toast.callNameDuplicate", { name: value }));
      return;
    }
    onChange([...names, value]);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      <div>
        <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.callNames")}</label>
        <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">{t("admin.models.form.callNamesHint")}</p>
      </div>
      {names.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {names.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-[12px] font-mono"
            >
              {name}
              <button
                type="button"
                onClick={() => onChange(names.filter((n) => n !== name))}
                className="p-0.5 rounded hover:bg-background/80 text-muted-foreground hover:text-foreground transition-colors"
                title={t("admin.models.form.removeCallName")}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addName();
            }
          }}
          className={inputClass + " flex-1 font-mono text-[13px]"}
          placeholder={t("admin.models.form.callNamePlaceholder")}
        />
        <button
          type="button"
          onClick={addName}
          disabled={!draft.trim()}
          className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-xl text-[12px] text-primary hover:bg-blue-50 disabled:opacity-50 transition-colors border border-border/40"
        >
          <Plus className="w-3.5 h-3.5" /> {t("admin.models.form.addCallName")}
        </button>
      </div>
    </div>
  );
}


export default function ModelsTab({ token }: { token: string }) {
  const { t } = useT();
  const { models: adminModels, setModels: setAdminModels } = useModels();

  const categoryLabel = useCallback((cat: Model["category"]) => {
    const key = `modelPlaza.cat.${cat}`;
    const translated = (t as (k: string) => string)(key);
    return translated !== key ? translated : (categoryLabels[cat] || cat);
  }, [t]);

  const statusLabel = useCallback((status: Model["status"]) => {
    const plazaKey = `modelPlaza.status.${status}`;
    const plazaLabel = (t as (k: string) => string)(plazaKey);
    if (plazaLabel !== plazaKey) return plazaLabel;
    const adminKey = `admin.models.status.${status}`;
    const adminLabel = (t as (k: string) => string)(adminKey);
    if (adminLabel !== adminKey) return adminLabel;
    return statusLabels[status] ?? status;
  }, [t]);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([...DEFAULT_STATUS_FILTER]);
  const [openHeader, setOpenHeader] = useState<string | null>(null);
  const [importFormat, setImportFormat] = useState<"openai" | "custom">("openai");
  const [customHeaders, setCustomHeaders] = useState<{ key: string; val: string }[]>([{ key: "", val: "" }]);
  const [newModel, setNewModel] = useState({
    id: "", name: "", provider: "", contextWindow: "",
    category: "chat" as Model["category"],
    status: "online" as Model["status"],
    baseUrl: "", apiKey: "", modelApiName: "",
    callNames: [] as string[],
    addedAt: new Date().toISOString().split("T")[0],
  });

  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [editForm, setEditForm] = useState({
    name: "", provider: "", contextWindow: "",
    category: "chat" as Model["category"],
    status: "online" as Model["status"],
    tags: "",
    callNames: [] as string[],
    addedAt: "" as string, releaseDate: "" as string, params: "" as string,
    resolveToModelId: "" as string,
  });
  type EditEndpoint = {
    label: string;
    baseUrl: string;
    apiKey: string;
    modelApiName: string;
    upstreamPath: string;
    importFormat: "openai" | "custom" | "anthropic";
    headers: { key: string; val: string }[];
    keyHidden: boolean;
    /** 加权轮询的流量配比（>=1 的整数，缺省 1 均分）。 */
    weight: number;
  };
  const blankEndpoint = (label: string): EditEndpoint => ({
    label, baseUrl: "", apiKey: "", modelApiName: "", upstreamPath: "",
    importFormat: "openai", headers: [{ key: "", val: "" }], keyHidden: false,
    weight: 1,
  });
  const [editEndpoints, setEditEndpoints] = useState<EditEndpoint[]>([blankEndpoint(t("admin.models.endpoint.primary"))]);
  const [saving, setSaving] = useState(false);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [connectivityCache, setConnectivityCache] = useState<Record<string, ConnectivityCacheEntry>>({});
  const [connectivityResult, setConnectivityResult] = useState<{
    modelId: string;
    modelName: string;
    results: ConnectivityResult[];
  } | null>(null);

  const syncToBackend = useCallback(async (models: Model[]) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/models/sync`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ models }),
      });
      if (!res.ok) {
        toast.error(t("admin.models.toast.syncFailed"));
      }
    } catch {
      toast.error(t("admin.models.toast.syncNetworkError"));
    }
  }, [token]);

  useEffect(() => {
    fetch(`${API_BASE}/api/admin/models`, { headers: authHeaders(token) })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Record<string, unknown>[]) => {
        if (!Array.isArray(list) || list.length === 0) return;
        const parsed: Model[] = list.map((r) => ({
          id: String(r.id),
          name: String(r.name || r.id),
          provider: String(r.provider || ""),
          status: (r.status as Model["status"]) || "online",
          category: displayCategoryForModel(String(r.id), r.category as string) as Model["category"],
          shortDescription: String(r.shortDescription ?? ""),
          description: String(r.description ?? ""),
          contextWindow: String(r.contextWindow ?? "-"),
          speed: (r.speed as Model["speed"]) || "medium",
          baseUrl: r.baseUrl as string | undefined,
          modelApiName: r.modelApiName as string | undefined,
          importFormat: (r.importFormat as Model["importFormat"]) || "openai",
          customHeaders: r.customHeaders as Record<string, string> | undefined,
          endpoints: r.endpoints as Model["endpoints"],
          endpointCount: r.endpointCount as number | undefined,
          tags: r.tags as string[] | undefined,
          badge: r.badge as Model["badge"],
          scene: r.scene as Model["scene"],
          scenes: r.scenes as Model["scenes"],
          autoApprove: Boolean(r.autoApprove),
          arch: r.arch as Model["arch"],
          params: r.params as string | undefined,
          activatedParams: r.activatedParams as string | undefined,
          dimension: r.dimension as string | undefined,
          addedAt: String(r.addedAt ?? ""),
          releaseDate: resolveReleaseDate(String(r.id), r.releaseDate as string | undefined),
          resolveToModelId: r.resolveToModelId as string | null | undefined,
          callNames: Array.isArray(r.callNames) ? (r.callNames as string[]) : undefined,
          pricing: "",
        }));
        setAdminModels(sortModelsPlaza(parsed));
      })
      .catch(() => { /* keep context cache */ });
  }, [token, setAdminModels]);

  const openEdit = async (m: Model) => {
    setEditingModel(m);

    // Fetch FULL model config from admin API
    let fullModel: Record<string, any> = m as any;
    try {
      const res = await fetch(`${API_BASE}/api/admin/models`, { headers: authHeaders(token) });
      if (res.ok) {
        const list: Record<string, any>[] = await res.json();
        const found = list.find((r: any) => r.id === m.id);
        if (found) fullModel = found;
      }
    } catch { /* fallback to context model on network error */ }

    setEditForm({
      name: fullModel.name ?? m.name,
      provider: fullModel.provider ?? m.provider,
      contextWindow: fullModel.contextWindow ?? m.contextWindow,
      category: (fullModel.category ?? m.category) as Model["category"],
      status: (fullModel.status ?? m.status) as Model["status"],
      tags: ((fullModel.tags as string[] | undefined) || m.tags || []).join("、"),
      addedAt: (fullModel as any).addedAt || "",
      releaseDate: (fullModel as any).releaseDate || "",
      params: (fullModel as any).params || "",
      resolveToModelId: (fullModel as any).resolveToModelId || "",
      callNames: resolveCallNames(
        m.id,
        (fullModel as any).modelApiName || m.modelApiName,
        Array.isArray((fullModel as any).callNames) ? (fullModel as any).callNames : m.callNames,
      ),
    });

    // Populate endpoints with full data (including apiKey + customHeaders)
    const headersToRows = (hdrs?: Record<string, string>) =>
      hdrs && Object.keys(hdrs).length
        ? Object.entries(hdrs).map(([key, val]) => ({ key, val }))
        : [{ key: "", val: "" }];

    const endpoints = Array.isArray(fullModel.endpoints) && fullModel.endpoints.length > 0
      ? fullModel.endpoints
      : null;

    if (endpoints) {
      setEditEndpoints(endpoints.map((ep: any, i: number) => ({
        label: ep.label || t("admin.models.endpoint.label", { n: i + 1 }),
        baseUrl: ep.baseUrl || ep.base_url || "",
        apiKey: "",
        modelApiName: ep.modelApiName || ep.model_api_name || "",
        upstreamPath: ep.upstreamPath || ep.upstream_path || "",
        importFormat: (ep.importFormat || ep.import_format || "openai") as EditEndpoint["importFormat"],
        headers: headersToRows(ep.customHeaders || ep.custom_headers),
        keyHidden: !!(ep.apiKey || ep.api_key),
        weight: Number(ep.weight ?? 1) || 1,
      })));
    } else {
      setEditEndpoints([{
        label: t("admin.models.endpoint.primary"),
        baseUrl: fullModel.baseUrl || "",
        apiKey: "",
        modelApiName: fullModel.modelApiName || "",
        upstreamPath: fullModel.upstreamPath || "",
        importFormat: (fullModel.importFormat || "openai") as EditEndpoint["importFormat"],
        headers: headersToRows(fullModel.customHeaders),
        keyHidden: !!fullModel.apiKey,
        weight: 1,
      }]);
    }

  };

  const handleEditSave = async () => {
    if (!editingModel) return;

    // lts 别名模型是纯路由入口：只做 resolve，不配置接入参数
    const isLts = editForm.category === "lts";
    if (isLts && !editForm.resolveToModelId) {
      toast.error(t("admin.models.toast.resolveRequired"));
      return;
    }

    // Build endpoints payload, dropping rows without a baseUrl
    const cleaned = editEndpoints
      .map((ep, i) => {
        const headers = ep.importFormat === "custom" && ep.headers.some((h) => h.key && h.val)
          ? Object.fromEntries(ep.headers.filter((h) => h.key && h.val).map((h) => [h.key, h.val]))
          : null;
        return {
          row: ep, idx: i, headers,
          baseUrl: ep.baseUrl.trim(),
        };
      })
      .filter((x) => x.baseUrl.length > 0);

    // Allow saving with an empty endpoint list — useful for models that are
    // pre-registered before any deployment URL exists.
    // Warn (don't block) when the model is supposed to be on-line yet has none.
    // lts 别名模型无端点配置，跳过该提醒。
    if (!isLts && cleaned.length === 0 && editForm.status === "online") {
      toast(t("admin.models.toast.savedNoEndpoint"), {
        duration: 5000,
        icon: "⚠️",
      });
    }

    setSaving(true);

    // For each existing endpoint with hidden key and no new value typed,
    // we *omit* apiKey so the backend keeps the existing one.
    const endpointsPayload = cleaned.map(({ row, headers, baseUrl }, i) => {
      const label = row.label.trim() || t("admin.models.endpoint.label", { n: i + 1 });
      const keep = row.keyHidden && !row.apiKey;
      return {
        label,
        baseUrl,
        ...(keep ? {} : { apiKey: row.apiKey || null }),
        modelApiName: row.modelApiName || null,
        importFormat: row.importFormat,
        upstreamPath: row.upstreamPath.trim() || null,
        customHeaders: headers,
        weight: row.weight || 1,
      };
    });

    try {
      const res = await fetch(`${API_BASE}/api/admin/models/${editingModel.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          name:          editForm.name,
          provider:      editForm.provider,
          contextWindow: editForm.contextWindow,
          category:      editForm.category,
          status:        editForm.status,
          tags:          editForm.tags ? editForm.tags.split(/[，、,]+/).map((t) => t.trim()).filter(Boolean) : [],
          addedAt:       editForm.addedAt || null,
          releaseDate:   editForm.releaseDate || null,
          params:        editForm.params || null,
          resolveToModelId: editForm.resolveToModelId || null,
          callNames:     editForm.callNames,
          ...(isLts ? {} : { endpoints: endpointsPayload }),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(t("admin.models.toast.saveFailed", { detail: err?.detail || String(res.status) }));
        return;
      }
    } catch {
      toast.error(t("admin.models.toast.saveNetworkError"));
      return;
    } finally {
      setSaving(false);
    }

    // Sync local state — primary endpoint mirrored to legacy fields (if any).
    // When there are no endpoints we clear those legacy fields so the row UI
    // correctly reflects "no upstream configured".
    const primary = endpointsPayload[0];
    const localEndpoints: ModelEndpoint[] = endpointsPayload.map((ep) => ({
      label: ep.label,
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey ?? undefined,
      modelApiName: ep.modelApiName ?? undefined,
      importFormat: ep.importFormat,
      customHeaders: ep.customHeaders ?? undefined,
      weight: ep.weight || 1,
    }));
    setAdminModels((ms) =>
      ms.map((m) =>
        m.id === editingModel.id
          ? {
              ...m,
              name: editForm.name, provider: editForm.provider,
              contextWindow: editForm.contextWindow,
              category: editForm.category,
              status: editForm.status,
              tags: editForm.tags ? editForm.tags.split(/[，、,]+/).map((t) => t.trim()).filter(Boolean) : m.tags,
              callNames: editForm.callNames,
              resolveToModelId: editForm.resolveToModelId || undefined,
              // lts 别名模型没有端点配置，保留本地已有端点字段不覆盖
              ...(isLts ? {} : {
                baseUrl: primary?.baseUrl,
                modelApiName: primary?.modelApiName ?? undefined,
                importFormat: primary?.importFormat,
                customHeaders: primary?.customHeaders ?? undefined,
                endpoints: localEndpoints,
                endpointCount: localEndpoints.length,
              }),
            }
          : m
      )
    );

    setEditingModel(null);
    toast.success(t("admin.models.toast.updated", { name: editForm.name }));
  };


  const onlineCount = useMemo(
    () => adminModels.filter((m) => m.status === "online").length,
    [adminModels],
  );

  const uniqueStatuses = useMemo(
    () => [...new Set(adminModels.map((m) => m.status))].sort((a, b) => a.localeCompare(b)),
    [adminModels],
  );

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    adminModels.forEach((m) => set.add(m.category));
    return Array.from(set).sort((a, b) =>
      categoryLabel(a as Model["category"]).localeCompare(categoryLabel(b as Model["category"]), "zh"),
    );
  }, [adminModels, categoryLabel]);

  const statusFilterIsDefault = statusFilter.length === DEFAULT_STATUS_FILTER.length
    && DEFAULT_STATUS_FILTER.every((s) => statusFilter.includes(s));

  const hasColumnFilter = categoryFilter.length > 0 || !statusFilterIsDefault;

  const listModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = adminModels.filter((m) => {
      const matchSearch = !q
        || m.name.toLowerCase().includes(q)
        || m.provider.toLowerCase().includes(q)
        || m.id.toLowerCase().includes(q);
      const matchCategory = categoryFilter.length === 0 || categoryFilter.includes(m.category);
      const matchStatus = statusFilter.length === 0 || statusFilter.includes(m.status);
      return matchSearch && matchCategory && matchStatus;
    });
    if (sortField) {
      rows = [...rows].sort((a, b) => compareModels(a, b, sortField, sortDir, categoryLabel));
    } else {
      rows = sortModelsPlaza(rows);
    }
    return rows;
  }, [adminModels, search, categoryFilter, statusFilter, sortField, sortDir, categoryLabel]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDir === "desc") setSortDir("asc");
      else { setSortField(null); setSortDir("desc"); }
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const clearColumnFilters = () => {
    setCategoryFilter([]);
    setStatusFilter([...DEFAULT_STATUS_FILTER]);
  };

  function SortLabel({ field, label }: { field: SortField; label: string }) {
    return (
      <span
        className="inline-flex items-center gap-1 cursor-pointer select-none hover:text-foreground"
        onClick={() => handleSort(field)}
      >
        {label}
        {sortField === field
          ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-30" />}
      </span>
    );
  }

  // lts 别名模型：编辑时只保留路由目标 + 基础展示字段，隐藏接入参数
  const editingIsLts = editingModel !== null && editForm.category === "lts";

  const statusBadgeClass = (status: Model["status"]) => {
    if (status === "online") return "bg-ok/10 text-green-700";
    if (status === "upcoming") return "bg-sky-50 text-sky-700";  // 抢先体验计划
    if (status === "sunsetting") return "bg-warn/10 text-amber-700";
    if (status === "offline") return "bg-gray-100 text-gray-500";
    if (status === "pilot" || status === "maintenance" || status === "upgrading") return "bg-warn/10 text-amber-700";
    return "bg-gray-100 text-gray-500";
  };

  const toggleStatus = (id: string) => {
    const model = adminModels.find((m) => m.id === id);
    const goingOffline = model?.status === "online";
    setAdminModels((ms) => {
      const updated = ms.map((m) => (m.id === id ? { ...m, status: m.status === "online" ? "offline" as const : "online" as const } : m));
      syncToBackend(updated);
      return updated;
    });
    if (goingOffline) {
      toast.warning(t("admin.models.toast.offline", { name: model?.name || "" }), {
        description: t("admin.models.toast.offlineDesc"),
        duration: 6000,
      });
    } else {
      toast.success(t("admin.models.toast.online", { name: model?.name || "" }));
    }
  };

  const openConnectivityDetail = (m: Model, entry: ConnectivityCacheEntry) => {
    setConnectivityResult({
      modelId: m.id,
      modelName: m.name || m.id,
      results: entry.results,
    });
  };

  const runConnectivityTest = async (
    m: Model,
    opts?: { openModal?: boolean; quiet?: boolean },
  ): Promise<boolean> => {
    setTestingModelId(m.id);
    try {
      const res = await fetch(`${API_BASE}/api/admin/models/${m.id}/connectivity-test`, {
        method: "POST",
        headers: authHeaders(token),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!opts?.quiet) {
          toast.error(typeof data?.detail === "string" ? data.detail : t("admin.models.test.failed"));
        }
        return false;
      }
      const results: ConnectivityResult[] = Array.isArray(data.results) ? data.results : [];
      const entry = summarizeConnectivity(results);
      setConnectivityCache((prev) => ({ ...prev, [m.id]: entry }));
      if (opts?.openModal !== false) {
        openConnectivityDetail(m, entry);
      }
      return entry.ok;
    } catch {
      if (!opts?.quiet) toast.error(t("admin.models.test.networkError"));
      return false;
    } finally {
      setTestingModelId(null);
    }
  };

  const runConnectivityTestAll = async () => {
    const targets = listModels.filter(isConnectivityTestable);
    if (!targets.length) {
      toast.message(t("admin.models.test.testAllEmpty"));
      return;
    }
    setTestingAll(true);
    let passed = 0;
    let failed = 0;
    for (const m of targets) {
      const ok = await runConnectivityTest(m, { openModal: false, quiet: true });
      if (ok) passed += 1;
      else failed += 1;
    }
    setTestingAll(false);
    toast.success(t("admin.models.test.testAllDone", { passed, failed, total: targets.length }));
  };

  const deleteModel = async (id: string) => {
    const model = adminModels.find((m) => m.id === id);
    try {
      const res = await fetch(`${API_BASE}/api/admin/models/${id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      await requireOk(res, t("admin.models.toast.deleteFailed"));
      setAdminModels((models) => models.filter((item) => item.id !== id));
      toast.success(t("admin.models.toast.deleted", { name: model?.name || "" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.models.toast.deleteFailed"));
    }
  };

  const handleAdd = async () => {
    if (!newModel.id || !newModel.name || !newModel.provider) { toast.error(t("admin.models.toast.fillRequired")); return; }
    setAdding(true);

    const resolvedHeaders =
      importFormat === "custom" && customHeaders.some((h) => h.key && h.val)
        ? Object.fromEntries(customHeaders.filter((h) => h.key && h.val).map((h) => [h.key, h.val]))
        : null;

    const callNames = resolveCallNames(newModel.id, newModel.modelApiName || undefined, newModel.callNames);

    const newEntry: Model = {
      ...newModel,
      callNames,
      shortDescription: "",
      description: "",
      pricing: "",
      status: newModel.status,
      speed: "fast" as const,
      addedAt: newModel.addedAt || new Date().toISOString().split("T")[0],
      importFormat,
      baseUrl: newModel.baseUrl || undefined,
      apiKey: newModel.apiKey || undefined,
      modelApiName: newModel.modelApiName || undefined,
      customHeaders: resolvedHeaders ?? undefined,
    };

    try {
      // Sync the full list (adds the new model to DB via sync endpoint)
      const withNew = [newEntry, ...adminModels];
      const res = await fetch(`${API_BASE}/api/admin/models/sync`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ models: withNew }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(t("admin.models.toast.addFailed", { detail: err?.detail || String(res.status) }));
        return;
      }
    } catch {
      toast.error(t("admin.models.toast.addNetworkError"));
      return;
    } finally {
      setAdding(false);
    }

    setAdminModels((ms) => sortModelsPlaza([newEntry, ...ms]));
    setNewModel({ id: "", name: "", provider: "", contextWindow: "", category: "chat", status: "online", baseUrl: "", apiKey: "", modelApiName: "", callNames: [], addedAt: new Date().toISOString().split("T")[0] });
    setCustomHeaders([{ key: "", val: "" }]);
    setImportFormat("openai");
    setShowAdd(false);
    toast.success(t("admin.models.toast.added"));
  };

  const inputClass = "w-full px-4 py-3 rounded-xl bg-bg-soft text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15 border border-border/40 transition-all";

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("admin.nav.models")}
        description={t("admin.nav.models.desc")}
        subline={t("admin.models.summary", { total: adminModels.length, online: onlineCount })}
        actions={(
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-[13px] hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" /> {t("admin.models.addNew")}
          </button>
        )}
      />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-[16px] h-[16px] text-muted-foreground/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("admin.models.searchPlaceholder")}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-card text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15 border border-border/30 shadow-sm"
          />
        </div>
        {hasColumnFilter && (
          <button
            type="button"
            onClick={clearColumnFilters}
            className="shrink-0 flex items-center gap-1 px-2.5 py-2 rounded-xl text-[12px] text-muted-foreground hover:text-foreground hover:bg-secondary border border-border/30 transition-colors"
          >
            <X className="w-3 h-3" /> {t("common.clear")}
          </button>
        )}
      </div>

      {/* Add Modal */}
      <ModalPortal open={showAdd} onClose={() => setShowAdd(false)}>
          <div
            className="relative bg-card rounded-2xl w-full max-w-lg p-7 space-y-5 shadow-xl overflow-y-auto modal-panel-enter"
            style={{ maxHeight: "min(90vh, calc(100dvh - 3rem))" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-[18px] font-medium text-foreground">{t("admin.models.addNew")}</h2>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.id")}</label>
                  <input value={newModel.id} onChange={(e) => setNewModel((n) => ({ ...n, id: e.target.value }))} className={inputClass + " font-mono"} placeholder="my-model-v1" />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.displayName")}</label>
                  <input value={newModel.name} onChange={(e) => setNewModel((n) => ({ ...n, name: e.target.value }))} className={inputClass + " font-serif"} placeholder="MyModel V1" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.provider")}</label>
                  <input value={newModel.provider} onChange={(e) => setNewModel((n) => ({ ...n, provider: e.target.value }))} className={inputClass} placeholder={t("admin.models.form.providerHint")} />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.category")}</label>
                  <select value={newModel.category} onChange={(e) => setNewModel((n) => ({ ...n, category: e.target.value as Model["category"] }))} className={inputClass}>
                    {Object.keys(categoryLabels).map((k) => (
                      <option key={k} value={k}>{categoryLabel(k as Model["category"])}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.contextWindow")}</label>
                  <input value={newModel.contextWindow} onChange={(e) => setNewModel((n) => ({ ...n, contextWindow: e.target.value }))} className={inputClass} placeholder="128K" />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.apiModelName")}</label>
                  <input value={newModel.modelApiName} onChange={(e) => setNewModel((n) => ({ ...n, modelApiName: e.target.value }))} className={inputClass + " font-mono"} placeholder={t("admin.models.form.apiModelNameHint")} />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">
                    {t("admin.models.form.addedAt")} <span className="opacity-50 font-normal">{t("admin.models.form.addedAtHint")}</span>
                  </label>
                  <input type="date" value={newModel.addedAt} onChange={(e) => setNewModel((n) => ({ ...n, addedAt: e.target.value }))} className={inputClass} />
                </div>
              </div>
              <div>
                <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.status")}</label>
                <select
                  value={newModel.status}
                  onChange={(e) => setNewModel((n) => ({ ...n, status: e.target.value as Model["status"] }))}
                  className={inputClass}
                >
                  <option value="online">{t("admin.models.status.online")}</option>
                  <option value="exclusive">{t("admin.models.status.exclusive")}</option>
                  <option value="upcoming">{t("admin.models.status.upcoming")}</option>
                  <option value="sunsetting">{t("admin.models.status.sunsetting")}</option>
                  <option value="offline">{t("admin.models.status.offline")}</option>
                </select>
              </div>
              <CallNamesEditor
                names={resolveCallNames(newModel.id, newModel.modelApiName, newModel.callNames.length ? newModel.callNames : undefined)}
                onChange={(callNames) => setNewModel((n) => ({ ...n, callNames }))}
                inputClass={inputClass}
                t={t}
              />
              <div className="border-t border-border/30 pt-3">
                <label className="text-[12px] text-muted-foreground block mb-2">{t("admin.models.form.importFormat")}</label>
                <div className="flex gap-2 mb-3">
                  {[{ k: "openai" as const, label: t("admin.models.format.openai") }, { k: "custom" as const, label: t("admin.models.format.custom") }].map(({ k, label }) => (
                    <button key={k} type="button" onClick={() => setImportFormat(k)}
                      className={`flex-1 py-2 rounded-xl text-[13px] transition-all border ${importFormat === k ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/40 hover:text-foreground"}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-[12px] text-muted-foreground block mb-1.5">Base URL</label>
                    <input value={newModel.baseUrl} onChange={(e) => setNewModel((n) => ({ ...n, baseUrl: e.target.value }))} className={inputClass + " font-mono"} placeholder={t("admin.models.form.baseUrlHint")} />
                  </div>
                  <div>
                    <label className="text-[12px] text-muted-foreground block mb-1.5">API Key</label>
                    <input type="password" value={newModel.apiKey} onChange={(e) => setNewModel((n) => ({ ...n, apiKey: e.target.value }))} className={inputClass + " font-mono"} placeholder="sk-..." />
                  </div>
                  {importFormat === "custom" && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-[12px] text-muted-foreground">{t("admin.models.form.customHeaders")}</label>
                        <button type="button" onClick={() => setCustomHeaders((h) => [...h, { key: "", val: "" }])} className="flex items-center gap-1 text-[11px] text-primary hover:opacity-80 transition-opacity">
                          <Plus className="w-3 h-3" /> {t("admin.models.form.add")}
                        </button>
                      </div>
                      <div className="space-y-2">
                        {customHeaders.map((h, hi) => (
                          <div key={hi} className="flex gap-2 items-center">
                            <input value={h.key} onChange={(e) => setCustomHeaders((hs) => hs.map((x, i) => i === hi ? { ...x, key: e.target.value } : x))} className={inputClass + " flex-1 font-mono"} placeholder={t("admin.models.form.headerName")} />
                            <input value={h.val} onChange={(e) => setCustomHeaders((hs) => hs.map((x, i) => i === hi ? { ...x, val: e.target.value } : x))} className={inputClass + " flex-1 font-mono"} placeholder={t("admin.models.form.headerValue")} />
                            {customHeaders.length > 1 && (
                              <button type="button" onClick={() => setCustomHeaders((hs) => hs.filter((_, i) => i !== hi))} className="p-1.5 text-red-400 hover:bg-danger/10 rounded-lg transition-colors shrink-0">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowAdd(false)} className="px-5 py-2.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">{t("admin.models.form.cancel")}</button>
              <button onClick={handleAdd} disabled={adding} className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-xl text-[13px] disabled:opacity-60">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {adding ? t("admin.models.form.adding") : t("admin.models.form.confirmAdd")}
              </button>
            </div>
          </div>
      </ModalPortal>

      {/* Edit Modal */}
      <ModalPortal open={!!editingModel} onClose={() => setEditingModel(null)}>
          <div
            className="relative bg-card rounded-2xl w-full shadow-xl modal-panel-enter flex flex-col"
            style={{ maxWidth: editingIsLts ? "560px" : "900px", maxHeight: "min(92vh, calc(100dvh - 3rem))" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-7 pt-6 pb-4 border-b border-border shrink-0">
              <div>
                <h2 className="font-serif text-[18px] font-medium text-foreground">{t("admin.models.edit.title")}</h2>
                <p className="text-[12px] text-muted-foreground mt-0.5">ID: <code>{editingModel?.id}</code></p>
              </div>
              <button onClick={() => setEditingModel(null)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            {/* Modal body — 2-column grid, left fixed / right scrolls */}
            <div className="flex-1 overflow-hidden flex min-h-0">
            <div className={editingIsLts ? "flex-1 overflow-y-auto min-h-0" : "w-1/2 overflow-y-auto border-r border-border"}>
              {/* ── Left column: basic info ── */}
              <div className="px-7 py-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.displayName")}</label>
                  <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className={inputClass + " font-serif"} />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.provider")}</label>
                  <input value={editForm.provider} onChange={(e) => setEditForm((f) => ({ ...f, provider: e.target.value }))} className={inputClass} />
                </div>
              </div>
              <div className={editingIsLts ? "" : "grid grid-cols-2 gap-3"}>
                {!editingIsLts && (
                <>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.category")}</label>
                  <select value={editForm.category} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value as Model["category"] }))} className={inputClass}>
                    {Object.keys(categoryLabels).map((k) => (
                      <option key={k} value={k}>{categoryLabel(k as Model["category"])}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.contextWindow")}</label>
                  <input value={editForm.contextWindow} onChange={(e) => setEditForm((f) => ({ ...f, contextWindow: e.target.value }))} className={inputClass} placeholder="128K" />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">
                    {t("admin.models.form.addedAt")} <span className="opacity-50 font-normal">{t("admin.models.form.addedAtHint")}</span>
                  </label>
                  <input type="date" value={editForm.addedAt} onChange={(e) => setEditForm((f) => ({ ...f, addedAt: e.target.value }))} className={inputClass} />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">
                    {t("admin.models.form.releaseDate")} <span className="opacity-50 font-normal">{t("admin.models.form.releaseDateHint")}</span>
                  </label>
                  <input value={editForm.releaseDate} onChange={(e) => setEditForm((f) => ({ ...f, releaseDate: e.target.value }))} className={inputClass} placeholder="2026-04" />
                </div>
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.params")}</label>
                  <input value={editForm.params} onChange={(e) => setEditForm((f) => ({ ...f, params: e.target.value }))} className={inputClass} placeholder="671B" />
                </div>
                </>
                )}
                <div>
                  <label className="text-[12px] text-muted-foreground block mb-1.5">
                    {t("admin.models.form.resolveToModelId")}
                    {editingIsLts
                      ? <span className="text-red-500"> *</span>
                      : <span className="opacity-50 font-normal"> {t("admin.models.form.resolveToModelIdHint")}</span>}
                  </label>
                  <select
                    value={editForm.resolveToModelId}
                    onChange={(e) => setEditForm((f) => ({ ...f, resolveToModelId: e.target.value }))}
                    className={inputClass}
                  >
                    <option value="">{t("admin.models.form.noResolveTarget")}</option>
                    {adminModels
                      .filter((m) => m.id !== editingModel?.id && m.category !== "lts")
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.id} — {m.provider}</option>
                      ))}
                  </select>
                  {editingIsLts && (
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      {t("admin.models.form.ltsResolveHint")}
                    </p>
                  )}
                </div>
              </div>
              <div>
                <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.tags")}</label>
                <input value={editForm.tags} onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))} className={inputClass} placeholder={t("admin.models.form.tagsHint")} />
              </div>

              <CallNamesEditor
                names={editForm.callNames}
                onChange={(callNames) => setEditForm((f) => ({ ...f, callNames }))}
                inputClass={inputClass}
                t={t}
              />

              {/* ── Lifecycle status ─────────────────── */}
              <div>
                <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.form.status")}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value as Model["status"] }))}
                  className={inputClass}
                >
                  <option value="online">{t("admin.models.status.online")}</option>
                  <option value="exclusive">{t("admin.models.status.exclusive")}</option>
                  <option value="upcoming">{t("admin.models.status.upcoming")}</option>
                  <option value="sunsetting">{t("admin.models.status.sunsetting")}</option>
                  <option value="offline">{t("admin.models.status.offline")}</option>
                </select>
              </div>
              {editForm.status === "upcoming" && (
                <p className="text-[11px] text-blue-700 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40 rounded-lg px-3 py-2 -mt-1">
                  {t("admin.models.status.upcomingHint")}
                </p>
              )}

              </div>{/* end left column */}
            </div>{/* end left scroll wrapper */}

              {/* ── Right column: endpoint config + key refresh（lts 别名模型隐藏） ── */}
              {!editingIsLts && (
              <div className="w-1/2 overflow-y-auto">
              <div className="px-7 py-5 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[12px] text-muted-foreground font-medium">{t("admin.models.endpoints.title")}</label>
                  <button type="button"
                    onClick={() => setEditEndpoints((eps) => [...eps, blankEndpoint(t("admin.models.endpoint.label", { n: eps.length + 1 }))])}
                    className="flex items-center gap-1 text-[11px] text-primary hover:opacity-80 transition-opacity">
                    <Plus className="w-3 h-3" /> {t("admin.models.endpoints.addEndpoint")}
                  </button>
                </div>
                {editEndpoints.length > 1 && (
                  <p className="text-[11px] text-muted-foreground/70 mb-2">{t("admin.models.endpoints.multiHint", { n: editEndpoints.length })}</p>
                )}
                <div className="space-y-3">
                  {editEndpoints.map((ep, ei) => {
                    const updateEp = (patch: Partial<EditEndpoint>) =>
                      setEditEndpoints((eps) => eps.map((x, i) => i === ei ? { ...x, ...patch } : x));
                    const updateHeader = (hi: number, patch: Partial<{ key: string; val: string }>) =>
                      setEditEndpoints((eps) => eps.map((x, i) => i === ei ? { ...x, headers: x.headers.map((h, j) => j === hi ? { ...h, ...patch } : h) } : x));
                    return (
                      <div key={ei} className="rounded-xl border border-border/30 bg-background/40 p-3 space-y-2.5">
                        <div className="flex items-center gap-2">
                          <input value={ep.label}
                            onChange={(e) => updateEp({ label: e.target.value })}
                            className={inputClass + " flex-1 !py-2 font-serif text-[13px]"}
                            placeholder={t("admin.models.endpoints.labelPlaceholder")} />
                          {editEndpoints.length > 1 && (
                            <button type="button"
                              onClick={() => setEditEndpoints((eps) => eps.filter((_, i) => i !== ei))}
                              className="p-2 text-red-400 hover:bg-danger/10 rounded-lg transition-colors shrink-0"
                              title={t("admin.models.endpoints.remove")}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {[{ k: "openai" as const, label: t("admin.models.format.openai") }, { k: "anthropic" as const, label: t("admin.models.format.anthropic") }, { k: "custom" as const, label: t("admin.models.format.custom") }].map(({ k, label }) => (
                            <button key={k} type="button"
                              onClick={() => updateEp({ importFormat: k })}
                              className={`flex-1 py-1.5 rounded-lg text-[12px] transition-all border ${ep.importFormat === k ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border/40 hover:text-foreground"}`}>
                              {label}
                            </button>
                          ))}
                        </div>
                        <div>
                          <label className="text-[11px] text-muted-foreground block mb-1">Base URL</label>
                          <input value={ep.baseUrl} onChange={(e) => updateEp({ baseUrl: e.target.value })}
                            className={inputClass + " font-mono"}
                            placeholder={
                              ep.importFormat === "custom"
                                ? t("admin.models.endpoints.baseUrlPlaceholder.custom")
                                : ep.importFormat === "anthropic"
                                  ? t("admin.models.endpoints.baseUrlPlaceholder.anthropic")
                                  : t("admin.models.endpoints.baseUrlPlaceholder.openai")
                            } />
                          {ep.importFormat === "custom" && (
                            <p className="text-[10px] text-muted-foreground/70 mt-1">{t("admin.models.endpoints.customUrlHint")}</p>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">API Key</label>
                            <input type="password" value={ep.apiKey}
                              onChange={(e) => updateEp({ apiKey: e.target.value })}
                              className={inputClass + " font-mono"}
                              placeholder={ep.keyHidden ? t("admin.models.endpoints.keyUnchanged") : t("admin.models.endpoints.keyOptional")} />
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">{t("admin.models.form.apiModelName")}</label>
                            <input value={ep.modelApiName}
                              onChange={(e) => updateEp({ modelApiName: e.target.value })}
                              className={inputClass + " font-mono"} placeholder={t("admin.models.endpoints.apiModelNameHint")} />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">
                              {t("admin.models.endpoints.weight")}{" "}
                              <span className="opacity-60 font-normal">{t("admin.models.endpoints.weightHint")}</span>
                            </label>
                            <input type="number" min={1} step={1} value={ep.weight}
                              onChange={(e) => updateEp({ weight: Math.max(1, Number(e.target.value) || 1) })}
                              className={inputClass} />
                          </div>
                        </div>
                        {ep.importFormat !== "custom" && (
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">{t("admin.models.form.upstreamPath")}</label>
                            <input value={ep.upstreamPath}
                              onChange={(e) => updateEp({ upstreamPath: e.target.value })}
                              className={inputClass + " font-mono"} placeholder={t("admin.models.endpoints.upstreamPathHint")} />
                          </div>
                        )}
                        {ep.importFormat === "custom" && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-[11px] text-muted-foreground">{t("admin.models.form.customHeaders")}</label>
                              <button type="button"
                                onClick={() => updateEp({ headers: [...ep.headers, { key: "", val: "" }] })}
                                className="flex items-center gap-1 text-[11px] text-primary hover:opacity-80 transition-opacity">
                                <Plus className="w-3 h-3" /> {t("admin.models.form.add")}
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              {ep.headers.map((h, hi) => (
                                <div key={hi} className="flex gap-2 items-center">
                                  <input value={h.key} onChange={(e) => updateHeader(hi, { key: e.target.value })} className={inputClass + " flex-1 !py-2 font-mono"} placeholder={t("admin.models.form.headerName")} />
                                  <input value={h.val} onChange={(e) => updateHeader(hi, { val: e.target.value })} className={inputClass + " flex-1 !py-2 font-mono"} placeholder={t("admin.models.form.headerValue")} />
                                  {ep.headers.length > 1 && (
                                    <button type="button"
                                      onClick={() => updateEp({ headers: ep.headers.filter((_, j) => j !== hi) })}
                                      className="p-1.5 text-red-400 hover:bg-danger/10 rounded-lg transition-colors shrink-0">
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>


              </div>{/* end right content */}
            </div>
              )}{/* end right scroll wrapper */}
            </div>{/* end columns flex */}

            {/* Modal footer */}
            <div className="flex justify-end gap-3 px-7 py-4 border-t border-border shrink-0">
              <button onClick={() => setEditingModel(null)} className="px-5 py-2.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">{t("admin.models.form.cancel")}</button>
              <button onClick={handleEditSave} disabled={saving} className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-xl text-[13px] disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {saving ? t("admin.models.form.saving") : t("admin.models.form.save")}
              </button>
            </div>
          </div>
      </ModalPortal>

      <ModalPortal open={!!connectivityResult} onClose={() => setConnectivityResult(null)}>
        <div
          className="relative bg-card rounded-2xl w-full max-w-lg shadow-xl modal-panel-enter flex flex-col"
          style={{ maxHeight: "min(85vh, calc(100dvh - 3rem))" }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-border shrink-0">
            <div>
              <h2 className="font-serif text-[16px] font-medium text-foreground">{t("admin.models.test.title")}</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <span className="font-serif font-medium text-foreground">{connectivityResult?.modelName}</span>
                <code className="ml-1.5 font-mono text-[11px]">{connectivityResult?.modelId}</code>
              </p>
            </div>
            <button onClick={() => setConnectivityResult(null)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
          <div className="px-6 py-4 overflow-y-auto space-y-3">
            {connectivityResult?.results.map((r) => (
              <div
                key={`${r.index}-${r.label}`}
                className={`rounded-xl border px-4 py-3 ${r.ok ? "border-green-200/70 bg-green-50/40" : "border-red-200/70 bg-red-50/40"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-serif text-[13px] font-medium text-foreground">{r.label}</div>
                    {r.base_url && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={r.base_url}>
                        {r.base_url}
                      </div>
                    )}
                    {!r.ok && (
                      <div className="text-[12px] mt-1.5 text-red-700">{r.message}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {r.ok ? (
                      <span className={`text-[14px] font-semibold tabular-nums ${connectivityLatencyClass(true, r.latency_ms)}`}>
                        {t("admin.models.test.latency", { ms: r.latency_ms })}
                      </span>
                    ) : (
                      <span className="inline-block text-[11px] px-2 py-0.5 rounded-md font-medium bg-red-100 text-red-700">
                        {t("admin.models.test.fail")}
                      </span>
                    )}
                    {!r.ok && r.status_code != null && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                        HTTP {r.status_code}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-border shrink-0">
            {connectivityResult && !summarizeConnectivity(connectivityResult.results).ok && (
              <button
                type="button"
                onClick={() => {
                  const m = adminModels.find((x) => x.id === connectivityResult.modelId);
                  if (m) void runConnectivityTest(m);
                }}
                disabled={testingModelId === connectivityResult.modelId}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-[13px] text-primary hover:bg-blue-50 disabled:opacity-50 transition-colors"
              >
                {testingModelId === connectivityResult.modelId
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <RotateCcw className="w-4 h-4" />}
                {t("admin.models.test.retest")}
              </button>
            )}
            <button
              onClick={() => setConnectivityResult(null)}
              className="px-5 py-2.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </ModalPortal>

      <div className="bg-card rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {listModels.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-[13px] text-muted-foreground/50">
              {t("admin.models.empty")}
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/40 bg-secondary/40">
                  <ModelsTh active={sortField === "id"}>
                    <span className="inline-flex items-center gap-1">
                      <SortLabel field="id" label={t("admin.models.col.model")} />
                    </span>
                  </ModelsTh>
                  <ModelsTh active={sortField === "category" || categoryFilter.length > 0}>
                    <span className="inline-flex items-center gap-1">
                      <SortLabel field="category" label={t("admin.models.col.category")} />
                      <HeaderFilter
                        active={categoryFilter.length > 0}
                        open={openHeader === "category"}
                        onOpen={() => setOpenHeader("category")}
                        onClose={() => setOpenHeader(null)}
                      >
                        <HeaderMultiList
                          options={categoryOptions}
                          selected={categoryFilter}
                          onToggle={(v) => setCategoryFilter((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
                          searchPlaceholder={t("admin.models.searchPlaceholder")}
                          emptyText={t("admin.models.filter.noMatch")}
                          labelFor={(v) => categoryLabel(v as Model["category"])}
                        />
                      </HeaderFilter>
                    </span>
                  </ModelsTh>
                  <ModelsTh active={sortField === "status" || !statusFilterIsDefault}>
                    <span className="inline-flex items-center gap-1">
                      <SortLabel field="status" label={t("admin.models.col.status")} />
                      <HeaderFilter
                        active={!statusFilterIsDefault}
                        open={openHeader === "status"}
                        onOpen={() => setOpenHeader("status")}
                        onClose={() => setOpenHeader(null)}
                      >
                        <HeaderMultiList
                          options={uniqueStatuses}
                          selected={statusFilter}
                          onToggle={(v) => setStatusFilter((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
                          searchPlaceholder={t("admin.models.searchPlaceholder")}
                          emptyText={t("admin.models.filter.noMatch")}
                          labelFor={(v) => statusLabel(v as Model["status"])}
                        />
                      </HeaderFilter>
                    </span>
                  </ModelsTh>
                  <ModelsTh>{t("admin.models.col.endpoints")}</ModelsTh>
                  <ModelsTh className="text-center">
                    <span className="inline-flex items-center justify-center gap-1.5">
                      {t("admin.models.col.test")}
                      <button
                        type="button"
                        onClick={runConnectivityTestAll}
                        disabled={testingAll || testingModelId !== null}
                        className="p-1 rounded-md text-muted-foreground hover:text-primary hover:bg-secondary disabled:opacity-40 transition-colors"
                        title={t("admin.models.test.testAllHint")}
                      >
                        {testingAll
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Zap className="w-3.5 h-3.5" />}
                      </button>
                    </span>
                  </ModelsTh>
                  <ModelsTh className="text-right">{t("admin.models.col.actions")}</ModelsTh>
                </tr>
              </thead>
              <tbody>
                {listModels.map((m) => (
                  <tr key={m.id} className="border-b border-border/20 hover:bg-secondary/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5 min-w-[200px]">
                        <ProviderIcon provider={m.provider} id={m.id} size="sm" className="shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-serif text-[13px] font-medium text-foreground">{m.name || m.id}</span>
                          </div>
                          {m.name && m.name !== m.id && (
                            <span className="text-[11px] text-muted-foreground font-mono">{m.id}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-[11px] bg-secondary px-2 py-0.5 rounded">{categoryLabel(m.category)}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`text-[11px] px-2.5 py-0.5 rounded-md ${statusBadgeClass(m.status)}`}>
                        {statusLabel(m.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[12px] text-muted-foreground tabular-nums">
                      {(m.endpoints?.length ?? m.endpointCount ?? 0) || "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(() => {
                        const testable = isConnectivityTestable(m);
                        const cached = connectivityCache[m.id];
                        const isTesting = testingModelId === m.id;

                        if (!testable) {
                          return <span className="text-[11px] text-muted-foreground/50">—</span>;
                        }
                        if (isTesting) {
                          return (
                            <span className="inline-flex items-center justify-center py-1">
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                            </span>
                          );
                        }
                        if (cached) {
                          if (!cached.ok) {
                            return (
                              <span className="inline-flex items-center justify-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => openConnectivityDetail(m, cached)}
                                  className="inline-flex items-center justify-center rounded-lg px-2 py-1 hover:bg-secondary/60 transition-colors"
                                  title={cached.message}
                                >
                                  <span className="text-[12px] font-medium text-red-600">
                                    {t("admin.models.test.fail")}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => runConnectivityTest(m, { openModal: false })}
                                  disabled={testingAll}
                                  className="p-1 rounded-md text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
                                  title={t("admin.models.test.retest")}
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              </span>
                            );
                          }
                          return (
                            <button
                              type="button"
                              onClick={() => openConnectivityDetail(m, cached)}
                              className="inline-flex items-center justify-center min-w-[52px] rounded-lg px-2 py-1 hover:bg-secondary/60 transition-colors"
                              title={t("admin.models.test.latency", { ms: cached.latency_ms })}
                            >
                              <span className={`text-[13px] font-semibold tabular-nums ${connectivityLatencyClass(true, cached.latency_ms)}`}>
                                {t("admin.models.test.latency", { ms: cached.latency_ms })}
                              </span>
                            </button>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={() => runConnectivityTest(m)}
                            disabled={testingAll}
                            className="inline-flex items-center justify-center p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-blue-50 disabled:opacity-40 transition-colors"
                            title={t("admin.models.test.action")}
                          >
                            <Activity className="w-4 h-4" />
                          </button>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(m)}
                          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                          title={t("admin.models.edit.title")}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => toggleStatus(m.id)}
                          className={`p-2 rounded-lg transition-colors ${m.status === "online" ? "text-amber-500 hover:bg-warn/10" : "text-green-500 hover:bg-ok/10"}`}
                          title={m.status === "online" ? t("admin.models.action.offline") : t("admin.models.action.online")}
                        >
                          {m.status === "online" ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => deleteModel(m.id)}
                          className="p-2 rounded-lg text-red-400 hover:bg-danger/10 transition-colors"
                          title={t("admin.models.action.delete")}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

    </div>
  );
}
