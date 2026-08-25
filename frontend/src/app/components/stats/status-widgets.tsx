import type { ReactNode } from "react";

/* 运营看板（PlatformStatus）与个人用量统计（Usage）共享的展示组件。
 *
 * 两个页面在用户要求下逐步统一视觉：顶部 Hero KPI 卡、流量趋势、场景/模型分布
 * 环图都从这里取，避免两处维护同一套实现。这些组件全部基于同一组 CSS 变量
 * （--card / --fg / --bg-soft / --border-strong…），在 ConsolePageShell 与公开页
 * 布局里都能直接使用。 */

export function fmtStr(template: string, replacements: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(replacements[key] ?? `{${key}}`));
}

export function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function fmtPct(n: number, d = 1): string {
  if (!isFinite(n)) return "0%";
  return `${n >= 10 ? Math.round(n) : n.toFixed(d)}%`;
}

export function fmtSignedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  return `${sign}${abs >= 10 ? Math.round(abs) : abs.toFixed(1)}%`;
}

export const DONUT_PALETTE = [
  "#5B8DEF", "#E87461", "#7BC47F", "#F0B954",
  "#9B8EC4", "#5BC0BE", "#D47DAA", "#7A9E7E",
];

/* ──────────────────────────────────────────────────────────────
   Donut chart (interactive SVG)
────────────────────────────────────────────────────────────── */
export function DonutChart({
  data, size = 200, thickness = 32,
  hovered, onHover, centerLabel, centerSub, legendFooter,
}: {
  data: { name: string; value: number; key: string; color: string }[];
  size?: number;
  thickness?: number;
  hovered: number | null;
  onHover: (i: number | null) => void;
  centerLabel?: string;
  centerSub?: string;
  /** 跟在图例列表末尾（如「查看全部」），紧贴前 N 项下方 */
  legendFooter?: ReactNode;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 8;
  const innerR = outerR - thickness;
  const active = hovered !== null ? data[hovered] : null;

  let accAngle = -Math.PI / 2;
  const gapAngle = (Math.PI / 180) * 1.8;
  const arcs = data.map((d, i) => {
    const pct = total > 0 ? d.value / total : 0;
    const angle = pct * Math.PI * 2 - gapAngle;
    const startAngle = accAngle + gapAngle / 2;
    const endAngle = accAngle + gapAngle / 2 + angle;
    accAngle += pct * Math.PI * 2;
    const largeArc = angle > Math.PI ? 1 : 0;
    const isActive = hovered === i;
    const isDimmed = hovered !== null && !isActive;
    const r = isActive ? outerR + 4 : outerR;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + innerR * Math.cos(endAngle);
    const iy1 = cy + innerR * Math.sin(endAngle);
    const ix2 = cx + innerR * Math.cos(startAngle);
    const iy2 = cy + innerR * Math.sin(startAngle);
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
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          {arcs.map(({ d, i, path, isDimmed }) => (
            <path
              key={d.key}
              d={path}
              fill={d.color}
              opacity={isDimmed ? 0.25 : 1}
              style={{ transition: "opacity 0.2s ease", cursor: "pointer" }}
              onMouseEnter={() => onHover(i)}
              onMouseLeave={() => onHover(null)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {active ? (
            <>
              <p className="max-w-[70%] truncate px-3 text-center font-serif text-[10px] leading-tight text-fg-muted">{active.name}</p>
              <p className="mt-1 text-[22px] font-bold leading-none tabular-nums">{fmtPct(total > 0 ? (active.value / total) * 100 : 0)}</p>
              <p className="mt-0.5 text-[10px] text-fg-muted">{fmtCompact(active.value)}</p>
            </>
          ) : (
            <>
              <p className="text-[10px] text-fg-muted">{centerLabel ?? "Total"}</p>
              <p className="mt-1 text-[22px] font-bold leading-none tabular-nums">{fmtCompact(total)}</p>
              {centerSub && <p className="mt-0.5 text-[10px] text-fg-muted">{centerSub}</p>}
            </>
          )}
        </div>
      </div>
      <div className="w-full min-w-0">
        <div className="space-y-1.5">
          {data.map((d, i) => {
            const pct = total > 0 ? (d.value / total) * 100 : 0;
            const isActive = hovered === i;
            const isDimmed = hovered !== null && !isActive;
            return (
              <div
                key={d.key}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5"
                style={{ opacity: isDimmed ? 0.3 : 1, transition: "opacity 0.2s ease", background: isActive ? "var(--bg-soft)" : "transparent" }}
                onMouseEnter={() => onHover(i)}
                onMouseLeave={() => onHover(null)}
              >
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: d.color }} />
                <span className="min-w-0 flex-1 truncate font-serif text-[12px] font-medium text-fg">{d.name}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-fg-muted">{fmtPct(pct)}</span>
              </div>
            );
          })}
        </div>
        {legendFooter && <div className="mt-1.5 px-1">{legendFooter}</div>}
      </div>
    </div>
  );
}

/** 通用分段切换（日/月/累计、调用次数/Token 等）。 */
export function SegmentedToggle<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full bg-bg-soft p-0.5">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold transition-colors"
          style={{
            background: value === opt.key ? "var(--ink)" : "transparent",
            color: value === opt.key ? "var(--bg)" : "var(--fg-muted)",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function HeroKpiCard({
  icon, label, value, sub, toggle,
}: {
  icon: ReactNode; label: string; value: string; sub?: ReactNode; toggle?: ReactNode;
}) {
  return (
    <div className="card flex flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-subtle">{icon}</span>
        {toggle}
      </div>
      <p className="mt-3 text-[12px] text-fg-muted">{label}</p>
      <p className="mt-1 text-[24px] font-bold leading-none tracking-tight tabular-nums">{value}</p>
      {sub && <div className="mt-1.5 text-[11.5px] text-fg-muted">{sub}</div>}
    </div>
  );
}

export function SectionHeader({ eyebrow, title, desc, right, descMaxCh = 56 }: { eyebrow: string; title: string; desc?: string; right?: ReactNode; descMaxCh?: number }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-[12px] font-medium text-fg-muted">{eyebrow}</p>
        <h3 className="mt-1 font-serif text-[16px] font-medium tracking-normal text-fg">{title}</h3>
        {desc && <p className="mt-1 text-[12.5px] text-fg-muted" style={{ maxWidth: `${descMaxCh}ch` }}>{desc}</p>}
      </div>
      {right}
    </div>
  );
}

export function RangeToggle({ value, options, onChange, suffix = "" }: { value: number; options: number[]; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full bg-bg-soft p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className="rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors"
          style={{
            background: value === opt ? "var(--ink)" : "transparent",
            color: value === opt ? "var(--bg)" : "var(--fg-muted)",
          }}
        >
          {opt}{suffix}
        </button>
      ))}
    </div>
  );
}
