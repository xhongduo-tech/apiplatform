// "查看全部"抽屉：多维度切换 + 搜索 + 排序 + 分页加载 + 汇总(sum)footer。
// /status 公开页与管理员数据统计页共用同一份 UI，只是各自传入不同的 fetcher
// （公开页只开放 project/model/scene，管理端多开 user/department 且带成本列）。
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Search, ArrowUpDown, ArrowUp, ArrowDown, Loader2 } from "lucide-react";
import { ModalPortal } from "../admin-tab-utils";
import { compactNum, fmtTok, fmtCost, ARENA_COLORS } from "../admin-dashboard-widgets";
import { useT, type TranslationKey } from "../../i18n";
import type { BreakdownRow, BreakdownResponse, BreakdownParams } from "../../api/gateway";

export type { BreakdownRow, BreakdownResponse } from "../../api/gateway";

export interface BreakdownDimensionDef {
  key: string;
  labelKey: TranslationKey;
}

export type BreakdownFetcher = (params: BreakdownParams) => Promise<BreakdownResponse>;

const PAGE_SIZE = 20;

type SortField = "calls" | "tokens" | "prompt_tokens" | "completion_tokens" | "avg_latency" | "cost";

const SORT_COLUMNS: { field: SortField; labelKey: TranslationKey; showWhenCost?: boolean }[] = [
  { field: "calls", labelKey: "breakdown.column.calls" },
  { field: "tokens", labelKey: "breakdown.column.tokens" },
  { field: "prompt_tokens", labelKey: "breakdown.column.prompt" },
  { field: "completion_tokens", labelKey: "breakdown.column.completion" },
  { field: "avg_latency", labelKey: "breakdown.column.avgLatency" },
  { field: "cost", labelKey: "breakdown.column.cost", showWhenCost: true },
];

