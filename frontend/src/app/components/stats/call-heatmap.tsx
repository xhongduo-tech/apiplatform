import { useCallback, useMemo } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useT } from "../../i18n";
import { fmtStr, SectionHeader, SegmentedToggle } from "./status-widgets";

export type HeatmapMode = "week" | "month" | "cumulative";

/** 与后端 /heatmap 契约一致 */
export interface CallHeatmapResponse {
  mode: HeatmapMode;
  matrix: number[][];
  dates: string[];
  max: number;
  total: number;
  range_start: string;
  range_end: string;
  week_start: string | null;
  week_end: string | null;
  x_axis: "hour" | "day";
  daily_only_cols?: number[];
  timezone: string;
}

export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localDateStr(new Date(y, m - 1, d + n));
}

function addMonths(dateStr: string, n: number): string {
  const [y, m] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  return localDateStr(dt);
}

function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function cellBg(ratio: number): string {
  if (ratio === 0) return "var(--bg-soft)";
  if (ratio < 0.15) return "rgba(var(--brand-rgb), 0.18)";
  if (ratio < 0.35) return "rgba(var(--brand-rgb), 0.38)";
  if (ratio < 0.6) return "rgba(var(--brand-rgb), 0.6)";
  if (ratio < 0.85) return "rgba(var(--brand-rgb), 0.8)";
  return "var(--brand)";
}

const HOUR_BAND_KEYS = [
  "status.heatmap.band.0",
  "status.heatmap.band.1",
  "status.heatmap.band.2",
  "status.heatmap.band.3",
  "status.heatmap.band.4",
  "status.heatmap.band.5",
  "status.heatmap.band.6",
] as const;

/** 月/累计：顶部日期刻度——月初、月末、逢 5/10/15… 显示 m/d，跨月边界必显 */
function dayAxisLabel(iso: string | undefined, col: number, colCount: number): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-").map(Number);
  const isEdge = col === 0 || col === colCount - 1;
  const isMonthStart = d === 1;
  const isTick = d === 5 || d === 10 || d === 15 || d === 20 || d === 25 || d === 30;
  if (isEdge || isMonthStart || isTick) return `${m}/${d}`;
  return "";
}

