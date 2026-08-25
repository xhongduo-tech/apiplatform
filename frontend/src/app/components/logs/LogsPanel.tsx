import { useState, useEffect, useCallback, useMemo, useRef, Fragment, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
  Download, RefreshCw, X, Timer, Trash2, Search, Filter,
  ArrowUpDown, ArrowUp, ArrowDown, Copy, Check,
} from "lucide-react";
import { toast } from "sonner";
import { copyText } from "../../browser-compat";
import { api, COOKIE_SESSION_TOKEN } from "../../api/gateway";
import { useT, type TFn } from "../../i18n";
import { ConsolePageShell } from "../console-page-shell";
import { cn, PAGE_TITLE_CLASS } from "../ui/utils";
import { authHeaders, ADMIN_LOGS_FILTERS_KEY } from "../admin-tab-utils";

export type LogsScope = "user" | "admin";

export interface LogsPanelProps {
  scope: LogsScope;
  token: string;
  /** 嵌入 admin Tab 时不包 ConsolePageShell、不显示页头标题 */
  embedded?: boolean;
  subtitle?: string;
}

interface LogRecord {
  id: string;
  request_id?: string | null;
  model_id: string;
  api_key_name?: string;
  key_name?: string;
  department?: string;
  auth_id?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  cache_write_tokens?: number;
  usage_estimated?: boolean;
  stream?: boolean;
  latency_ms: number;
  total_duration_ms: number;
  estimated_cost?: number;
  status_code: number;
  created_at: string;
  error_detail?: string;
  response_preview?: string;
}

interface PagedResponse {
  total: number;
  records: LogRecord[];
  retention_days?: number;
  retention_cutoff?: string | null;
  has_purged_range?: boolean;
  unique_models?: string[];
  unique_key_names?: string[];
  unique_departments?: string[];
}

const PAGE_SIZE = 50;

function tpl(template: string, params: Record<string, string | number>): string {
  let result = template;
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(`{${k}}`, String(v));
  }
  return result;
}

function normISO(iso: string) {
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
}
function formatTime(iso: string) {
  const d = new Date(normISO(iso));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function formatTimeFull(iso: string) {
  const d = new Date(normISO(iso));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function formatDateOnly(iso: string) {
  const d = new Date(normISO(iso));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function HoverTip({ children, tip }: { children: React.ReactNode; tip: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const place = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = rect.left + rect.width / 2;
    // 上方空间够则上浮，否则下浮——避免被表格 overflow 裁切（已 portal 到 body）
    if (rect.top > 72) {
      setPos({ left, bottom: window.innerHeight - rect.top + 6 });
    } else {
      setPos({ left, top: rect.bottom + 6 });
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [show, place]);

  return (
    <span
      ref={hostRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 3 }}
      onMouseEnter={() => { timerRef.current = setTimeout(() => setShow(true), 400); }}
      onMouseLeave={() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        setShow(false);
        setPos(null);
      }}
    >
      {children}
      {show && pos && createPortal(
        <span
          style={{
            position: "fixed",
            left: pos.left,
            ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }),
            transform: "translateX(-50%)",
            padding: "6px 10px",
            borderRadius: 8,
            background: "var(--card)",
            color: "var(--foreground)",
            fontSize: 12,
            whiteSpace: "normal",
            width: 220,
            textAlign: "center",
            lineHeight: 1.5,
            zIndex: 10000,
            pointerEvents: "none",
            fontWeight: 400,
            border: "1px solid var(--border)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
          }}
        >
          {tip}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Token 为网关估算值的小徽标（上游未回报 usage 时的兜底标记） */
function EstBadge({ tip }: { tip: string }) {
  return (
    <HoverTip tip={tip}>
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-bold cursor-help"
        style={{ background: "var(--brand-tint-15)", color: "var(--brand, #d97757)" }}>
        估
      </span>
    </HoverTip>
  );
}

function statusColor(code: number): string {
  if (code >= 200 && code < 300) return "var(--ok)";
  if (code === 429) return "#f59e0b";
  if (code === 401 || code === 403) return "#ef4444";
  if (code >= 400 && code < 500) return "var(--warn)";
  if (code === 502 || code === 503 || code === 504) return "#dc2626";
  return "var(--danger)";
}

function statusLabel(code: number): string {
  const map: Record<number, string> = {
    200: "OK", 400: "Bad Req", 401: "Unauth", 403: "Forbid", 404: "Not Found",
    422: "Unproc", 429: "Limit", 500: "Error", 502: "Bad GW", 503: "Unavail", 504: "Timeout",
  };
  if (map[code]) return map[code];
  if (code >= 200 && code < 300) return "OK";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500) return "5xx";
  return String(code);
}

type DatePreset = "today" | "3d" | "week" | "month" | "all" | "custom";
type SortField = "time" | "token" | "prompt" | "completion" | "ttft" | "duration";

function localDatetimeStr(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function getPresetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case "today": {
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: localDatetimeStr(s), to: localDatetimeStr(now) };
    }
    case "3d": {
      const s = new Date(now); s.setDate(s.getDate() - 3); s.setHours(0, 0, 0, 0);
      return { from: localDatetimeStr(s), to: localDatetimeStr(now) };
    }
    case "week": {
      const day = now.getDay();
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day === 0 ? 6 : day - 1));
      return { from: localDatetimeStr(s), to: localDatetimeStr(now) };
    }
    case "month": {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: localDatetimeStr(s), to: localDatetimeStr(now) };
    }
    default:
      return { from: "", to: "" };
  }
}

function downloadCsvFromUrl(token: string, url: string, filename: string, t: TFn) {
  const headers = new Headers();
  if (token && token !== COOKIE_SESSION_TOKEN) {
    headers.append("Authorization", `Bearer ${token}`);
  }
  fetch(url, { headers, credentials: "same-origin" })
    .then(res => {
      if (!res.ok) throw new Error("Export failed");
      return res.blob();
    })
    .then(blob => {
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(objUrl);
      toast.success(t("common.exportSuccess"));
    })
    .catch(() => toast.error(t("common.exportFailed")));
}

