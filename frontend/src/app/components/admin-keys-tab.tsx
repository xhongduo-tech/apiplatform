import { useState, useEffect, useCallback } from "react";
import {
  Trash2, PowerOff, Power, Loader2, Search, RefreshCw, Zap, Copy, X, Check, Plus, Pencil, AlertTriangle, ChevronLeft, ChevronRight,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { toast } from "sonner";
import {
  copyToClipboard, downloadCsv, API_BASE, authHeaders, fmtTime, matchPreset, ModalPortal,
  HeaderFilter, FilterList, requireOk,
  type ApiRecord, type RatePreset as Preset,
} from "./admin-tab-utils";
import { api, type AdminApplicationRow } from "../api/gateway";
import { useT } from "../i18n";

type KeySortKey = "project_name" | "department" | "auth_id" | "revoked" | "granted_at";

/** 操作列闪电按钮：档位色对齐用户侧 Keys（默认黑 / 高并发 brand / 超高并发紫）。 */
function adminTierVis(
  presets: Preset[],
  r: ApiRecord,
  t: ReturnType<typeof useT>["t"],
) {
  const hit = matchPreset(presets, r.rpmLimit, r.tpmLimit);
  if (hit?.unlimited) {
    return {
      label: hit.name,
      iconCls: "text-violet-600",
      actionCls: "text-violet-600 hover:text-violet-600 hover:bg-violet-50",
    };
  }
  if (hit?.key === "high") {
    return {
      label: hit.name,
      iconCls: "text-brand",
      actionCls: "text-brand hover:text-brand hover:bg-brand/10",
    };
  }
  if (hit?.key === "default" || (r.rpmLimit == null && r.tpmLimit == null)) {
    return {
      label: hit?.name ?? t("admin.keys.default"),
      iconCls: "text-foreground",
      actionCls: "text-foreground hover:text-brand hover:bg-brand/10",
    };
  }
  return {
    label: t("admin.keys.custom"),
    iconCls: "text-foreground",
    actionCls: "text-foreground hover:text-brand hover:bg-brand/10",
  };
}

const inputClass =
  "w-full px-3.5 py-2.5 rounded-xl bg-bg-soft text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15 border border-border/40 transition-all";

type ConfirmState = {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmClass: string;
  onConfirm: () => void;
} | null;

type CreateState = {
  name: string;
  authId: string;
  projectName: string;
  department: string;
  projectDesc: string;
  createdKey: string | null;
  loading: boolean;
  copied: boolean;
  confirmedSaved: boolean;
};

const PAGE_SIZE = 50;

export default function KeysTab({ token }: { token: string }) {
  const { t } = useT();
  const [records, setRecords] = useState<ApiRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "revoked" | "pending">("all");
  const [deptFilter, setDeptFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [sort, setSort] = useState<KeySortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterOpen, setFilterOpen] = useState<"department" | "tier" | "status" | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rateLimits, setRateLimits] = useState<{ rpm: number; tpm: number } | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // ── 待审批的密钥申请（合并展示在同一个 Keys 标签页里，不单开 Tab）──────────────
  const [appRows, setAppRows] = useState<AdminApplicationRow[]>([]);
  const [appPendingTotal, setAppPendingTotal] = useState(0);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<AdminApplicationRow | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  /** 明文密钥单次展示（仅管理员主动更换新密钥；审批密钥由申请人领取） */
  const [keyReveal, setKeyReveal] = useState<{ name: string; apiKey: string; title: string } | null>(null);

  const refreshPendingCount = useCallback(async () => {
    try {
      const d = await api.adminApplicationsList(token, { limit: 1, offset: 0, status: "pending" });
      setAppPendingTotal(d.pendingTotal ?? 0);
    } catch {
      /* 角标刷新失败不打扰管理员，下次操作会重试 */
    }
  }, [token]);

  useEffect(() => { refreshPendingCount(); }, [refreshPendingCount]);

  const defaultCreate: CreateState = {
    name: "", authId: "", projectName: "", department: "", projectDesc: "",
    createdKey: null, loading: false, copied: false, confirmedSaved: false,
  };
  const [createForm, setCreateForm] = useState<CreateState>(defaultCreate);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/public/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (c?.rate_limit) setRateLimits(c.rate_limit);
        if (Array.isArray(c?.rate_limit_presets)) setPresets(c.rate_limit_presets);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (statusFilter === "pending") {
        const d = await api.adminApplicationsList(token, {
          limit: PAGE_SIZE, offset: page * PAGE_SIZE, status: "pending",
        });
        setAppRows(d.data ?? []);
        setTotal(d.total ?? 0);
        setAppPendingTotal(d.pendingTotal ?? 0);
      } else {
        const data = await api.adminKeysList(token, {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          status: statusFilter !== "all" ? statusFilter : undefined,
          q: debouncedSearch.trim() || undefined,
          department: deptFilter || undefined,
          tier: tierFilter || undefined,
          sort: sort || undefined,
          order: sort ? sortDir : undefined,
        });
        const list = Array.isArray(data?.data) ? data.data : [];
        setRecords(list.map((r) => ({
          ...r,
          projectDesc: r.projectDesc ?? undefined,
        })));
        setTotal(typeof data?.total === "number" ? data.total : 0);
        setDepartments(Array.isArray(data?.departments) ? data.departments : []);
      }
    } catch {
      toast.error(t("admin.keys.loadFailed"));
    }
    setLoading(false);
  }, [token, page, statusFilter, debouncedSearch, deptFilter, tierFilter, sort, sortDir, t]);

  useEffect(() => { loadData(); }, [loadData]);

  function toggleSort(field: KeySortKey) {
    if (sort === field) {
      if (sortDir === "desc") setSortDir("asc");
      else { setSort(null); setSortDir("desc"); }
    } else {
      setSort(field);
      setSortDir(field === "project_name" || field === "department" || field === "auth_id" ? "asc" : "desc");
    }
    setPage(0);
  }

  function tierFilterLabel(v: string) {
    if (v === "default") return t("admin.keys.default");
    if (v === "high") return t("keys.highConcurrency");
    if (v === "unlimited") return t("keys.ultraConcurrency");
    if (v === "custom") return t("admin.keys.custom");
    return v;
  }

  const SortIcon = ({ field }: { field: KeySortKey }) => (
    sort === field
      ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
      : <ArrowUpDown className="h-3 w-3 opacity-30" />
  );

  const hasExtraFilter = Boolean(deptFilter || tierFilter);

  async function runApprove(row: AdminApplicationRow) {
    setBusyAppId(row.id);
    try {
      await api.adminApplicationReview(token, row.id, "approve");
      const name = row.projectName || row.name;
      toast.success(t("admin.keys.applicationApproved", { name }));
      loadData();
      refreshPendingCount();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.keys.networkError"));
    }
    setBusyAppId(null);
  }

  async function runReject() {
    if (!rejecting || !rejectNote.trim()) return;
    const row = rejecting;
    setBusyAppId(row.id);
    try {
      await api.adminApplicationReview(token, row.id, "reject", rejectNote.trim());
      toast.success(t("admin.keys.applicationRejected", { name: row.projectName || row.name }));
      setRejecting(null);
      setRejectNote("");
      loadData();
      refreshPendingCount();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.keys.networkError"));
    }
    setBusyAppId(null);
  }

  const doRevoke = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${id}/revoke`, { method: "POST", headers: authHeaders(token) });
      await requireOk(res, t("admin.keys.revokeFailed"));
      setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, revoked: true } : r)));
      toast.success(t("admin.keys.revokeSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.revokeFailed"));
    }
  };

  const doRestore = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${id}/restore`, { method: "POST", headers: authHeaders(token) });
      await requireOk(res, t("admin.keys.restoreFailed"));
      setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, revoked: false } : r)));
      toast.success(t("admin.keys.restoreSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.restoreFailed"));
    }
  };

  const doDelete = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${id}`, { method: "DELETE", headers: authHeaders(token) });
      await requireOk(res, t("admin.keys.deleteFailed"));
      setRecords((rs) => rs.filter((r) => r.id !== id));
      setTotal((t) => t - 1);
      toast.success(t("admin.keys.deleteSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.deleteFailed"));
    }
  };

  const doRegenerate = async (r: ApiRecord) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${r.id}/regenerate`, {
        method: "POST",
        headers: authHeaders(token),
      });
      await requireOk(res, t("admin.keys.rotateFailed"));
      const data = await res.json();
      const name = r.projectName || r.name;
      setKeyReveal({
        name,
        apiKey: data.api_key,
        title: t("admin.keys.rotateSuccess"),
      });
      loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.networkError"));
    }
  };

  const regenerate = (r: ApiRecord) => {
    setConfirm({
      title: t("admin.keys.confirmRotateTitle"),
      body: (
        <div className="space-y-2">
          <p className="m-0">{t("admin.keys.confirmRotateBody", { name: r.projectName || r.name })}</p>
          <div className="rounded-xl bg-amber-50 p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-[12px] text-amber-700 leading-relaxed m-0">
              {t("admin.keys.confirmRotateWarning")}
            </p>
          </div>
        </div>
      ),
      confirmLabel: t("admin.keys.confirmRotateLabel"),
      confirmClass: "bg-ink hover:opacity-90 text-bg",
      onConfirm: () => { doRegenerate(r); setConfirm(null); },
    });
  };

  const revoke = (id: string) => {
    setConfirm({
      title: t("admin.keys.confirmRevokeTitle"),
      body: <span>{t("admin.keys.confirmRevokeBody")}</span>,
      confirmLabel: t("admin.keys.confirmRevokeLabel"),
      confirmClass: "bg-ink hover:opacity-90 text-bg",
      onConfirm: () => { doRevoke(id); setConfirm(null); },
    });
  };

  const restore = (id: string) => {
    setConfirm({
      title: t("admin.keys.confirmRestoreTitle"),
      body: <span>{t("admin.keys.confirmRestoreBody")}</span>,
      confirmLabel: t("admin.keys.confirmRestoreLabel"),
      confirmClass: "bg-emerald-600 hover:bg-emerald-700 text-white",
      onConfirm: () => { doRestore(id); setConfirm(null); },
    });
  };

  const deleteKey = (id: string) => {
    setConfirm({
      title: t("admin.keys.confirmDeleteTitle"),
      body: (
        <div className="space-y-2">
          <p className="m-0">{t("admin.keys.confirmDeleteBody")}</p>
          <div className="rounded-xl bg-red-50 p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-[12px] text-red-700 leading-relaxed m-0">
              {t("admin.keys.confirmDeleteWarning")}
            </p>
          </div>
        </div>
      ),
      confirmLabel: t("admin.keys.confirmDeleteLabel"),
      confirmClass: "bg-red-600 hover:bg-red-700 text-white",
      onConfirm: () => { doDelete(id); setConfirm(null); },
    });
  };

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const f = createForm;
    if (!f.authId.trim() || !f.name.trim() || !f.projectName.trim() || !f.department.trim()) {
      toast.error(t("admin.keys.fillRequired"));
      return;
    }
    setCreateForm((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          name: f.name.trim(),
          auth_id: f.authId.trim(),
          project_name: f.projectName.trim(),
          department: f.department.trim(),
          project_desc: f.projectDesc.trim() || null,
          models: [],
        }),
      });
      await requireOk(res, t("admin.keys.createFailed"));
      const data = await res.json();
      setCreateForm((s) => ({ ...s, createdKey: data.api_key, loading: false }));
      loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.networkError"));
      setCreateForm((s) => ({ ...s, loading: false }));
    }
  }

  function copyCreatedKey() {
    if (!createForm.createdKey) return;
    copyToClipboard(createForm.createdKey);
    setCreateForm((s) => ({ ...s, copied: true }));
    setTimeout(() => setCreateForm((s) => ({ ...s, copied: false })), 2000);
  }

  const [configKey, setConfigKey] = useState<ApiRecord | null>(null);
  const [limitForm, setLimitForm] = useState({
    rpm: "", tpm: "", rpmUnlimited: false, tpmUnlimited: false, applyAll: false,
  });
  const [savingLimit, setSavingLimit] = useState(false);

  const [editKey, setEditKey] = useState<ApiRecord | null>(null);
  const [editForm, setEditForm] = useState({ name: "", projectDesc: "", loading: false });

  const openEdit = (r: ApiRecord) => {
    setEditKey(r);
    setEditForm({
      name: r.projectName || r.name || "",
      projectDesc: r.projectDesc || "",
      loading: false,
    });
  };

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editKey) return;
    const name = editForm.name.trim();
    if (!name) {
      toast.error(t("admin.keys.fillRequired"));
      return;
    }
    setEditForm((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${editKey.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          name,
          project_desc: editForm.projectDesc.trim() || null,
        }),
      });
      await requireOk(res, t("admin.keys.editFailed"));
      toast.success(t("admin.keys.editSuccess"));
      setEditKey(null);
      setEditForm({ name: "", projectDesc: "", loading: false });
      loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.networkError"));
      setEditForm((s) => ({ ...s, loading: false }));
    }
  }

  const openConfig = (r: ApiRecord) => {
    setConfigKey(r);
    setLimitForm({
      rpm: r.rpmLimit != null && r.rpmLimit > 0 ? String(r.rpmLimit) : "",
      tpm: r.tpmLimit != null && r.tpmLimit > 0 ? String(r.tpmLimit) : "",
      rpmUnlimited: r.rpmLimit === -1,
      tpmUnlimited: r.tpmLimit === -1,
      applyAll: false,
    });
  };

  const formLimit = (raw: string, unlimited: boolean): number | null => {
    if (unlimited) return -1;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const applyPreset = (p: Preset) => {
    if (p.unlimited) {
      setLimitForm((f) => ({ ...f, rpmUnlimited: true, tpmUnlimited: true, rpm: "", tpm: "" }));
    } else if (p.key === "default") {
      setLimitForm((f) => ({ ...f, rpmUnlimited: false, tpmUnlimited: false, rpm: "", tpm: "" }));
    } else {
      setLimitForm((f) => ({
        ...f, rpmUnlimited: false, tpmUnlimited: false, rpm: String(p.rpm), tpm: String(p.tpm),
      }));
    }
  };

  const saveLimit = async () => {
    if (!configKey) return;
    setSavingLimit(true);
    const payload = {
      rpm_limit: formLimit(limitForm.rpm, limitForm.rpmUnlimited),
      tpm_limit: formLimit(limitForm.tpm, limitForm.tpmUnlimited),
      apply_to_user_keys: limitForm.applyAll,
    };
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${configKey.id}/limits`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      });
      await requireOk(res, t("admin.keys.saveLimitFailed"));
      const updated = await res.json();
      const applied = updated.appliedKeys ?? 1;
      setRecords((rs) => rs.map((r) => (r.id === configKey.id ? { ...r, ...updated } : r)));
      if (applied > 1) {
        toast.success(t("admin.keys.appliedKeys", { count: String(applied) }));
        loadData();
      } else {
        toast.success(t("admin.keys.limitsSaved"));
      }
      setConfigKey(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.keys.networkError"));
    }
    setSavingLimit(false);
  };

  const fmtLimit = (v: number | null | undefined) =>
    v === -1 ? t("admin.keys.unlimited") : v != null ? String(v) : t("admin.keys.default");

  const fmtTier = (r: ApiRecord) =>
    matchPreset(presets, r.rpmLimit, r.tpmLimit)?.name
    ?? (r.rpmLimit == null && r.tpmLimit == null ? t("admin.keys.platformDefault") : t("admin.keys.custom"));

  const exportCsv = () => {
    const allRows = records.map((r) => [
      r.name, r.authId, r.department, r.projectName, r.apiKey || "",
      r.grantedAt, r.revoked ? t("admin.keys.status.revoked") : t("admin.keys.status.active"),
      fmtTier(r), fmtLimit(r.rpmLimit), fmtLimit(r.tpmLimit),
    ]);
    downloadCsv(
      `keys_${new Date().toISOString().slice(0, 10)}.csv`,
      allRows,
      [t("admin.keys.csv.name"), t("admin.keys.csv.authId"), t("admin.keys.csv.department"), t("admin.keys.csv.project"), t("admin.keys.csv.apiKey"), t("admin.keys.csv.grantedAt"), t("admin.keys.csv.status"), t("admin.keys.csv.tier"), t("admin.keys.csv.rpm"), t("admin.keys.csv.tpm")],
    );
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const statusFilterLabels = [
    { key: "all" as const, label: t("admin.keys.filterAll") },
    { key: "active" as const, label: t("admin.keys.filterActive") },
    { key: "revoked" as const, label: t("admin.keys.filterRevoked") },
    { key: "pending" as const, label: t("admin.keys.filterPending") },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/40 bg-secondary/30 px-4 py-3 text-[13px] text-muted-foreground">
        {t("admin.keys.infoBanner")}
        {rateLimits && (
          <>
            ，{t("admin.keys.infoBannerRateLimit", { rpm: rateLimits.rpm.toLocaleString(), tpm: rateLimits.tpm.toLocaleString() })}
          </>
        )}
        。{t("admin.keys.infoBannerConcurrencyHint")}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { setCreateForm(defaultCreate); setShowCreate(true); }}
          className="flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[12px] text-bg hover:bg-ink/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> {t("admin.keys.createTitle")}
        </button>
        <div className="flex rounded-xl border border-border/40 overflow-hidden">
          {statusFilterLabels.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setStatusFilter(key); setPage(0); }}
              className={`flex items-center gap-1.5 px-3 py-2 text-[12px] transition-colors ${
                statusFilter === key
                  ? "bg-ink text-bg"
                  : "bg-background text-muted-foreground hover:bg-secondary"
              }`}
            >
              {label}
              {key === "pending" && appPendingTotal > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                  statusFilter === key ? "bg-bg/20 text-bg" : "bg-amber-100 text-amber-700"
                }`}>
                  {appPendingTotal}
                </span>
              )}
            </button>
          ))}
        </div>
        {statusFilter !== "pending" && (
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("admin.keys.searchPlaceholder")}
              className="w-full rounded-xl border border-border/40 bg-background py-2.5 pl-9 pr-4 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/15"
            />
          </div>
        )}
        {statusFilter !== "pending" && hasExtraFilter && (
          <button
            type="button"
            onClick={() => { setDeptFilter(""); setTierFilter(""); setPage(0); }}
            className="rounded-xl px-3 py-2 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {t("admin.keys.clearFilters")}
          </button>
        )}
        <button type="button" onClick={loadData} className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] text-muted-foreground hover:bg-secondary">
          <RefreshCw className="h-3.5 w-3.5" /> {t("admin.keys.refresh")}
        </button>
        {statusFilter !== "pending" && (
          <button type="button" onClick={exportCsv} className="rounded-xl bg-primary px-4 py-2 text-[12px] text-primary-foreground hover:opacity-90">
            {t("admin.keys.exportCsv")}
          </button>
        )}
      </div>

      {statusFilter === "pending" ? (
      <div className="overflow-x-auto rounded-2xl bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
          </div>
        ) : appRows.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-muted-foreground">{t("admin.keys.emptyPending")}</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border/30 text-left text-[12px] text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.project")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.department")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.authId")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.reason")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.issuedAt")}</th>
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {appRows.map((r) => {
                const working = busyAppId === r.id;
                return (
                  <tr key={r.id} className="border-b border-border/20">
                    <td className="px-4 py-3">
                      <div className="max-w-[220px]">
                        <div className="truncate font-serif font-medium">{r.projectName || r.name}</div>
                        {r.projectDesc && (
                          <div className="truncate text-[11px] text-muted-foreground" title={r.projectDesc}>{r.projectDesc}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">{r.department}</td>
                    <td className="px-4 py-3 font-mono text-[12px]">{r.authId}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-muted-foreground" title={r.reason || ""}>{r.reason || "—"}</td>
                    <td className="px-4 py-3 text-[12px] text-muted-foreground">{r.createdAt ? fmtTime(r.createdAt) : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {working ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => runApprove(r)}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-green-700 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors"
                            >
                              <Check className="h-3.5 w-3.5" /> {t("admin.keys.action.approve")}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setRejecting(r); setRejectNote(""); }}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                            >
                              <X className="h-3.5 w-3.5" /> {t("admin.keys.action.reject")}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      ) : (
      <div className="overflow-x-auto rounded-2xl bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
          </div>
        ) : records.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-muted-foreground">{t("admin.keys.empty")}</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border/30 text-left text-[12px] text-muted-foreground">
                <th className={`px-4 py-3 font-medium ${sort === "project_name" ? "text-foreground" : ""}`}>
                  <button type="button" onClick={() => toggleSort("project_name")} className="inline-flex items-center gap-1">
                    {t("admin.keys.col.project")} <SortIcon field="project_name" />
                  </button>
                </th>
                <th className={`px-4 py-3 font-medium ${sort === "department" || deptFilter ? "text-foreground" : ""}`}>
                  <span className="inline-flex items-center gap-1">
                    <button type="button" onClick={() => toggleSort("department")} className="inline-flex items-center gap-1">
                      {t("admin.keys.col.department")} <SortIcon field="department" />
                    </button>
                    <HeaderFilter
                      active={Boolean(deptFilter)}
                      open={filterOpen === "department"}
                      onOpen={() => setFilterOpen("department")}
                      onClose={() => setFilterOpen(null)}
                      width={220}
                    >
                      <FilterList
                        options={departments}
                        selected={deptFilter}
                        onSelect={(v) => { setDeptFilter(v); setPage(0); setFilterOpen(null); }}
                        allLabel={t("admin.keys.filterAll")}
                        emptyText={t("admin.keys.filterEmpty")}
                      />
                    </HeaderFilter>
                  </span>
                </th>
                <th className={`px-4 py-3 font-medium ${sort === "auth_id" ? "text-foreground" : ""}`}>
                  <button type="button" onClick={() => toggleSort("auth_id")} className="inline-flex items-center gap-1">
                    {t("admin.keys.col.authId")} <SortIcon field="auth_id" />
                  </button>
                </th>
                <th className="px-4 py-3 font-medium">API Key</th>
                <th className={`px-4 py-3 font-medium ${sort === "revoked" || tierFilter ? "text-foreground" : ""}`}>
                  <span className="inline-flex items-center gap-1">
                    <button type="button" onClick={() => toggleSort("revoked")} className="inline-flex items-center gap-1">
                      {t("admin.keys.col.status")} <SortIcon field="revoked" />
                    </button>
                    <HeaderFilter
                      active={Boolean(tierFilter)}
                      open={filterOpen === "tier"}
                      onOpen={() => setFilterOpen("tier")}
                      onClose={() => setFilterOpen(null)}
                    >
                      <div className="mb-1 px-2.5 pt-1 text-[11px] text-muted-foreground">{t("admin.upgrade.col.tier")}</div>
                      <FilterList
                        options={["default", "high", "unlimited", "custom"]}
                        selected={tierFilter}
                        onSelect={(v) => { setTierFilter(v); setPage(0); setFilterOpen(null); }}
                        allLabel={t("admin.keys.filterAll")}
                        labelFor={tierFilterLabel}
                        emptyText={t("admin.keys.filterEmpty")}
                      />
                    </HeaderFilter>
                  </span>
                </th>
                <th className={`px-4 py-3 font-medium ${sort === "granted_at" ? "text-foreground" : ""}`}>
                  <button type="button" onClick={() => toggleSort("granted_at")} className="inline-flex items-center gap-1">
                    {t("admin.keys.col.issuedAt")} <SortIcon field="granted_at" />
                  </button>
                </th>
                <th className="px-4 py-3 font-medium">{t("admin.keys.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const tierVis = adminTierVis(presets, r, t);
                const rpmLabel = r.rpmLimit === -1
                  ? t("admin.keys.unlimited")
                  : r.rpmLimit != null && r.rpmLimit > 0
                    ? r.rpmLimit.toLocaleString()
                    : t("admin.keys.default");
                const tpmLabel = r.tpmLimit === -1
                  ? t("admin.keys.unlimited")
                  : r.tpmLimit != null && r.tpmLimit > 0
                    ? r.tpmLimit.toLocaleString()
                    : t("admin.keys.default");
                const tierTitle = r.revoked
                  ? `${tierVis.label} · RPM ${rpmLabel} / TPM ${tpmLabel}`
                  : `${tierVis.label} · RPM ${rpmLabel} / TPM ${tpmLabel} · ${t("admin.keys.tierLimitTooltip")}`;
                return (
                <tr key={r.id} className={`border-b border-border/20 ${r.revoked ? "opacity-50" : ""}`}>
                  <td className="max-w-[220px] px-4 py-3">
                    <div className="truncate font-serif font-medium" title={r.projectName || r.name}>{r.projectName || r.name}</div>
                    {r.projectDesc && (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={r.projectDesc}>{r.projectDesc}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">{r.department}</td>
                  <td className="px-4 py-3 font-mono text-[12px]">{r.authId}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <code className="max-w-[160px] truncate font-mono text-[11px]">{r.apiKey || "—"}</code>
                      {/* 明文不落库，列表无法复制完整密钥；改为管理员更换新密钥 */}
                      <button
                        type="button"
                        onClick={() => regenerate(r)}
                        className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                        title={t("admin.keys.rotate")}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">{r.revoked ? t("admin.keys.status.revoked") : t("admin.keys.status.active")}</td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">{r.grantedAt ? fmtTime(r.grantedAt) : "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {/* 档位展示 + 并发调整合二为一：闪电色标档位，点击打开限额弹窗（吊销后仅展示） */}
                      {r.revoked ? (
                        <span
                          className={`inline-flex rounded-lg p-1.5 ${tierVis.iconCls} opacity-60`}
                          title={tierTitle}
                        >
                          <Zap className="h-3.5 w-3.5" />
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openConfig(r)}
                          className={`rounded-lg p-1.5 transition-colors ${tierVis.actionCls}`}
                          title={tierTitle}
                        >
                          <Zap className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEdit(r)}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                        title={t("admin.keys.edit")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {r.revoked ? (
                        <button type="button" onClick={() => restore(r.id)} className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50" title={t("admin.keys.restore")}>
                          <Power className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <button type="button" onClick={() => revoke(r.id)} className="rounded-lg p-1.5 text-amber-600 hover:bg-warn/10" title={t("admin.keys.revoke")}>
                          <PowerOff className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button type="button" onClick={() => deleteKey(r.id)} className="rounded-lg p-1.5 text-red-500 hover:bg-danger/10" title={t("admin.keys.delete")}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      )}

      {/* 分页 */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span>{t("admin.keys.totalCount", { total: String(total) })}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-lg p-1.5 hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span>{t("admin.keys.pageInfo", { page: String(page + 1), totalPages: String(totalPages) })}</span>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded-lg p-1.5 hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 确认弹窗 */}
      <ModalPortal open={confirm !== null} onClose={() => setConfirm(null)}>
        <div
          className="relative w-full max-w-md rounded-2xl bg-card p-7 shadow-xl modal-panel-enter"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {confirm && (
            <>
              <div className="mb-4 flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-4 h-4 text-red-600" />
                </div>
                <h3 className="mt-1 font-serif text-[16px] font-medium text-foreground">{confirm.title}</h3>
              </div>
              <div className="text-[14px] text-fg leading-relaxed mb-5">{confirm.body}</div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setConfirm(null)}
                  className="rounded-xl px-5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={confirm.onConfirm}
                  className={`rounded-xl px-5 py-2.5 text-[13px] transition-colors ${confirm.confirmClass}`}
                >
                  {confirm.confirmLabel}
                </button>
              </div>
            </>
          )}
        </div>
      </ModalPortal>

      {/* 创建密钥弹窗 */}
      <ModalPortal open={showCreate} onClose={() => { setShowCreate(false); setCreateForm(defaultCreate); }}>
        <div
          className="relative w-full max-w-md rounded-2xl bg-card p-7 shadow-xl modal-panel-enter"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {createForm.createdKey ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2.5 mb-1">
                <div className="w-8 h-8 rounded-lg bg-bg-soft flex items-center justify-center text-fg">
                  <Plus className="w-4 h-4" />
                </div>
                <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{t("admin.keys.createSuccess")}</h3>
              </div>
              <div className="flex items-start gap-3 rounded-xl bg-red-50 p-4">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p className="text-[13px] text-fg leading-relaxed m-0">
                  {t("admin.keys.showOnceWarning")}
                </p>
              </div>
              <div className="rounded-xl bg-bg-soft px-4 py-3 font-mono text-[12px] text-fg break-all">{createForm.createdKey}</div>
              <button
                type="button"
                onClick={copyCreatedKey}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors"
              >
                {createForm.copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {createForm.copied ? t("admin.keys.copied") : t("admin.keys.copyKey")}
              </button>
              {/* 勾选「已妥善保存」即关闭整窗，收起单次展示的全部内容 */}
              <label className="flex items-start gap-2.5 cursor-pointer text-[13px] text-fg">
                <input
                  type="checkbox"
                  checked={createForm.confirmedSaved}
                  onChange={(e) => {
                    if (!e.target.checked) {
                      setCreateForm((s) => ({ ...s, confirmedSaved: false }));
                      return;
                    }
                    setShowCreate(false);
                    setCreateForm(defaultCreate);
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-border/60 shrink-0"
                />
                <span className="leading-snug">{t("admin.keys.confirmSaved")}</span>
              </label>
            </div>
          ) : (
            <>
              <div className="mb-5 flex items-start justify-between">
                <div>
                  <h2 className="font-serif text-[18px] font-medium text-foreground">{t("admin.keys.createTitle")}</h2>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{t("admin.keys.createDesc")}</p>
                </div>
                <button onClick={() => { setShowCreate(false); setCreateForm(defaultCreate); }} className="rounded-lg p-1.5 hover:bg-secondary transition-colors">
                  <X className="h-5 w-5 text-muted-foreground" />
                </button>
              </div>
              <form onSubmit={handleCreateSubmit} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] text-muted-foreground mb-1.5">{t("admin.keys.form.authId")}</label>
                    <input className={inputClass + " font-mono"} value={createForm.authId} onChange={(e) => setCreateForm((s) => ({ ...s, authId: e.target.value }))} placeholder={t("admin.keys.form.authIdHint")} disabled={createForm.loading} />
                  </div>
                  <div>
                    <label className="block text-[12px] text-muted-foreground mb-1.5">{t("admin.keys.form.name")}</label>
                    <input className={inputClass + " font-serif"} value={createForm.name} onChange={(e) => setCreateForm((s) => ({ ...s, name: e.target.value }))} placeholder={t("admin.keys.form.nameHint")} disabled={createForm.loading} />
                  </div>
                </div>
                <div>
                  <label className="block text-[12px] text-muted-foreground mb-1.5">{t("admin.keys.form.department")}</label>
                  <input className={inputClass} value={createForm.department} onChange={(e) => setCreateForm((s) => ({ ...s, department: e.target.value }))} placeholder={t("admin.keys.form.departmentHint")} disabled={createForm.loading} />
                </div>
                <div>
                  <label className="block text-[12px] text-muted-foreground mb-1.5">{t("admin.keys.form.project")}</label>
                  <input className={inputClass + " font-serif"} value={createForm.projectName} onChange={(e) => setCreateForm((s) => ({ ...s, projectName: e.target.value }))} placeholder={t("admin.keys.form.projectHint")} disabled={createForm.loading} />
                </div>
                <div>
                  <label className="block text-[12px] text-muted-foreground mb-1.5">{t("admin.keys.form.description")}</label>
                  <textarea className={inputClass + " resize-none"} value={createForm.projectDesc} onChange={(e) => setCreateForm((s) => ({ ...s, projectDesc: e.target.value }))} rows={3} disabled={createForm.loading} placeholder={t("admin.keys.form.descriptionHint")} />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => { setShowCreate(false); setCreateForm(defaultCreate); }} disabled={createForm.loading} className="rounded-xl px-5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary">{t("common.cancel")}</button>
                  <button type="submit" disabled={createForm.loading} className="flex items-center gap-2 rounded-xl bg-ink px-6 py-2.5 text-[13px] text-bg disabled:opacity-60">
                    {createForm.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {createForm.loading ? t("admin.keys.creating") : t("admin.keys.create")}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </ModalPortal>

      {/* 编辑名称与描述 */}
      <ModalPortal open={editKey !== null} onClose={() => !editForm.loading && setEditKey(null)}>
        <div
          className="relative w-full max-w-md rounded-2xl bg-card p-7 shadow-xl modal-panel-enter"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <div className="mb-5 flex items-start justify-between">
            <div>
              <h2 className="font-serif text-[18px] font-medium text-foreground">{t("admin.keys.editTitle")}</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <span className="font-mono">{editKey?.authId}</span>
                {editKey?.department ? ` · ${editKey.department}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditKey(null)}
              disabled={editForm.loading}
              className="rounded-lg p-1.5 hover:bg-secondary transition-colors disabled:opacity-40"
            >
              <X className="h-5 w-5 text-muted-foreground" />
            </button>
          </div>
          <form onSubmit={handleEditSubmit} className="space-y-3">
            <div>
              <label className="mb-1.5 block text-[12px] text-muted-foreground">{t("admin.keys.form.project")}</label>
              <input
                className={inputClass + " font-serif"}
                value={editForm.name}
                onChange={(e) => setEditForm((s) => ({ ...s, name: e.target.value }))}
                placeholder={t("admin.keys.form.projectHint")}
                disabled={editForm.loading}
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] text-muted-foreground">{t("admin.keys.form.description")}</label>
              <textarea
                className={`${inputClass} resize-none`}
                value={editForm.projectDesc}
                onChange={(e) => setEditForm((s) => ({ ...s, projectDesc: e.target.value }))}
                rows={4}
                disabled={editForm.loading}
                placeholder={t("admin.keys.form.descriptionHint")}
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEditKey(null)}
                disabled={editForm.loading}
                className="rounded-xl px-5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={editForm.loading}
                className="flex items-center gap-2 rounded-xl bg-ink px-6 py-2.5 text-[13px] text-bg disabled:opacity-60"
              >
                {editForm.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
                {editForm.loading ? t("admin.keys.saving") : t("admin.keys.save")}
              </button>
            </div>
          </form>
        </div>
      </ModalPortal>

      {/* 并发与限额弹窗 */}
      <ModalPortal open={configKey !== null} onClose={() => setConfigKey(null)}>
        <div
          className="relative w-full max-w-md rounded-2xl bg-card p-7 shadow-xl modal-panel-enter"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <div className="mb-5 flex items-start justify-between">
            <div>
              <h2 className="font-serif text-[18px] font-medium text-foreground">{t("admin.keys.concurrencyTitle")}</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <span className="font-serif font-medium text-foreground">{configKey?.projectName || configKey?.name}</span> · <span className="font-mono">{configKey?.authId}</span>
              </p>
            </div>
            <button onClick={() => setConfigKey(null)} className="rounded-lg p-1.5 hover:bg-secondary transition-colors">
              <X className="h-5 w-5 text-muted-foreground" />
            </button>
          </div>

          <div className="space-y-4">
            {presets.length > 0 && (
              <div>
                <label className="mb-1.5 block text-[12px] text-muted-foreground">{t("admin.keys.quickUpgrade")}</label>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => {
                    const active = matchPreset(
                      presets,
                      formLimit(limitForm.rpm, limitForm.rpmUnlimited),
                      formLimit(limitForm.tpm, limitForm.tpmUnlimited),
                    )?.key === p.key;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={`rounded-xl border px-3 py-1.5 text-[12px] transition-all ${
                          active
                            ? "border-foreground bg-foreground text-background"
                            : "border-border/40 bg-background text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {([
                { field: "rpm", flag: "rpmUnlimited", label: t("admin.keys.rpm"), dflt: rateLimits?.rpm },
                { field: "tpm", flag: "tpmUnlimited", label: t("admin.keys.tpm"), dflt: rateLimits?.tpm },
              ] as const).map(({ field, flag, label, dflt }) => {
                const unlimited = limitForm[flag];
                return (
                  <div key={field}>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <label className="text-[12px] text-muted-foreground">{label}</label>
                      <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={unlimited}
                          onChange={(e) =>
                            setLimitForm((f) => ({ ...f, [flag]: e.target.checked, [field]: "" }))
                          }
                          className="h-3.5 w-3.5 rounded border-border/60"
                        />
                        {t("admin.keys.unlimited")}
                      </label>
                    </div>
                    {unlimited ? (
                      <div className="rounded-xl border border-violet-200 bg-violet-50/60 px-3.5 py-2.5 text-[12px] text-violet-700">
                        {t("admin.keys.noLimit")}
                      </div>
                    ) : (
                      <input
                        type="number"
                        min={1}
                        value={limitForm[field]}
                        onChange={(e) => setLimitForm((f) => ({ ...f, [field]: e.target.value }))}
                        className={inputClass}
                        placeholder={dflt ? t("admin.keys.placeholderDefault", { n: dflt.toLocaleString() }) : t("admin.keys.leaveEmptyDefault")}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {limitForm.rpmUnlimited && limitForm.tpmUnlimited && (
              <div className="-mt-1 rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-3 text-[12px] text-violet-700">
                {t("admin.keys.ultraConcurrencyDesc")}
              </div>
            )}
            <p className="-mt-2 text-[11px] text-muted-foreground/70">
              {t("admin.keys.concurrencyDesc")}
            </p>

            <label className="flex items-center gap-2 text-[12px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={limitForm.applyAll}
                onChange={(e) => setLimitForm((f) => ({ ...f, applyAll: e.target.checked }))}
                className="h-4 w-4 rounded border-border/60"
              />
              {t("admin.keys.applyAllKeys", { authId: configKey?.authId || "" })}
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => setConfigKey(null)}
              className="rounded-xl px-5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={saveLimit}
              disabled={savingLimit}
              className="flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-[13px] text-primary-foreground disabled:opacity-60"
            >
              {savingLimit ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {savingLimit ? t("admin.keys.saving") : t("admin.keys.save")}
            </button>
          </div>
        </div>
      </ModalPortal>

      {/* 驳回申请：理由必填，这条备注是申请人唯一能看到的解释 */}
      <ModalPortal open={rejecting !== null} onClose={() => setRejecting(null)}>
        <div className="relative w-full max-w-md rounded-2xl bg-card p-7 shadow-xl modal-panel-enter" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          {rejecting && (
            <>
              <h3 className="font-serif text-[16px] font-medium text-foreground">{t("admin.keys.modal.rejectTitle")}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
                {t("admin.keys.modal.rejectHint", { name: rejecting.projectName || rejecting.name, authId: rejecting.authId })}
              </p>
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                rows={3}
                autoFocus
                placeholder={t("admin.keys.modal.rejectPlaceholder")}
                className={inputClass + " mt-4 resize-none"}
              />
              <div className="mt-5 flex justify-end gap-3">
                <button type="button" onClick={() => setRejecting(null)} className="rounded-xl px-5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={!rejectNote.trim() || busyAppId === rejecting.id}
                  onClick={runReject}
                  className="rounded-xl bg-danger px-5 py-2.5 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {t("admin.keys.action.reject")}
                </button>
              </div>
            </>
          )}
        </div>
      </ModalPortal>

      {/* 明文密钥单次展示（审批通过 / 更换新密钥） */}
      <ModalPortal open={keyReveal !== null} onClose={() => setKeyReveal(null)}>
        <div className="relative w-full max-w-md rounded-2xl bg-card p-7 shadow-xl modal-panel-enter" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          {keyReveal && (
            <div className="space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-bg-soft flex items-center justify-center text-fg">
                  <RefreshCw className="w-4 h-4" />
                </div>
                <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{keyReveal.title}</h3>
              </div>
              <div className="flex items-start gap-3 rounded-xl bg-red-50 p-4">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p className="text-[13px] text-fg leading-relaxed m-0">{t("admin.keys.showOnceWarning")}</p>
              </div>
              <div className="rounded-xl bg-bg-soft px-4 py-3 font-mono text-[12px] text-fg break-all">{keyReveal.apiKey}</div>
              <button
                type="button"
                onClick={() => {
                  copyToClipboard(keyReveal.apiKey);
                  toast.success(t("admin.keys.copied"));
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors"
              >
                <Copy className="w-3.5 h-3.5" /> {t("admin.keys.copyKey")}
              </button>
              {/* 勾选「已妥善保存」即关闭整窗，收起单次展示的全部内容 */}
              <label className="flex items-start gap-2.5 cursor-pointer text-[13px] text-fg">
                <input
                  type="checkbox"
                  onChange={(e) => {
                    if (e.target.checked) setKeyReveal(null);
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-border/60 shrink-0"
                />
                <span className="leading-snug">{t("admin.keys.confirmSaved")}</span>
              </label>
            </div>
          )}
        </div>
      </ModalPortal>
    </div>
  );
}
