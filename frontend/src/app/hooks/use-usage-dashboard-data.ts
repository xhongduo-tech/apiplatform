import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  api,
  type TimeseriesPoint,
  type LogStatsResponse,
  type RateLimitResponse,
  type CallHeatmapResponse,
  type HeatmapMode,
  type ContextLengthResponse,
  type ToolCallsResponse,
} from "../api/gateway";
import { useT } from "../i18n";
import { useCountUp } from "./use-count-up";
import { fmtStr, fmtCompact, fmtSignedPct } from "../components/stats/status-widgets";
import { localDateStr } from "../components/stats/call-heatmap";
import { API_BASE, authHeaders } from "../components/admin-tab-utils";
import { ADMIN_EXPIRED_EVENT } from "../api/gateway";

export interface ModelDistRow { model_id: string; calls: number; tokens: number }
export interface SceneDistRow { scene: string; label: string; calls: number; tokens: number }

export interface StatsSummary {
  year: number;
  monthly: { month: number; calls: number; tokens: number }[];
  total_tokens: number;
  total_calls: number;
  all_time_calls: number;
  all_time_tokens: number;
}

export type PeriodKey = "day" | "month" | "cumulative";
export type ModelMetric = "calls" | "tokens";
export type DashboardScope = "user" | "admin";

export interface AdminOverview {
  active_keys: number;
  online_models: number;
  estimated_token_cost: number;
}

function growth(curr: number, prev: number) {
  if (prev === 0) return curr > 0 ? "+100%" : "—";
  const pct = Math.round(((curr - prev) / prev) * 100);
  return (pct >= 0 ? "+" : "") + pct + "%";
}

