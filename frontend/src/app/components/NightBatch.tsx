import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { createPortal } from "react-dom";
import { Moon, Plus, Trash2, Loader2, List, CalendarDays, Clock, Filter, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api, type NightBatchRegistration, type ModelInfo } from "../api/gateway";
import { useAuth } from "../hooks/use-auth";
import { ConsolePageShell } from "./console-page-shell";
import { NightBatchModal, NightBatchEditDialog, type NightBatchEditTarget } from "./night-batch-modal";
import { PAGE_TITLE_CLASS } from "./ui/utils";
import { categoryLabels } from "./model-data";
import { useT, type TranslationKey } from "../i18n";
import { SafeHtml } from "../safe-html";

/** 传给纯函数的翻译器：与 useT() 的 t 同型，缺键在编译期就能发现。 */
type Translate = (key: TranslationKey) => string;

const PAGE_SIZE = 20;
const CALENDAR_DAYS = 30;

function getWeekdayLabels(t: Translate): string[] {
  return [t("usage.weekday.mon"), t("usage.weekday.tue"), t("usage.weekday.wed"), t("usage.weekday.thu"), t("usage.weekday.fri"), t("usage.weekday.sat"), t("usage.weekday.sun")];
}

const CATEGORY_SORT_ORDER: Record<string, number> = {
  flagship: 0,
  chat: 1,
  vision: 2,
  embedding: 3,
  reranker: 4,
  ocr: 5,
  lts: 99,
};

const CALENDAR_SLOTS = (() => {
  const slots: { hour: number; minute: number; label: string }[] = [];
  for (let h = 19; h < 24; h++) {
    for (const m of [0, 30]) {
      slots.push({ hour: h, minute: m, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` });
    }
  }
  for (let h = 0; h < 8; h++) {
    for (const m of [0, 30]) {
      if (h === 7 && m === 30) continue;
      slots.push({ hour: h, minute: m, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` });
    }
  }
  return slots;
})();

const HOUR_LABELS = (() => {
  const labels: { label: string; colSpan: number }[] = [];
  for (let h = 19; h < 24; h++) labels.push({ label: `${h}:00`, colSpan: 2 });
  for (let h = 0; h < 8; h++) {
    if (h === 7) labels.push({ label: `${h}:00`, colSpan: 1 });
    else labels.push({ label: `${h}:00`, colSpan: 2 });
  }
  return labels;
})();

const MODEL_COLORS = [
  { bg: "#dbeafe", text: "#1e40af" },
  { bg: "#dcfce7", text: "#166534" },
  { bg: "#fef3c7", text: "#92400e" },
  { bg: "#fce7f3", text: "#9d174d" },
  { bg: "#e0e7ff", text: "#3730a3" },
  { bg: "#ccfbf1", text: "#134e4a" },
  { bg: "#fae8ff", text: "#6b21a8" },
  { bg: "#ffedd5", text: "#9a3412" },
  { bg: "#ede9fe", text: "#5b21b6" },
  { bg: "#fce4ec", text: "#880e4f" },
];

let _platformTzOffset = 480;

function computeTzOffset(tzName: string): number {
  try {
    const now = Date.now();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const vals: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") vals[p.type] = parseInt(p.value, 10);
    }
    const tzDate = new Date(vals.year, vals.month - 1, vals.day, vals.hour, vals.minute, vals.second);
    const utcTime = Date.UTC(vals.year, vals.month - 1, vals.day, vals.hour, vals.minute, vals.second);
    return (tzDate.getTime() - utcTime) / 60000;
  } catch {
    return 480;
  }
}

function initPlatformTzOffset(tzName: string) {
  _platformTzOffset = computeTzOffset(tzName);
}

function bjNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + _platformTzOffset) * 60000);
}

function nightOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours();
  const m = d.getMinutes();
  const isMorning = h < 7 || (h === 7 && m < 30);
  const date = isMorning ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1) : d;
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function slotIndex(h: number, m: number): number {
  const totalMinutes = h * 60 + m;
  const startMinutes = 19 * 60;
  if (totalMinutes >= startMinutes) return Math.floor((totalMinutes - startMinutes) / 30);
  return Math.floor((24 * 60 - startMinutes + totalMinutes) / 30);
}

function nowSlotIndex(): number {
  const now = bjNow();
  return slotIndex(now.getHours(), now.getMinutes());
}

function todayBjStr(): string {
  return nightOf(bjNow());
}

function modelColor(modelId: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < modelId.length; i++) {
    hash = ((hash << 5) - hash) + modelId.charCodeAt(i);
    hash |= 0;
  }
  return MODEL_COLORS[Math.abs(hash) % MODEL_COLORS.length];
}

function formatDateLabel(dateStr: string, t: Translate, weekdayLabels: string[]): string {
  const d = new Date(dateStr + "T12:00:00");
  const p = (n: number) => String(n).padStart(2, "0");
  const dayOfWeek = d.getDay();
  const weekday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return t("nightBatch.formatDate")
    .replace("{month}", p(d.getMonth() + 1))
    .replace("{date}", p(d.getDate()))
    .replace("{weekday}", weekdayLabels[weekday]);
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00");
  return d.getDay() === 0 || d.getDay() === 6;
}

function formatTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(s.getHours())}:${p(s.getMinutes())} – ${p(e.getHours())}:${p(e.getMinutes())}`;
}

function formatWindow(startIso: string, endIso: string) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const p = (n: number) => String(n).padStart(2, "0");
  const sameDate = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate();
  const sDate = `${p(s.getMonth() + 1)}-${p(s.getDate())}`;
  const sTime = `${p(s.getHours())}:${p(s.getMinutes())}`;
  const eDate = `${p(e.getMonth() + 1)}-${p(e.getDate())}`;
  const eTime = `${p(e.getHours())}:${p(e.getMinutes())}`;
  return sameDate ? `${sDate} ${sTime}–${eTime}` : `${sDate} ${sTime} → ${eDate} ${eTime}`;
}

function normISO(iso: string) {
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
}

const INTENSITY_KEY_MAP: Record<string, string> = {
  "low_high_token": "nightBatch.intensity.lowHighToken",
  "low_low_token": "nightBatch.intensity.lowLowToken",
  "high_concurrency": "nightBatch.intensity.highConcurrency",
};

function translateIntensity(value: string | null | undefined, t: Translate): string {
  if (!value) return "—";
  const key = INTENSITY_KEY_MAP[value];
  if (key) return t(key as TranslationKey);
  return value;
}

function formatCreatedAt(iso: string) {
  const d = new Date(normISO(iso));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describeRepeat(row: NightBatchRegistration, t: Translate, weekdayLabels: string[]): string {
  if (!row.repeat_weekdays || row.repeat_weekdays.length === 0) return t("nightBatch.noRepeat");
  const days = [...row.repeat_weekdays].sort((a, b) => a - b).map((w) => weekdayLabels[w]).join("、");
  return t("nightBatch.repeatDesc").replace("{days}", days).replace("{until}", row.repeat_until ?? "—");
}

function DeleteConfirmDialog({
  target, token, onClose, onSuccess,
}: {
  target: { mode: "single" | "series"; row: NightBatchRegistration };
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useT();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !loading) onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose, loading]);

  async function confirm() {
    setLoading(true);
    try {
      if (target.mode === "series") {
        await api.nightBatchDeleteSeries(token, target.row.series_id);
      } else {
        await api.nightBatchDelete(token, target.row.id);
      }
      toast.success(target.mode === "series" ? t("nightBatch.toast.deletedSeries") : t("nightBatch.toast.deleted"));
      onSuccess();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("nightBatch.toast.deleteFailed"));
      setLoading(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div
        className="animate-enter w-full max-w-[420px] rounded-2xl bg-card p-6"
        style={{ boxShadow: "var(--shadow-pop)" }}
      >
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-danger/10 flex items-center justify-center text-danger">
            <Trash2 className="w-4 h-4" />
          </div>
          <h3 className="m-0 font-serif text-[16px] font-medium text-foreground">
            {target.mode === "series" ? t("nightBatch.confirmSeriesTitle") : t("nightBatch.confirmSingleTitle")}
          </h3>
        </div>
        <p className="text-[14px] text-foreground leading-[1.75] m-0">
          {target.mode === "series" ? (
            <SafeHtml
              html={t("nightBatch.confirmSeriesBody").replace("{n}", String(target.row.series_total))}
            />
          ) : (
            t("nightBatch.confirmSingleBody").replace("{window}", formatWindow(target.row.start_at, target.row.end_at))
          )}
        </p>
        <div className="flex gap-2.5 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-muted-foreground border border-border hover:bg-secondary transition-colors disabled:opacity-40"
          >
            {t("nightBatch.cancel")}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-danger text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? (
              <span className="inline-flex items-center justify-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />{t("nightBatch.deleting")}
              </span>
            ) : (
              t("nightBatch.confirmDelete")
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function NightBatch() {
  const { token, authId } = useAuth();
  const { t } = useT();
  const [page, setPage] = useState(0);
  const [jumpPage, setJumpPage] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ mode: "single" | "series"; row: NightBatchRegistration } | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "calendar">("calendar");

  const [calendarRows, setCalendarRows] = useState<NightBatchRegistration[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [listModelFilter, setListModelFilter] = useState<string[]>([]);
  const [calendarModelFilter, setCalendarModelFilter] = useState<string[]>([]);
  const [listOnlyMine, setListOnlyMine] = useState(false);
  const [calendarOnlyMine, setCalendarOnlyMine] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [nowTick, setNowTick] = useState(0);
  const [showModelPopup, setShowModelPopup] = useState(false);
  const [showListModelPopup, setShowListModelPopup] = useState(false);
  const [editTarget, setEditTarget] = useState<NightBatchEditTarget | null>(null);
  const [allListRows, setAllListRows] = useState<NightBatchRegistration[]>([]);

  useEffect(() => {
    const interval = setInterval(() => setNowTick((n) => n + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    api.config().then((cfg) => {
      if (cfg.platform_timezone) initPlatformTzOffset(cfg.platform_timezone);
    }).catch(() => {});
  }, []);

  const fetchList = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await api.nightBatchList(token, {
        limit: 500,
        offset: 0,
      });
      const all = Array.isArray(data.data) ? data.data : [];
      setAllListRows(all);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("nightBatch.toast.loadListFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  const fetchCalendar = useCallback(async () => {
    if (!token) return;
    setCalendarLoading(true);
    try {
      const p = (n: number) => String(n).padStart(2, "0");
      const now = bjNow();
      const startStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
      const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + CALENDAR_DAYS + 1);
      const endStr = `${endDate.getFullYear()}-${p(endDate.getMonth() + 1)}-${p(endDate.getDate())}`;
      const data = await api.nightBatchList(token, {
        limit: 500,
        offset: 0,
        overlap_start: `${startStr}T00:00:00`,
        overlap_end: `${endStr}T12:00:00`,
      });
      setCalendarRows(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("nightBatch.toast.loadCalendarFailed"));
    } finally {
      setCalendarLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    api.models()
      .then((res) => setModels(Array.isArray(res.data) ? res.data : []))
      .catch(() => setModels([]));
  }, []);

  useEffect(() => { setPage(0); fetchList(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(0); }, [listModelFilter, listOnlyMine]);

  useEffect(() => {
    if (viewMode === "calendar") fetchCalendar();
  }, [viewMode, token, fetchCalendar]);

  useEffect(() => {
    if (viewMode === "list") { setPage(0); fetchList(); }
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredRows = useMemo(() => {
    let result = allListRows;
    if (listModelFilter.length > 0) {
      result = result.filter((r) => listModelFilter.includes(r.model_id));
    }
    if (listOnlyMine && authId) {
      result = result.filter((r) => r.creator_auth_id === authId);
    }
    return result;
  }, [allListRows, listModelFilter, listOnlyMine, authId]);

  const totalFiltered = filteredRows.length;
  const totalPages = Math.ceil(totalFiltered / PAGE_SIZE) || 1;
  const pagedRows = useMemo(() => {
    return filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }, [filteredRows, page]);

  function handlePageChange(p: number) { setPage(p); setJumpPage(""); }
  function handleJumpPage() {
    const p = parseInt(jumpPage, 10) - 1;
    if (isNaN(p) || p < 0 || p >= totalPages) { toast.error(t("nightBatch.pageError").replace("{max}", String(totalPages))); return; }
    handlePageChange(p);
  }

  const calendarDates = useMemo(() => {
    const p = (n: number) => String(n).padStart(2, "0");
    const dates: string[] = [];
    const now = bjNow();
    for (let i = 0; i < CALENDAR_DAYS; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      dates.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
    return dates;
  }, [nowTick]);

  const calendarData = useMemo(() => {
    const map: Record<string, NightBatchRegistration[]> = {};
    const filtered = calendarRows.filter((r) => {
      if (calendarModelFilter.length > 0 && !calendarModelFilter.includes(r.model_id)) return false;
      if (calendarOnlyMine && !!authId && r.creator_auth_id !== authId) return false;
      return true;
    });
    for (const r of filtered) {
      const night = nightOf(new Date(r.start_at));
      if (!map[night]) map[night] = [];
      map[night].push(r);
    }
    return map;
  }, [calendarRows, calendarModelFilter, calendarOnlyMine, authId]);

  const calendarHighlight = useMemo(() => {
    return todayBjStr();
  }, [nowTick]);

  const isToday = (dateStr: string) => dateStr === calendarHighlight;

  const currentNightStr = useMemo(() => todayBjStr(), [nowTick]);

  function refreshAfterDelete() {
    if (viewMode === "list") fetchList();
    else fetchCalendar();
  }

  function refreshAfterEdit() {
    if (viewMode === "list") fetchList();
    else fetchCalendar();
  }

  const listGrouped = useMemo(() => {
    const groups: { date: string; label: string; items: NightBatchRegistration[] }[] = [];
    const seen = new Map<string, number>();
    for (const r of pagedRows) {
      const s = new Date(r.start_at);
      const p = (n: number) => String(n).padStart(2, "0");
      const key = `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`;
      let idx = seen.get(key);
      if (idx === undefined) {
        const d = new Date(key + "T12:00:00");
        const dayOfWeek = d.getDay();
        const wd = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        idx = groups.length;
        groups.push({
          date: key,
          label: t("nightBatch.formatDateForList")
            .replace("{month}", p(d.getMonth() + 1))
            .replace("{date}", p(d.getDate()))
            .replace("{weekday}", getWeekdayLabels(t)[wd]),
          items: [],
        });
        seen.set(key, idx);
      }
      groups[idx].items.push(r);
    }
    return groups;
  }, [pagedRows, t]);

  const onlineModels = useMemo(
    () => {
      const filtered = models.filter((m) => m.status === "online");
      filtered.sort((a, b) => {
        const catA = CATEGORY_SORT_ORDER[a.category] ?? 99;
        const catB = CATEGORY_SORT_ORDER[b.category] ?? 99;
        if (catA !== catB) return catA - catB;
        const dateA = a.releaseDate || "";
        const dateB = b.releaseDate || "";
        if (dateA && dateB) return dateB.localeCompare(dateA);
        return a.name.localeCompare(b.name);
      });
      return filtered;
    },
    [models],
  );

  const groupedOnlineModels = useMemo(() => {
    const groups: { category: string; label: string; models: ModelInfo[] }[] = [];
    const order = ["flagship", "chat", "vision", "embedding", "reranker", "ocr", "lts"];
    for (const cat of order) {
      const items = onlineModels.filter((m) => m.category === cat);
      if (items.length > 0) {
        const label = categoryLabels[cat as keyof typeof categoryLabels] || cat;
        groups.push({ category: cat, label, models: items });
      }
    }
    const categorized = new Set(order);
    const rest = onlineModels.filter((m) => !categorized.has(m.category));
    if (rest.length > 0) {
      groups.push({ category: "other", label: t("common.other"), models: rest });
    }
    return groups;
  }, [onlineModels, t]);

  return (
    <ConsolePageShell className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>{t("nightBatch.pageTitle")}</h1>
          <p className="mt-3 text-[14px] text-fg leading-[1.75]">{t("nightBatch.pageSubtitle")}</p>
          <p className="mt-1 text-[14px] text-danger leading-[1.75] font-semibold">{t("nightBatch.pageTip")}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-xl border border-border bg-secondary p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] transition-colors ${viewMode === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              style={{ fontWeight: viewMode === "list" ? 600 : 400 }}
            >
              <List className="w-3.5 h-3.5" /> {t("nightBatch.listTab")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("calendar")}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] transition-colors ${viewMode === "calendar" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              style={{ fontWeight: viewMode === "calendar" ? 600 : 400 }}
            >
              <CalendarDays className="w-3.5 h-3.5" /> {t("nightBatch.calendarTab")}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-[13px] hover:opacity-90 transition-opacity"
            style={{ fontWeight: 500 }}
          >
            <Plus className="w-4 h-4" /> {t("nightBatch.registerBtn")}
          </button>
        </div>
      </div>

      {viewMode === "list" ? (
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-2.5 border-b border-border gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted-foreground font-medium">
                {t("nightBatch.listView")}
                {totalFiltered > 0 && (
                  <span className="ml-2 text-[12px] opacity-60">{t("nightBatch.totalCount").replace("{n}", String(totalFiltered))}</span>
                )}
              </span>
              <div className="flex items-center rounded-lg border border-border bg-secondary p-0.5">
                <button
                  type="button"
                  onClick={() => setListOnlyMine(false)}
                  className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                    !listOnlyMine
                      ? "bg-card text-foreground shadow-sm font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t("nightBatch.viewAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setListOnlyMine(true)}
                  className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                    listOnlyMine
                      ? "bg-card text-foreground shadow-sm font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t("nightBatch.onlyMine")}
                </button>
              </div>
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowListModelPopup(!showListModelPopup)}
                className={`model-list-filter-trigger flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] transition-colors border ${
                  listModelFilter.length > 0
                    ? "border-primary/30 bg-primary/5 text-primary font-medium"
                    : "border-border bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {listModelFilter.length === 0
                  ? t("nightBatch.allModels")
                  : listModelFilter.length === 1
                    ? onlineModels.find((m) => m.id === listModelFilter[0])?.name || listModelFilter[0]
                    : t("nightBatch.selectedModels").replace("{n}", String(listModelFilter.length))}
                <Filter className="w-3 h-3" />
              </button>
              {showListModelPopup && (
                <ModelFilterPopup
                  models={groupedOnlineModels}
                  selected={listModelFilter}
                  onToggle={(id) => setListModelFilter((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                  )}
                  onClear={() => setListModelFilter([])}
                  onClose={() => setShowListModelPopup(false)}
                />
              )}
            </div>
          </div>
          {loading ? (
            <div className="p-4 space-y-2">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="skeleton h-11 rounded-xl w-full" style={{ animationDelay: `${i * 80}ms` }} />
              ))}
            </div>
          ) : totalFiltered === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <Moon className="w-8 h-8 text-muted-foreground opacity-40 mb-1" />
              <p className="text-[15px] text-foreground" style={{ fontWeight: 500 }}>{t("nightBatch.emptyTitle")}</p>
              <p className="text-[13px] text-muted-foreground">{t("nightBatch.emptyDesc")}</p>
            </div>
          ) : (
            <div>
              {listGrouped.map((group) => (
                <div key={group.date}>
                  <div
                    className="px-5 py-2 text-[12px] font-semibold text-muted-foreground flex items-center gap-2"
                    style={{ background: "var(--secondary)", borderBottom: "1px solid var(--border)" }}
                  >
                    <Clock className="w-3 h-3" />
                    {group.label}
                    <span className="font-normal opacity-60">{t("nightBatch.sessions").replace("{n}", String(group.items.length))}</span>
                  </div>
                  {group.items.map((r) => {
                    const isExpanded = expandedId === r.id;
                    const isMine = !!authId && r.creator_auth_id === authId;
                    const color = modelColor(r.model_id);
                    return (
                      <div
                        key={r.id}
                        onClick={() => setExpandedId(isExpanded ? null : r.id)}
                        className="cursor-pointer hover:bg-secondary/60 transition-colors"
                        style={{ borderBottom: "1px solid var(--border)" }}
                      >
                        <div className="px-5 py-3 flex items-center gap-3" style={{ minHeight: 48 }}>
                          <div
                            style={{
                              width: 3,
                              height: 36,
                              borderRadius: 2,
                              background: color.text,
                              flexShrink: 0,
                              alignSelf: "stretch",
                            }}
                          />
                          <div style={{ minWidth: 120, fontWeight: 600, color: "var(--foreground)", fontSize: 13 }}>
                            {formatTimeRange(r.start_at, r.end_at)}
                          </div>
                          <span
                            className="font-serif"
                            style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 5,
                            background: color.bg,
                            color: color.text,
                            fontSize: 12,
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}>
                            {r.model_name}
                          </span>
                          <div className="font-serif font-medium" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "var(--foreground)" }}>
                            {r.description}
                          </div>
                          {r.intensity_note && (
                            <span style={{
                              display: "inline-block",
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: "var(--secondary)",
                              color: "var(--muted-foreground)",
                              fontSize: 11,
                              whiteSpace: "nowrap",
                              flexShrink: 0,
                            }}>
                              {translateIntensity(r.intensity_note, t)}
                            </span>
                          )}
                          <div className="font-serif" style={{ fontSize: 12, color: "var(--muted-foreground)", whiteSpace: "nowrap", flexShrink: 0 }}>
                            {r.project}{r.contact_name !== r.creator_name ? ` · ${r.contact_name}` : ""}
                          </div>
                          {r.series_total > 1 && (
                            <span style={{
                              display: "inline-block",
                              padding: "1px 6px",
                              borderRadius: 100,
                              background: "var(--secondary)",
                              fontSize: 11,
                              color: "var(--muted-foreground)",
                              whiteSpace: "nowrap",
                              flexShrink: 0,
                            }}>
                              {t("nightBatch.seriesTotal").replace("{n}", String(r.series_total))}
                            </span>
                          )}
                          <div style={{ color: "var(--muted-foreground)", flexShrink: 0, transition: "transform 0.15s", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>
                            <ChevronRight className="w-3.5 h-3.5" />
                          </div>
                        </div>

                        {isExpanded && (
                          <div style={{ padding: "0 20px 12px 48px" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: "6px 20px", fontSize: 12 }}>
                              {[
                                { label: t("nightBatch.label.creator"), value: r.creator_name, entity: true },
                                { label: t("nightBatch.label.contact"), value: r.contact_name, entity: true },
                                { label: t("nightBatch.label.department"), value: r.project || "—", entity: true },
                                { label: t("nightBatch.label.intensity"), value: r.intensity_note || "—", entity: false },
                                { label: t("nightBatch.label.repeatRule"), value: describeRepeat(r, t, getWeekdayLabels(t)), entity: false },
                                { label: t("nightBatch.label.registerTime"), value: formatCreatedAt(r.created_at), entity: false },
                              ].map(({ label, value, entity }) => (
                                <div key={label}>
                                  <span style={{ color: "var(--muted-foreground)" }}>{label}{t("nightBatch.labelColon")}</span>
                                  <span className={entity ? "font-serif font-medium" : undefined} style={{ color: "var(--foreground)" }}>{value}</span>
                                </div>
                              ))}
                            </div>
                            {isMine && (
                              <div className="flex items-center gap-2 mt-2">
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setEditTarget({ mode: "single", reg: r }); }}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-card transition-colors text-muted-foreground"
                                >
                                  <Pencil className="w-3 h-3" /> {t("nightBatch.editSingle")}
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setDeleteTarget({ mode: "single", row: r }); }}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-card transition-colors text-muted-foreground"
                                >
                                  <Trash2 className="w-3 h-3" /> {t("nightBatch.deleteSingle")}
                                </button>
                                {r.series_total > 1 && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setEditTarget({ mode: "series", reg: r }); }}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-card transition-colors text-primary"
                                  >
                                    <Pencil className="w-3 h-3" /> {t("nightBatch.editSeries")}
                                  </button>
                                )}
                                {r.series_total > 1 && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setDeleteTarget({ mode: "series", row: r }); }}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-card transition-colors text-danger"
                                  >
                                    <Trash2 className="w-3 h-3" /> {t("nightBatch.deleteSeriesCount").replace("{n}", String(r.series_total))}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-border flex-wrap gap-2">
              <p className="text-[12px] text-muted-foreground">
                {t("nightBatch.pagination").replace("{page}", String(page + 1)).replace("{totalPages}", String(totalPages)).replace("{total}", String(totalFiltered))}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button disabled={page === 0} onClick={() => handlePageChange(page - 1)}
                  className="px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  {t("nightBatch.prevPage")}
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const p = totalPages <= 5 ? i : page < 3 ? i : page > totalPages - 3 ? totalPages - 5 + i : page - 2 + i;
                  return (
                    <button key={p} onClick={() => handlePageChange(p)}
                      className="w-8 h-8 rounded-lg text-[12px] transition-colors"
                      style={{ background: p === page ? "var(--primary)" : "transparent", color: p === page ? "var(--primary-foreground)" : "var(--foreground)", fontWeight: p === page ? 600 : 400, border: p === page ? "none" : "1px solid var(--border)" }}>{p + 1}</button>
                  );
                })}
                <button disabled={page >= totalPages - 1} onClick={() => handlePageChange(page + 1)}
                  className="px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  {t("nightBatch.nextPage")}
                </button>
                <div className="flex items-center gap-1 ml-2">
                  <span className="text-[12px] text-muted-foreground">{t("nightBatch.jumpTo")}</span>
                  <input type="number" min={1} max={totalPages} value={jumpPage}
                    onChange={(e) => setJumpPage(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleJumpPage()}
                    placeholder={t("nightBatch.pagePlaceholder")}
                    className="w-14 px-2 py-1 rounded-lg text-[12px] border border-border focus:outline-none focus:ring-2 focus:ring-brand/20 text-center" />
                  <button onClick={handleJumpPage}
                    className="px-2 py-1 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors">{t("nightBatch.jump")}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-2.5 border-b border-border gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted-foreground font-medium">
                {t("nightBatch.calendarView").replace("{n}", String(CALENDAR_DAYS))}
                {calendarRows.length > 0 && (
                  <span className="ml-2 text-[12px] opacity-60">{t("nightBatch.totalRegs").replace("{n}", String(calendarRows.length))}</span>
                )}
              </span>
              <div className="flex items-center rounded-lg border border-border bg-secondary p-0.5">
                <button
                  type="button"
                  onClick={() => setCalendarOnlyMine(false)}
                  className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                    !calendarOnlyMine
                      ? "bg-card text-foreground shadow-sm font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t("nightBatch.viewAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setCalendarOnlyMine(true)}
                  className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                    calendarOnlyMine
                      ? "bg-card text-foreground shadow-sm font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t("nightBatch.onlyMine")}
                </button>
              </div>
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowModelPopup(!showModelPopup)}
                className={`model-filter-trigger flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] transition-colors border ${
                  calendarModelFilter.length > 0
                    ? "border-primary/30 bg-primary/5 text-primary font-medium"
                    : "border-border bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {calendarModelFilter.length === 0
                  ? t("nightBatch.allModels")
                  : calendarModelFilter.length === 1
                    ? onlineModels.find((m) => m.id === calendarModelFilter[0])?.name || calendarModelFilter[0]
                    : t("nightBatch.selectedModels").replace("{n}", String(calendarModelFilter.length))}
                <Filter className="w-3 h-3" />
              </button>
              {showModelPopup && (
                <ModelFilterPopup
                  models={groupedOnlineModels}
                  selected={calendarModelFilter}
                  onToggle={(id) => setCalendarModelFilter((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                  )}
                  onClear={() => setCalendarModelFilter([])}
                  onClose={() => setShowModelPopup(false)}
                />
              )}
            </div>
          </div>
          {calendarLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="skeleton h-11 rounded-xl w-full" style={{ animationDelay: `${i * 80}ms` }} />
              ))}
            </div>
          ) : (
            <CalendarGrid
              dates={calendarDates}
              data={calendarData}
              slots={CALENDAR_SLOTS}
              hourLabels={HOUR_LABELS}
              isToday={isToday}
              currentNightStr={currentNightStr}
              authId={authId}
              nowIndex={nowSlotIndex()}
              nowTick={nowTick}
              onDelete={(r) => setDeleteTarget({ mode: "single", row: r })}
              onDeleteSeries={(r) => setDeleteTarget({ mode: "series", row: r })}
              onEdit={(r) => setEditTarget({ mode: "single", reg: r })}
              onEditSeries={(r) => setEditTarget({ mode: "series", reg: r })}
            />
          )}
        </div>
      )}

      <NightBatchModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={() => { setShowCreateModal(false); setPage(0); fetchList(); if (viewMode === "calendar") fetchCalendar(); }}
      />

      {editTarget && (
        <NightBatchEditDialog
          target={editTarget}
          token={token}
          onClose={() => setEditTarget(null)}
          onSuccess={() => refreshAfterEdit()}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmDialog
          target={deleteTarget}
          token={token}
          onClose={() => setDeleteTarget(null)}
          onSuccess={() => refreshAfterDelete()}
        />
      )}
    </ConsolePageShell>
  );
}

function CalendarGrid({
  dates,
  data,
  slots,
  hourLabels,
  isToday,
  currentNightStr,
  authId,
  nowIndex,
  nowTick,
  onDelete,
  onDeleteSeries,
  onEdit,
  onEditSeries,
}: {
  dates: string[];
  data: Record<string, NightBatchRegistration[]>;
  slots: { hour: number; minute: number; label: string }[];
  hourLabels: { label: string; colSpan: number }[];
  isToday: (d: string) => boolean;
  currentNightStr: string;
  authId: string;
  nowIndex: number;
  nowTick: number;
  onDelete: (r: NightBatchRegistration) => void;
  onDeleteSeries: (r: NightBatchRegistration) => void;
  onEdit: (r: NightBatchRegistration) => void;
  onEditSeries: (r: NightBatchRegistration) => void;
}) {
  const { t } = useT();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [detailReg, setDetailReg] = useState<NightBatchRegistration | null>(null);
  const [tooltipReg, setTooltipReg] = useState<NightBatchRegistration | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const dateRows = useMemo(() => {
    return dates.map((dateStr) => {
      const regs = data[dateStr] || [];
      const sorted = [...regs].sort(
        (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
      );

      const lanes: (string | null)[][] = [];
      const regLaneIdx: Record<string, number> = {};
      let maxLanes = 0;

      for (const reg of sorted) {
        const s = new Date(reg.start_at);
        const e = new Date(reg.end_at);
        const sIdx = slotIndex(s.getHours(), s.getMinutes());
        let eIdx = slotIndex(e.getHours(), e.getMinutes());
        if (e.getHours() * 60 + e.getMinutes() <= s.getHours() * 60 + s.getMinutes()) {
          eIdx = slots.length;
        }
        eIdx = Math.min(eIdx, slots.length);

        let lane = -1;
        laneSearch: for (let li = 0; ; li++) {
          if (li >= lanes.length) {
            lanes.push(new Array(slots.length).fill(null));
          }
          for (let si = sIdx; si < eIdx; si++) {
            if (lanes[li][si] != null) continue laneSearch;
          }
          lane = li;
          break;
        }

        for (let si = sIdx; si < eIdx; si++) {
          lanes[lane][si] = reg.id;
        }

        regLaneIdx[reg.id] = lane;
        maxLanes = Math.max(maxLanes, lane + 1);
      }

      maxLanes = Math.max(maxLanes, 1);

      const laneCells: { reg: NightBatchRegistration | null; colSpan: number; isFirst: boolean }[][] = [];
      for (let li = 0; li < maxLanes; li++) {
        const cells: { reg: NightBatchRegistration | null; colSpan: number; isFirst: boolean }[] = [];
        let i = 0;
        while (i < slots.length) {
          const id = lanes[li] ? lanes[li][i] : null;
          if (!id) {
            cells.push({ reg: null, colSpan: 1, isFirst: false });
            i++;
          } else {
            let span = 1;
            while (i + span < slots.length && lanes[li]?.[i + span] === id) span++;
            const reg = sorted.find((r) => r.id === id)!;
            cells.push({ reg, colSpan: span, isFirst: true });
            i += span;
          }
        }
        laneCells.push(cells);
      }

      const regCount = sorted.length;

      return { dateStr, sorted, regCount, weekend: isWeekend(dateStr), maxLanes, laneCells };
    });
  }, [dates, data, slots, nowTick]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 260px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
            <tr>
              <th
                style={{
                  padding: "3px 4px",
                  textAlign: "center",
                  fontWeight: 600,
                  color: "var(--muted-foreground)",
                  whiteSpace: "nowrap",
                  background: "var(--card)",
                  borderBottom: "2px solid var(--border)",
                  position: "sticky",
                  left: 0,
                  zIndex: 3,
                  minWidth: 50,
                  verticalAlign: "bottom",
                }}
              >
                {t("nightBatch.dateColumn")}
              </th>
              {hourLabels.map((h, i) => (
                <th
                  key={i}
                  colSpan={h.colSpan}
                  style={{
                    padding: "6px 2px",
                    textAlign: "center",
                    fontWeight: 600,
                    color: "var(--muted-foreground)",
                    whiteSpace: "nowrap",
                    background: "var(--card)",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 11,
                  }}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dateRows.map(({ dateStr, sorted, regCount, weekend, maxLanes, laneCells }) => {
              const today = isToday(dateStr);
              const isCurrentNight = dateStr === currentNightStr;
              const showNow = isCurrentNight && nowIndex >= 0 && nowIndex < slots.length;
              return (
                <Fragment key={dateStr}>
                  {Array.from({ length: maxLanes }).map((_, laneIdx) => {
                    const cells = laneCells[laneIdx];
                    const isFirstLane = laneIdx === 0;
                    return (
                      <tr
                        key={`${dateStr}-${laneIdx}`}
                        style={{
                          background: today
                            ? "var(--brand-soft, rgba(59,130,246,0.06))"
                            : weekend
                              ? "var(--secondary)"
                              : undefined,
                          borderBottom: laneIdx === maxLanes - 1 ? "1px solid var(--border)" : undefined,
                          height: 44,
                        }}
                      >
                        {isFirstLane && (
                          <td
                            rowSpan={maxLanes}
                            style={{
                              padding: "3px 4px",
                              whiteSpace: "nowrap",
                              fontWeight: today ? 700 : 500,
                              color: today ? "var(--primary)" : "var(--foreground)",
                              background: "inherit",
                              position: "sticky",
                              left: 0,
                              zIndex: 1,
                              borderRight: "1px solid var(--border)",
                              verticalAlign: "middle",
                              textAlign: "center",
                            }}
                          >
                            <div style={{ fontSize: 11, lineHeight: 1.2 }}>{formatDateLabel(dateStr, t, getWeekdayLabels(t))}{today ? <span style={{ display: "inline-block", padding: "0px 4px", borderRadius: 100, background: "var(--primary)", color: "var(--primary-foreground)", fontSize: 9, fontWeight: 600, lineHeight: "14px", marginLeft: 4 }}>{t("nightBatch.today")}</span> : null}</div>
                            {regCount > 0 && (
                              <div style={{ fontSize: 9, color: "var(--muted-foreground)", marginTop: 3 }}>
                                {t("nightBatch.sessions").replace("{n}", String(regCount))}
                              </div>
                            )}
                          </td>
                        )}
                        {cells.map((cell, idx) => {
                          if (!cell.reg) {
                            return (
                              <td
                                key={idx}
                                style={{
                                  padding: "1px",
                                  borderRight: "1px solid var(--border)",
                                  opacity: 0.06,
                                  position: "relative",
                                }}
                              >
                                {showNow && idx === nowIndex && (
                                  <div
                                    style={{
                                      position: "absolute",
                                      left: "50%",
                                      top: 0,
                                      bottom: 0,
                                      width: 2,
                                      background: "#ef4444",
                                      transform: "translateX(-50%)",
                                      zIndex: 2,
                                      borderRadius: 1,
                                    }}
                                  />
                                )}
                              </td>
                            );
                          }
                          if (!cell.isFirst) return null;
                          const reg = cell.reg;
                          const color = modelColor(reg.model_id);
                          const isMine = !!authId && reg.creator_auth_id === authId;
                          const isHovered = hoveredId === reg.id;
                          return (
                            <td
                              key={idx}
                              colSpan={cell.colSpan}
                              style={{ padding: "1px", position: "relative" }}
                              onMouseEnter={(e) => {
                                setHoveredId(reg.id);
                                setTooltipReg(reg);
                                setTooltipPos({ x: e.clientX, y: e.clientY });
                              }}
                              onMouseLeave={() => {
                                setHoveredId(null);
                                setTooltipReg(null);
                              }}
                              onMouseMove={(e) => {
                                if (tooltipReg === reg) {
                                  setTooltipPos({ x: e.clientX, y: e.clientY });
                                }
                              }}
                            >
                              <div
                                onClick={() => setDetailReg(reg)}
                                style={{
                                  background: color.bg,
                                  color: color.text,
                                  borderRadius: 6,
                                  padding: "4px 6px",
                                  fontSize: 11,
                                  lineHeight: 1.4,
                                  cursor: "pointer",
                                  border: isHovered ? `1.5px solid ${color.text}` : "1.5px solid transparent",
                                  transition: "border-color 0.15s, box-shadow 0.15s",
                                  boxShadow: isHovered ? "0 1px 4px rgba(0,0,0,0.1)" : undefined,
                                }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 1 }}>
                                  <span
                                    className="font-serif"
                                    style={{
                                    display: "inline-block",
                                    padding: "0px 4px",
                                    borderRadius: 3,
                                    background: color.text,
                                    color: "#fff",
                                    fontSize: 9,
                                    fontWeight: 600,
                                    lineHeight: "14px",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {reg.model_name}
                                  </span>
                                  <span style={{ fontSize: 9, fontWeight: 600, color: color.text, opacity: 0.85, whiteSpace: "nowrap" }}>
                                    {new Date(reg.start_at).getHours().toString().padStart(2, "0")}:{new Date(reg.start_at).getMinutes().toString().padStart(2, "0")}
                                  </span>
                                </div>
                                <div className="font-serif" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, fontWeight: 500 }}>
                                  {reg.description}
                                </div>
                              </div>
                              {isMine && isHovered && (
                                <div
                                  style={{
                                    position: "absolute",
                                    top: "100%",
                                    left: 0,
                                    zIndex: 10,
                                    display: "flex",
                                    gap: 2,
                                    marginTop: 1,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onEdit(reg); }}
                                    className="px-1.5 py-0.5 rounded text-[9px] border border-border bg-card hover:bg-secondary transition-colors text-muted-foreground whitespace-nowrap"
                                  >
                                    {t("nightBatch.edit")}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onDelete(reg); }}
                                    className="px-1.5 py-0.5 rounded text-[9px] border border-border bg-card hover:bg-secondary transition-colors text-muted-foreground whitespace-nowrap"
                                  >
                                    {t("nightBatch.deleteSingle")}
                                  </button>
                                  {reg.series_total > 1 && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); onEditSeries(reg); }}
                                      className="px-1.5 py-0.5 rounded text-[9px] border border-border bg-card hover:bg-secondary transition-colors text-primary whitespace-nowrap"
                                    >
                                      {t("nightBatch.editSeries")}
                                    </button>
                                  )}
                                  {reg.series_total > 1 && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); onDeleteSeries(reg); }}
                                      className="px-1.5 py-0.5 rounded text-[9px] border border-border bg-card hover:bg-secondary transition-colors text-danger whitespace-nowrap"
                                    >
                                      {t("nightBatch.deleteSeries")}
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {tooltipReg && createPortal(
        <div
          style={{
            position: "fixed",
            left: tooltipPos.x + 12,
            top: tooltipPos.y + 12,
            zIndex: 9998,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "8px 12px",
            boxShadow: "var(--shadow-pop)",
            fontSize: 12,
            lineHeight: 1.6,
            maxWidth: 260,
            pointerEvents: "none",
            opacity: 0,
            animation: "night-tooltip-in 0.12s 1s forwards",
          }}
        >
          <div className="font-serif font-medium" style={{ color: "var(--foreground)", marginBottom: 3 }}>{tooltipReg.description}</div>
          <div style={{ color: "var(--muted-foreground)", fontSize: 11 }}>{t("nightBatch.tooltip.intensity")}{tooltipReg.intensity_note || t("nightBatch.tooltip.unspecified")}</div>
          <div style={{ color: "var(--muted-foreground)", fontSize: 11 }}>{t("nightBatch.tooltip.time")}{formatTimeRange(tooltipReg.start_at, tooltipReg.end_at)}</div>
          <div className="font-serif" style={{ color: "var(--muted-foreground)", fontSize: 11 }}>{tooltipReg.project || "—"} · {tooltipReg.contact_name}</div>
          <div style={{ color: "var(--muted-foreground)", fontSize: 10, marginTop: 2, opacity: 0.6 }}>{t("nightBatch.tooltip.clickDetail")}</div>
        </div>,
        document.body,
      )}

      {detailReg && (
        <DetailPopover
          reg={detailReg}
          authId={authId}
          onClose={() => setDetailReg(null)}
          onDelete={(r) => { setDetailReg(null); onDelete(r); }}
          onDeleteSeries={(r) => { setDetailReg(null); onDeleteSeries(r); }}
          onEdit={(r) => { setDetailReg(null); onEdit(r); }}
          onEditSeries={(r) => { setDetailReg(null); onEditSeries(r); }}
        />
      )}
    </>
  );
}

function DetailPopover({
  reg,
  authId,
  onClose,
  onDelete,
  onDeleteSeries,
  onEdit,
  onEditSeries,
}: {
  reg: NightBatchRegistration;
  authId: string;
  onClose: () => void;
  onDelete: (r: NightBatchRegistration) => void;
  onDeleteSeries: (r: NightBatchRegistration) => void;
  onEdit: (r: NightBatchRegistration) => void;
  onEditSeries: (r: NightBatchRegistration) => void;
}) {
  const { t } = useT();
  const isMine = !!authId && reg.creator_auth_id === authId;
  const color = modelColor(reg.model_id);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="animate-enter bg-card rounded-2xl w-full max-w-[380px] overflow-hidden"
        style={{ boxShadow: "var(--shadow-pop)" }}
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-3 h-10 rounded-full"
              style={{ background: color.text }}
            />
            <div>
              <h3 className="font-serif text-[15px] font-medium text-foreground">{reg.description}</h3>
              <p className="text-[11px] text-muted-foreground">{formatWindow(reg.start_at, reg.end_at)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.label.model")}</div>
              <div className="font-serif" style={{ display: "inline-block", padding: "2px 8px", borderRadius: 6, background: color.bg, color: color.text, fontSize: 12, fontWeight: 500 }}>{reg.model_name}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.label.project")}</div>
              <div className="font-serif font-medium text-foreground">{reg.description}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.label.contact")}</div>
              <div className="font-serif font-medium text-foreground">{reg.contact_name}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.label.intensity")}</div>
              <div className="text-foreground">{translateIntensity(reg.intensity_note, t)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.label.repeatRule")}</div>
              <div className="text-foreground">{describeRepeat(reg, t, getWeekdayLabels(t))}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.label.department")}</div>
              <div className="text-foreground">{reg.project || "—"}</div>
            </div>
          </div>
          {reg.series_total > 1 && (
            <div style={{ padding: "2px 8px", borderRadius: 100, background: "var(--secondary)", fontSize: 11, color: "var(--muted-foreground)", display: "inline-block" }}>
              {t("nightBatch.seriesBadge").replace("{n}", String(reg.series_total))}
            </div>
          )}
          {isMine && (
            <div className="flex items-center gap-2 pt-2 border-t border-border flex-wrap">
              <button
                type="button"
                onClick={() => { onEdit(reg); onClose(); }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors text-muted-foreground"
              >
                <Pencil className="w-3 h-3" /> {t("nightBatch.editSingle")}
              </button>
              {reg.series_total > 1 && (
                <button
                  type="button"
                  onClick={() => { onEditSeries(reg); onClose(); }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors text-primary"
                >
                  <Pencil className="w-3 h-3" /> {t("nightBatch.editSeries")}
                </button>
              )}
              <button
                type="button"
                onClick={() => onDelete(reg)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors text-muted-foreground"
              >
                <Trash2 className="w-3 h-3" /> {t("nightBatch.deleteSingle")}
              </button>
              {reg.series_total > 1 && (
                <button
                  type="button"
                  onClick={() => onDeleteSeries(reg)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] border border-border hover:bg-secondary transition-colors text-danger"
                >
                  <Trash2 className="w-3 h-3" /> {t("nightBatch.deleteSeries")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModelFilterPopup({
  models,
  selected,
  onToggle,
  onClear,
  onClose,
}: {
  models: { category: string; label: string; models: ModelInfo[] }[];
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { t } = useT();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".model-filter-popup") && !target.closest(".model-filter-trigger") && !target.closest(".model-list-filter-trigger")) {
        onClose();
      }
    };
    setTimeout(() => document.addEventListener("click", handler), 0);
    return () => document.removeEventListener("click", handler);
  }, [onClose]);

  const allSelected = selected.length === 0;

  return (
    <div
      className="model-filter-popup absolute right-0 top-full mt-1 z-50 bg-card rounded-xl border border-border overflow-hidden"
      style={{ boxShadow: "var(--shadow-pop)", minWidth: 240, maxHeight: 360, overflowY: "auto" }}
    >
      <button
        type="button"
        onClick={onClear}
        className={`w-full text-left px-4 py-2.5 text-[12px] transition-colors hover:bg-secondary flex items-center gap-2 ${
          allSelected ? "bg-primary/5 text-primary font-semibold" : "text-foreground"
        }`}
      >
        <span
          style={{
            width: 14, height: 14, borderRadius: 3,
            border: `1.5px solid ${allSelected ? "var(--primary)" : "var(--border)"}`,
            background: allSelected ? "var(--primary)" : "transparent",
            display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}
        >
          {allSelected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="var(--primary-foreground)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </span>
        {t("nightBatch.allModels")}
      </button>
      {models.map((group) => (
        <div key={group.category}>
          <div className="px-4 py-1 text-[10px] font-semibold text-muted-foreground bg-secondary/50">
            {group.label}
          </div>
          {group.models.map((m) => {
            const active = selected.includes(m.id);
            const color = modelColor(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onToggle(m.id)}
                className="w-full text-left px-4 py-2 text-[12px] transition-colors hover:bg-secondary flex items-center gap-2 text-foreground"
              >
                <span
                  style={{
                    width: 14, height: 14, borderRadius: 3,
                    border: `1.5px solid ${active ? color.text : "var(--border)"}`,
                    background: active ? color.text : "transparent",
                    display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}
                >
                  {active && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  )}
                </span>
                <span className="font-serif font-medium">{m.name}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
