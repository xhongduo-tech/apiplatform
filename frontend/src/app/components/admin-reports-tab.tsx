import { useState, useRef, useMemo, type RefObject, type ReactNode } from "react";
import {
  Loader2, Download, FileText, Activity, TrendingUp, AlertTriangle,
  CheckCircle2, Sparkles, ArrowUpRight, ArrowDownRight, Clock, Cpu,
  Database, Zap, Server, ShieldAlert, Target, Lightbulb, Eye, BarChart3,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, PieChart, Pie, Cell,
} from "recharts";
import { toast } from "sonner";
import { API_BASE, authHeaders } from "./admin-tab-utils";
import {
  downloadElementAsPdf,
  downloadReportJson,
  downloadReportMarkdown,
  reportPdfFilename,
} from "./admin-report-pdf";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";

export type ReportDetailData = {
  id: string; kind: string; label: string; health: string;
  period_start: string | null; period_end: string | null; generated_at: string | null;
  requests: number; error_rate: number; total_tokens: number; cost: number;
  health_score?: number; summary_md?: string;
  metrics?: Record<string, any>;
};

const REPORT_KIND_KEYS = [
  { key: "daily", labelKey: "report.kind.daily" as TranslationKey, descKey: "report.kind.daily.desc" as TranslationKey },
  { key: "weekly", labelKey: "report.kind.weekly" as TranslationKey, descKey: "report.kind.weekly.desc" as TranslationKey },
  { key: "monthly", labelKey: "report.kind.monthly" as TranslationKey, descKey: "report.kind.monthly.desc" as TranslationKey },
  { key: "quarterly", labelKey: "report.kind.quarterly" as TranslationKey, descKey: "report.kind.quarterly.desc" as TranslationKey },
  { key: "yearly", labelKey: "report.kind.yearly" as TranslationKey, descKey: "report.kind.yearly.desc" as TranslationKey },
  { key: "cumulative", labelKey: "report.kind.cumulative" as TranslationKey, descKey: "report.kind.cumulative.desc" as TranslationKey },
] as const;

export function useReportKinds(t: (key: TranslationKey) => string) {
  return useMemo(() => REPORT_KIND_KEYS.map((k) => ({
    key: k.key,
    label: t(k.labelKey),
    desc: t(k.descKey),
  })), [t]);
}

export function useKindLabel(t: (key: TranslationKey) => string): Record<string, string> {
  const kinds = useReportKinds(t);
  return useMemo(() => Object.fromEntries(kinds.map((k) => [k.key, k.label])), [kinds]);
}

const CHART_COLORS = [
  "#5B8DEF", "#E87461", "#7BC47F", "#F0B954", "#9B8EC4",
  "#5BC0BE", "#D47DAA", "#7A9E7E",
];

function useHealthMeta(t: (key: TranslationKey) => string) {
  return useMemo(() => ({
    ok: { label: t("report.health.ok"), color: "var(--ok)", bg: "rgba(34,197,94,0.1)" },
    warning: { label: t("report.health.warning"), color: "var(--warn)", bg: "rgba(234,179,8,0.1)" },
    critical: { label: t("report.health.critical"), color: "var(--danger)", bg: "rgba(239,68,68,0.1)" },
  } as Record<string, { label: string; color: string; bg: string }>), [t]);
}

function fmtStr(template: string, replacements: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(replacements[key] ?? `{${key}}`));
}