/** 筛选 chip（时间预设 / 状态码 / 缓存共用） */
function ChipBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="apiplatform-btn"
      style={{
        padding: "4px 12px", borderRadius: 100, fontSize: 12, fontWeight: 500,
        border: `1.5px solid ${active ? "var(--primary)" : "var(--border)"}`,
        background: active ? "var(--primary)" : "var(--card)",
        color: active ? "var(--primary-foreground)" : "var(--muted-foreground)",
        cursor: "pointer", transition: "all 0.15s",
      }}>
      {children}
    </button>
  );
}

/** 表头筛选：Filter 图标 + body 门户弹层（避开表格 overflow / sticky header 遮挡） */
function HeaderFilter({
  active, open, onOpen, onClose, children, width = 280,
}: {
  active: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  const [pos, setPos] = useState<{
    left: number;
    maxHeight: number;
    /** 向下展开用 top；向上展开用 bottom（相对视口底边） */
    top?: number;
    bottom?: number;
  } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 4;
    const pad = 8;
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - width - pad));
    const below = window.innerHeight - rect.bottom - gap - pad;
    const above = rect.top - gap - pad;
    // 下方空间不足时改为向上展开，高度钳在可用范围内（避免顶出视口只剩一条边）
    const openUp = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(openUp ? above : below, window.innerHeight - pad * 2));
    if (openUp) {
      setPos({ left, maxHeight, bottom: window.innerHeight - rect.top + gap });
    } else {
      setPos({ left, maxHeight, top: rect.bottom + gap });
    }
  }, [width]);

  useEffect(() => {
    if (!open) return;
    place();
    function onDown(e: MouseEvent) {
      if (boxRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    // 滚动/缩放时跟着锚点重算，避免弹层留在错误位置被遮住
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, onClose, place]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) { onClose(); return; }
          place();
          onOpen();
        }}
        className="inline-flex items-center justify-center p-0.5 rounded transition-colors apiplatform-btn"
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
            left: pos.left,
            ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }),
            zIndex: 9999,
            width,
            maxHeight: pos.maxHeight,
            overflowY: "auto",
            overflowX: "hidden",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 10,
            boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          }}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 表头多选列表（模型 / API Key） */
