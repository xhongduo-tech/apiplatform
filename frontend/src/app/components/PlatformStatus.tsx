import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Activity, Cpu, Database, KeyRound,
  Radio, RefreshCw, TrendingUp, Zap,
} from "lucide-react";
import {
  api,
  type ContextLengthResponse,
  type PlatformHeatmapResponse,
  type PlatformStatusData,
  type ModelInfo,
  type HeatmapMode,
  type ToolCallsResponse,
} from "../api/gateway";
import { useCountUp } from "../hooks/use-count-up";
import { CATEGORY_COLORS } from "./home/shared";
import { PAGE_TITLE_CLASS } from "./ui/utils";
import { BreakdownDrawer, type BreakdownDimensionDef } from "./stats/BreakdownDrawer";
import {
  DonutChart, SegmentedToggle, HeroKpiCard, SectionHeader, RangeToggle,
  fmtStr, fmtCompact, fmtPct, fmtSignedPct, DONUT_PALETTE,
} from "./stats/status-widgets";
import { CallHeatmapPanel, localDateStr } from "./stats/call-heatmap";
import { SessionContextLengthChart, SessionToolCallsChart } from "./stats/session-charts";
import { useT } from "../i18n";

// 公开页只开放非敏感维度：项目名（project）会点名具体业务，需管理员权限，
// 公开抽屉仅保留模型与场景，与 /public/platform-status/breakdown 的口径一致
const PUBLIC_BREAKDOWN_DIMENSIONS: BreakdownDimensionDef[] = [
  { key: "model", labelKey: "breakdown.dim.model" },
  { key: "scene", labelKey: "breakdown.dim.scene" },
];

/* ──────────────────────────────────────────────────────────────
   Top hero stat cards（5 模块）
────────────────────────────────────────────────────────────── */
type PeriodKey = "day" | "month" | "cumulative";

const TREND_RANGE_OPTIONS = [7, 14, 30, 60, 90];
const DIST_RANGE_OPTIONS = [7, 30, 90];

function PeriodToggle({ value, onChange }: { value: PeriodKey; onChange: (v: PeriodKey) => void }) {
  const { t } = useT();
  return (
    <SegmentedToggle
      value={value}
      onChange={onChange}
      options={[
        { key: "day", label: t("status.kpi.period.day") },
        { key: "month", label: t("status.kpi.period.month") },
        { key: "cumulative", label: t("status.kpi.period.cumulative") },
      ]}
    />
  );
}

