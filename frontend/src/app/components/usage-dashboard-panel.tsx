import { useCallback, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Activity, ArrowUpRight, BarChart3, CircleDollarSign, Database, Gauge,
  KeyRound, TrendingUp, Zap,
} from "lucide-react";
import type { BreakdownParams, HeatmapMode } from "../api/gateway";
import { api } from "../api/gateway";
import { useT } from "../i18n";
import {
  DonutChart, SegmentedToggle, HeroKpiCard, SectionHeader, RangeToggle,
  fmtStr, fmtCompact, fmtPct, fmtSignedPct,
} from "./stats/status-widgets";
import { CallHeatmapPanel } from "./stats/call-heatmap";
import { SessionContextLengthChart, SessionToolCallsChart } from "./stats/session-charts";
import { BreakdownDrawer, type BreakdownDimensionDef } from "./stats/BreakdownDrawer";
import type { UsageDashboardData } from "../hooks/use-usage-dashboard-data";

const TREND_RANGE_OPTIONS = [7, 14, 30, 60, 90];

const USAGE_BREAKDOWN_DIMENSIONS: BreakdownDimensionDef[] = [
  { key: "project", labelKey: "breakdown.dim.scene" },
  { key: "model", labelKey: "breakdown.dim.model" },
];

function KpiGrowth({ text, pct }: { text: string; pct: string }) {
  if (pct === "—") return <span>{text}</span>;
  const up = !pct.startsWith("-");
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold tabular-nums ${up ? "text-ok" : "text-danger"}`}>
      <TrendingUp size={11} className={up ? "" : "rotate-180"} />
      {text}
    </span>
  );
}

export interface UsageDashboardPanelProps {
  data: UsageDashboardData;
  token: string;
  onHeatmapCellClick?: (ctx: {
    mode: HeatmapMode; row: number; col: number; value: number; date: string;
  }) => void;
  showEmptyState?: boolean;
}

export function UsageDashboardPanel({ data, token, onHeatmapCellClick, showEmptyState = false }: UsageDashboardPanelProps) {
  const { t } = useT();
  const scope = data.scope;
  const gradPrefix = scope === "admin" ? "admin" : "usage";
  const [breakdownDim, setBreakdownDim] = useState<string | null>(null);

  const fetchBreakdown = useCallback(
    (params: BreakdownParams) =>
      scope === "admin"
        ? api.adminStatsBreakdown(token, params)
        : api.userStatsBreakdown(token, params),
    [scope, token],
  );

  const kpiSub = (v: string | null) =>
    v != null && data.kpiGrowthLabel
      ? <KpiGrowth text={fmtStr(data.kpiGrowthLabel, { pct: v })} pct={v} />
      : <span>{t("usage.kpi.allTime")}</span>;

  const fifthIcon = data.fifthKpiIcon === "cost"
    ? <CircleDollarSign size={16} />
    : <Gauge size={16} />;

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <HeroKpiCard
          icon={<Zap size={16} />}
          label={t("usage.kpi.calls")}
          value={data.kpiReady ? data.callsDisplay : "—"}
          toggle={
            <SegmentedToggle
              value={data.period}
              onChange={data.setPeriod}
              options={[
                { key: "day", label: t("usage.kpi.period.day") },
                { key: "month", label: t("usage.kpi.period.month") },
                { key: "cumulative", label: t("usage.kpi.period.cumulative") },
              ]}
            />
          }
          sub={kpiSub(data.callsGrowthV)}
        />
        <HeroKpiCard
          icon={<Database size={16} />}
          label={t("usage.kpi.tokens")}
          value={data.kpiReady ? data.tokensDisplay : "—"}
          toggle={
            <SegmentedToggle
              value={data.period}
              onChange={data.setPeriod}
              options={[
                { key: "day", label: t("usage.kpi.period.day") },
                { key: "month", label: t("usage.kpi.period.month") },
                { key: "cumulative", label: t("usage.kpi.period.cumulative") },
              ]}
            />
          }
          sub={kpiSub(data.tokensGrowthV)}
        />
        <HeroKpiCard
          icon={<KeyRound size={16} />}
          label={data.keysKpiLabel}
          value={data.keyCardValue}
          sub={data.keyCardSub}
        />
        <HeroKpiCard
          icon={<Activity size={16} />}
          label={t("usage.kpi.health")}
          value={data.healthValue}
          sub={data.healthSub}
        />
        <HeroKpiCard
          icon={fifthIcon}
          label={data.fifthKpiLabel}
          value={data.rateInfo.value}
          sub={data.rateInfo.sub}
        />
      </div>

      <div className="card mb-6 p-6">
        <SectionHeader
          eyebrow={t("usage.trend.eyebrow")}
          title={fmtStr(t("usage.trend.title"), { n: data.days })}
          desc={data.derived ? fmtStr(t("usage.trend.desc"), {
            calls: fmtCompact(data.derived.totalWindowCalls),
            tokens: fmtCompact(data.derived.totalWindowTokens),
            growthText: data.derived.callsGrowth >= 0 ? t("usage.trend.growth") : t("usage.trend.decline"),
            pct: fmtSignedPct(Math.abs(data.derived.callsGrowth)),
          }) : undefined}
          right={<RangeToggle value={data.days} options={TREND_RANGE_OPTIONS} onChange={data.setDays} suffix="d" />}
        />

        {data.tsError ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-[12px] text-fg-muted">
            <span>{data.tsError}</span>
            <button
              type="button"
              onClick={() => data.fetchTimeseries()}
              className="rounded-full bg-bg-soft px-3 py-1 text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg"
            >
              {t("usage.common.reload")}
            </button>
          </div>
        ) : data.tsLoading && data.trendData.length === 0 ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <p className="sr-only">
              {data.trendData.map((row) => `${row.fullDay || row.day}: ${t("usage.trend.calls")} ${fmtCompact(row.calls)}, ${t("usage.trend.tokens")} ${fmtCompact(row.tokens)}`).join("; ")}
            </p>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-48 rounded-xl" />
            ))}
          </div>
        ) : data.trendData.length === 0 ? (
          <div className="py-12 text-center text-[12px] text-fg-muted">{t("usage.detail.noData")}</div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[12px] font-medium text-fg-muted">{t("usage.trend.calls")}</span>
                <span className="text-[18px] font-bold tabular-nums">{fmtCompact(data.derived?.totalWindowCalls ?? 0)}</span>
              </div>
              <div style={{ width: "100%", height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart accessibilityLayer data={data.trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id={`${gradPrefix}-calls-grad`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#5B8DEF" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#5B8DEF" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} />
                    <YAxis tickCount={4} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} tickFormatter={(v: number) => fmtCompact(v)} />
                    <Tooltip
                      contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      formatter={(value) => [fmtCompact(Number(value ?? 0)), t("usage.trend.calls")]}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullDay ?? ""}
                    />
                    <Area type="monotone" dataKey="calls" stroke="#5B8DEF" strokeWidth={2} fill={`url(#${gradPrefix}-calls-grad)`} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[12px] font-medium text-fg-muted">{t("usage.trend.tokens")}</span>
                <span className="text-[18px] font-bold tabular-nums">{fmtCompact(data.derived?.totalWindowTokens ?? 0)}</span>
              </div>
              <div style={{ width: "100%", height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart accessibilityLayer data={data.trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id={`${gradPrefix}-tokens-grad`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#E87461" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#E87461" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} />
                    <YAxis tickCount={4} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} tickFormatter={(v: number) => fmtCompact(v)} />
                    <Tooltip
                      contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      formatter={(value) => [fmtCompact(Number(value ?? 0)), t("usage.trend.tokens")]}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullDay ?? ""}
                    />
                    <Area type="monotone" dataKey="tokens" stroke="#E87461" strokeWidth={2} fill={`url(#${gradPrefix}-tokens-grad)`} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="border-t border-border pt-6 lg:pt-8">
              <div className="mb-4">
                <p className="text-[12px] font-medium text-fg-muted">{t("usage.scene.eyebrow")}</p>
                <p className="mt-1 text-[11.5px] text-fg-subtle">
                  {data.sceneSummary
                    ? fmtStr(t("usage.scene.desc"), {
                        calls: fmtCompact(data.sceneSummary.total),
                        topScene: data.sceneSummary.topName,
                        pct: fmtPct(data.sceneSummary.pct),
                      })
                    : t("usage.detail.noData")}
                </p>
              </div>
              <div key={data.sceneDonutKey} style={data.donutEnter}>
                {data.sceneDonutData.length === 0 ? (
                  <div className="py-10 text-center text-[12px] text-fg-muted">{t("usage.detail.noData")}</div>
                ) : (
                  <DonutChart
                    data={data.sceneDonutData}
                    size={200}
                    thickness={34}
                    hovered={data.hoveredScene}
                    onHover={data.setHoveredScene}
                    centerLabel={t("usage.scene.totalCalls")}
                    legendFooter={
                      <button
                        type="button"
                        onClick={() => setBreakdownDim("project")}
                        className="text-[11.5px] font-medium text-fg-muted transition-colors hover:text-fg"
                      >
                        {t("breakdown.viewAll")}
                      </button>
                    }
                  />
                )}
              </div>
            </div>
            <div className="border-t border-border pt-6 lg:pt-8">
              <div className="mb-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-medium text-fg-muted">{t("usage.model.eyebrow")}</p>
                  <SegmentedToggle
                    value={data.modelMetric}
                    onChange={(v) => data.setModelMetric(v)}
                    options={[
                      { key: "calls", label: t("usage.model.metricCalls") },
                      { key: "tokens", label: t("usage.model.metricTokens") },
                    ]}
                  />
                </div>
                <p className="mt-1 text-[11.5px] text-fg-subtle">
                  {data.modelMetric === "calls"
                    ? fmtStr(t("usage.model.descCalls"), { topModel: data.modelSummary?.topName ?? "—", value: fmtCompact(data.modelSummary?.topValue ?? 0) })
                    : fmtStr(t("usage.model.descTokens"), { topModel: data.modelSummary?.topName ?? "—", value: fmtCompact(data.modelSummary?.topValue ?? 0) })}
                </p>
              </div>
              <div key={data.modelDonutKey} style={data.donutEnter}>
                {data.modelDonutData.length === 0 ? (
                  <div className="py-10 text-center text-[12px] text-fg-muted">{t("usage.detail.noData")}</div>
                ) : (
                  <DonutChart
                    data={data.modelDonutData}
                    size={200}
                    thickness={34}
                    hovered={data.hoveredModelPie}
                    onHover={data.setHoveredModelPie}
                    centerLabel={data.modelMetric === "calls" ? t("usage.model.totalCalls") : t("usage.model.totalTokens")}
                    legendFooter={
                      <button
                        type="button"
                        onClick={() => setBreakdownDim("model")}
                        className="text-[11.5px] font-medium text-fg-muted transition-colors hover:text-fg"
                      >
                        {t("breakdown.viewAll")}
                      </button>
                    }
                  />
                )}
              </div>
            </div>
            <div className="border-t border-border pt-6 lg:pt-8">
              <div className="mb-4">
                <p className="text-[12px] font-medium text-fg-muted">{t("usage.session.toolCalls.eyebrow")}</p>
                <p className="mt-1 text-[11.5px] text-fg-subtle">
                  {data.toolCalls?.total_sessions
                    ? fmtStr(t("usage.session.toolCalls.desc"), {
                        n: data.days,
                        sessions: fmtCompact(data.toolCalls.total_sessions),
                      })
                    : fmtStr(t("usage.session.toolCalls.descEmpty"), { n: data.days })}
                </p>
              </div>
              {data.sessionError ? (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-[12px] text-fg-muted">
                  <span>{data.sessionError}</span>
                  <button
                    type="button"
                    onClick={() => data.fetchSessionCharts()}
                    className="rounded-full bg-bg-soft px-3 py-1 text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg"
                  >
                    {t("usage.common.reload")}
                  </button>
                </div>
              ) : data.sessionLoading && !data.toolCalls ? (
                <div className="skeleton h-64 rounded-xl" />
              ) : (
                <SessionToolCallsChart buckets={data.toolCalls?.buckets ?? []} />
              )}
            </div>
            <div className="border-t border-border pt-6 lg:pt-8">
              <div className="mb-4">
                <p className="text-[12px] font-medium text-fg-muted">{t("usage.session.contextLength.eyebrow")}</p>
                <p className="mt-1 text-[11.5px] text-fg-subtle">
                  {data.contextLength?.total
                    ? fmtStr(t("usage.session.contextLength.desc"), {
                        n: data.days,
                        p50: fmtCompact(data.contextLength.p50),
                      })
                    : fmtStr(t("usage.session.contextLength.descEmpty"), { n: data.days })}
                </p>
              </div>
              {data.sessionError ? null : data.sessionLoading && !data.contextLength ? (
                <div className="skeleton h-64 rounded-xl" />
              ) : (
                <SessionContextLengthChart
                  buckets={(data.contextLength?.buckets ?? []).map((b) => ({
                    label: b.label,
                    count: b.count,
                    share: b.share,
                  }))}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <CallHeatmapPanel
        heatmap={data.heatmap}
        loading={data.heatmapLoading}
        error={data.heatmapError}
        mode={data.heatmapMode}
        onModeChange={data.setHeatmapMode}
        anchorDate={data.anchorDate}
        onAnchorDateChange={data.setAnchorDate}
        onReload={data.fetchHeatmap}
        onCellClick={onHeatmapCellClick}
        loadingLabel={t("usage.common.loading")}
        reloadLabel={t("usage.common.reload")}
      />

      {showEmptyState && data.stats && data.stats.total_calls === 0 && !data.loading && (
        <div className="bg-card rounded-2xl border border-border p-10 flex flex-col items-center gap-4 text-center apiplatform-fade-slide-up" style={{ animationDelay: "200ms" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: "var(--bg-soft)" }}>
            <BarChart3 className="w-7 h-7" style={{ color: "var(--fg-subtle)" }} />
          </div>
          <div>
            <p className="font-serif text-[15px] font-medium text-foreground">
              {t("usage.empty.title").replace("{year}", String(data.currentYear))}
            </p>
            <p className="text-[13px] text-muted-foreground max-w-xs mt-1">{t("usage.empty.hint")}</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => { window.location.href = "/docs?section=authentication"; }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium text-white transition-all duration-200 apiplatform-btn hover:opacity-90"
              style={{ background: "var(--brand-solid)" }}
            >
              {t("usage.empty.getStarted")}
              <ArrowUpRight className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = "/keys"; }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[12px] transition-all duration-200 apiplatform-btn hover:border-brand"
              style={{ borderColor: "var(--border)" }}
            >
              {t("usage.empty.getKeys")}
            </button>
          </div>
        </div>
      )}

      <BreakdownDrawer
        open={breakdownDim !== null}
        onClose={() => setBreakdownDim(null)}
        title={breakdownDim === "model" ? t("usage.model.eyebrow") : t("usage.scene.eyebrow")}
        dimensions={USAGE_BREAKDOWN_DIMENSIONS}
        initialDimension={breakdownDim ?? undefined}
        days={data.days}
        fetcher={fetchBreakdown}
        enableCrossFilter
      />
    </>
  );
}