function HeaderMultiList({
  options, selected, onToggle, searchPlaceholder, emptyText,
}: {
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [kw, setKw] = useState("");
  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return k ? options.filter(o => o.toLowerCase().includes(k)) : options;
  }, [options, kw]);

  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-border bg-background mb-2">
        <Search className="w-3 h-3 text-muted-foreground shrink-0" />
        <input autoFocus value={kw} onChange={e => setKw(e.target.value)}
          placeholder={searchPlaceholder}
          className="bg-transparent text-[12px] flex-1 focus:outline-none" />
      </div>
      <div>
        {shown.length === 0 ? (
          <p className="text-[12px] text-muted-foreground text-center py-3">{emptyText}</p>
        ) : shown.map(o => {
          const checked = selected.includes(o);
          return (
            <button key={o} type="button" onClick={() => onToggle(o)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] text-left hover:bg-secondary transition-colors apiplatform-btn"
              style={{ color: checked ? "var(--primary)" : "var(--foreground)", fontWeight: checked ? 600 : 400 }}>
              <span
                className="w-3.5 h-3.5 rounded shrink-0 inline-flex items-center justify-center"
                style={{
                  border: `1.5px solid ${checked ? "var(--primary)" : "var(--border)"}`,
                  background: checked ? "var(--primary)" : "transparent",
                }}>
                {checked && <Check className="w-2.5 h-2.5" style={{ color: "var(--primary-foreground)" }} />}
              </span>
              <span className="truncate">{o}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function LogsPanel({ scope, token, embedded = false, subtitle }: LogsPanelProps) {
  const { t } = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = scope === "admin";
  const dense = embedded && isAdmin;
  const cellPad = dense ? "px-2 py-2" : "px-4 py-3";
  const useUrlParams = scope === "user";

  const initialWd = (() => {
    const raw = searchParams.get("wd");
    if (raw == null) return null;
    const n = Number(raw);
    return (Number.isInteger(n) && n >= 0 && n <= 6) ? n : null;
  })();
  const initialHour = (() => {
    const raw = searchParams.get("h");
    if (raw == null) return null;
    const n = Number(raw);
    return (Number.isInteger(n) && n >= 0 && n <= 23) ? n : null;
  })();
  const WD_I18N_KEYS = [
    "usage.weekday.mon", "usage.weekday.tue", "usage.weekday.wed",
    "usage.weekday.thu", "usage.weekday.fri", "usage.weekday.sat",
    "usage.weekday.sun",
  ] as const;
  const [weekdayFilter, setWeekdayFilter] = useState<number | null>(initialWd);
  const [hourFilter, setHourFilter] = useState<number | null>(initialHour);

  const STATUS_CHIPS = useMemo(() => [
    { label: t("logs.status.all"), value: "", dot: "var(--fg-subtle)" },
    { label: t("logs.status.2xx"), value: "2xx", dot: "var(--ok)" },
    { label: t("logs.status.429"), value: "429", dot: "#f59e0b" },
    { label: t("logs.status.4xx"), value: "4xx", dot: "var(--warn)" },
    { label: t("logs.status.5xx"), value: "5xx", dot: "var(--danger)" },
  ], [t]);

  const PRESET_LABELS: Record<DatePreset, string> = useMemo(() => ({
    today: t("logs.preset.today"), "3d": t("logs.preset.3d"), week: t("logs.preset.week"), month: t("logs.preset.month"), all: t("logs.preset.all"), custom: t("logs.preset.custom"),
  }), [t]);

  const [records, setRecords] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [retentionCutoff, setRetentionCutoff] = useState<string | null>(null);
  const [hasPurgedRange, setHasPurgedRange] = useState(false);
  const [uniqueModels, setUniqueModels] = useState<string[]>([]);
  const [uniqueKeyNames, setUniqueKeyNames] = useState<string[]>([]);
  const [uniqueDepartments, setUniqueDepartments] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [jumpPage, setJumpPage] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [modelFilter, setModelFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [keyNameFilter, setKeyNameFilter] = useState<string[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState<string[]>([]);
  // requestIdInput 是输入框即时值，防抖后落入 requestIdFilter 才真正触发查询
  const [requestIdInput, setRequestIdInput] = useState("");
  const [requestIdFilter, setRequestIdFilter] = useState("");
  const [cacheFilter, setCacheFilter] = useState("");
  const [openHeader, setOpenHeader] = useState<"time" | "model" | "key" | "status" | "department" | null>(null);

  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const firstLoadDone = useRef(false);

  const colSpan = isAdmin ? 11 : 9;

  // admin：数据看板热力图跳转写入的 pending 日期筛选
  useEffect(() => {
    if (!isAdmin) return;
    try {
      const raw = sessionStorage.getItem(ADMIN_LOGS_FILTERS_KEY);
      if (!raw) return;
      sessionStorage.removeItem(ADMIN_LOGS_FILTERS_KEY);
      const pending = JSON.parse(raw) as { dateFrom?: string; dateTo?: string };
      if (pending?.dateFrom) setDateFrom(pending.dateFrom);
      if (pending?.dateTo) setDateTo(pending.dateTo);
      if (pending?.dateFrom || pending?.dateTo) setDatePreset("custom");
    } catch { /* ignore */ }
  }, [isAdmin]);

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  // Request ID 搜索防抖：避免每个按键都发一次查询
  useEffect(() => {
    const h = setTimeout(() => setRequestIdFilter(requestIdInput.trim()), 400);
    return () => clearTimeout(h);
  }, [requestIdInput]);

  const closeHeader = useCallback(() => setOpenHeader(null), []);

  const buildParams = useCallback((pageNum: number, extra?: Record<string, string | undefined>) => {
    const p = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(pageNum * PAGE_SIZE),
    });
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    if (modelFilter.length > 0) p.set("model_id", modelFilter.join(","));
    if (statusFilter) p.set("status_code", statusFilter);
    if (keyNameFilter.length > 0) p.set("key_name", keyNameFilter.join(","));
    if (isAdmin && departmentFilter.length > 0) p.set("department", departmentFilter.join(","));
    if (requestIdFilter) p.set("request_id", requestIdFilter);
    if (cacheFilter) p.set("cache_filter", cacheFilter);
    if (useUrlParams && weekdayFilter != null) p.set("wd", String(weekdayFilter));
    if (useUrlParams && hourFilter != null) p.set("hour", String(hourFilter));
    if (sortField) {
      p.set("sort_field", sortField);
      p.set("sort_dir", sortDir);
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v != null) p.set(k, v);
      }
    }
    return p.toString();
  }, [dateFrom, dateTo, modelFilter, statusFilter, keyNameFilter, departmentFilter, requestIdFilter, cacheFilter, weekdayFilter, hourFilter, sortField, sortDir, isAdmin, useUrlParams]);

  const normalizeRecord = (r: any): LogRecord => ({
    ...r,
    api_key_name: r.api_key_name || r.key_name,
    prompt_tokens: Number(r.prompt_tokens || 0),
    completion_tokens: Number(r.completion_tokens || 0),
    total_tokens: Number(r.total_tokens || 0),
    cache_hit_tokens: Number(r.cache_hit_tokens || 0),
    cache_miss_tokens: Number(r.cache_miss_tokens || 0),
    cache_write_tokens: Number(r.cache_write_tokens || 0),
    latency_ms: Number(r.latency_ms || 0),
    total_duration_ms: Number(r.total_duration_ms || 0),
    estimated_cost: Number(r.estimated_cost || 0),
    usage_estimated: !!r.usage_estimated,
    stream: !!r.stream,
    status_code: Number(r.status_code || 0),
  });

  const fetchLogs = useCallback(async (
    pageNum: number,
    opts?: { silent?: boolean },
  ): Promise<boolean> => {
    if (!token) return false;
    if (!opts?.silent) setLoading(true);
    try {
      const params = buildParams(pageNum);
      let data: PagedResponse;
      if (isAdmin) {
        const resp = await fetch(`/api/admin/usage?${params}`, { headers: authHeaders(token) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
      } else {
        data = await api.userLogsPaged(token, params);
      }
      const recs = Array.isArray(data.records) ? data.records : [];
      setRecords(recs.map(normalizeRecord));
      setTotal(data.total || 0);
      setRetentionDays(typeof data.retention_days === "number" ? data.retention_days : null);
      setRetentionCutoff(data.retention_cutoff ?? null);
      setHasPurgedRange(!!data.has_purged_range);
      setUniqueModels(data.unique_models ?? []);
      setUniqueKeyNames(data.unique_key_names ?? []);
      setUniqueDepartments(data.unique_departments ?? []);
      firstLoadDone.current = true;
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("logs.error.unknown");
      toast.error(tpl(t("logs.toast.loadFailed"), { msg }));
      firstLoadDone.current = true;
      return false;
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [token, buildParams, t, isAdmin]);

  async function handleRefresh() {
    if (refreshing || loading) return;
    setRefreshing(true);
    const ok = await fetchLogs(page, { silent: true });
    setRefreshing(false);
    if (ok) toast.success(t("logs.toast.refreshDone"));
  }

  function handleExport() {
    if (!token) return;
    setExporting(true);
    const p = buildParams(0);
    const exportParams = `${p}&export=csv`;
    const url = isAdmin ? `/api/admin/usage?${exportParams}` : `/api/user/logs?${exportParams}`;
    const filename = `${isAdmin ? "admin" : "api"}-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadCsvFromUrl(token, url, filename, t);
    setExporting(false);
  }

  function copyRequestId(reqId: string) {
    void copyText(reqId).then((ok) => {
      if (!ok) throw new Error("copy failed");
      setCopiedId(reqId);
      toast.success(t("logs.copiedRequestId"));
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => toast.error(t("common.copyFailed")));
  }

  useEffect(() => {
    setPage(0); fetchLogs(0);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect: refetch on filter/sort changes
  // 只跳过挂载时的首次运行（初始加载由上面的 [token] effect 负责）；
  // 此后每一次运行都对应真实的筛选/排序变更，必须触发重新查询。
  const filtersInitialized = useRef(false);
  useEffect(() => {
    if (!filtersInitialized.current) { filtersInitialized.current = true; return; }
    setPage(0);
    fetchLogs(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, modelFilter, statusFilter, keyNameFilter, departmentFilter, requestIdFilter, cacheFilter, sortField, sortDir, weekdayFilter, hourFilter]);

  // Effect: page change
  useEffect(() => {
    if (firstLoadDone.current) fetchLogs(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowLeft" && !e.metaKey && !e.ctrlKey) {
        if (page > 0) handlePageChange(page - 1);
      }
      if (e.key === "ArrowRight" && !e.metaKey && !e.ctrlKey) {
        if (page < totalPages - 1) handlePageChange(page + 1);
      }
      if ((e.key === "r" || e.key === "R") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        handleRefresh();
      }
      if (e.key === "Escape") {
        setExpandedId(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, totalPages]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectPreset(p: DatePreset) {
    setDatePreset(p);
    if (p === "custom") return;
    const { from, to } = getPresetRange(p);
    setDateFrom(from); setDateTo(to);
    setPage(0);
  }

  function clearFilter() {
    setDatePreset("all"); setDateFrom(""); setDateTo("");
    setModelFilter([]); setStatusFilter("");
    setKeyNameFilter([]); setDepartmentFilter([]);
    setRequestIdInput(""); setRequestIdFilter("");
    setCacheFilter("");
    setWeekdayFilter(null); setHourFilter(null);
    setSortField(null); setSortDir("desc");
    setPage(0);
    if (useUrlParams && (searchParams.has("wd") || searchParams.has("h"))) {
      searchParams.delete("wd");
      searchParams.delete("h");
      setSearchParams(searchParams, { replace: true });
    }
  }

  function clearTimeFilter() {
    setWeekdayFilter(null);
    setHourFilter(null);
    setPage(0);
    if (!useUrlParams) return;
    const sp = new URLSearchParams(searchParams);
    sp.delete("wd");
    sp.delete("h");
    setSearchParams(sp, { replace: true });
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      if (sortDir === "desc") { setSortDir("asc"); }
      else { setSortField(null); setSortDir("desc"); return; }
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  function handlePageChange(p: number) { setPage(p); setJumpPage(""); }
  function handleJumpPage() {
    const p = parseInt(jumpPage, 10) - 1;
    if (isNaN(p) || p < 0 || p >= totalPages) { toast.error(tpl(t("logs.pagination.invalidPage"), { total: totalPages })); return; }
    handlePageChange(p);
  }

  const hasFilter = !!(dateFrom || dateTo || modelFilter.length > 0 || statusFilter || keyNameFilter.length > 0 || departmentFilter.length > 0 || requestIdFilter || cacheFilter || weekdayFilter != null || hourFilter != null);
  const showSkeleton = loading && !firstLoadDone.current;
  const showLoadingBar = loading && firstLoadDone.current;

  const thStyle = (active: boolean): React.CSSProperties => ({
    padding: dense ? "8px 10px" : "12px 16px", textAlign: "left", fontWeight: 500,
    color: active ? "var(--primary)" : "var(--muted-foreground)",
    whiteSpace: "nowrap", background: "var(--card)",
  });

  function SortLabel({ field, label, tip }: { field: SortField; label: string; tip?: string }) {
    const inner = (
      <span className="inline-flex items-center gap-1" style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => handleSort(field)}>
        {label}
        {sortField === field
          ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-30" />}
      </span>
    );
    return tip ? <HoverTip tip={tip}>{inner}</HoverTip> : inner;
  }

  const headerBlock = (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      {!embedded && (
        <div>
          <h1 className={PAGE_TITLE_CLASS}>{t("logs.title")}</h1>
          {subtitle && <p className="text-[13px] text-muted-foreground mt-1">{subtitle}</p>}
        </div>
      )}
      <div className={`flex items-center gap-2 flex-wrap ${embedded ? "ml-auto" : ""}`}>
        <button onClick={handleRefresh} disabled={refreshing || loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] border border-border hover:bg-secondary transition-colors disabled:opacity-60 apiplatform-btn"
          style={{ fontWeight: 500 }}
          title={t("logs.refreshHint")}>
          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? t("logs.refreshing") : t("logs.refresh")}
        </button>
        <button onClick={handleExport} disabled={records.length === 0 || exporting}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-xl text-[13px] hover:opacity-90 transition-opacity disabled:opacity-60 apiplatform-btn"
          style={{ fontWeight: 500 }}>
          <Download className="w-3.5 h-3.5" /> {t("logs.exportCsv")}
        </button>
      </div>
    </div>
  );

  const body = (
    <>
      {headerBlock}
      <div className={cn("bg-card rounded-2xl border border-border", dense && "rounded-xl")} style={{ overflow: "visible" }}>
        <div className={cn("border-b border-border flex items-center gap-2 flex-wrap", dense ? "px-3 py-2" : "px-4 py-3")}>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-background flex-1" style={{ minWidth: 220, maxWidth: 420 }}>
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              value={requestIdInput}
              onChange={e => setRequestIdInput(e.target.value)}
              placeholder={t("logs.filter.requestIdPlaceholder")}
              className="bg-transparent text-[12px] flex-1 focus:outline-none"
            />
            {requestIdInput && (
              <button type="button" onClick={() => { setRequestIdInput(""); setRequestIdFilter(""); }}
                className="p-0.5 rounded text-muted-foreground hover:bg-secondary transition-colors apiplatform-btn">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {hasFilter && (
            <button type="button" onClick={clearFilter}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[12px] border border-border hover:bg-secondary transition-colors apiplatform-btn"
              style={{ fontWeight: 500 }}>
              <X className="w-3 h-3" /> {t("logs.filter.clear")}
            </button>
          )}
          {retentionDays ? (
            <span className="text-[11px] text-muted-foreground ml-auto">
              {tpl(t("logs.filter.retention"), { days: retentionDays })}
            </span>
          ) : null}
          {hasPurgedRange && retentionCutoff && (
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--warn)" }}>
              <Trash2 className="w-3 h-3 shrink-0" />
              {tpl(t("logs.filter.purged"), { date: formatDateOnly(retentionCutoff) })}
            </span>
          )}
        </div>
        {showLoadingBar && (
          <div className="h-[2px] w-full overflow-hidden">
            <div
              className="h-full animate-pulse"
              style={{ background: "linear-gradient(90deg, transparent 0%, var(--primary) 50%, transparent 100%)", width: "100%" }}
            />
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: dense ? "12px" : "13px",
              ...(dense ? { minWidth: "max-content" } : {}),
            }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={thStyle(sortField === "time" || !!(dateFrom || dateTo))}>
                    <span className="inline-flex items-center gap-1">
                      <SortLabel field="time" label={t("logs.table.header.time")} />
                      <HeaderFilter
                        active={!!(dateFrom || dateTo)}
                        open={openHeader === "time"}
                        onOpen={() => setOpenHeader("time")}
                        onClose={closeHeader}
                        width={320}
                      >
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {(["today", "3d", "week", "month", "all", "custom"] as DatePreset[]).map(p => (
                            <ChipBtn key={p} active={datePreset === p} onClick={() => selectPreset(p)}>
                              {PRESET_LABELS[p]}
                            </ChipBtn>
                          ))}
                        </div>
                        {datePreset === "custom" && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <input type="datetime-local" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                              className="px-2 py-1 rounded-lg text-[12px] border border-border bg-background focus:outline-none focus:ring-2 focus:ring-brand/20 flex-1" />
                            <span className="text-[12px] text-muted-foreground">{t("logs.filter.to")}</span>
                            <input type="datetime-local" value={dateTo} onChange={e => setDateTo(e.target.value)}
                              className="px-2 py-1 rounded-lg text-[12px] border border-border bg-background focus:outline-none focus:ring-2 focus:ring-brand/20 flex-1" />
                          </div>
                        )}
                      </HeaderFilter>
                    </span>
                  </th>
                  <th style={thStyle(modelFilter.length > 0)}>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <span style={{ userSelect: "none" }}>{t("logs.table.header.model")}</span>
                      <HeaderFilter
                        active={modelFilter.length > 0}
                        open={openHeader === "model"}
                        onOpen={() => setOpenHeader("model")}
                        onClose={closeHeader}
                      >
                        <HeaderMultiList
                          options={uniqueModels}
                          selected={modelFilter}
                          onToggle={m => setModelFilter(prev => prev.includes(m) ? prev.filter(v => v !== m) : [...prev, m])}
                          searchPlaceholder={t("logs.filter.search")}
                          emptyText={t("logs.stats.noData")}
                        />
                      </HeaderFilter>
                    </span>
                  </th>
                  {isAdmin && (
                    <th style={thStyle(departmentFilter.length > 0)}>
                      <span className="inline-flex items-center gap-1">
                        <span style={{ userSelect: "none" }}>{t("logs.table.header.department")}</span>
                        <HeaderFilter
                          active={departmentFilter.length > 0}
                          open={openHeader === "department"}
                          onOpen={() => setOpenHeader("department")}
                          onClose={closeHeader}
                        >
                          <HeaderMultiList
                            options={uniqueDepartments}
                            selected={departmentFilter}
                            onToggle={d => setDepartmentFilter(prev => prev.includes(d) ? prev.filter(v => v !== d) : [...prev, d])}
                            searchPlaceholder={t("logs.filter.search")}
                            emptyText={t("logs.stats.noData")}
                          />
                        </HeaderFilter>
                      </span>
                    </th>
                  )}
                  {isAdmin && (
                    <th style={thStyle(false)}>
                      <span style={{ userSelect: "none" }}>{t("logs.table.header.authId")}</span>
                    </th>
                  )}
                  <th style={thStyle(keyNameFilter.length > 0)}>
                    <span className="inline-flex items-center gap-1">
                      <span style={{ userSelect: "none" }}>{t("logs.filter.apiKey")}</span>
                      <HeaderFilter
                        active={keyNameFilter.length > 0}
                        open={openHeader === "key"}
                        onOpen={() => setOpenHeader("key")}
                        onClose={closeHeader}
                      >
                        <HeaderMultiList
                          options={uniqueKeyNames}
                          selected={keyNameFilter}
                          onToggle={k => setKeyNameFilter(prev => prev.includes(k) ? prev.filter(v => v !== k) : [...prev, k])}
                          searchPlaceholder={t("logs.filter.search")}
                          emptyText={t("logs.stats.noData")}
                        />
                      </HeaderFilter>
                    </span>
                  </th>
                  <th style={thStyle(sortField === "token")}>
                    <SortLabel field="token" label={t("logs.table.header.tokenTotal")} />
                  </th>
                  <th style={{ ...thStyle(sortField === "prompt"), paddingRight: 8 }}>
                    <HoverTip tip={t("logs.table.tooltip.prompt")}>
                      <SortLabel field="prompt" label={t("logs.table.header.prompt")} />
                    </HoverTip>
                  </th>
                  <th style={{ ...thStyle(sortField === "completion"), paddingLeft: 8 }}>
                    <HoverTip tip={t("logs.table.tooltip.completion")}>
                      <SortLabel field="completion" label={t("logs.table.header.completion")} />
                    </HoverTip>
                  </th>
                  <th style={thStyle(sortField === "ttft")}>
                    <HoverTip tip={t("logs.table.tooltip.ttft")}>
                      <SortLabel field="ttft" label={t("logs.table.header.ttft")} />
                    </HoverTip>
                  </th>
                  <th style={thStyle(sortField === "duration")}>
                    <SortLabel field="duration" label={t("logs.table.header.duration")} />
                  </th>
                  <th style={thStyle(!!statusFilter || !!cacheFilter)}>
                    <span className="inline-flex items-center gap-1">
                      <span style={{ userSelect: "none" }}>{t("logs.table.header.statusCode")}</span>
                      <HeaderFilter
                        active={!!statusFilter || !!cacheFilter}
                        open={openHeader === "status"}
                        onOpen={() => setOpenHeader("status")}
                        onClose={closeHeader}
                        width={260}
                      >
                        <p className="text-[11px] text-muted-foreground mb-1.5" style={{ fontWeight: 500 }}>{t("logs.filter.statusCode")}</p>
                        <div className="flex flex-col gap-0.5 mb-3">
                          {STATUS_CHIPS.map(c => (
                            <button key={c.value || "all"} type="button"
                              onClick={() => { setStatusFilter(c.value); closeHeader(); }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] text-left hover:bg-secondary transition-colors apiplatform-btn"
                              style={{
                                color: statusFilter === c.value ? "var(--primary)" : "var(--foreground)",
                                fontWeight: statusFilter === c.value ? 600 : 400,
                                background: statusFilter === c.value ? "var(--secondary)" : undefined,
                              }}>
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
                              {c.label}
                            </button>
                          ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground mb-1.5" style={{ fontWeight: 500 }}>{t("logs.filter.cacheHit")}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            { label: t("logs.filter.cache.all"), value: "" },
                            { label: t("logs.filter.cache.hit"), value: "hit" },
                            { label: t("logs.filter.cache.miss"), value: "miss" },
                          ].map(opt => (
                            <ChipBtn key={opt.value || "all"} active={cacheFilter === opt.value}
                              onClick={() => setCacheFilter(opt.value)}>
                              {opt.label}
                            </ChipBtn>
                          ))}
                        </div>
                      </HeaderFilter>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {showSkeleton ? (
                  [...Array(6)].map((_, i) => (
                    <tr key={i}>
                      <td colSpan={colSpan} className={cn(cellPad, "py-3")}>
                        <div className="skeleton h-8 rounded-xl w-full" style={{ animationDelay: `${i * 80}ms` }} />
                      </td>
                    </tr>
                  ))
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className={cn(cellPad, dense ? "py-12" : "py-16")}>
                      <div className="flex flex-col items-center justify-center gap-2">
                        <p className="text-[15px] text-foreground" style={{ fontWeight: 500 }}>{t("logs.table.empty")}</p>
                        <p className="text-[13px] text-muted-foreground">
                          {hasFilter ? t("logs.table.emptyFiltered") : t("logs.table.emptyNoCalls")}
                        </p>
                        {hasPurgedRange && retentionCutoff && (
                          <p className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--warn)" }}>
                            <Trash2 className="w-3 h-3 shrink-0" />
                            {tpl(t("logs.table.emptyPurged"), { date: formatDateOnly(retentionCutoff) })}
                          </p>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : records.map((r) => {
                  const isExpanded = expandedId === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : r.id)}
                        className={isExpanded ? "" : "apiplatform-row"}
                        style={{
                          borderBottom: isExpanded ? "none" : "1px solid var(--border)",
                          cursor: "pointer",
                          background: isExpanded ? "var(--secondary)" : undefined,
                        }}>
                        <td className={cn(cellPad, "text-[12px] text-muted-foreground whitespace-nowrap")} title={formatTimeFull(r.created_at)}>
                          {formatTime(r.created_at)}
                        </td>
                        <td className={cn(cellPad, "whitespace-nowrap")}>
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <span
                              className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 font-mono text-[12px] apiplatform-chip whitespace-nowrap"
                              style={{ fontWeight: 600, color: "var(--foreground)" }}
                              title={r.model_id}>
                              {r.model_id}
                            </span>
                            {r.stream && (
                              <HoverTip tip={t("logs.table.badge.stream")}>
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
                                  style={{ background: "var(--brand-soft, rgba(217,119,87,0.12))", color: "var(--brand, #d97757)" }}>
                                  流式
                                </span>
                              </HoverTip>
                            )}
                          </span>
                        </td>
                        {isAdmin && (
                          <td className={cn(cellPad, "text-[12px] text-muted-foreground whitespace-nowrap")}>{r.department || "—"}</td>
                        )}
                        {isAdmin && (
                          <td className={cn(cellPad, "text-[12px] text-muted-foreground whitespace-nowrap font-mono")}>{r.auth_id || "—"}</td>
                        )}
                        <td className={cn(cellPad, "whitespace-nowrap font-serif text-[12px] font-medium text-foreground")}>{r.api_key_name || "—"}</td>
                        <td className={cn(cellPad, "text-[12px] tabular-nums text-foreground whitespace-nowrap")} style={{ fontWeight: 600 }}>
                          <span className="inline-flex items-center gap-1">
                            {r.total_tokens.toLocaleString()}
                            {r.usage_estimated && <EstBadge tip={t("logs.table.badge.estimated")} />}
                          </span>
                        </td>
                        <td className={cn(cellPad, "text-[12px] tabular-nums text-muted-foreground whitespace-nowrap")}>
                          <span className="inline-flex items-center gap-1">
                            {r.prompt_tokens.toLocaleString()}
                            {r.usage_estimated && <EstBadge tip={t("logs.table.badge.estimated")} />}
                          </span>
                        </td>
                        <td className={cn(cellPad, "text-[12px] tabular-nums text-muted-foreground whitespace-nowrap")}>
                          <span className="inline-flex items-center gap-1">
                            {r.completion_tokens.toLocaleString()}
                            {r.usage_estimated && <EstBadge tip={t("logs.table.badge.estimated")} />}
                          </span>
                        </td>
                        <td className={cn(cellPad, "text-[12px] tabular-nums text-muted-foreground whitespace-nowrap")}>
                          <span style={{ color: r.latency_ms > 3000 ? "var(--warn)" : r.latency_ms > 1000 ? "var(--fg-subtle)" : undefined }}>
                            {fmtMs(r.latency_ms)}
                          </span>
                        </td>
                        <td className={cn(cellPad, "text-[12px] tabular-nums text-muted-foreground whitespace-nowrap")}>{fmtMs(r.total_duration_ms)}</td>
                        <td className={cn(cellPad, "whitespace-nowrap")}>
                          <span
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[12px]"
                            style={{ color: statusColor(r.status_code), fontWeight: 600 }}
                          >
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(r.status_code) }} />
                            {r.status_code} <span className="opacity-60 font-[400]">{statusLabel(r.status_code)}</span>
                          </span>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr>
                          <td colSpan={colSpan} className={cn(cellPad, "pb-4")} style={{ background: "var(--secondary)", borderBottom: "1px solid var(--border)" }}>
                            <div
                              className="rounded-xl border border-border p-4 text-[12px] space-y-2"
                              style={{ background: "var(--card)" }}
                              onClick={e => e.stopPropagation()}>
                              <div className="grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                                <div><span className="text-muted-foreground">{t("logs.expand.requestId")}:</span>
                                  <span className="ml-1.5 text-foreground inline-flex items-center gap-1" style={{ fontWeight: 600 }}>
                                    <code className="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-secondary">{r.request_id || "—"}</code>
                                    {r.request_id && (
                                      <button onClick={() => copyRequestId(r.request_id!)}
                                        className="p-0.5 rounded hover:bg-secondary transition-colors apiplatform-btn" title={t("common.copy")}>
                                        {copiedId === r.request_id ? <Check className="w-3 h-3 text-[var(--ok)]" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                      </button>
                                    )}
                                  </span>
                                </div>
                                <div><span className="text-muted-foreground">{t("logs.expand.apiKey")}:</span> <span className="ml-1.5 font-serif font-medium text-foreground">{r.api_key_name || "—"}</span></div>
                                {isAdmin && (
                                  <>
                                    <div><span className="text-muted-foreground">{t("logs.expand.department")}:</span> <span className="ml-1.5 text-foreground" style={{ fontWeight: 600 }}>{r.department || "—"}</span></div>
                                    <div><span className="text-muted-foreground">{t("logs.expand.authId")}:</span> <span className="ml-1.5 text-foreground font-mono" style={{ fontWeight: 600 }}>{r.auth_id || "—"}</span></div>
                                  </>
                                )}
                                <div><span className="text-muted-foreground">{t("logs.expand.model")}:</span> <span className="ml-1.5 font-mono font-medium text-foreground">{r.model_id}</span></div>
                                <div><span className="text-muted-foreground">{t("logs.expand.timeFull")}:</span> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>{formatTimeFull(r.created_at)}</span></div>
                                <div><span className="text-muted-foreground">{t("logs.expand.stream")}:</span> <span className="ml-1.5 text-foreground" style={{ fontWeight: 600 }}>{r.stream ? t("logs.expand.stream.yes") : t("logs.expand.stream.no")}</span></div>
                              </div>
                              <div className="h-px bg-border" />
                              <div className="grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
                                <div><span className="text-muted-foreground">{t("logs.expand.inputTokens")}:</span> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>{r.prompt_tokens.toLocaleString()}</span></div>
                                <div><span className="text-muted-foreground">{t("logs.expand.outputTokens")}:</span> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>{r.completion_tokens.toLocaleString()}</span></div>
                                <div><span className="text-muted-foreground">{t("logs.expand.totalTokens")}:</span> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>{r.total_tokens.toLocaleString()}</span></div>
                                <div><span className="text-muted-foreground">{t("logs.expand.usageSource")}:</span>
                                  <span className="ml-1.5 inline-flex items-center gap-1" style={{ fontWeight: 600 }}>
                                    {r.usage_estimated ? t("logs.expand.usageSource.estimated") : t("logs.expand.usageSource.measured")}
                                    {r.usage_estimated && <EstBadge tip={t("logs.table.badge.estimated")} />}
                                  </span>
                                </div>
                                {(r.cache_hit_tokens ?? 0) > 0 && (
                                  <div><span className="text-muted-foreground">{t("logs.expand.cacheHitInput")}:</span> <span className="ml-1.5 tabular-nums" style={{ fontWeight: 600, color: "var(--ok)" }}>{(r.cache_hit_tokens ?? 0).toLocaleString()}</span></div>
                                )}
                                {(r.cache_miss_tokens ?? 0) > 0 && (
                                  <div><span className="text-muted-foreground">{t("logs.expand.cacheMissInput")}:</span> <span className="ml-1.5 tabular-nums" style={{ fontWeight: 600 }}>{(r.cache_miss_tokens ?? 0).toLocaleString()}</span></div>
                                )}
                                {(r.cache_write_tokens ?? 0) > 0 && (
                                  <div><span className="text-muted-foreground">{t("logs.expand.cacheWrite")}:</span> <span className="ml-1.5 tabular-nums" style={{ fontWeight: 600 }}>{(r.cache_write_tokens ?? 0).toLocaleString()}</span></div>
                                )}
                              </div>
                              <div className="h-px bg-border" />
                              <div className="grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
                                <div><span className="text-muted-foreground">{t("logs.expand.ttft")}:</span> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>{fmtMs(r.latency_ms)}</span></div>
                                <div><span className="text-muted-foreground">{t("logs.expand.totalDuration")}:</span> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>{fmtMs(r.total_duration_ms)}</span></div>
                                {(r.estimated_cost ?? 0) > 0 && (
                                  <div><HoverTip tip={t("logs.expand.estimatedCostTip")}><span className="text-muted-foreground cursor-help" style={{ borderBottom: "1px dashed var(--border)" }}>{t("logs.expand.estimatedCost")}:</span></HoverTip> <span className="ml-1.5 text-foreground tabular-nums" style={{ fontWeight: 600 }}>${r.estimated_cost!.toFixed(4)}</span></div>
                                )}
                                <div><span className="text-muted-foreground">{t("logs.expand.statusCode")}:</span>
                                  <span className="ml-1.5" style={{ fontWeight: 600, color: statusColor(r.status_code) }}>{r.status_code} {statusLabel(r.status_code)}</span>
                                </div>
                              </div>
                              {r.error_detail && (
                                <>
                                  <div className="h-px bg-border" />
                                  <div>
                                    <span className="text-muted-foreground" style={{ fontWeight: 500 }}>{t("logs.expand.errorDetail")}</span>
                                    <pre className="mt-1 p-2 rounded-lg text-[11px] overflow-x-auto whitespace-pre-wrap font-mono"
                                      style={{ background: "var(--bg-soft)", color: "var(--danger)" }}>{r.error_detail}</pre>
                                  </div>
                                </>
                              )}
                              {r.response_preview && (
                                <>
                                  <div className="h-px bg-border" />
                                  <div>
                                    <span className="text-muted-foreground" style={{ fontWeight: 500 }}>{t("logs.expand.responsePreview")}</span>
                                    <pre className="mt-1 p-2 rounded-lg text-[11px] overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto"
                                      style={{ background: "var(--bg-soft)", color: "var(--fg-subtle)" }}>{typeof r.response_preview === "string" ? r.response_preview.slice(0, 500) : JSON.stringify(r.response_preview, null, 2).slice(0, 500)}</pre>
                                  </div>
                                </>
                              )}
                              {!r.error_detail && !r.response_preview && (
                                <>
                                  <div className="h-px bg-border" />
                                  <p className="text-[12px] text-muted-foreground">{t("logs.expand.noPreview")}</p>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
        </div>

        {/* Pagination */}
        {records.length > 0 && (
          <div className={cn("border-t border-border flex items-center justify-between gap-3 flex-wrap", dense ? "px-3 py-2" : "px-4 py-3")} style={{ background: "var(--bg-soft)" }}>
            <div className="flex items-center gap-2 flex-wrap">
              {(useUrlParams && (weekdayFilter != null || hourFilter != null)) && (
                <button onClick={clearTimeFilter}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] border border-brand/30 bg-brand/10 text-brand hover:bg-brand/20 transition-colors apiplatform-btn"
                  style={{ fontWeight: 500 }}>
                  <Timer className="w-3 h-3" />
                  {weekdayFilter != null && t(WD_I18N_KEYS[weekdayFilter])}
                  {weekdayFilter != null && hourFilter != null && " "}
                  {hourFilter != null && `${hourFilter.toString().padStart(2, "0")}:00–${(hourFilter + 1).toString().padStart(2, "0")}:00`}
                  <X className="w-3 h-3 ml-0.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[12px] text-muted-foreground tabular-nums">
                {tpl(t("logs.pagination.pageInfo"), {
                  current: records.length > 0 ? page + 1 : 0,
                  total: totalPages,
                  count: total.toLocaleString(),
                })}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => handlePageChange(page - 1)} disabled={page <= 0}
                  className="px-2 py-1 rounded-lg text-[12px] border border-border disabled:opacity-30 enabled:hover:bg-secondary transition-colors apiplatform-btn">
                  ← {t("logs.pagination.prev")}
                </button>
                <button onClick={() => handlePageChange(page + 1)} disabled={page >= totalPages - 1}
                  className="px-2 py-1 rounded-lg text-[12px] border border-border disabled:opacity-30 enabled:hover:bg-secondary transition-colors apiplatform-btn">
                  {t("logs.pagination.next")} →
                </button>
                <div className="flex items-center gap-1 ml-2">
                  <span className="text-[11px] text-muted-foreground">{t("logs.pagination.jumpTo")}</span>
                  <input value={jumpPage} onChange={e => setJumpPage(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={e => e.key === "Enter" && handleJumpPage()}
                    placeholder={t("logs.pagination.pagePlaceholder")}
                    className="w-12 px-2 py-1 rounded-lg text-[12px] border border-border bg-card text-center focus:outline-none focus:ring-2 focus:ring-brand/20 tabular-nums" />
                  <button onClick={handleJumpPage}
                    className="px-2 py-1 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors apiplatform-btn">
                    {t("logs.pagination.jump")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {records.length > 0 && (
          <div className={cn("text-[11px] text-muted-foreground border-t border-border", dense ? "px-3 py-1.5" : "px-4 py-2")} style={{ background: "var(--bg-soft)" }}>
            {t("logs.table.hint")}
          </div>
        )}
      </div>
    </>
  );

  if (embedded) {
    return <div className={dense ? "space-y-3" : "space-y-5"}>{body}</div>;
  }
  return (
    <ConsolePageShell className="space-y-5">
      {body}
    </ConsolePageShell>
  );
}