function YoYText({ value }: { value: number | null }) {
  const { t } = useT();
  if (value === null) return <span>{t("status.kpi.yoyNone")}</span>;
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold tabular-nums ${value >= 0 ? "text-ok" : "text-danger"}`}>
      <TrendingUp size={11} className={value >= 0 ? "" : "rotate-180"} />
      {fmtStr(t("status.kpi.yoy"), { pct: fmtSignedPct(value) })}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Main page
────────────────────────────────────────────────────────────── */
export function PlatformStatus() {
  const { t } = useT();
  const [data, setData] = useState<PlatformStatusData | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // 趋势/场景/模型三区共享同一个时间窗口（顶部「近 N 天…」右侧的 7d/14d…切换）
  const [days, setDays] = useState(30);
  const [hoveredScene, setHoveredScene] = useState<number | null>(null);
  const [hoveredModelPie, setHoveredModelPie] = useState<number | null>(null);
  const [breakdownDim, setBreakdownDim] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("day");
  const [modelMetric, setModelMetric] = useState<"calls" | "tokens">("calls");

  // ── 调用热力图：周/月/累计 ──
  const [heatmap, setHeatmap] = useState<PlatformHeatmapResponse | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("week");
  const [anchorDate, setAnchorDate] = useState(() => localDateStr(new Date()));
  const heatmapReqRef = useRef(0);

  const [toolCalls, setToolCalls] = useState<ToolCallsResponse | null>(null);
  const [contextLength, setContextLength] = useState<ContextLengthResponse | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionReqRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [res, modelsRes] = await Promise.all([
        api.platformStatus({ trendDays: days, distDays: days }),
        api.models().catch(() => ({ data: [] as ModelInfo[] })),
      ]);
      setData(res);
      setModels(modelsRes.data);
      setLastUpdated(new Date());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("status.loadFailed"));
    }
  }, [days, t]);

  useEffect(() => {
    load();
  }, [load]);

  const fetchHeatmap = useCallback(async () => {
    const reqId = ++heatmapReqRef.current;
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      const res = await api.platformStatusHeatmap({
        mode: heatmapMode,
        date: heatmapMode === "cumulative" ? undefined : anchorDate,
      });
      if (reqId !== heatmapReqRef.current) return;
      setHeatmap({ ...res, mode: heatmapMode });
    } catch {
      if (reqId !== heatmapReqRef.current) return;
      setHeatmapError(t("status.heatmap.loadFailed"));
    } finally {
      if (reqId === heatmapReqRef.current) setHeatmapLoading(false);
    }
  }, [anchorDate, heatmapMode, t]);

  useEffect(() => {
    fetchHeatmap();
  }, [fetchHeatmap]);

  const fetchSessionCharts = useCallback(async () => {
    const reqId = ++sessionReqRef.current;
    setSessionLoading(true);
    setSessionError(null);
    try {
      const [tc, ctx] = await Promise.all([
        api.platformStatusToolCalls(days),
        api.platformStatusContextLength(days),
      ]);
      if (reqId !== sessionReqRef.current) return;
      setToolCalls(tc);
      setContextLength(ctx);
    } catch {
      if (reqId !== sessionReqRef.current) return;
      setSessionError(t("usage.error.sessionChartsLoad"));
    } finally {
      if (reqId === sessionReqRef.current) setSessionLoading(false);
    }
  }, [days, t]);

  useEffect(() => {
    fetchSessionCharts();
  }, [fetchSessionCharts]);

  // 日/月/累计：顶部「API 调用次数 / Token 消耗」两张卡随 period 切换展示值与同比
  const periodCalls = data
    ? period === "day" ? data.today.calls
    : period === "month" ? data.month.calls
    : data.cumulative.calls
    : 0;
  const periodTokens = data
    ? period === "day" ? data.today.tokens
    : period === "month" ? data.month.tokens
    : data.cumulative.tokens
    : 0;
  const yoyCalls = data?.yoy?.[period]?.calls ?? null;
  const yoyTokens = data?.yoy?.[period]?.tokens ?? null;
  const callsDisplay = useCountUp(periodCalls, 1100, !!data, fmtCompact);
  const tokensDisplay = useCountUp(periodTokens, 1200, !!data, fmtCompact);

  // 近 5 分钟请求卡：主值 = 近 5 分钟请求数量，小字 = 近 1 小时请求数量
  const recent5minCallsDisplay = useCountUp(data?.realtime.recent_5min.calls ?? 0, 1000, !!data, fmtCompact);
  const recent1hCalls = data?.realtime.recent_1h.calls ?? 0;

  const trendData = useMemo(() => (data?.trend ?? []).map((d) => {
    const [, m, day] = d.day.split("-");
    return { day: `${Number(m)}/${Number(day)}`, fullDay: d.day, calls: d.calls, tokens: d.tokens };
  }), [data]);

  /* ── Derived metrics ── */
  const derived = useMemo(() => {
    if (!data) return null;
    if (trendData.length === 0) {
      // 空库（新部署/刚清库）：趋势为空不整块空白，KPI 卡/分布区仍渲染、数值归零
      return {
        callsGrowth: 0, tokensGrowth: 0,
        totalWindowCalls: 0, totalWindowTokens: 0,
        onlineModelCount: models.filter((m) => m.status === "online").length,
        totalModelCount: models.length,
      };
    }
    const half = Math.floor(trendData.length / 2);
    const secondHalf = trendData.slice(half);
    const firstHalf = trendData.slice(0, half);
    const sumCalls = (arr: typeof trendData) => arr.reduce((s, d) => s + d.calls, 0);
    const sumTokens = (arr: typeof trendData) => arr.reduce((s, d) => s + d.tokens, 0);
    const c2 = sumCalls(secondHalf);
    const c1 = sumCalls(firstHalf);
    const callsGrowth = c1 > 0 ? ((c2 - c1) / c1) * 100 : 0;
    const t2 = sumTokens(secondHalf);
    const t1 = sumTokens(firstHalf);
    const tokensGrowth = t1 > 0 ? ((t2 - t1) / t1) * 100 : 0;
    const totalWindowCalls = sumCalls(trendData);
    const totalWindowTokens = sumTokens(trendData);
    const onlineModelCount = models.filter((m) => m.status === "online").length;
    const totalModelCount = models.length;
    return {
      callsGrowth, tokensGrowth,
      totalWindowCalls, totalWindowTokens,
      onlineModelCount, totalModelCount,
    };
  }, [data, trendData, models]);

  // 场景分布：固定 5 类（后端已按 SCENE_TYPES 顺序返回），过滤 0 桶避免环图空弧渲染异常
  const sceneDonutData = useMemo(() => (data?.by_scene ?? [])
    .filter((s) => s.calls > 0)
    .map((s, i) => ({
      name: s.label,
      value: s.calls,
      key: s.category,
      color: CATEGORY_COLORS[s.category]?.bg ?? DONUT_PALETTE[i % DONUT_PALETTE.length],
    })), [data]);

  // 模型分布：右上角切换「调用次数 / Token 消耗」，数据随 metric 变化；
  // 先按 metric 排序再取 Top 6，切到 Token 时展示的是 Token 最高的模型
  const modelDonutData = useMemo(() => [...(data?.by_model ?? [])]
    .sort((a, b) => (modelMetric === "calls" ? b.calls - a.calls : b.tokens - a.tokens))
    .slice(0, 6)
    .map((m, i) => ({
      name: m.name,
      value: modelMetric === "calls" ? m.calls : m.tokens,
      key: m.model_id,
      color: DONUT_PALETTE[i % DONUT_PALETTE.length],
    })), [data, modelMetric]);

  // 场景/模型分布的一行解释（仿照流量趋势 desc）：取占比/值最高的桶
  const sceneSummary = useMemo(() => {
    if (!sceneDonutData.length) return null;
    const total = sceneDonutData.reduce((s, d) => s + d.value, 0);
    if (!total) return null;
    const top = sceneDonutData.reduce((mx, d) => (d.value > mx.value ? d : mx), sceneDonutData[0]);
    return { topName: top.name, pct: (top.value / total) * 100, total };
  }, [sceneDonutData]);

  const modelSummary = useMemo(() => {
    if (!modelDonutData.length) return null;
    return { topName: modelDonutData[0].name, topValue: modelDonutData[0].value };
  }, [modelDonutData]);

  const loading = !data && !error;

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="container-1200 py-10">

        {/* Header */}
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Activity size={13} className="text-fg-subtle" />
              <span className="section-label">{t("status.label")}</span>
              <span className="text-[11px] text-fg-subtle">
                {fmtStr(t("status.updatedAt"), { time: lastUpdated?.toLocaleTimeString("zh-CN", { hour12: false }) ?? "--" })}
              </span>
            </div>
            <h1 className={PAGE_TITLE_CLASS}>{t("status.title")}</h1>
            <p className="page-desc">{t("status.desc")}</p>
          </div>
        </div>

        {error && !data ? (
          <div className="card p-8 text-center text-[13px] text-danger">{error}</div>
        ) : loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="card p-5">
                <div className="skeleton h-4 w-20" />
                <div className="skeleton mt-3 h-7 w-24" />
              </div>
            ))}
          </div>
        ) : derived && data && (
          <>
            {/* ── 顶部 5 模块 ── */}
            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <HeroKpiCard
                icon={<Zap size={16} />}
                label={t("status.kpi.calls")}
                value={callsDisplay}
                toggle={<PeriodToggle value={period} onChange={setPeriod} />}
                sub={<YoYText value={yoyCalls} />}
              />
              <HeroKpiCard
                icon={<Database size={16} />}
                label={t("status.kpi.tokens")}
                value={tokensDisplay}
                toggle={<PeriodToggle value={period} onChange={setPeriod} />}
                sub={<YoYText value={yoyTokens} />}
              />
              <HeroKpiCard
                icon={<Cpu size={16} />}
                label={t("status.kpi.models")}
                value={`${derived.onlineModelCount}`}
                sub={fmtStr(t("status.kpi.modelsTotal"), { total: derived.totalModelCount })}
              />
              <HeroKpiCard
                icon={<Radio size={16} />}
                label={t("status.kpi.recent5m")}
                value={recent5minCallsDisplay}
                sub={fmtStr(t("status.kpi.recent1hCalls"), { n: fmtCompact(recent1hCalls) })}
              />
              <HeroKpiCard
                icon={<KeyRound size={16} />}
                label={t("status.kpi.keys")}
                value={`${data.cumulative.active_keys}`}
                sub={fmtStr(t("status.kpi.monthlyActive"), { n: data.monthly_active_keys })}
              />
            </div>

            {/* ── 融合看板：流量趋势 + 场景分布 + 模型分布（共享 7d/14d…时间切换） ── */}
            <div className="card mb-6 p-6">
              <SectionHeader
                eyebrow={t("status.trend.eyebrow")}
                title={fmtStr(t("status.trend.title"), { n: days })}
                desc={fmtStr(t("status.trend.desc"), {
                  calls: fmtCompact(derived.totalWindowCalls),
                  tokens: fmtCompact(derived.totalWindowTokens),
                  growthText: derived.callsGrowth >= 0 ? t("status.trend.growth") : t("status.trend.decline"),
                  pct: fmtSignedPct(Math.abs(derived.callsGrowth)),
                })}
                right={<RangeToggle value={days} options={TREND_RANGE_OPTIONS} onChange={setDays} suffix="d" />}
              />
              <div className="grid gap-6 lg:grid-cols-2">
                <p className="sr-only">
                  {trendData.map((row) => `${row.fullDay || row.day}: ${t("status.trend.calls")} ${fmtCompact(row.calls)}, ${t("status.trend.tokens")} ${fmtCompact(row.tokens)}`).join("; ")}
                </p>
                {/* 调用量趋势 */}
                <div>
                  <div className="mb-2 flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-fg-muted">{t("status.trend.calls")}</span>
                    <span className="text-[18px] font-bold tabular-nums">{fmtCompact(derived.totalWindowCalls)}</span>
                  </div>
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart accessibilityLayer data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="calls-grad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#5B8DEF" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#5B8DEF" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} />
                        <YAxis tickCount={4} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} tickFormatter={(v: number) => fmtCompact(v)} />
                        <Tooltip
                          contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                          formatter={(value) => [fmtCompact(Number(value ?? 0)), t("status.trend.tooltipCalls")]}
                          labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullDay ?? ""}
                        />
                        <Area type="monotone" dataKey="calls" stroke="#5B8DEF" strokeWidth={2} fill="url(#calls-grad)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                {/* Token 消耗趋势 */}
                <div>
                  <div className="mb-2 flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-fg-muted">{t("status.trend.tokens")}</span>
                    <span className="text-[18px] font-bold tabular-nums">{fmtCompact(derived.totalWindowTokens)}</span>
                  </div>
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart accessibilityLayer data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="tokens-grad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#E87461" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#E87461" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} />
                        <YAxis tickCount={4} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 11, fill: "var(--fg-subtle)" }} tickFormatter={(v: number) => fmtCompact(v)} />
                        <Tooltip
                          contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                          formatter={(value) => [fmtCompact(Number(value ?? 0)), t("status.trend.tokens")]}
                          labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullDay ?? ""}
                        />
                        <Area type="monotone" dataKey="tokens" stroke="#E87461" strokeWidth={2} fill="url(#tokens-grad)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                {/* 场景分布 */}
                <div className="border-t border-border pt-6 lg:pt-8">
                  <div className="mb-4">
                    <p className="text-[12px] font-medium text-fg-muted">{t("status.scene.eyebrow")}</p>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">
                      {fmtStr(t("status.scene.desc"), {
                        calls: fmtCompact(sceneSummary?.total ?? 0),
                        topScene: sceneSummary?.topName ?? "—",
                        pct: fmtPct(sceneSummary?.pct ?? 0),
                      })}
                    </p>
                  </div>
                  {sceneDonutData.length === 0 ? (
                    <div className="py-10 text-center text-[12px] text-fg-muted">{t("status.noData")}</div>
                  ) : (
                    <DonutChart data={sceneDonutData} size={200} thickness={34} hovered={hoveredScene} onHover={setHoveredScene} centerLabel={t("status.model.totalCalls")} centerSub={fmtStr(t("status.scene.nearDays"), { n: days })} />
                  )}
                </div>
                {/* 模型分布 */}
                <div className="border-t border-border pt-6 lg:pt-8">
                  <div className="mb-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[12px] font-medium text-fg-muted">{t("status.model.eyebrow")}</p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setBreakdownDim("model")}
                          className="text-[11.5px] font-medium text-fg-muted transition-colors hover:text-fg"
                        >
                          {t("breakdown.viewAll")}
                        </button>
                        <SegmentedToggle
                          value={modelMetric}
                          onChange={(v) => setModelMetric(v)}
                          options={[
                            { key: "calls", label: t("status.model.metricCalls") },
                            { key: "tokens", label: t("status.model.metricTokens") },
                          ]}
                        />
                      </div>
                    </div>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">
                      {modelMetric === "calls"
                        ? fmtStr(t("status.model.descCalls"), { topModel: modelSummary?.topName ?? "—", value: fmtCompact(modelSummary?.topValue ?? 0) })
                        : fmtStr(t("status.model.descTokens"), { topModel: modelSummary?.topName ?? "—", value: fmtCompact(modelSummary?.topValue ?? 0) })}
                    </p>
                  </div>
                  {modelDonutData.length === 0 ? (
                    <div className="py-10 text-center text-[12px] text-fg-muted">{t("status.noData")}</div>
                  ) : (
                    <DonutChart data={modelDonutData} size={200} thickness={34} hovered={hoveredModelPie} onHover={setHoveredModelPie} centerLabel={modelMetric === "calls" ? t("status.model.totalCalls") : t("status.model.totalTokens")} centerSub={`of ${data.by_model.length}`} />
                  )}
                </div>
                {/* Tool Call 分布 */}
                <div className="border-t border-border pt-6 lg:pt-8">
                  <div className="mb-4">
                    <p className="text-[12px] font-medium text-fg-muted">{t("usage.session.toolCalls.eyebrow")}</p>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">
                      {toolCalls?.total_sessions
                        ? fmtStr(t("usage.session.toolCalls.desc"), {
                            n: days,
                            sessions: fmtCompact(toolCalls.total_sessions),
                          })
                        : fmtStr(t("usage.session.toolCalls.descEmpty"), { n: days })}
                    </p>
                  </div>
                  {sessionError ? (
                    <div className="flex flex-col items-center justify-center py-10 gap-2 text-[12px] text-fg-muted">
                      <span>{sessionError}</span>
                      <button
                        type="button"
                        onClick={() => fetchSessionCharts()}
                        className="rounded-full bg-bg-soft px-3 py-1 text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg"
                      >
                        {t("status.heatmap.reload")}
                      </button>
                    </div>
                  ) : sessionLoading && !toolCalls ? (
                    <div className="skeleton h-64 rounded-xl" />
                  ) : (
                    <SessionToolCallsChart buckets={toolCalls?.buckets ?? []} />
                  )}
                </div>
                {/* 上下文长度 */}
                <div className="border-t border-border pt-6 lg:pt-8">
                  <div className="mb-4">
                    <p className="text-[12px] font-medium text-fg-muted">{t("usage.session.contextLength.eyebrow")}</p>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">
                      {contextLength?.total
                        ? fmtStr(t("usage.session.contextLength.desc"), {
                            n: days,
                            p50: fmtCompact(contextLength.p50),
                          })
                        : fmtStr(t("usage.session.contextLength.descEmpty"), { n: days })}
                    </p>
                  </div>
                  {sessionError ? null : sessionLoading && !contextLength ? (
                    <div className="skeleton h-64 rounded-xl" />
                  ) : (
                    <SessionContextLengthChart
                      buckets={(contextLength?.buckets ?? []).map((b) => ({
                        label: b.label,
                        count: b.count,
                        share: b.share,
                      }))}
                    />
                  )}
                </div>
              </div>
            </div>

          </>
        )}

        {data && !error && (
          <div className="card mb-6 p-6">
            <CallHeatmapPanel
              heatmap={heatmap}
              loading={heatmapLoading}
              error={heatmapError}
              mode={heatmapMode}
              onModeChange={setHeatmapMode}
              anchorDate={anchorDate}
              onAnchorDateChange={setAnchorDate}
              onReload={fetchHeatmap}
              loadingLabel={t("status.heatmap.loading")}
              reloadLabel={t("status.heatmap.reload")}
              variant="plain"
            />
          </div>
        )}

        <BreakdownDrawer
          open={breakdownDim !== null}
          onClose={() => setBreakdownDim(null)}
          title={breakdownDim === "model" ? t("status.model.title") : t("status.scene.title")}
          dimensions={PUBLIC_BREAKDOWN_DIMENSIONS}
          initialDimension={breakdownDim ?? undefined}
          days={days}
          fetcher={api.platformStatusBreakdown}
        />
      </div>
    </div>
  );
}
