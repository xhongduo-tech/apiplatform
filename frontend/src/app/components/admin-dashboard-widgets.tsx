// 管理后台仪表盘可复用组件 —— 结构/样式对齐用户侧 /usage 页（Usage.tsx），
// 去掉 i18n、文案硬编码中文，仅保留仪表盘需要的能力。
import { useState, type ReactNode } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import { ArrowDownRight, ArrowUpRight, type Activity } from "lucide-react";

// ── 调色板与格式化 ────────────────────────────────────────────────────────
export const ARENA_COLORS = [
  "var(--chart-4)",
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--chart-2)",
  "var(--block-peach)",
  "var(--block-blue)",
  "var(--block-sand)",
  "#a8a89a",
  "#c9a96e",
];

export const CALLS_COLOR = "var(--chart-4)";
const TOKENS_COLOR = "var(--chart-1)";

export const fmtTok = (n: number) => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};

export const compactNum = (n: number) => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return n.toLocaleString();
};

/** 成本金额（沿用 Logs.tsx 的 $ 约定） */
export const fmtCost = (n: number) => `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;

// ── 区块卡片：着色图标块 + 标题（/usage 的 section header 样式）───────────
export function SectionCard({ title, subtitle, icon: Icon, accent = "var(--brand)", right, children, delay = 0, className = "" }: {
  title: string;
  subtitle?: string;
  icon: typeof Activity;
  accent?: string;
  right?: ReactNode;
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      className={`bg-card rounded-2xl border border-border p-5 transition-shadow duration-300 hover:shadow-card apiplatform-fade-slide-up ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${accent}18` }}>
            <Icon className="w-4 h-4" style={{ color: accent }} />
          </div>
          <div>
            <h3 className="font-serif text-[14px] font-medium text-foreground">{title}</h3>
            {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ── KPI 卡片（复刻 Usage.tsx KpiCard）────────────────────────────────────
type LucideIcon = typeof Activity;

export function KpiCard({ label, value, sub, accentColor, icon: Icon, loading, trend, delay = 0 }: {
  label: string;
  value: string;
  sub: string;
  accentColor: string;
  icon: LucideIcon;
  loading?: boolean;
  trend?: { value: string; up: boolean } | null;
  delay?: number;
}) {
  return (
    <div
      className="bg-card rounded-2xl border border-border overflow-hidden transition-all duration-300 hover:shadow-card hover:-translate-y-0.5 group relative"
      style={{ animation: `apiplatform-fadeSlideUp 0.5s var(--ease-entrance) ${delay}ms both` }}
    >
      <div className="h-1 w-full apiplatform-kpi-accent" style={{ background: accentColor }} />
      <div className="p-5 pt-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-300 group-hover:scale-110"
              style={{ background: `${accentColor}20` }}
            >
              <Icon className="w-4 h-4" style={{ color: accentColor }} />
            </div>
            <p className="text-[12px] text-muted-foreground leading-tight">{label}</p>
          </div>
        </div>
        <p className="text-[26px] tabular-nums leading-none mb-2" style={{ fontWeight: 700, color: "var(--foreground)" }}>
          {loading ? <span className="skeleton inline-block w-24 h-7 rounded" /> : <span className="apiplatform-num-flip" key={value}>{value}</span>}
        </p>
        <div className="flex items-center gap-2">
          {trend ? (
            <TrendChip trend={trend} />
          ) : null}
          <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
        </div>
      </div>
    </div>
  );
}

function TrendChip({ trend }: { trend: { value: string; up: boolean } }) {
  const IconCmp = trend.up ? ArrowUpRight : ArrowDownRight;
  return (
    <div
      className="flex items-center gap-0.5 text-[12px] font-semibold tabular-nums apiplatform-trend-up"
      style={{ color: trend.up ? "var(--ok)" : "var(--danger)" }}
    >
      <IconCmp className="w-3 h-3" />
      {trend.value}
    </div>
  );
}

// ── 富 Tooltip（复刻 Usage.tsx TokenTooltip，通用 name/value）─────────────
export interface ChartTooltipItem { name: string; value: number; color?: string; dataKey?: string; payload?: { fullLabel?: string } }

export function ChartTooltip({ active, payload, label, formatValue }: {
  active?: boolean;
  payload?: ChartTooltipItem[];
  label?: string;
  formatValue?: (name: string, value: number, dataKey?: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const fmt = formatValue ?? ((_n, v) => v.toLocaleString());
  const fullLabel = payload[0]?.payload?.fullLabel ?? label ?? "";
  return (
    <div
      className="rounded-2xl bg-card px-4 py-3 shadow-pop min-w-[220px] border border-border"
      style={{ animation: "apiplatform-scaleIn 0.15s ease-out both" }}
    >
      <div className="flex items-center justify-between gap-6 mb-2 pb-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-[12px] font-semibold text-foreground">{fullLabel}</span>
      </div>
      {payload.map((p) => {
        // 渐变填充的系列 p.color 是 url(#...)，按 dataKey（非展示用名，翻译无关）回退到实色
        const isCall = p.dataKey === "calls";
        const color = p.color && String(p.color).startsWith("url(")
          ? (isCall ? CALLS_COLOR : TOKENS_COLOR)
          : (p.color ?? "var(--fg-muted)");
        return (
          <div key={p.name} className="flex items-center gap-2.5 mb-1.5 last:mb-0">
            <span className="inline-block w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: color }} />
            <span className="text-[12px] text-muted-foreground flex-1">{p.name}</span>
            <span className="text-[12px] text-foreground tabular-nums" style={{ fontWeight: 600 }}>{fmt(p.name, p.value || 0, p.dataKey)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── 交互式环形图 + 联动图例（Usage.tsx 同款，尺寸/半径/图例标题可配）──────
export interface DonutItem { name: string; value: number; badge?: string }

export function DonutWithLegend({ data, total, valueFormatter, size = 180, innerRadius = 56, outerRadius = 76, activeOuterRadius = 80, legendTitle }: {
  data: DonutItem[];
  total: number;
  valueFormatter?: (v: number) => string;
  size?: number;
  innerRadius?: number;
  outerRadius?: number;
  activeOuterRadius?: number;
  legendTitle?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const top = activeIndex != null ? data[activeIndex] : data[0];
  const topPct = total > 0 && top ? (top.value / total) * 100 : 0;
  const fmt = valueFormatter ?? ((v: number) => v.toLocaleString());

  return (
    <div className="flex items-start gap-3">
      <div className="relative shrink-0 pt-1" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={innerRadius}
              outerRadius={activeIndex != null ? activeOuterRadius : outerRadius}
              paddingAngle={2.5}
              dataKey="value"
              stroke="var(--card)"
              strokeWidth={3}
              onMouseEnter={(_, idx) => setActiveIndex(idx)}
              onMouseLeave={() => setActiveIndex(null)}
              animationBegin={100}
              animationDuration={800}
              animationEasing="ease-out"
            >
              {data.map((_, idx) => (
                <Cell
                  key={idx}
                  fill={ARENA_COLORS[idx % ARENA_COLORS.length]}
                  style={{
                    opacity: activeIndex != null && activeIndex !== idx ? 0.35 : 1,
                    transition: "opacity 0.2s ease, transform 0.2s ease",
                    cursor: "pointer",
                    transformOrigin: "center",
                    transform: activeIndex === idx ? "scale(1.04)" : "scale(1)",
                  }}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {top && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none transition-all duration-200">
            <span className="max-w-[90px] truncate px-1 text-center font-serif text-[9px] leading-tight tracking-wider text-muted-foreground">
              {top.name}
            </span>
            <span
              key={activeIndex ?? "default"}
              className="text-[22px] font-bold tabular-nums mt-0.5 apiplatform-num-flip"
              style={{ color: activeIndex != null ? ARENA_COLORS[activeIndex % ARENA_COLORS.length] : "var(--brand)" }}
            >
              {topPct.toFixed(1)}%
            </span>
            <span className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{fmt(top.value)}</span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 pl-1">
        {legendTitle != null && (
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground text-center mt-4 mb-3" style={{ letterSpacing: "0.06em" }}>
            {legendTitle}
          </p>
        )}
        <div className={legendTitle != null ? "space-y-2.5" : "space-y-2 mt-2"}>
          {data.map((d, idx) => {
            const pct = total > 0 ? (d.value / total) * 100 : 0;
            const isActive = activeIndex === idx;
            const color = ARENA_COLORS[idx % ARENA_COLORS.length];
            return (
              <div
                key={d.name}
                className="flex items-center gap-2 text-[12px] group/leg rounded-md px-1.5 py-1 -mx-1.5 transition-all duration-200 cursor-default"
                style={{ background: isActive ? `${color}10` : "transparent" }}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseLeave={() => setActiveIndex(null)}
              >
                <span
                  className="w-3 h-3 rounded-[4px] shrink-0 transition-transform duration-200"
                  style={{ background: color, transform: isActive ? "scale(1.25)" : "scale(1)" }}
                />
                <span
                  className="min-w-0 flex-1 truncate font-serif transition-colors duration-200"
                  style={{
                    color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
                    fontWeight: isActive ? 600 : 500,
                  }}
                  title={d.name}
                >
                  {d.name}
                </span>
                {d.badge && (
                  <span className="text-[10px] text-muted-foreground/80 shrink-0 px-1.5 py-px rounded-full tabular-nums" style={{ background: "var(--bg-soft)" }}>
                    {d.badge}
                  </span>
                )}
                <span
                  className="tabular-nums shrink-0 font-semibold transition-colors duration-200"
                  style={{ color: isActive ? color : "var(--foreground)" }}
                >
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Top N 条形排行（复刻 Usage.tsx TopNBarChart，行内可带副标题）──────────
export interface TopNRow { name: string; calls: number; tokens: number; sub?: string }

export function TopNBarChart({ data, totalCalls, emptyText = "暂无数据", unit = "次" }: {
  data: TopNRow[];
  totalCalls: number;
  emptyText?: string;
  unit?: string;
}) {
  if (data.length === 0) {
    return <div className="text-[13px] text-muted-foreground py-8 text-center">{emptyText}</div>;
  }
  const top = data.slice(0, 6);
  return (
    <div className="space-y-3 apiplatform-fade-list">
      {top.map((row, idx) => {
        const share = totalCalls > 0 ? (row.calls / totalCalls) * 100 : 0;
        const color = ARENA_COLORS[idx % ARENA_COLORS.length];
        return (
          <div key={row.name} className="group/item flex items-center gap-3 py-1" style={{ animationDelay: `${idx * 60}ms` }}>
            <span
              className="shrink-0 w-3 h-3 rounded-[4px] transition-transform duration-200 group-hover/item:scale-125"
              style={{ background: color }}
            />
            <div className="min-w-0 flex-1">
              <span className="block truncate font-serif text-[12.5px] font-medium text-foreground transition-all" title={row.name}>
                {row.name}
              </span>
              {row.sub && (
                <span className="block text-[10px] text-muted-foreground/70 truncate">{row.sub}</span>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums hidden sm:inline">{fmtTok(row.tokens)}</span>
            <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{row.calls.toLocaleString()}{unit}</span>
            <span className="text-[13px] font-bold tabular-nums shrink-0 w-12 text-right" style={{ color }}>
              {share.toFixed(1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