export function BreakdownDrawer({
  open, onClose, title, dimensions, initialDimension, days, fetcher, showCost = false,
  enableCrossFilter = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  dimensions: BreakdownDimensionDef[];
  initialDimension?: string;
  days: number;
  fetcher: BreakdownFetcher;
  showCost?: boolean;
  /** 启用 model ↔ scene 行内交叉筛选（Usage 看板） */
  enableCrossFilter?: boolean;
}) {
  const { t } = useT();
  const [dimension, setDimension] = useState(initialDimension ?? dimensions[0]?.key ?? "project");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("calls");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [rows, setRows] = useState<BreakdownRow[]>([]);
  const [totals, setTotals] = useState<BreakdownRow | null>(null);
  const [totalGroups, setTotalGroups] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [crossFilter, setCrossFilter] = useState<{ dimension: string; value: string; displayLabel: string } | null>(null);
  const requestSeq = useRef(0);

  // 重新打开时回到初始维度、清空搜索/排序，避免上次关闭前的筛选状态残留
  useEffect(() => {
    if (open) {
      setDimension(initialDimension ?? dimensions[0]?.key ?? "project");
      setSearchInput("");
      setSearch("");
      setSortField("calls");
      setSortDir("desc");
      setCrossFilter(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 输入防抖 300ms 再触发搜索请求，避免逐字符打字都打后端
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = async (offset: number, append: boolean) => {
    const seq = ++requestSeq.current;
    if (append) setLoadingMore(true); else setLoading(true);
    setError("");
    try {
      const res = await fetcher({
        dimension, days, search, sortField, sortDir, limit: PAGE_SIZE, offset,
        filterDimension: crossFilter?.dimension,
        filterValue: crossFilter?.value,
      });
      if (seq !== requestSeq.current) return; // 竞态：更晚的请求已在途，丢弃这次的结果
      setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
      setTotals(res.totals);
      setTotalGroups(res.total_groups);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : t("breakdown.loadFailed"));
    } finally {
      if (seq !== requestSeq.current) return;
      if (append) setLoadingMore(false); else setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    load(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dimension, search, sortField, sortDir, days, crossFilter]);

  const toggleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const maxCalls = useMemo(() => rows.reduce((m, r) => Math.max(m, r.calls), 1), [rows]);
  const hasMore = rows.length < totalGroups;

  // 用户维度下点部门名 → 切到部门维度并带上该部门名搜索，实现"点击筛选同一类型"
  const jumpToDepartment = (dept: string) => {
    if (!dimensions.some((d) => d.key === "department") || !dept) return;
    setDimension("department");
    setSearchInput(dept);
  };

  const drillCrossFilter = (row: BreakdownRow) => {
    if (!enableCrossFilter) return;
    const label = row.display_label ?? row.label;
    if (dimension === "scene") {
      setCrossFilter({ dimension: "scene", value: row.label, displayLabel: label });
      setDimension("model");
    } else if (dimension === "model") {
      setCrossFilter({ dimension: "model", value: row.label, displayLabel: label });
      setDimension("scene");
    }
  };

  const crossFilterLabel = crossFilter
    ? crossFilter.dimension === "scene"
      ? t("breakdown.crossFilter.scene", { name: crossFilter.displayLabel })
      : t("breakdown.crossFilter.model", { name: crossFilter.displayLabel })
    : null;

  if (!open) return null;

  return (
    <ModalPortal open={open} onClose={onClose} zIndex={10050}>
      <div
        className="relative flex max-h-[85vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/30 px-6 py-4 shrink-0">
          <h2 className="font-serif text-[15px] font-medium text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("breakdown.closeAria")}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Controls: dimension tabs + search */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border/30 px-6 py-3 shrink-0">
          {dimensions.length > 1 && (
            <div className="flex gap-1 bg-secondary/60 p-1 rounded-xl">
              {dimensions.map((d) => (
                <button
                  key={d.key}
                  onClick={() => setDimension(d.key)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] transition-all duration-200 ${
                    dimension === d.key ? "bg-card text-foreground shadow-sm font-semibold" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(d.labelKey)}
                </button>
              ))}
            </div>
          )}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("breakdown.search")}
              className="w-full rounded-xl border border-border/40 bg-bg-soft py-2 pl-8 pr-3 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-primary/15"
            />
          </div>
          <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
            {loading ? t("breakdown.loading") : t("breakdown.resultCount", { n: totalGroups })}
          </span>
        </div>

        {crossFilter && (
          <div className="flex items-center gap-2 border-b border-border/30 px-6 py-2 shrink-0">
            <span className="text-[11.5px] text-foreground px-2.5 py-1 rounded-full" style={{ background: "var(--bg-soft)" }}>
              {crossFilterLabel}
            </span>
            <button
              type="button"
              onClick={() => setCrossFilter(null)}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("breakdown.clearFilter")}
            </button>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="py-12 text-center text-[13px] text-danger">{error}</div>
          ) : loading ? (
            <div className="py-16 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-muted-foreground">{t("breakdown.noResults")}</div>
          ) : (
            <table className="w-full min-w-[820px] border-collapse">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border/40 text-left">
                  <th className="px-4 py-2.5 text-[11px] font-medium text-muted-foreground w-10">#</th>
                  <th className="px-2 py-2.5 text-[11px] font-medium text-muted-foreground">{t("breakdown.column.name")}</th>
                  {SORT_COLUMNS.filter((c) => !c.showWhenCost || showCost).map((c) => (
                    <th
                      key={c.field}
                      onClick={() => toggleSort(c.field)}
                      className="px-3 py-2.5 text-[11px] font-medium text-muted-foreground text-right cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        {t(c.labelKey)}
                        {sortField === c.field ? (
                          sortDir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </span>
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-[11px] font-medium text-muted-foreground text-right whitespace-nowrap">{t("breakdown.column.cacheHitRate")}</th>
                  <th className="px-3 py-2.5 text-[11px] font-medium text-muted-foreground text-right whitespace-nowrap">{t("breakdown.column.successRate")}</th>
                  {enableCrossFilter && (dimension === "model" || dimension === "scene") && (
                    <th className="px-3 py-2.5 text-[11px] font-medium text-muted-foreground text-right whitespace-nowrap w-[100px]" />
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.label}-${i}`} className="border-b border-border/20 hover:bg-secondary/40 transition-colors">
                    <td className="px-4 py-2.5 text-[11px] text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="px-2 py-2.5 text-[12.5px] text-foreground max-w-[220px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="h-2 w-2 rounded-[2px] shrink-0"
                          style={{ background: ARENA_COLORS[i % ARENA_COLORS.length], opacity: r.calls / maxCalls * 0.7 + 0.3 }}
                        />
                        <span className="truncate font-serif font-medium" title={r.display_label ?? r.label}>{r.display_label ?? r.label}</span>
                        {r.department && dimension === "user" && (
                          <button
                            type="button"
                            onClick={() => jumpToDepartment(r.department!)}
                            className="shrink-0 text-[10px] px-1.5 py-px rounded-full text-muted-foreground hover:text-foreground transition-colors"
                            style={{ background: "var(--bg-soft)" }}
                            title={t("breakdown.filterByDepartment")}
                          >
                            {r.department}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[12.5px] text-foreground text-right tabular-nums font-medium">{compactNum(r.calls)}</td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground text-right tabular-nums">{fmtTok(r.tokens)}</td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground text-right tabular-nums">{fmtTok(r.prompt_tokens)}</td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground text-right tabular-nums">{fmtTok(r.completion_tokens)}</td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground text-right tabular-nums">{r.avg_latency_ms != null ? `${r.avg_latency_ms.toLocaleString()}ms` : "—"}</td>
                    {showCost && (
                      <td className="px-3 py-2.5 text-[12px] text-muted-foreground text-right tabular-nums">{r.cost != null ? fmtCost(r.cost) : "—"}</td>
                    )}
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground text-right tabular-nums">{r.cache_hit_rate.toFixed(1)}%</td>
                    <td className="px-3 py-2.5 text-[12px] text-right tabular-nums" style={{ color: r.success_rate == null ? "var(--fg-subtle)" : r.success_rate >= 99 ? "var(--ok)" : r.success_rate >= 95 ? "var(--warn)" : "var(--danger)" }}>
                      {r.success_rate != null ? `${r.success_rate.toFixed(1)}%` : "—"}
                    </td>
                    {enableCrossFilter && (dimension === "model" || dimension === "scene") && (
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => drillCrossFilter(r)}
                          className="text-[10.5px] font-medium text-muted-foreground whitespace-nowrap px-2 py-0.5 rounded-full transition-colors hover:text-foreground hover:bg-secondary"
                        >
                          {dimension === "scene" ? t("breakdown.drillToModels") : t("breakdown.drillToScenes")}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer: sum row + load more */}
        {!loading && !error && rows.length > 0 && (
          <div className="border-t border-border/30 px-6 py-3 shrink-0">
            {totals && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-2.5 text-[12px]">
                <span className="font-semibold text-foreground">{t("breakdown.totalRow")}</span>
                <span className="text-muted-foreground">{t("breakdown.column.calls")} <b className="text-foreground tabular-nums">{compactNum(totals.calls)}</b></span>
                <span className="text-muted-foreground">{t("breakdown.column.tokens")} <b className="text-foreground tabular-nums">{fmtTok(totals.tokens)}</b></span>
                {showCost && (
                  <span className="text-muted-foreground">{t("breakdown.column.cost")} <b className="text-foreground tabular-nums">{totals.cost != null ? fmtCost(totals.cost) : "—"}</b></span>
                )}
                <span className="text-muted-foreground">{t("breakdown.column.successRate")} <b className="text-foreground tabular-nums">{totals.success_rate != null ? `${totals.success_rate.toFixed(1)}%` : "—"}</b></span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t("breakdown.shownCount", { shown: rows.length, total: totalGroups })}
              </span>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => load(rows.length, true)}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
                  style={{ background: "var(--bg-soft)" }}
                >
                  {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("breakdown.loadMore")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </ModalPortal>
  );
}