export function CallHeatmapPanel({
  heatmap,
  loading,
  error,
  mode,
  onModeChange,
  anchorDate,
  onAnchorDateChange,
  onReload,
  onCellClick,
  loadingLabel,
  reloadLabel,
  className = "",
  variant = "card",
}: {
  heatmap: CallHeatmapResponse | null;
  loading: boolean;
  error: string | null;
  mode: HeatmapMode;
  onModeChange: (m: HeatmapMode) => void;
  anchorDate: string;
  onAnchorDateChange: (d: string) => void;
  onReload: () => void;
  onCellClick?: (ctx: { mode: HeatmapMode; row: number; col: number; value: number; date: string }) => void;
  loadingLabel: string;
  reloadLabel: string;
  className?: string;
  variant?: "card" | "plain";
}) {
  const { t } = useT();

  const weekdayLabels = useMemo(
    () => [
      t("usage.weekday.mon"), t("usage.weekday.tue"), t("usage.weekday.wed"),
      t("usage.weekday.thu"), t("usage.weekday.fri"), t("usage.weekday.sat"),
      t("usage.weekday.sun"),
    ],
    [t],
  );

  const rangeLabel = useMemo(() => {
    if (!heatmap) return "";
    if (mode === "week" && heatmap.week_start && heatmap.week_end) {
      return `${fmtDay(heatmap.week_start)} ~ ${fmtDay(heatmap.week_end)}`;
    }
    return `${fmtDay(heatmap.range_start)} ~ ${fmtDay(heatmap.range_end)}`;
  }, [heatmap, mode]);

  const descKey = mode === "week"
    ? "status.heatmap.desc.week"
    : mode === "month"
      ? "status.heatmap.desc.month"
      : "status.heatmap.desc.cumulative";

  const titleKey = mode === "week"
    ? "status.heatmap.title.week"
    : mode === "month"
      ? "status.heatmap.title.month"
      : "status.heatmap.title.cumulative";

  const goPrev = () => {
    if (mode === "week") {
      onAnchorDateChange(addDays(heatmap?.week_start ?? anchorDate, -7));
    } else if (mode === "month") {
      onAnchorDateChange(addMonths(anchorDate, -1));
    }
  };

  const goNext = () => {
    if (mode === "week") {
      onAnchorDateChange(addDays(heatmap?.week_start ?? anchorDate, 7));
    } else if (mode === "month") {
      onAnchorDateChange(addMonths(anchorDate, 1));
    }
  };

  const weekRowLabels = useMemo(() => {
    if (!heatmap || mode !== "week") return [];
    return heatmap.dates.map((d, i) => `${fmtDay(d)} ${weekdayLabels[i]}`);
  }, [heatmap, mode, weekdayLabels]);

  const bandRowLabels = useMemo(
    () => HOUR_BAND_KEYS.map((k) => t(k)),
    [t],
  );

  const dailyOnlySet = useMemo(
    () => new Set(heatmap?.daily_only_cols ?? []),
    [heatmap?.daily_only_cols],
  );

  const tooltip = useCallback((
    row: number,
    col: number,
    value: number,
    colDate: string,
  ) => {
    if (mode === "week") {
      return t("status.heatmap.tooltip")
        .replace("{date}", fmtDay(colDate))
        .replace("{wd}", weekdayLabels[row])
        .replace("{h}", String(col).padStart(2, "0"))
        .replace("{h2}", String(col + 1).padStart(2, "0"))
        .replace("{v}", String(value));
    }
    const bandLabel = bandRowLabels[row] ?? "";
    const dailyOnly = dailyOnlySet.has(col);
    const tpl = dailyOnly ? t("status.heatmap.tooltip.daySummary") : t("status.heatmap.tooltip.dayBand");
    return tpl
      .replace("{date}", fmtDay(colDate))
      .replace("{band}", bandLabel)
      .replace("{v}", String(value));
  }, [mode, weekdayLabels, bandRowLabels, dailyOnlySet, t]);

  const colCount = heatmap?.matrix[0]?.length ?? (mode === "week" ? 24 : 0);
  const rowCount = heatmap?.matrix.length ?? 7;
  const isDayMode = mode !== "week";
  // 月/累计列数多：左轴加宽以容纳「0–2 时」类标签；网格用 flex 铺满，与周视图一致
  const labelColClass = isDayMode
    ? "w-[4.25rem] shrink-0"
    : "w-16 shrink-0";

  const shellClass = variant === "card"
    ? `bg-card rounded-2xl border border-border p-5 transition-shadow duration-300 hover:shadow-card apiplatform-fade-slide-up ${className}`
    : className;

  return (
    <div className={shellClass} style={variant === "card" ? { animationDelay: "280ms" } : undefined}>
      <SectionHeader
        eyebrow={t("status.heatmap.eyebrow")}
        title={t(titleKey)}
        desc={fmtStr(t(descKey), {
          range: rangeLabel,
          total: heatmap ? heatmap.total.toLocaleString() : "0",
        })}
        descMaxCh={88}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SegmentedToggle
              value={mode}
              onChange={onModeChange}
              options={[
                { key: "week", label: t("status.heatmap.mode.week") },
                { key: "month", label: t("status.heatmap.mode.month") },
                { key: "cumulative", label: t("status.heatmap.mode.cumulative") },
              ]}
            />
            {mode !== "cumulative" && (
              <>
                <button
                  type="button"
                  onClick={goPrev}
                  aria-label={mode === "week" ? t("status.heatmap.prevWeek") : t("status.heatmap.prevMonth")}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg border transition-colors hover:border-brand"
                  style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                >
                  <ChevronLeft size={15} />
                </button>
                <input
                  type="date"
                  value={anchorDate}
                  onChange={(e) => { if (e.target.value) onAnchorDateChange(e.target.value); }}
                  aria-label={t("status.heatmap.selectDate")}
                  className="h-8 px-2 rounded-lg text-[12px] tabular-nums outline-none transition-colors hover:border-brand"
                  style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", color: "var(--fg)" }}
                />
                <button
                  type="button"
                  onClick={goNext}
                  aria-label={mode === "week" ? t("status.heatmap.nextWeek") : t("status.heatmap.nextMonth")}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg border transition-colors hover:border-brand"
                  style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                >
                  <ChevronRight size={15} />
                </button>
              </>
            )}
          </div>
        }
      />

      {loading || (!heatmap && !error) ? (
        <div className="h-40 flex items-center justify-center gap-2 text-[13px] text-fg-muted">
          <RefreshCw className="w-4 h-4 animate-spin" style={{ color: "var(--brand)" }} />
          {loadingLabel}
        </div>
      ) : error ? (
        <div className="h-40 flex flex-col items-center justify-center gap-2 text-[13px] text-fg-muted">
          <span>{error}</span>
          <button
            onClick={onReload}
            className="px-3 py-1.5 rounded-lg border text-[11px] transition-colors hover:border-brand"
            style={{ borderColor: "var(--border)" }}
          >
            {reloadLabel}
          </button>
        </div>
      ) : heatmap ? (
        <div className="overflow-x-auto">
          <div className={isDayMode ? "min-w-[720px]" : "min-w-[560px]"}>
            <div className="flex mb-1">
              <div className={labelColClass} />
              <div className="flex flex-1 gap-0.5 min-w-0">
                {Array.from({ length: colCount }, (_, c) => {
                  let label = "";
                  if (mode === "week") {
                    label = c % 4 === 0 ? String(c).padStart(2, "0") : "";
                  } else {
                    label = dayAxisLabel(heatmap.dates[c], c, colCount);
                  }
                  return (
                    <div
                      key={c}
                      className="flex-1 min-w-0 text-center text-[9px] text-fg-subtle tabular-nums leading-tight"
                      title={isDayMode && heatmap.dates[c] ? fmtDay(heatmap.dates[c]) : undefined}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>
            </div>
            {Array.from({ length: rowCount }, (_, rIdx) => {
              const rowLabel = mode === "week"
                ? (weekRowLabels[rIdx] ?? "")
                : (bandRowLabels[rIdx] ?? "");
              return (
                <div key={rIdx} className="flex items-center mb-0.5">
                  <div
                    className={`${labelColClass} text-[11px] text-fg-subtle pr-2 text-right whitespace-nowrap`}
                    title={rowLabel}
                  >
                    {rowLabel}
                  </div>
                  <div className="flex flex-1 gap-0.5 min-w-0">
                    {Array.from({ length: colCount }, (_, cIdx) => {
                      const v = heatmap.matrix[rIdx]?.[cIdx] ?? 0;
                      const ratio = heatmap.max > 0 ? v / heatmap.max : 0;
                      const colDate = mode === "week"
                        ? (heatmap.dates[rIdx] ?? "")
                        : (heatmap.dates[cIdx] ?? "");
                      const dailyOnly = mode !== "week" && dailyOnlySet.has(cIdx);
                      // 贴边列改对齐，避免 tooltip 被 overflow-x 容器裁切
                      const edgePad = Math.max(2, Math.ceil(colCount * 0.08));
                      const hAlign = cIdx < edgePad
                        ? "left-0"
                        : cIdx >= colCount - edgePad
                          ? "right-0"
                          : "left-1/2 -translate-x-1/2";
                      const vAlign = rIdx === 0
                        ? "top-full mt-1.5"
                        : "bottom-full mb-1.5";
                      const tooltipClasses = `absolute ${vAlign} ${hAlign} px-2 py-1 rounded-md bg-neutral-800 text-neutral-100 shadow-lg text-[10px] whitespace-nowrap pointer-events-none opacity-0 group-hover/cell:opacity-100 transition-opacity duration-150 z-30 font-sans`;
                      const clickable = v > 0 && !!onCellClick;
                      return (
                        <div
                          key={cIdx}
                          className={`rounded-[3px] transition-all duration-150 relative group/cell aspect-square flex-1 min-w-0 ${clickable ? "cursor-pointer hover:scale-125 hover:z-20" : "cursor-default"}`}
                          style={{
                            background: cellBg(ratio),
                            minHeight: isDayMode ? 18 : 14,
                            outline: dailyOnly && v > 0 ? "1px dashed rgba(var(--brand-rgb), 0.45)" : undefined,
                          }}
                          onClick={() => {
                            if (!clickable) return;
                            onCellClick?.({ mode, row: rIdx, col: cIdx, value: v, date: colDate });
                          }}
                        >
                          <div className={tooltipClasses}>
                            {tooltip(rIdx, cIdx, v, colDate)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-end gap-2 mt-3 text-[10px] text-fg-muted">
              <span>{t("status.heatmap.low")}</span>
              {[0, 0.15, 0.35, 0.6, 0.85, 1].map((r, i) => (
                <div key={i} className="w-3 h-3 rounded-[3px]" style={{
                  background: r === 0 ? "var(--bg-soft)" : `rgba(var(--brand-rgb), ${r})`,
                }} />
              ))}
              <span>{t("status.heatmap.high")}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