async function adminJson<T>(token: string, path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { headers: authHeaders(token) });
  if (r.status === 401) {
    window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
    throw new Error("admin token expired");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function useUsageDashboardData(scope: DashboardScope, token: string | null) {
  const { t } = useT();
  const currentYear = new Date().getFullYear();

  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [modelDist, setModelDist] = useState<ModelDistRow[]>([]);
  const [sceneDist, setSceneDist] = useState<SceneDistRow[]>([]);

  const [days, setDays] = useState(30);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [tsLoading, setTsLoading] = useState(false);
  const [tsError, setTsError] = useState<string | null>(null);

  const [health, setHealth] = useState<LogStatsResponse | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitResponse | null>(null);
  const [keyCounts, setKeyCounts] = useState<{ active: number; monthlyActive: number } | null>(null);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);

  const [heatmap, setHeatmap] = useState<CallHeatmapResponse | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("week");
  const [anchorDate, setAnchorDate] = useState(() => localDateStr(new Date()));
  const heatmapReqRef = useRef(0);

  const [period, setPeriod] = useState<PeriodKey>("month");
  const [modelMetric, setModelMetric] = useState<ModelMetric>("calls");
  const [hoveredScene, setHoveredScene] = useState<number | null>(null);
  const [hoveredModelPie, setHoveredModelPie] = useState<number | null>(null);

  const [toolCalls, setToolCalls] = useState<ToolCallsResponse | null>(null);
  const [contextLength, setContextLength] = useState<ContextLengthResponse | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setStatsError(null);
    try {
      if (scope === "user") {
        setStats(await api.userStats(token, currentYear));
      } else {
        setStats(await adminJson(token, `/api/admin/stats/summary?year=${currentYear}`));
      }
    } catch {
      setStatsError(t("usage.error.statsLoad"));
      if (scope === "user") toast.error(t("usage.error.statsToast"));
    } finally {
      setLoading(false);
    }
  }, [token, currentYear, scope, t]);

  const fetchDist = useCallback(async () => {
    if (!token) return;
    try {
      if (scope === "user") {
        const [models, scenes] = await Promise.all([
          api.userStatsModels(token, { days }),
          api.userStatsScenes(token, days),
        ]);
        setModelDist(Array.isArray(models) ? models : []);
        setSceneDist(Array.isArray(scenes) ? scenes : []);
      } else {
        const [models, scenes] = await Promise.all([
          adminJson<ModelDistRow[]>(token, `/api/admin/stats/by_model?days=${days}`),
          adminJson<SceneDistRow[]>(token, `/api/admin/stats/by_scene?days=${days}`),
        ]);
        setModelDist(Array.isArray(models) ? models : []);
        setSceneDist(Array.isArray(scenes) ? scenes : []);
      }
    } catch {
      if (scope === "user") toast.error(t("usage.error.modelDist"));
    }
  }, [token, days, scope, t]);

  const fetchTimeseries = useCallback(async () => {
    if (!token) return;
    setTsLoading(true);
    setTsError(null);
    try {
      if (scope === "user") {
        const res = await api.userStatsTimeseries(token, { days });
        setTimeseries(Array.isArray(res.data) ? res.data : []);
      } else {
        const res = await adminJson<{ data: TimeseriesPoint[] }>(token, `/api/admin/stats/timeseries?days=${days}`);
        setTimeseries(Array.isArray(res.data) ? res.data : []);
      }
    } catch {
      setTsError(t("usage.error.timeseriesLoad"));
      if (scope === "user") toast.error(t("usage.error.timeseriesToast"));
    } finally {
      setTsLoading(false);
    }
  }, [token, days, scope, t]);

  const fetchHealth = useCallback(async () => {
    if (!token) return;
    try {
      if (scope === "user") {
        const end = new Date();
        const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
        const params = new URLSearchParams({
          date_from: start.toISOString().slice(0, 10),
          date_to: end.toISOString().slice(0, 10),
        });
        setHealth(await api.userLogsStats(token, params.toString()));
      } else {
        // 轻量专用接口：避免复用 /admin/usage（全表分位+distinct）在看板并发下超时
        setHealth(await adminJson<LogStatsResponse>(
          token, `/api/admin/stats/health?days=${days}`,
        ));
      }
    } catch { /* silent */ }
  }, [token, days, scope]);

  const fetchKeysAndRates = useCallback(async () => {
    if (!token) return;
    if (scope === "user") {
      try {
        const keysRes = await api.userKeys(token);
        const keys = (keysRes.data ?? []).filter((k) => k.status === "active");
        const monthAgo = new Date();
        monthAgo.setDate(monthAgo.getDate() - 30);
        const monthlyActive = keys.filter(
          (k) => k.last_used_at && new Date(`${k.last_used_at}T00:00:00`) >= monthAgo,
        ).length;
        setKeyCounts({ active: keys.length, monthlyActive });
      } catch { /* silent */ }
      try {
        setRateLimits(await api.userRateLimits(token));
      } catch { /* silent */ }
    } else {
      try {
        const ov = await adminJson<AdminOverview>(
          token, "/api/admin/stats/overview",
        );
        setAdminOverview({
          active_keys: ov.active_keys ?? 0,
          online_models: ov.online_models ?? 0,
          estimated_token_cost: Number(ov.estimated_token_cost ?? 0),
        });
        setKeyCounts({ active: ov.active_keys ?? 0, monthlyActive: ov.online_models ?? 0 });
      } catch { /* silent */ }
    }
  }, [token, scope]);

  const fetchHeatmap = useCallback(async () => {
    if (!token) return;
    const reqId = ++heatmapReqRef.current;
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      const params = {
        mode: heatmapMode,
        date: heatmapMode === "cumulative" ? undefined : anchorDate,
      };
      const res = scope === "user"
        ? await api.userStatsHeatmapWeek(token, params)
        : await adminJson<CallHeatmapResponse>(
          token,
          `/api/admin/stats/heatmap/week?${new URLSearchParams({
            ...(params.mode ? { mode: params.mode } : {}),
            ...(params.date ? { date: params.date } : {}),
          }).toString()}`,
        );
      if (reqId !== heatmapReqRef.current) return;
      setHeatmap({ ...res, mode: heatmapMode });
    } catch {
      if (reqId !== heatmapReqRef.current) return;
      setHeatmapError(t("usage.error.heatmapLoad"));
    } finally {
      if (reqId === heatmapReqRef.current) setHeatmapLoading(false);
    }
  }, [token, anchorDate, heatmapMode, scope, t]);

  const fetchSessionCharts = useCallback(async () => {
    if (!token) return;
    setSessionLoading(true);
    setSessionError(null);
    try {
      if (scope === "user") {
        const [tc, ctx] = await Promise.all([
          api.userStatsToolCalls(token, days),
          api.userStatsContextLength(token, days),
        ]);
        setToolCalls(tc);
        setContextLength(ctx);
      } else {
        const [tc, ctx] = await Promise.all([
          adminJson<ToolCallsResponse>(token, `/api/admin/stats/tool-calls?days=${days}`),
          adminJson<ContextLengthResponse>(token, `/api/admin/stats/context-length?days=${days}`),
        ]);
        setToolCalls(tc);
        setContextLength(ctx);
      }
    } catch {
      setSessionError(t("usage.error.sessionChartsLoad"));
    } finally {
      setSessionLoading(false);
    }
  }, [token, days, scope, t]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchDist(); }, [fetchDist]);
  useEffect(() => { fetchTimeseries(); }, [fetchTimeseries]);
  useEffect(() => { fetchHealth(); }, [fetchHealth]);
  useEffect(() => { fetchKeysAndRates(); }, [fetchKeysAndRates]);
  useEffect(() => { fetchHeatmap(); }, [fetchHeatmap]);
  useEffect(() => { fetchSessionCharts(); }, [fetchSessionCharts]);

  const curMonthNum = new Date().getMonth() + 1;
  const monthStats = (m: number) => stats?.monthly.find((x) => x.month === m) ?? { calls: 0, tokens: 0 };
  const thisMo = monthStats(curMonthNum);
  const prevMo = monthStats(curMonthNum - 1);

  const lastTs = timeseries[timeseries.length - 1];
  const prevTs = timeseries[timeseries.length - 2];
  const periodCalls = period === "day" ? (lastTs?.calls ?? 0)
    : period === "month" ? thisMo.calls
    : (stats?.all_time_calls ?? 0);
  const periodTokens = period === "day" ? (lastTs?.total_tokens ?? 0)
    : period === "month" ? thisMo.tokens
    : (stats?.all_time_tokens ?? 0);

  const kpiReady = period === "day" ? timeseries.length > 0 : !!stats && !loading;
  const callsDisplay = useCountUp(periodCalls, 1100, kpiReady, fmtCompact);
  const tokensDisplay = useCountUp(periodTokens, 1200, kpiReady, fmtCompact);

  const kpiGrowthLabel = period === "day" ? t("usage.kpi.dod")
    : period === "month" ? t("usage.kpi.mom")
    : "";
  const callsGrowthV = period === "cumulative" ? null : growth(periodCalls, period === "day" ? (prevTs?.calls ?? 0) : prevMo.calls);
  const tokensGrowthV = period === "cumulative" ? null : growth(periodTokens, period === "day" ? (prevTs?.total_tokens ?? 0) : prevMo.tokens);

  const healthRate = health != null ? Number(health.success_rate) : NaN;
  const healthValue = health != null && Number.isFinite(healthRate) ? `${healthRate.toFixed(1)}%` : "—";
  const healthSub = health != null && Number.isFinite(Number(health.total))
    ? fmtStr(t("usage.kpi.healthSub"), {
      ok: Number(health.success_count || 0).toLocaleString(),
      total: Number(health.total || 0).toLocaleString(),
    })
    : "—";

  const rateInfo = useMemo(() => {
    if (scope === "admin") {
      const cost = adminOverview?.estimated_token_cost ?? 0;
      const value = cost >= 1
        ? `¥${cost.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `¥${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
      return {
        value,
        sub: t("admin.dashboard.kpi.tokenCostSub"),
      };
    }
    if (!rateLimits) return { value: "—", sub: "—" };
    if (rateLimits.night_unlimited) {
      return { value: t("usage.ratelimit.nightBadge"), sub: t("usage.kpi.rateNight") };
    }
    const keys = rateLimits.data ?? [];
    if (keys.length === 0) return { value: "—", sub: t("usage.kpi.rateNone") };
    let peak = 0;
    for (const k of keys) {
      for (const mtr of [k.rpm, k.tpm]) {
        if (mtr.unlimited || mtr.limit <= 0) continue;
        const p = mtr.used / mtr.limit;
        if (p > peak) peak = p;
      }
    }
    return { value: `${Math.round(peak * 100)}%`, sub: t("usage.kpi.rateSub") };
  }, [rateLimits, scope, adminOverview, t]);

  const keyCardValue = keyCounts ? fmtCompact(keyCounts.active) : "—";
  const keyCardSub = scope === "admin"
    ? fmtStr(t("admin.dashboard.kpi.onlineModelsSuffix"), { n: keyCounts?.monthlyActive ?? 0 })
    : keyCounts
      ? fmtStr(t("usage.kpi.monthlyActive"), { n: keyCounts.monthlyActive })
      : "—";

  const trendData = useMemo(() => timeseries.map((d) => {
    const [, m, day] = d.day.split("-");
    return { day: `${Number(m)}/${Number(day)}`, fullDay: d.day, calls: d.calls, tokens: d.total_tokens };
  }), [timeseries]);

  const derived = useMemo(() => {
    if (trendData.length === 0) return null;
    const half = Math.floor(trendData.length / 2);
    const secondHalf = trendData.slice(half);
    const firstHalf = trendData.slice(0, half);
    const sumCalls = (arr: typeof trendData) => arr.reduce((s, d) => s + d.calls, 0);
    const sumTokens = (arr: typeof trendData) => arr.reduce((s, d) => s + d.tokens, 0);
    const c2 = sumCalls(secondHalf);
    const c1 = sumCalls(firstHalf);
    const t2 = sumTokens(secondHalf);
    const t1 = sumTokens(firstHalf);
    return {
      callsGrowth: c1 > 0 ? ((c2 - c1) / c1) * 100 : 0,
      tokensGrowth: t1 > 0 ? ((t2 - t1) / t1) * 100 : 0,
      totalWindowCalls: sumCalls(trendData),
      totalWindowTokens: sumTokens(trendData),
    };
  }, [trendData]);

  const sceneDonutData = useMemo(() => [...sceneDist]
    .filter((s) => s.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 6)
    .map((s, i) => ({
      name: s.label || s.scene || t("usage.top.unnamed"),
      value: s.calls,
      key: s.scene || `s${i}`,
      color: `var(--chart-${(i % 5) + 1})`,
    })), [sceneDist, t]);

  const sceneSummary = useMemo(() => {
    const items = sceneDist.filter((s) => s.calls > 0);
    if (!items.length) return null;
    const total = items.reduce((s, d) => s + d.calls, 0);
    if (!total) return null;
    const top = items.reduce((mx, d) => (d.calls > mx.calls ? d : mx), items[0]);
    return {
      topName: top.label || top.scene || t("usage.top.unnamed"),
      pct: (top.calls / total) * 100,
      total,
    };
  }, [sceneDist, t]);

  const modelDonutData = useMemo(() => [...modelDist]
    .sort((a, b) => (modelMetric === "calls" ? b.calls - a.calls : b.tokens - a.tokens))
    .slice(0, 6)
    .map((m, i) => ({
      name: m.model_id,
      value: modelMetric === "calls" ? m.calls : m.tokens,
      key: m.model_id,
      color: `var(--chart-${(i % 5) + 1})`,
    })), [modelDist, modelMetric]);

  const modelSummary = useMemo(() => {
    if (!modelDist.length) return null;
    const sorted = [...modelDist].sort((a, b) =>
      (modelMetric === "calls" ? b.calls - a.calls : b.tokens - a.tokens),
    );
    const top = sorted[0];
    if (!top) return null;
    return {
      topName: top.model_id,
      topValue: modelMetric === "calls" ? top.calls : top.tokens,
    };
  }, [modelDist, modelMetric]);

  const sceneDonutKey = sceneDonutData.map((d) => `${d.name}:${d.value}`).join("|");
  const modelDonutKey = modelDonutData.map((d) => `${d.name}:${d.value}`).join("|");
  const donutEnter = { animation: "apiplatform-fadeSlideUp 0.35s var(--ease-entrance) both" };

  const reloadAll = useCallback(() => {
    fetchStats();
    fetchDist();
    fetchTimeseries();
    fetchHealth();
    fetchKeysAndRates();
    fetchHeatmap();
    fetchSessionCharts();
  }, [fetchStats, fetchDist, fetchTimeseries, fetchHealth, fetchKeysAndRates, fetchHeatmap, fetchSessionCharts]);

  return {
    scope,
    currentYear,
    stats,
    loading,
    statsError,
    days,
    setDays,
    period,
    setPeriod,
    modelMetric,
    setModelMetric,
    hoveredScene,
    setHoveredScene,
    hoveredModelPie,
    setHoveredModelPie,
    tsLoading,
    tsError,
    sessionLoading,
    sessionError,
    toolCalls,
    contextLength,
    heatmap,
    heatmapLoading,
    heatmapError,
    heatmapMode,
    setHeatmapMode,
    anchorDate,
    setAnchorDate,
    fetchTimeseries,
    fetchHeatmap,
    fetchSessionCharts,
    reloadAll,
    kpiReady,
    callsDisplay,
    tokensDisplay,
    kpiGrowthLabel,
    callsGrowthV,
    tokensGrowthV,
    healthValue,
    healthSub,
    rateInfo,
    keyCardValue,
    keyCardSub,
    trendData,
    derived,
    sceneDonutData,
    sceneSummary,
    modelDonutData,
    modelSummary,
    sceneDonutKey,
    modelDonutKey,
    donutEnter,
    keysKpiLabel: scope === "admin" ? t("admin.dashboard.kpi.activeKeys") : t("usage.kpi.keys"),
    fifthKpiLabel: scope === "admin" ? t("admin.dashboard.kpi.tokenCostEstimate") : t("usage.kpi.rateLimit"),
    fifthKpiIcon: scope === "admin" ? "cost" as const : "gauge" as const,
  };
}

export type UsageDashboardData = ReturnType<typeof useUsageDashboardData>;