/* ─── Arena-style donut chart (pure SVG) ─── */
function ArenaDonut({
  slices, size = 340, outerR = 140, innerR = 82,
  centerLabel, centerValue, centerSub,
  legendTitle = "",
  footnote,
}: {
  slices: { name: string; value: number; color: string; suffix?: string }[];
  size?: number;
  outerR?: number;
  innerR?: number;
  centerLabel?: string;
  centerValue: string;
  centerSub?: string;
  legendTitle?: string;
  footnote?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const total = slices.reduce((s, d) => s + d.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const gapAngle = (Math.PI / 180) * 1.8;
  const active = hovered !== null ? slices[hovered] : null;
  const activePct = active ? (active.value / total) * 100 : 0;

  let accAngle = -Math.PI / 2;
  const arcs = slices.map((d, i) => {
    const pct = total > 0 ? d.value / total : 0;
    const angle = pct * Math.PI * 2 - gapAngle;
    const startAngle = accAngle + gapAngle / 2;
    const endAngle = accAngle + gapAngle / 2 + angle;
    accAngle += pct * Math.PI * 2;
    const isActive = hovered === i;
    const isDimmed = hovered !== null && !isActive;
    const r = isActive ? outerR + 5 : outerR;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + innerR * Math.cos(endAngle);
    const iy1 = cy + innerR * Math.sin(endAngle);
    const ix2 = cx + innerR * Math.cos(startAngle);
    const iy2 = cy + innerR * Math.sin(startAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const path = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      "Z",
    ].join(" ");
    return { d, i, path, isDimmed };
  });

  return (
    <div className="rounded-2xl border border-border/30 bg-white p-8 shadow-sm dark:bg-card">
      <div className="flex flex-col items-center lg:flex-row lg:items-center lg:gap-10">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
            {arcs.map(({ d, i, path, isDimmed }) => (
              <path
                key={i}
                d={path}
                fill={d.color}
                opacity={isDimmed ? 0.28 : 1}
                style={{ transition: "opacity 0.22s ease, d 0.22s ease", cursor: "pointer" }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            {active ? (
              <>
                <p className="max-w-[160px] truncate text-center font-serif text-[13px] leading-tight">{active.name}</p>
                <p className="mt-1 text-[32px] font-bold leading-none tabular-nums">{activePct.toFixed(1)}%</p>
                <p className="mt-1 text-[11px] text-fg-muted tabular-nums">{fmtN(active.value)}{active.suffix ? ` ${active.suffix}` : ""}</p>
              </>
            ) : (
              <>
                {centerLabel && <p className="text-[12px] uppercase tracking-[0.1em] text-fg-subtle">{centerLabel}</p>}
                <p className="mt-1 font-serif text-[30px] font-bold leading-none tabular-nums">{centerValue}</p>
                {centerSub && <p className="mt-1 text-[11px] text-fg-muted">{centerSub}</p>}
              </>
            )}
          </div>
        </div>
        <div className="mt-4 w-full max-w-[220px] lg:mt-0">
          <p className="mb-3 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">{legendTitle}</p>
          <div className="space-y-2">
            {slices.map((d, i) => {
              const pct = total > 0 ? (d.value / total) * 100 : 0;
              const isActive = hovered === i;
              const isDimmed = hovered !== null && !isActive;
              return (
                <div
                  key={i}
                  className="flex cursor-pointer items-center gap-2.5"
                  style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s ease" }}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: d.color }} />
                  <span className="min-w-0 flex-1 truncate font-serif text-[13px] leading-tight text-fg">{d.name}</span>
                  <span className="shrink-0 text-[13px] tabular-nums text-fg-muted">{pct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {footnote && (
        <p className="mt-4 text-center font-serif text-[12px] italic text-fg-subtle">
          {footnote}
        </p>
      )}
    </div>
  );
}

/* ─── Arena-style horizontal ranking bars ─── */
function ArenaHBar({
  title, subtitle, items, color = "#E87461", valueFormatter, footnote,
}: {
  title: string; subtitle: string;
  items: { name: string; value: number; sub?: string }[];
  color?: string; valueFormatter?: (v: number) => string;
  footnote?: string;
}) {
  const max = items.length > 0 ? Math.max(...items.map((i) => i.value)) : 1;
  const fmt = valueFormatter ?? fmtN;
  return (
    <div className="rounded-2xl border border-border/30 bg-white p-8 shadow-sm dark:bg-card">
      <div className="mb-6 text-center">
        <h3 className="font-serif text-[28px] font-normal leading-tight">{title}</h3>
        <p className="mt-1.5 font-serif text-[15px] text-fg-muted">{subtitle}</p>
      </div>
      <div className="space-y-3">
        {items.map((item) => {
          const w = max > 0 ? (item.value / max) * 100 : 0;
          return (
            <div key={item.name} className="flex items-center gap-4">
              <span className="w-[180px] shrink-0 truncate text-right font-serif text-[14px] font-medium">{item.name}</span>
              <div className="flex-1">
                <div className="h-[26px] overflow-hidden rounded-[4px] bg-bg-soft/60">
                  <div className="h-full rounded-[4px] transition-all duration-700" style={{ width: `${Math.max(w, item.value > 0 ? 1 : 0)}%`, background: color }} />
                </div>
              </div>
              <span className="w-[100px] shrink-0 text-right font-mono text-[15px] tabular-nums font-medium">{fmt(item.value)}</span>
            </div>
          );
        })}
      </div>
      {footnote && (
        <p className="mt-6 text-center font-serif text-[12px] italic text-fg-subtle">{footnote}</p>
      )}
    </div>
  );
}

function fmtN(n: number): string {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

function fmtDelta(d: number | null | undefined, withPlus = true): string {
  if (d == null) return "—";
  const sign = d > 0 ? (withPlus ? "+" : "↑ ") : d < 0 ? "↓ " : "";
  return `${sign}${Math.abs(d).toFixed(1)}%`;
}

function fmtCost(v: number): string {
  if (v == null) return "—";
  return v >= 1 ? `¥${v.toFixed(2)}` : `¥${(v * 100).toFixed(2)}分`;
}

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/30 bg-card px-3 py-2 shadow-xl text-[12px]">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {typeof p.value === "number" ? fmtN(p.value) : p.value}
        </p>
      ))}
    </div>
  );
}

export async function adminReportFetch<T>(token: string, path: string, init?: RequestInit, sessionExpiredMsg?: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(token), "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("apiplatform-admin-expired"));
    throw new Error(sessionExpiredMsg ?? "Session expired");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function HealthRing({ score, health, size = 120 }: { score: number; health: string; size?: number }) {
  const { t } = useT();
  const HEALTH_META = useHealthMeta(t);
  const meta = HEALTH_META[health] || HEALTH_META.ok;
  const r = (size - 16) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;

  const latencyScore = Math.min(100, Math.max(0, 100 - Math.round((meta.color === "var(--danger)" ? 30 : 0))));
  const errorScore = Math.min(100, Math.max(0, 100 - Math.round((meta.color === "var(--danger)" ? 40 : 5))));
  const availabilityScore = Math.min(100, Math.max(0, score));

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={10} />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="white" strokeWidth={10} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset}
          />
        </svg>
        <div className="absolute text-center">
          <div className="text-[28px] font-bold leading-none text-white">{score}</div>
          <div className="mt-1 text-[10px] uppercase tracking-wider text-white/70">Health</div>
        </div>
      </div>
      <div className="w-full space-y-1.5 px-1">
        {[
          { label: t("report.latency.avgP50"), s: latencyScore },
          { label: t("report.table.errorRate"), s: errorScore },
          { label: t("report.kpi.successRate"), s: availabilityScore },
        ].map(({ label, s }) => (
          <div key={label} className="flex items-center gap-2 text-[10px] text-white/70">
            <span className="w-10 shrink-0">{label}</span>
            <div className="flex-1 h-1 rounded-full bg-white/15 overflow-hidden">
              <div className="h-full rounded-full bg-white/80" style={{ width: `${s}%` }} />
            </div>
            <span className="w-7 text-right tabular-nums">{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendArrow({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  const positive = value >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${positive ? "text-ok" : "text-danger"}`}>
      {positive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {fmtDelta(value)}
    </span>
  );
}

function Sparkline({ data, color = "#5B8DEF", height = 32 }: { data: number[]; color?: string; height?: number }) {
  if (!data.length) return null;
  const w = 120;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const areaPath = `M0,${height} L${points.join(" L")} L${w},${height} Z`;
  const linePath = `M${points.join(" L")}`;
  return (
    <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} className="mt-2">
      <defs>
        <linearGradient id={`spk-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#spk-${color.replace("#", "")})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function HourlyHeatmap({ byHour }: { byHour: any[] }) {
  if (!byHour.length) return null;
  const { t } = useT();
  const max = Math.max(...byHour.map((h) => h.requests || 0), 1);
  const groups: { label: string; hours: any[] }[] = [
    { label: t("report.hourly.midnight"), hours: byHour.slice(0, 7) },
    { label: t("report.hourly.morning"), hours: byHour.slice(7, 13) },
    { label: t("report.hourly.afternoon"), hours: byHour.slice(13, 19) },
    { label: t("report.hourly.evening"), hours: byHour.slice(19, 24) },
  ];
  return (
    <div>
      <div className="mb-3 grid grid-cols-[80px_repeat(6,1fr)] gap-1 text-[9px] text-fg-subtle">
        <div />
        {[0, 1, 2, 3, 4, 5, 6].map((h) => {
          const firstGroup = groups.find((g) => g.hours[h]) || groups[0];
          const hour = firstGroup.hours[h]?.hour ?? h;
          return <div key={h} className="text-center tabular-nums">{String(hour).padStart(2, "0")}</div>;
        })}
      </div>
      {groups.map((g) => (
        <div key={g.label} className="mb-1 grid grid-cols-[80px_repeat(6,1fr)] gap-1 items-center">
          <div className="text-[10px] font-medium text-fg-muted pr-2">{g.label}</div>
          {g.hours.map((h) => {
            const v = h.requests || 0;
            const intensity = max > 0 ? v / max : 0;
            const isPeak = v === max && max > 0;
            return (
              <div
                key={h.hour}
                className="group relative rounded-sm transition-all hover:ring-2 hover:ring-primary/40"
                style={{
                  height: 28,
                  // color-mix(in srgb, #5B8DEF p%, transparent) 的静态等值替代，兼容旧内核（禁用 color-mix）
                  background: intensity === 0 ? "var(--bg-soft)" : `rgba(91, 141, 239, ${Math.round(intensity * 100) / 100})`,
                  outline: isPeak ? "2px solid #5B8DEF" : "none",
                  outlineOffset: isPeak ? "1px" : undefined,
                }}
                title={`${h.label}: ${fmtN(v)} calls · ${fmtN(h.tokens || 0)} tokens`}
              />
            );
          })}
        </div>
      ))}
      <div className="mt-3 flex items-center gap-2 text-[10px] text-fg-subtle">
        <span>{t("report.hourly.low")}</span>
        <div className="h-2 flex-1 rounded-sm" style={{ background: "linear-gradient(to right, transparent, #5B8DEF)" }} />
        <span>{t("report.hourly.high")}</span>
      </div>
    </div>
  );
}

function InsightCallout({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "success" | "warning" }) {
  const styles = {
    info: { border: "border-blue-500/20", bg: "bg-blue-500/[0.04]", icon: "text-blue-500" },
    success: { border: "border-emerald-500/20", bg: "bg-emerald-500/[0.04]", icon: "text-emerald-500" },
    warning: { border: "border-amber-500/20", bg: "bg-amber-500/[0.04]", icon: "text-amber-500" },
  }[tone];
  return (
    <div className={`rounded-lg border ${styles.border} ${styles.bg} px-4 py-3 text-[12.5px] leading-relaxed`}>
      <span className={`mr-1.5 font-semibold ${styles.icon}`}>▸</span>
      {children}
    </div>
  );
}

export function OpsReportDocument({ d }: { d: ReportDetailData }) {
  const { t } = useT();
  const kindLabel = useKindLabel(t);
  const HEALTH_META = useHealthMeta(t);
  const m = d.metrics || {};
  const totals = m.totals || {};
  const c = m.compare || {};
  const insights: string[] = Array.isArray(m.executive_summary) ? m.executive_summary : [];
  const recommendations: string[] = Array.isArray(m.recommendations) ? m.recommendations : [];
  const anomalies: any[] = Array.isArray(m.anomalies) ? m.anomalies : [];
  const byModel: any[] = Array.isArray(m.by_model) ? m.by_model : [];
  const byProject: any[] = Array.isArray(m.by_project) ? m.by_project : [];
  const byDept: any[] = Array.isArray(m.by_department) ? m.by_department : [];
  const categories: any[] = Array.isArray(m.category_breakdown) ? m.category_breakdown : [];
  const byStatus: any[] = Array.isArray(m.by_status) ? m.by_status : [];
  const byHour: any[] = Array.isArray(m.by_hour) ? m.by_hour : [];
  const saturation: any[] = Array.isArray(m.saturation) ? m.saturation : [];
  const healthScore = m.health_score ?? d.health_score ?? 85;

  const trendData = useMemo(() => {
    if (m.series?.length) return m.series;
    return Array.isArray(m.by_hour) ? m.by_hour.map((h: any) => ({
      label: h.label || `${String(h.hour ?? 0).padStart(2, "0")}:00`,
      requests: h.requests,
      tokens: h.tokens,
    })) : [];
  }, [m.series, m.by_hour]);

  const trendTitle =
    m.series_granularity === "hour" ? t("report.trend.hourly")
    : m.series_granularity === "month" ? t("report.trend.monthly")
    : t("report.trend.daily");

  const categoryPie = categories.map((x) => ({ name: x.label, value: x.requests, share: x.share_pct }));
  const modelPie = byModel.slice(0, 8).map((x) => ({ name: x.name || x.model_id, value: x.requests }));

  const compareNote = typeof c.compare_note === "string" ? c.compare_note : null;
  const periodText =
    d.period_start && d.period_end
      ? `${d.period_start.slice(0, 10)} — ${d.period_end.slice(0, 10)}`
      : "";

  const peakHour = m.peak_hour || (byHour.length > 0 ? byHour.reduce((mx: any, h: any) => h.requests > (mx?.requests ?? 0) ? h : mx, byHour[0]) : null);
  const avgLatency = totals.avg_latency_ms ? `${Math.round(totals.avg_latency_ms)}ms` : "—";
  const successRate = totals.success ? ((totals.success / (totals.requests || 1)) * 100).toFixed(3) : ((100 - (totals.error_rate ?? 0)).toFixed(3));
  const costPerCall = totals.requests > 0 && totals.cost ? (totals.cost / totals.requests * 1000).toFixed(2) : null;
  const tokensPerCall = totals.requests > 0 && totals.total_tokens ? Math.round(totals.total_tokens / totals.requests) : null;

  const sparkCalls = useMemo(() => trendData.map((d: any) => d.requests || 0), [trendData]);
  const sparkTokens = useMemo(() => trendData.map((d: any) => d.tokens || 0), [trendData]);

  const promptPct = totals.total_tokens > 0 ? Math.round(((totals.prompt_tokens ?? 0) / totals.total_tokens) * 100) : 0;
  const completionPct = totals.total_tokens > 0 ? Math.round(((totals.completion_tokens ?? 0) / totals.total_tokens) * 100) : 0;

  const status4xx = byStatus.filter((s: any) => String(s.status_code).startsWith("4")).reduce((sum: number, s: any) => sum + (s.count || 0), 0);
  const status5xx = byStatus.filter((s: any) => String(s.status_code).startsWith("5")).reduce((sum: number, s: any) => sum + (s.count || 0), 0);
  const status2xx = byStatus.filter((s: any) => String(s.status_code).startsWith("2")).reduce((sum: number, s: any) => sum + (s.count || 0), 0);
  const totalStatus = byStatus.reduce((sum: number, s: any) => sum + (s.count || 0), 0) || 1;

  const topCatLabel = categories[0]?.label ?? "";
  const topCatPct = categories[0]?.share_pct ?? 0;
  const topModel = byModel[0];
  const topProject = byProject[0];

  const soWhatInsights = useMemo(() => {
    const out: { tone: "info" | "success" | "warning"; text: ReactNode }[] = [];
    if (topModel && topCatLabel) {
      out.push({ tone: "info", text: <>{fmtStr(t("report.insight.topModel"), { model: topModel.model_id, pct: topModel.share_pct, category: topCatLabel, catPct: topCatPct })}</> });
    }
    if (peakHour && peakHour.requests) {
      const share = Math.round((peakHour.requests / (totals.requests || 1)) * 100);
      out.push({ tone: "info", text: <>{fmtStr(t("report.insight.peakTraffic"), { hour: peakHour.label, count: fmtN(peakHour.requests), share })}</> });
    }
    if (c.requests_delta_pct != null && c.requests_delta_pct > 20) {
      out.push({ tone: "success", text: <>{fmtStr(t("report.insight.growth"), { pct: c.requests_delta_pct })}</> });
    }
    if ((totals.error_rate ?? 0) < 0.5) {
      out.push({ tone: "success", text: <>{fmtStr(t("report.insight.lowError"), { pct: totals.error_rate })}</> });
    } else if ((totals.error_rate ?? 0) > 2) {
      const errorType = status5xx > status4xx ? t("report.insight.errorType.server") : t("report.insight.errorType.client");
      out.push({ tone: "warning", text: <>{fmtStr(t("report.insight.highError"), { pct: totals.error_rate, errorType })}</> });
    }
    if (topProject && totals.total_tokens) {
      const pShare = Math.round((topProject.tokens / totals.total_tokens) * 100);
      if (pShare >= 30) {
        out.push({ tone: "warning", text: <>{fmtStr(t("report.insight.concentrated"), { project: topProject.project, pct: pShare })}</> });
      }
    }
    return out;
  }, [topModel, topCatLabel, topCatPct, peakHour, t, c.requests_delta_pct, status5xx, status4xx, topProject, totals]);

  return (
    <div className="mx-auto max-w-[900px] overflow-hidden rounded-2xl border border-border/40 bg-card shadow-2xl">
      {/* ══════════════ COVER ══════════════ */}
      <div
        className="relative overflow-hidden px-10 py-10 text-white"
        style={{ background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 35%, #4338ca 70%, #6366f1 100%)" }}
      >
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
          backgroundSize: "28px 28px",
        }} />
        <div className="relative flex items-start justify-between gap-8">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-white/60">
              <Sparkles className="h-3.5 w-3.5" />
              {t("report.cover.tagline")}
            </div>
            <h2 className="font-serif text-[32px] font-medium leading-tight tracking-normal">{d.label}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px] text-white/70">
              <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{periodText}</span>
              <span className="flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5" />{kindLabel[d.kind] || d.kind}</span>
              <span className="text-white/40">|</span>
              <span>{t("report.cover.generatedAt")} {d.generated_at?.replace("T", " ").slice(0, 16)}</span>
            </div>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 backdrop-blur-sm text-[12px]">
              {d.health === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              <span className="font-medium">{HEALTH_META[d.health]?.label || d.health}</span>
              {anomalies.length > 0 && <><span className="text-white/30">·</span><span className="text-white/70">{anomalies.length} alerts</span></>}
            </div>
          </div>
          <HealthRing score={healthScore} health={d.health} size={130} />
        </div>
      </div>

      <div className="px-8 py-8 space-y-8">
        {/* ══════════════ EXECUTIVE SUMMARY ══════════════ */}
        {insights.length > 0 && (
          <section className="relative overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.04] to-transparent p-6">
            <div className="absolute right-0 top-0 opacity-[0.03]">
              <Target className="h-40 w-40" />
            </div>
            <h3 className="relative mb-4 flex items-center gap-2 font-serif text-[15px] font-medium text-foreground">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary"><Eye className="h-3.5 w-3.5" /></span>
              {t("report.section.execSummary")}
            </h3>
            <div className="relative space-y-2.5">
              {insights.map((line, i) => (
                <p key={i} className="flex gap-2.5 text-[13.5px] leading-relaxed text-foreground/90">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{line.replace(/\*\*/g, "")}</span>
                </p>
              ))}
            </div>
          </section>
        )}

        {/* ══════════════ KPI HERO ROW ══════════════ */}
        <section>
          <h3 className="mb-3 text-[13px] font-bold uppercase tracking-[0.1em] text-fg-subtle">{t("report.section.keyMetrics")}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Activity, title: t("report.kpi.totalCalls"), color: "#5B8DEF",
                value: fmtN(totals.requests ?? 0), sub: t("report.kpi.requests"),
                trend: c.requests_delta_pct, spark: sparkCalls,
              },
              {
                icon: Zap, title: t("report.kpi.tokens"), color: "#E87461",
                value: fmtN(totals.total_tokens ?? 0), sub: tokensPerCall ? `${t("report.kpi.perCall")} ${fmtN(tokensPerCall)} tok/call` : "",
                trend: c.tokens_delta_pct, spark: sparkTokens,
              },
              {
                icon: ShieldAlert, title: t("report.kpi.successRate"), color: "#7BC47F",
                value: `${successRate}%`, sub: `${fmtN(totals.success ?? 0)} ${t("report.kpi.success")} / ${fmtN(totals.errors ?? 0)} ${t("report.kpi.failed")}`,
                trend: totals.error_rate != null ? -totals.error_rate : null,
              },
              {
                icon: TrendingUp, title: t("report.kpi.estimatedCost"), color: "#F0B954",
                value: fmtCost(Number(totals.cost ?? 0)), sub: costPerCall ? `¥${costPerCall}/${t("report.kpi.perK")}` : "",
                trend: c.cost_delta_pct,
              },
            ].map(({ icon: Icon, title, value, sub, trend, color, spark }) => (
              <div key={title} className="rounded-xl border border-border/40 p-4 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${color}15`, color }}>
                    <Icon className="h-4 w-4" />
                  </div>
                  {trend != null && <TrendArrow value={trend} />}
                </div>
                <div className="mt-3 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">{title}</div>
                <div className="mt-1 text-[24px] font-bold tracking-tight tabular-nums" style={{ color }}>{value}</div>
                {sub && <div className="mt-0.5 text-[11px] text-fg-muted">{sub}</div>}
                {spark && spark.length > 1 && <Sparkline data={spark} color={color} />}
              </div>
            ))}
          </div>
        </section>

        {/* ══════════════ TOKEN SPLIT + SECONDARY KPIs ══════════════ */}
        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-border/40 p-5 lg:col-span-1">
            <div className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">{t("report.token.structure")}</div>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-[22px] font-bold tabular-nums text-[#5B8DEF]">{fmtN(totals.prompt_tokens ?? 0)}</span>
              <span className="text-[11px] text-fg-subtle">{t("report.token.input")}</span>
              <span className="text-[22px] font-bold tabular-nums text-[#E87461]">{fmtN(totals.completion_tokens ?? 0)}</span>
              <span className="text-[11px] text-fg-subtle">{t("report.token.output")}</span>
            </div>
            <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-bg-soft">
              <div className="h-full bg-[#5B8DEF]" style={{ width: `${promptPct}%` }} />
              <div className="h-full bg-[#E87461]" style={{ width: `${completionPct}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-fg-subtle tabular-nums">
              <span>Prompt {promptPct}%</span>
              <span>Completion {completionPct}%</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:col-span-2">
            {[
              { icon: Clock, label: t("report.latency.avgP50"), value: avgLatency, sub: t("report.latency.responseTime") },
              { icon: Cpu, label: t("report.latency.max"), value: totals.max_latency_ms ? `${Math.round(totals.max_latency_ms)}ms` : "—", sub: t("report.latency.peakObserved") },
              { icon: Server, label: t("report.peak.hour"), value: peakHour ? (peakHour.label || `${String(peakHour.hour ?? 0).padStart(2, "0")}:00`) : "—", sub: peakHour ? `${fmtN(peakHour.requests)} ${t("report.peak.callsPerHr")}` : "" },
              { icon: Database, label: t("report.http.status"), value: `${Math.round((status2xx / totalStatus) * 100)}%`, sub: `${fmtN(status4xx)} 4xx · ${fmtN(status5xx)} 5xx` },
            ].map(({ icon: Icon, label, value, sub }) => (
              <div key={label} className="flex items-center gap-3 rounded-xl border border-border/30 bg-bg-soft/50 px-4 py-3">
                <Icon className="h-5 w-5 shrink-0 text-fg-subtle" />
                <div className="min-w-0">
                  <div className="truncate text-[10.5px] uppercase tracking-wider text-fg-subtle">{label}</div>
                  <div className="text-[18px] font-bold tabular-nums leading-tight">{value}</div>
                  {sub && <div className="truncate text-[10.5px] text-fg-muted">{sub}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ══════════════ AUTO INSIGHTS (So What?) ══════════════ */}
        {soWhatInsights.length > 0 && (
          <section className="space-y-2.5">
            <h3 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.1em] text-fg-subtle">
              <Lightbulb className="h-3.5 w-3.5" /> {t("report.section.insights")}
            </h3>
            {soWhatInsights.map((ins, i) => (
              <InsightCallout key={i} tone={ins.tone}>{ins.text}</InsightCallout>
            ))}
          </section>
        )}

        {/* ══════════════ TREND ══════════════ */}
        {trendData.length > 0 && (
          <section className="rounded-2xl border border-border/40 p-6">
            <div className="mb-1 flex items-baseline justify-between">
              <div>
                <h3 className="font-serif text-[15px] font-medium">{trendTitle}</h3>
                <p className="mt-0.5 text-[11px] text-fg-muted">{t("report.trend.subtitle")}</p>
              </div>
              {compareNote && <span className="text-[11px] text-fg-subtle italic">{compareNote}</span>}
            </div>
            <p className="sr-only">
              {trendData.map((row: any) => `${row.label}: ${t("report.trend.calls")} ${fmtN(row.requests || 0)}, ${t("report.trend.tokens")} ${fmtN(row.tokens || 0)}`).join("; ")}
            </p>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart accessibilityLayer data={trendData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="rep-req" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5B8DEF" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#5B8DEF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} interval="preserveStartEnd" />
                <YAxis yAxisId="l" tick={{ fontSize: 10, fill: "var(--fg-subtle)" }} width={48} tickFormatter={(v: number) => fmtN(v)} />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: "var(--fg-subtle)" }} width={54} tickFormatter={(v: number) => fmtN(v)} />
                <Tooltip content={<ChartTip />} />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Area yAxisId="l" type="monotone" dataKey="requests" name={t("report.trend.calls")} stroke="#5B8DEF" fill="url(#rep-req)" strokeWidth={2.5} />
                <Line yAxisId="r" type="monotone" dataKey="tokens" name={t("report.trend.tokens")} stroke="#E87461" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </section>
        )}

        {/* ══════════════ SCENE BREAKDOWN (rich horizontal stacked bars) ══════════════ */}
        {categories.length > 0 && (
          <section className="rounded-2xl border border-border/40 p-6">
            <h3 className="mb-1 font-serif text-[15px] font-medium">{t("report.scene.title")}</h3>
            <p className="mb-5 text-[11px] text-fg-muted">{t("report.scene.desc")}</p>
            <div className="space-y-4">
              {categories.map((cat: any, i: number) => {
                const color = CHART_COLORS[i % CHART_COLORS.length];
                const totalReq = categories.reduce((s: number, c: any) => s + (c.requests || 0), 0) || 1;
                const reqPct = (cat.requests / totalReq) * 100;
                const totalTok = categories.reduce((s: number, c: any) => s + (c.tokens || 0), 0) || 1;
                const tokPct = (cat.tokens / totalTok) * 100;
                return (
                  <div key={cat.category} className="group">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                        <span className="font-serif text-[13px] font-medium">{cat.label}</span>
                      </div>
                      <div className="flex items-center gap-4 text-[11.5px] tabular-nums">
                        <span className="text-fg-muted">{fmtN(cat.requests)}{t("report.unit.requests")} · {cat.share_pct}%</span>
                        <span className="text-fg-subtle">{fmtN(cat.tokens)} tok</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-fg-subtle">{t("report.scene.calls")}</span>
                        <div className="h-[8px] flex-1 overflow-hidden rounded-full bg-bg-soft">
                          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${reqPct}%`, background: color }} />
                        </div>
                        <span className="w-10 shrink-0 text-right text-[11px] font-semibold tabular-nums">{reqPct.toFixed(1)}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-fg-subtle">{t("report.scene.tokens")}</span>
                        <div className="h-[8px] flex-1 overflow-hidden rounded-full bg-bg-soft">
                          <div className="h-full rounded-full transition-all duration-500 opacity-60" style={{ width: `${tokPct}%`, background: color }} />
                        </div>
                        <span className="w-10 shrink-0 text-right text-[11px] font-semibold tabular-nums opacity-70">{tokPct.toFixed(1)}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ══════════════ TOP MODELS ARENA DONUT ══════════════ */}
        {modelPie.length > 0 && (
          <section>
            <div className="mb-2 text-center">
              <h3 className="font-serif text-[28px] font-normal leading-tight">{t("report.model.title")}</h3>
              <p className="mt-1.5 font-serif text-[15px] text-fg-muted">
                {fmtStr(t("report.model.subtitle"), { n: modelPie.length })}
              </p>
            </div>
            <ArenaDonut
              slices={modelPie.map((m, i) => ({ name: m.name, value: m.value, color: CHART_COLORS[i % CHART_COLORS.length] }))}
              centerLabel={t("report.model.totalCalls")}
              centerValue={fmtN(modelPie.reduce((s, m) => s + m.value, 0))}
              centerSub={periodText}
              legendTitle={t("report.model.topModels")}
              footnote={t("report.model.footnote")}
            />
          </section>
        )}

        {/* ══════════════ PROJECTS BY TOKENS (Arena bar) ══════════════ */}
        {byProject.length > 0 && (
          <section>
            <ArenaHBar
              title={t("report.projects.title")}
              subtitle={fmtStr(t("report.projects.subtitle"), { n: Math.min(byProject.length, 10), period: periodText })}
              items={byProject.slice(0, 10).map((p: any) => ({ name: p.project, value: p.tokens ?? 0 }))}
              color="#5B8DEF"
              footnote={t("report.projects.footnote")}
            />
          </section>
        )}

        {/* ══════════════ DEPARTMENT (Arena bar) + STATUS DONUT ══════════════ */}
        <section className="grid gap-5 lg:grid-cols-2">
          {byDept.length > 0 && (
            <ArenaHBar
              title={t("report.dept.title")}
              subtitle={fmtStr(t("report.dept.subtitle"), { period: periodText })}
              items={byDept.slice(0, 8).map((d: any) => ({ name: d.department, value: d.tokens ?? 0 }))}
              color="#9B8EC4"
              footnote={t("report.dept.footnote")}
            />
          )}
          <div className="rounded-2xl border border-border/30 bg-white p-6 shadow-sm dark:bg-card">
            <div className="mb-4 text-center">
              <h3 className="font-serif text-[20px] font-normal">{t("report.status.title")}</h3>
              <p className="mt-1 text-[13px] text-fg-muted">{t("report.status.subtitle")}</p>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[
                { label: t("report.status.2xx"), value: status2xx, pct: Math.round((status2xx / totalStatus) * 100), color: "var(--ok)" },
                { label: t("report.status.4xx"), value: status4xx, pct: Math.round((status4xx / totalStatus) * 100), color: "var(--warn)" },
                { label: t("report.status.5xx"), value: status5xx, pct: Math.round((status5xx / totalStatus) * 100), color: "var(--danger)" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border/30 p-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{s.label}</div>
                  <div className="mt-1 text-[20px] font-bold tabular-nums" style={{ color: s.color }}>{s.pct}%</div>
                  <div className="mt-0.5 text-[11px] tabular-nums text-fg-muted">{fmtN(s.value)}</div>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {byStatus.slice(0, 6).map((s: any) => {
                const total = totalStatus;
                const pct = total > 0 ? ((s.count / total) * 100).toFixed(1) : "0";
                const sc = String(s.status_code);
                const ok = sc.startsWith("2");
                const warn = sc.startsWith("4");
                return (
                  <div key={s.status_code} className="flex items-center gap-3">
                    <span
                      className="w-12 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-bold"
                      style={{
                        background: ok ? "rgba(34,197,94,0.1)" : warn ? "rgba(234,179,8,0.1)" : "rgba(239,68,68,0.1)",
                        color: ok ? "var(--ok)" : warn ? "var(--warn)" : "var(--danger)",
                      }}
                    >{s.status_code}</span>
                    <div className="flex-1">
                      <div className="h-[6px] overflow-hidden rounded-full bg-bg-soft">
                        <div className="h-full rounded-full" style={{
                          width: `${pct}%`,
                          background: ok ? "var(--ok)" : warn ? "var(--warn)" : "var(--danger)",
                        }} />
                      </div>
                    </div>
                    <span className="w-16 shrink-0 text-right text-[11.5px] font-semibold tabular-nums">{fmtN(s.count)}</span>
                    <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-fg-muted">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ══════════════ 24-HOUR RHYTHM HEATMAP ══════════════ */}
        {byHour.length > 0 && (
          <section className="rounded-2xl border border-border/30 bg-white p-8 shadow-sm dark:bg-card">
            <div className="mb-5 text-center">
              <h3 className="font-serif text-[28px] font-normal leading-tight">{t("report.hourly.title")}</h3>
              <p className="mt-1.5 font-serif text-[15px] text-fg-muted">
                {t("report.hourly.subtitle")} <b>{peakHour?.label || "--"}</b>
              </p>
            </div>
            <div className="mx-auto max-w-[720px]">
              <HourlyHeatmap byHour={byHour} />
            </div>
            <p className="mt-4 text-center font-serif text-[12px] italic text-fg-subtle">
              {t("report.hourly.footnote")}
            </p>
          </section>
        )}

        {/* ══════════════ SATURATION / PEAK LOAD ══════════════ */}
        {saturation.length > 0 && (
          <section className="rounded-2xl border border-border/40 p-6">
            <h3 className="mb-1 font-serif text-[14px] font-medium">{t("report.saturation.title")}</h3>
            <p className="mb-4 text-[11px] text-fg-muted">{t("report.saturation.desc")}</p>
            <div className="space-y-2">
              {saturation.slice(0, 8).map((s: any, i: number) => {
                const infl = s.inflation ?? 1;
                const highLoad = infl > 1.8;
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="w-44 shrink-0 truncate font-mono text-[12px] font-medium">{s.model_id}</span>
                    <span className="w-16 shrink-0 text-[11px] tabular-nums text-fg-muted">{Math.round(s.baseline_ms)}ms</span>
                    <div className="flex-1 h-[8px] rounded-full bg-bg-soft overflow-hidden">
                      <div className="h-full rounded-full" style={{
                        width: `${Math.min(100, (infl - 1) * 50)}%`,
                        background: highLoad ? "var(--danger)" : infl > 1.3 ? "var(--warn)" : "var(--ok)",
                      }} />
                    </div>
                    <span className="w-16 shrink-0 text-[11px] tabular-nums text-fg-muted">{Math.round(s.peak_ms)}ms</span>
                    <span className={`w-14 shrink-0 text-right text-[11px] font-bold tabular-nums ${highLoad ? "text-danger" : infl > 1.3 ? "text-warn" : "text-ok"}`}>
                      ×{infl.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ══════════════ MODEL DETAIL TABLE ══════════════ */}
        <section>
          <div className="overflow-hidden rounded-2xl border border-border/40">
            <div className="border-b border-border/40 bg-bg-soft/60 px-5 py-3">
              <h3 className="font-serif text-[13px] font-medium">{t("report.table.title")}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-fg-subtle">
                    <th className="px-4 py-2.5">{t("report.table.model")}</th>
                    <th className="px-4 py-2.5 text-right">{t("report.table.calls")}</th>
                    <th className="px-4 py-2.5 text-right">{t("report.table.tokens")}</th>
                    <th className="px-4 py-2.5 text-right">{t("report.table.share")}</th>
                    <th className="px-4 py-2.5 text-right">{t("report.table.errorRate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((x) => (
                    <tr key={x.model_id} className="border-t border-border/20 hover:bg-bg-soft/40">
                      <td className="px-4 py-2 font-serif font-medium">{x.name || x.model_id}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtN(x.requests)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-fg-muted">{fmtN(x.tokens ?? 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-fg-muted">{x.share_pct}%</td>
                      <td className="px-4 py-2 text-right tabular-nums" style={{ color: (x.error_rate ?? 0) > 1 ? "var(--danger)" : (x.error_rate ?? 0) > 0.1 ? "var(--warn)" : "var(--ok)" }}>
                        {x.error_rate}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ══════════════ RECOMMENDATIONS ══════════════ */}
        {recommendations.length > 0 && (
          <section className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.06] to-transparent p-6">
            <h3 className="mb-3 flex items-center gap-2 font-serif text-[15px] font-medium text-amber-700 dark:text-amber-400">
              <Lightbulb className="h-4 w-4" />
              {t("report.recommendations.title")}
            </h3>
            <div className="space-y-2">
              {recommendations.map((r, i) => (
                <div key={i} className="flex gap-3 rounded-lg bg-amber-500/[0.04] px-4 py-2.5 text-[13px] leading-relaxed text-amber-900 dark:text-amber-200/90">
                  <span className="mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-bold">{i + 1}</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ══════════════ ANOMALIES ══════════════ */}
        {anomalies.length > 0 && (
          <section>
            <h3 className="mb-3 flex items-center gap-2 font-serif text-[14px] font-medium">
              <AlertTriangle className="h-4 w-4 text-danger" />
              {fmtStr(t("report.anomalies.title"), { n: anomalies.length })}
            </h3>
            <div className="space-y-2">
              {anomalies.map((a, i) => (
                <div key={i} className="flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]" style={{
                  borderColor: a.level === "critical" ? "var(--danger)/30" : a.level === "warning" ? "var(--warn)/30" : "var(--border)",
                  background: a.level === "critical" ? "rgba(239,68,68,0.03)" : a.level === "warning" ? "rgba(234,179,8,0.03)" : "transparent",
                }}>
                  <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    a.level === "critical" ? "bg-danger/15 text-danger" :
                    a.level === "warning" ? "bg-warn/15 text-warn" :
                    "bg-block-blue/15 text-block-blue"
                  }`}>{a.level}</span>
                  <span className="text-foreground/85 leading-relaxed">{a.message}</span>
                  {a.code && <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-subtle">{a.code}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ══════════════ FOOTER / OUTLOOK ══════════════ */}
        <footer className="rounded-2xl border border-border/40 bg-gradient-to-br from-bg-soft/80 to-transparent p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h4 className="flex items-center gap-1.5 font-serif text-[13px] font-medium">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                {t("report.section.forecast")}
              </h4>
              <p className="mt-1.5 max-w-[52ch] text-[12px] leading-relaxed text-fg-muted">
                {t("report.section.outlookText")}
              </p>
            </div>
            <div className="text-right text-[11px] text-fg-subtle whitespace-nowrap">
              <div className="font-mono">{d.generated_at?.slice(0, 10)}</div>
              <div className="mt-0.5">{t("report.section.footerLabel")}</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function ReportDownloadBar({
  report,
  exportRef,
  disabled,
}: {
  report: ReportDetailData;
  exportRef: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState<"pdf" | "md" | "json" | null>(null);

  async function downloadPdf() {
    setBusy("pdf");
    try {
      const el = exportRef.current;
      if (!el) throw new Error(t("report.download.notReady"));
      await downloadElementAsPdf(el, reportPdfFilename(report.label, report.kind));
      toast.success(t("report.download.pdfSuccess"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("report.download.pdfError"));
    } finally {
      setBusy(null);
    }
  }

  function downloadMarkdown() {
    setBusy("md");
    try {
      downloadReportMarkdown(report);
      toast.success(t("report.download.mdSuccess"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("report.download.mdError"));
    } finally {
      setBusy(null);
    }
  }

  function downloadJson() {
    setBusy("json");
    try {
      downloadReportJson(report as unknown as Record<string, unknown>);
      toast.success(t("report.download.jsonSuccess"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("report.download.jsonError"));
    } finally {
      setBusy(null);
    }
  }

  const loading = busy !== null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-secondary/20 px-4 py-3">
      <span className="text-[13px] text-muted-foreground">{t("report.download.label")}</span>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={downloadPdf}
        className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-card px-3.5 py-2 text-[13px] hover:bg-secondary/40 disabled:opacity-60"
      >
        {busy === "pdf" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {t("report.download.pdf")}
      </button>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={downloadMarkdown}
        className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-card px-3.5 py-2 text-[13px] hover:bg-secondary/40 disabled:opacity-60"
      >
        {busy === "md" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
        {t("report.download.markdown")}
      </button>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={downloadJson}
        className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-card px-3.5 py-2 text-[13px] hover:bg-secondary/40 disabled:opacity-60"
      >
        {busy === "json" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {t("report.download.json")}
      </button>
    </div>
  );
}

export default function ReportsTab({ token }: { token: string }) {
  const { t } = useT();
  const reportKinds = useReportKinds(t);
  const kindLabelFromT = useKindLabel(t);
  const [selectedKind, setSelectedKind] = useState<string>("weekly");
  const [report, setReport] = useState<ReportDetailData | null>(null);
  const [generating, setGenerating] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  async function generate() {
    setGenerating(true);
    setReport(null);
    try {
      const data = await adminReportFetch<ReportDetailData>(token, "/api/admin/reports/generate", {
        method: "POST",
        body: JSON.stringify({ kind: selectedKind }),
      }, t("auth.sessionExpired"));
      setReport(data);
      toast.success(fmtStr(t("report.generated"), { kind: kindLabelFromT[selectedKind] }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("report.generateFailed"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/40 bg-secondary/20 px-5 py-4">
        <h2 className="font-serif text-[15px] font-medium">{t("report.page.title")}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">
          {t("report.page.desc")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reportKinds.map((k) => {
          const active = selectedKind === k.key;
          return (
            <button
              key={k.key}
              type="button"
              onClick={() => setSelectedKind(k.key)}
              className={`rounded-xl border px-4 py-4 text-left transition-all ${
                active
                  ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                  : "border-border/40 bg-card hover:border-border hover:shadow-sm"
              }`}
            >
              <div className="font-serif text-[14px] font-medium">{k.label}</div>
              <div className="mt-1 text-[12px] text-muted-foreground">{k.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={generating}
          onClick={generate}
          className="flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-[14px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {generating ? t("report.generating") : fmtStr(t("report.generate"), { kind: kindLabelFromT[selectedKind] })}
        </button>
      </div>

      {report && !generating && (
        <ReportDownloadBar report={report} exportRef={exportRef} />
      )}

      {generating && (
        <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/50 bg-card">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-3 text-[13px] text-muted-foreground">{t("report.loading")}</p>
          </div>
        </div>
      )}

      {!generating && report && (
        <div id="ops-report-export-root" ref={exportRef}>
          <OpsReportDocument d={report} />
        </div>
      )}

      {!generating && !report && (
        <div className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/40 bg-card px-8 text-center">
          <FileText className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-[14px] text-muted-foreground">{t("report.emptyHint")}</p>
        </div>
      )}
    </div>
  );
}
