import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Loader2, Check, X, ChevronLeft, ChevronRight, Zap, Eye, ArrowUpDown,
  ArrowUp, ArrowDown, Filter, Search,
} from "lucide-react";
import { toast } from "sonner";
import { api, type AdminUpgradeApplicationRow } from "../api/gateway";
import {
  API_BASE, authHeaders, fmtTime, matchPreset, ModalPortal,
  type RatePreset as Preset,
} from "./admin-tab-utils";
import { useT } from "../i18n";

/**
 * 高并发升级申请审批。
 *
 * 操作列：查看（名称/理由/备注）· 升级降级（待审：批准/驳回；已通过：调档）。
 * 表头支持部门/档位/状态筛选，以及密钥/部门/档位/状态/时间排序。
 */

const STATUS_CLS: Record<AdminUpgradeApplicationRow["status"], string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-gray-100 text-gray-500",
};

const FILTER_KEYS = ["", "pending", "approved", "rejected"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type SortKey = "key_name" | "department" | "target_tier" | "status" | "created_at" | "auth_id";

const PAGE_SIZE = 20;

function tierZapCls(tier?: string | null) {
  if (tier === "unlimited") return "text-violet-600";
  if (tier === "high") return "text-brand";
  return "text-foreground";
}

function displayTier(r: AdminUpgradeApplicationRow): string | null {
  if (r.status === "approved") return r.currentTier || r.targetTier || null;
  if (r.targetTier === "high" || r.targetTier === "unlimited") return r.targetTier;
  return null;
}

export default function UpgradeAppsTab({ token }: { token: string }) {
  const { t } = useT();

  function statusLabel(s: AdminUpgradeApplicationRow["status"]) {
    const map: Record<AdminUpgradeApplicationRow["status"], string> = {
      pending: t("admin.earlyAccess.status.pending"),
      approved: t("admin.earlyAccess.status.approved"),
      rejected: t("admin.earlyAccess.status.rejected"),
    };
    return map[s];
  }

  function filterLabel(k: FilterKey) {
    if (k === "") return t("admin.earlyAccess.filter.all");
    return statusLabel(k);
  }

  function tierLabel(tier?: string | null) {
    if (tier === "unlimited") return t("keys.ultraConcurrency");
    if (tier === "high") return t("keys.highConcurrency");
    if (tier === "default") return t("admin.keys.default");
    if (!tier) return "—";
    return tier;
  }

  const [rows, setRows] = useState<AdminUpgradeApplicationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [approvedTotal, setApprovedTotal] = useState(0);
  const [departments, setDepartments] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<FilterKey>("");
  const [deptFilter, setDeptFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterOpen, setFilterOpen] = useState<"department" | "tier" | "status" | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AdminUpgradeApplicationRow | null>(null);
  const [tiering, setTiering] = useState<AdminUpgradeApplicationRow | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    fetch(`${API_BASE}/api/public/config`)
      .then((r) => r.json())
      .then((c) => {
        if (Array.isArray(c?.rate_limit_presets)) setPresets(c.rate_limit_presets);
      })
      .catch(() => { /* 预设加载失败时档位弹窗仍可用裸数值 */ });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.adminUpgradeApplicationsList(token, {
        limit: PAGE_SIZE,
        offset,
        status: filter || undefined,
        department: deptFilter || undefined,
        tier: tierFilter || undefined,
        q: debouncedSearch || undefined,
        sort: sort || undefined,
        order: sort ? sortDir : undefined,
      });
      setRows(d.data ?? []);
      setTotal(d.total ?? 0);
      setPendingTotal(d.pendingTotal ?? 0);
      setApprovedTotal(d.approvedTotal ?? 0);
      setDepartments(d.departments ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.loadFailed"));
    }
    setLoading(false);
  }, [token, offset, filter, deptFilter, tierFilter, debouncedSearch, sort, sortDir, t]);

  useEffect(() => { load(); }, [load]);

  function toggleSort(field: SortKey) {
    if (sort === field) {
      if (sortDir === "desc") setSortDir("asc");
      else { setSort(null); setSortDir("desc"); }
    } else {
      setSort(field);
      setSortDir("desc");
    }
    setOffset(0);
  }

  async function runApprove(row: AdminUpgradeApplicationRow) {
    setBusy(row.id);
    try {
      await api.adminUpgradeApplicationReview(token, row.id, "approve");
      toast.success(t("admin.upgrade.approved", { name: row.keyName || row.projectName }));
      setTiering(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    }
    setBusy(null);
  }

  async function runReject(row: AdminUpgradeApplicationRow, note: string) {
    setBusy(row.id);
    try {
      await api.adminUpgradeApplicationReview(token, row.id, "reject", note);
      toast.success(t("admin.upgrade.rejected", { name: row.keyName || row.projectName }));
      setTiering(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    }
    setBusy(null);
  }

  async function saveKeyLimits(
    row: AdminUpgradeApplicationRow,
    body: { rpm_limit: number | null; tpm_limit: number | null },
  ) {
    if (!row.keyId) {
      toast.error(t("admin.upgrade.noKey"));
      return;
    }
    setBusy(row.id);
    try {
      const res = await fetch(`${API_BASE}/api/admin/keys/${row.keyId}/limits`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.detail || t("common.operationFailed"));
      }
      toast.success(t("admin.keys.limitsSaved"));
      setTiering(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    }
    setBusy(null);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const hasExtraFilter = Boolean(deptFilter || tierFilter || debouncedSearch);

  const SortIcon = ({ field }: { field: SortKey }) => (
    sort === field
      ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
      : <ArrowUpDown className="h-3 w-3 opacity-30" />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Zap className="h-3.5 w-3.5 text-brand" />
          {filter === "approved"
            ? t("admin.upgrade.elevatedStats", { total: approvedTotal })
            : t("admin.upgrade.stats", { pendingTotal })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
              placeholder={t("admin.upgrade.searchPlaceholder")}
              className="h-8 w-[200px] rounded-lg border border-border/40 bg-background pl-8 pr-3 text-[12px] focus:outline-none focus:ring-2 focus:ring-primary/15"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {FILTER_KEYS.map((key) => (
              <button
                key={key || "all"}
                type="button"
                onClick={() => { setFilter(key); setOffset(0); }}
                className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
                  filter === key
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {filterLabel(key)}
                {key === "pending" && pendingTotal > 0 && (
                  <span className="ml-1 rounded-md bg-yellow-100 px-1.5 py-0.5 text-[11px] font-medium text-yellow-700">
                    {pendingTotal}
                  </span>
                )}
                {key === "approved" && approvedTotal > 0 && (
                  <span className="ml-1 rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand">
                    {approvedTotal}
                  </span>
                )}
              </button>
            ))}
          </div>
          {hasExtraFilter && (
            <button
              type="button"
              onClick={() => { setDeptFilter(""); setTierFilter(""); setSearch(""); setOffset(0); }}
              className="rounded-lg px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {t("admin.upgrade.clearFilters")}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center justify-center rounded-2xl bg-card py-20 text-[13px] text-muted-foreground/50 shadow-sm">
          {filter === "approved" ? t("admin.upgrade.elevatedEmpty") : t("admin.upgrade.empty")}
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-card shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-[13px]">
                <thead>
                  <tr className="border-b border-border/40 bg-secondary/40">
                    <Th active={sort === "key_name"}>
                      <button type="button" onClick={() => toggleSort("key_name")} className="inline-flex items-center gap-1">
                        {t("admin.upgrade.col.key")} <SortIcon field="key_name" />
                      </button>
                    </Th>
                    <Th active={sort === "auth_id"}>
                      <button type="button" onClick={() => toggleSort("auth_id")} className="inline-flex items-center gap-1">
                        {t("admin.earlyAccess.th.authId")} <SortIcon field="auth_id" />
                      </button>
                    </Th>
                    <Th active={sort === "department" || Boolean(deptFilter)}>
                      <span className="inline-flex items-center gap-1">
                        <button type="button" onClick={() => toggleSort("department")} className="inline-flex items-center gap-1">
                          {t("admin.earlyAccess.th.department")} <SortIcon field="department" />
                        </button>
                        <HeaderFilter
                          active={Boolean(deptFilter)}
                          open={filterOpen === "department"}
                          onOpen={() => setFilterOpen("department")}
                          onClose={() => setFilterOpen(null)}
                        >
                          <FilterList
                            options={departments}
                            selected={deptFilter}
                            onSelect={(v) => { setDeptFilter(v); setOffset(0); setFilterOpen(null); }}
                            allLabel={t("admin.earlyAccess.filter.all")}
                            emptyText={t("admin.upgrade.filterEmpty")}
                          />
                        </HeaderFilter>
                      </span>
                    </Th>
                    <Th active={sort === "target_tier" || Boolean(tierFilter)}>
                      <span className="inline-flex items-center gap-1">
                        <button type="button" onClick={() => toggleSort("target_tier")} className="inline-flex items-center gap-1">
                          {t("admin.upgrade.col.tier")} <SortIcon field="target_tier" />
                        </button>
                        <HeaderFilter
                          active={Boolean(tierFilter)}
                          open={filterOpen === "tier"}
                          onOpen={() => setFilterOpen("tier")}
                          onClose={() => setFilterOpen(null)}
                        >
                          <FilterList
                            options={["high", "unlimited"]}
                            selected={tierFilter}
                            onSelect={(v) => { setTierFilter(v); setOffset(0); setFilterOpen(null); }}
                            allLabel={t("admin.earlyAccess.filter.all")}
                            labelFor={(v) => tierLabel(v)}
                            emptyText={t("admin.upgrade.filterEmpty")}
                          />
                        </HeaderFilter>
                      </span>
                    </Th>
                    <Th active={sort === "status"}>
                      <button type="button" onClick={() => toggleSort("status")} className="inline-flex items-center gap-1">
                        {t("admin.earlyAccess.th.status")} <SortIcon field="status" />
                      </button>
                    </Th>
                    <Th active={sort === "created_at"}>
                      <button type="button" onClick={() => toggleSort("created_at")} className="inline-flex items-center gap-1">
                        {t("admin.earlyAccess.th.submittedAt")} <SortIcon field="created_at" />
                      </button>
                    </Th>
                    <Th>{t("admin.earlyAccess.th.actions")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const cls = STATUS_CLS[r.status];
                    const working = busy === r.id;
                    const tier = displayTier(r);
                    return (
                      <tr key={r.id} className="border-b border-border/20 transition-colors hover:bg-secondary/20">
                        <td className="min-w-[140px] max-w-[200px] px-4 py-3 align-middle">
                          <div className="truncate font-serif font-medium" title={r.keyName || undefined}>{r.keyName || "—"}</div>
                          {r.name && (
                            <div className="truncate text-[11px] text-muted-foreground" title={r.name}>{r.name}</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle font-mono text-[12px]">{r.authId}</td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle text-muted-foreground">{r.department || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle">
                          {tier === "high" || tier === "unlimited" ? (
                            <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${tierZapCls(tier)}`}>
                              <Zap className="h-3.5 w-3.5 shrink-0" />
                              {tierLabel(tier)}
                            </span>
                          ) : (
                            <span className="text-[12px] text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle">
                          <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-medium ${cls}`}>
                            {statusLabel(r.status)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle text-muted-foreground">
                          {r.createdAt ? fmtTime(r.createdAt) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle">
                          <div className="flex flex-nowrap items-center gap-1">
                            {working && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
                            {!working && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setViewing(r)}
                                  className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                                  title={t("admin.upgrade.action.view")}
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setTiering(r)}
                                  className="rounded-lg p-1.5 text-brand transition-colors hover:bg-brand/10"
                                  title={t("admin.upgrade.action.tier")}
                                >
                                  <ArrowUpDown className="h-3.5 w-3.5" />
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
            </div>
          </div>

          <div className="flex items-center justify-between text-[12px] text-muted-foreground">
            <span>{t("admin.earlyAccess.pagination", { start: pageStart, end: pageEnd, total })}</span>
            <div className="flex items-center gap-1">
              <PageBtn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft className="h-3.5 w-3.5" /> {t("admin.earlyAccess.prevPage")}
              </PageBtn>
              <PageBtn disabled={pageEnd >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                {t("admin.earlyAccess.nextPage")} <ChevronRight className="h-3.5 w-3.5" />
              </PageBtn>
            </div>
          </div>
        </>
      )}

      <ViewDetailDialog row={viewing} onClose={() => setViewing(null)} statusLabel={statusLabel} tierLabel={tierLabel} />
      <TierActionDialog
        row={tiering}
        presets={presets}
        busy={busy === tiering?.id}
        onClose={() => setTiering(null)}
        onApprove={runApprove}
        onReject={runReject}
        onSaveLimits={saveKeyLimits}
        tierLabel={tierLabel}
      />
    </div>
  );
}

/** 查看：申请名称、理由、备注（及审批元信息）。 */
function ViewDetailDialog({
  row, onClose, statusLabel, tierLabel,
}: {
  row: AdminUpgradeApplicationRow | null;
  onClose: () => void;
  statusLabel: (s: AdminUpgradeApplicationRow["status"]) => string;
  tierLabel: (tier?: string | null) => string;
}) {
  const { t } = useT();
  if (!row) return null;

  return (
    <ModalPortal open onClose={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-lg" role="dialog" aria-modal="true">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-serif text-[15px] font-medium text-foreground">{t("admin.upgrade.viewTitle")}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {statusLabel(row.status)}
              {row.createdAt ? ` · ${fmtTime(row.createdAt)}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-secondary">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        <dl className="space-y-3 text-[13px]">
          <DetailRow label={t("admin.upgrade.view.name")} value={row.keyName || row.projectName || "—"} serif />
          {row.name && <DetailRow label={t("admin.earlyAccess.th.name")} value={row.name} />}
          <DetailRow label={t("admin.upgrade.col.tier")} value={tierLabel(displayTier(row) || row.targetTier)} />
          <DetailRow label={t("admin.keys.col.reason")} value={row.reason || "—"} multiline />
          <DetailRow label={t("admin.earlyAccess.th.note")} value={row.note || t("admin.upgrade.view.noNote")} multiline muted={!row.note} />
          {row.reviewedAt && (
            <DetailRow
              label={t("admin.earlyAccess.th.reviewedAt")}
              value={`${fmtTime(row.reviewedAt)}${row.reviewer ? ` · ${row.reviewer}` : ""}`}
            />
          )}
        </dl>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-secondary px-4 py-2 text-[13px] text-foreground transition-colors hover:bg-secondary/80"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}

function DetailRow({
  label, value, serif, multiline, muted,
}: {
  label: string;
  value: string;
  serif?: boolean;
  multiline?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 ${serif ? "font-serif font-medium" : ""} ${multiline ? "whitespace-pre-wrap leading-relaxed" : ""} ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </dd>
    </div>
  );
}

/** 升级降级：待审走批准/驳回；已通过则调密钥档位。 */
function TierActionDialog({
  row, presets, busy, onClose, onApprove, onReject, onSaveLimits, tierLabel,
}: {
  row: AdminUpgradeApplicationRow | null;
  presets: Preset[];
  busy: boolean;
  onClose: () => void;
  onApprove: (row: AdminUpgradeApplicationRow) => void;
  onReject: (row: AdminUpgradeApplicationRow, note: string) => void;
  onSaveLimits: (
    row: AdminUpgradeApplicationRow,
    body: { rpm_limit: number | null; tpm_limit: number | null },
  ) => void;
  tierLabel: (tier?: string | null) => string;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<"main" | "reject">("main");
  const [note, setNote] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  useEffect(() => {
    setMode("main");
    setNote("");
    if (!row) {
      setSelectedPreset(null);
      return;
    }
    const hit = matchPreset(presets, row.rpmLimit, row.tpmLimit);
    setSelectedPreset(hit?.key ?? (row.currentTier || row.targetTier || null));
  }, [row, presets]);

  if (!row) return null;

  const isPending = row.status === "pending";
  const canAdjustLimits = Boolean(row.keyId) && row.status !== "rejected";

  return (
    <ModalPortal open onClose={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-lg" role="dialog" aria-modal="true">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-serif text-[15px] font-medium text-foreground">
              {mode === "reject" ? t("admin.upgrade.modal.rejectTitle") : t("admin.upgrade.tierTitle")}
            </h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              <span className="font-serif font-medium text-foreground">{row.keyName || row.projectName}</span>
              {" · "}
              <span className="font-mono">{row.authId}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-secondary">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {mode === "reject" ? (
          <>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              {t("admin.keys.modal.rejectHint", { name: row.keyName || row.projectName, authId: row.authId })}
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              autoFocus
              placeholder={t("admin.keys.modal.rejectPlaceholder")}
              className="mt-4 w-full resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/15"
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setMode("main")}
                className="rounded-xl px-4 py-2 text-[13px] text-muted-foreground hover:text-foreground"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={!note.trim() || busy}
                onClick={() => onReject(row, note.trim())}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13px] text-primary-foreground disabled:opacity-50 apiplatform-btn"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("admin.earlyAccess.confirmReject")}
              </button>
            </div>
          </>
        ) : isPending ? (
          <>
            <div className="rounded-xl bg-secondary/50 px-4 py-3 text-[13px]">
              <div className="text-[11px] text-muted-foreground">{t("admin.upgrade.col.tier")}</div>
              <div className={`mt-0.5 inline-flex items-center gap-1 font-medium ${tierZapCls(row.targetTier)}`}>
                <Zap className="h-3.5 w-3.5" />
                {tierLabel(row.targetTier)}
              </div>
              {row.reason && (
                <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">{row.reason}</p>
              )}
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("reject")}
                className="inline-flex items-center gap-1 rounded-xl px-4 py-2 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" /> {t("admin.earlyAccess.action.reject")}
              </button>
              <button
                type="button"
                disabled={busy || !row.keyId}
                onClick={() => onApprove(row)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13px] text-primary-foreground disabled:opacity-50 apiplatform-btn"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t("admin.earlyAccess.action.approve")}
              </button>
            </div>
          </>
        ) : canAdjustLimits ? (
          <>
            <p className="mb-3 text-[12.5px] text-muted-foreground">{t("admin.upgrade.tierHint")}</p>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => {
                const active = selectedPreset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setSelectedPreset(p.key)}
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
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-4 py-2 text-[13px] text-muted-foreground hover:text-foreground"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={busy || !selectedPreset}
                onClick={() => {
                  const p = presets.find((x) => x.key === selectedPreset);
                  if (!p) return;
                  onSaveLimits(row, {
                    rpm_limit: p.unlimited ? -1 : (p.key === "default" ? null : p.rpm),
                    tpm_limit: p.unlimited ? -1 : (p.key === "default" ? null : p.tpm),
                  });
                }}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13px] text-primary-foreground disabled:opacity-50 apiplatform-btn"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t("admin.keys.save")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">{t("admin.upgrade.tierUnavailable")}</p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-secondary px-4 py-2 text-[13px] text-foreground"
              >
                {t("common.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalPortal>
  );
}

function HeaderFilter({
  active, open, onOpen, onClose, children,
}: {
  active: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
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
        className="inline-flex items-center justify-center rounded p-0.5 transition-colors"
        style={{
          color: active ? "var(--primary)" : "var(--muted-foreground)",
          background: active ? "var(--primary-tint-12)" : "transparent",
        }}
        aria-expanded={open}
      >
        <Filter className="h-3 w-3" strokeWidth={2} />
      </button>
      {open && pos && createPortal(
        <div
          ref={boxRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: Math.max(8, Math.min(pos.left, window.innerWidth - 220)),
            zIndex: 50,
            width: 200,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 8,
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

function FilterList({
  options, selected, onSelect, allLabel, labelFor, emptyText,
}: {
  options: string[];
  selected: string;
  onSelect: (v: string) => void;
  allLabel: string;
  labelFor?: (v: string) => string;
  emptyText: string;
}) {
  const items = ["", ...options];
  if (options.length === 0) {
    return <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">{emptyText}</div>;
  }
  return (
    <div className="max-h-56 overflow-y-auto">
      {items.map((v) => {
        const active = selected === v;
        return (
          <button
            key={v || "__all__"}
            type="button"
            onClick={() => onSelect(v)}
            className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
              active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
          >
            {v ? (labelFor ? labelFor(v) : v) : allLabel}
          </button>
        );
      })}
    </div>
  );
}

function Th({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <th className={`whitespace-nowrap px-4 py-2.5 text-left text-[12px] font-medium ${active ? "text-foreground" : "text-muted-foreground"}`}>
      {children}
    </th>
  );
}

function PageBtn({
  children, disabled, onClick,
}: { children: React.ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-0.5 rounded-lg px-2.5 py-1 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
