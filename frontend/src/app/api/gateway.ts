/** 轻量 fetch 封装。页面内请求用相对路径。 */

import { createAbortController } from "../browser-compat";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  short_desc?: string;
  description?: string;
  readme?: string | null;
  context_window?: string;
  category: string;
  status: string;
  speed?: string;
  pricing_input?: number;
  pricing_output?: number;
  is_virtual: boolean;
  /** LTS 虚拟模型对齐的真实模型 id（仅 category=lts 时返回） */
  resolve_to_model_id?: string | null;
  /** 推理引擎类型：vllm | llamacpp */
  engine_type?: string;
  /** 运营展示字段（admin 可编辑，存于 model_registry.extra）*/
  tags?: string[] | null;
  badge?: string | null;
  params?: string | null;
  /** 平台接入日期 YYYY-MM-DD（「最新」排序依据） */
  addedAt?: string | null;
  /** 模型原始发布日期 YYYY-MM */
  releaseDate?: string | null;
}

export interface TimeseriesPoint {
  day: string;
  calls: number;
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
  total_tokens: number;
}

export interface LogStatsResponse {
  total: number;
  success_count: number;
  success_rate: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  cache_hit_rate?: number | null;
  retention_days?: number;
  retention_cutoff?: string | null;
  has_purged_range?: boolean;
}

export interface ContextLengthBucket {
  label: string;
  count: number;
  share: number;
  cum_share: number;
}
export interface ContextLengthResponse {
  buckets: ContextLengthBucket[];
  total: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  min: number;
  days: number;
}

export interface ToolCallsBucket {
  label: string;
  count: number;
  share: number;
}

export interface ToolCallsResponse {
  buckets: ToolCallsBucket[];
  total_sessions: number;
  days: number;
}

/** GET /api/user/stats/heatmap/week：调用热力图（周/月/累计）。 */
export type HeatmapMode = "week" | "month" | "cumulative";

export interface CallHeatmapResponse {
  mode: HeatmapMode;
  matrix: number[][];
  /** 周模式为行日期（周一~周日）；月/累计为列日期 */
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

/** @deprecated 使用 CallHeatmapResponse */
export type WeekHeatmapResponse = CallHeatmapResponse;

export interface UserKeyRow {
  id: string;
  name: string;
  project_desc?: string | null;
  key_masked: string | null;
  /** 档位：default | high | unlimited | custom（后端按 rpm/tpm 归并，用于隐藏已升级密钥的升级入口） */
  tier?: string;
  created_at: string | null;
  last_used_at: string | null;
  status?: "active" | "pending" | "rejected" | "revoked";
  /** 审批已通过，但完整 Key 尚未向申请人做唯一一次交付。 */
  needs_claim?: boolean;
  /** 管理员驳回时填写的理由，仅 status === "rejected" 时有值 */
  note?: string | null;
  reviewed_at?: string | null;
}

export interface NightBatchRegistration {
  id: string;
  series_id: string;
  series_total: number;
  creator_auth_id: string;
  creator_name: string;
  project: string;
  model_id: string;
  model_name: string;
  contact_name: string;
  description: string;
  intensity_note?: string | null;
  start_at: string;
  end_at: string;
  repeat_weekdays?: number[] | null;
  repeat_until?: string | null;
  created_at: string;
}

interface NightBatchCreateBody {
  start_date: string;
  start_time: string;
  end_time: string;
  repeat_weekdays?: number[];
  repeat_until?: string | null;
  model_id: string;
  description: string;
  contact_name: string;
  intensity_note?: string | null;
}

/** 登记后可改的字段。时间与模型不可改——改期等于换一场，请删除后重新登记。
 *
 * 三个字段都可选，只传要改的即可。注意 `undefined` 与 `""` 含义不同：
 * 省略（undefined）= 不动该字段；传空串 = 清空该字段。后端按 `is not None`
 * 区分二者，因此「清空强度说明」必须传 `""` 而不是 `null`。 */
export interface NightBatchUpdateBody {
  description?: string;
  intensity_note?: string;
  contact_name?: string;
}

export interface RateLimitKey {
  key_id: string;
  key_name: string;
  resets_in: number;
  /** limit=0 且 unlimited=true 表示该 Key 档位为超高并发（不限速），与夜间窗口无关 */
  rpm: { used: number; limit: number; unlimited?: boolean };
  tpm: { used: number; limit: number; unlimited?: boolean };
}

/** GET /api/user/rate-limits：夜间窗口标记由服务端判定（窗口按平台时区计算，前端不能自行推算） */
export interface RateLimitResponse {
  data: RateLimitKey[];
  resets_in: number;
  /** 夜间不限流窗口生效中：RPM/TPM 检查整体跳过，且窗口内不做计数（used 恒为 0） */
  night_unlimited?: boolean;
  /** 窗口文案，如 "19:00–07:30" */
  night_window?: string;
}

export interface PlatformConfig {
  title: string;
  brand: string;
  platform_name?: string;
  browser_title?: string;
  slogan: string;
  organization_name?: string;
  footer_text?: string;
  support_department?: string;
  support_contact?: string;
  support_email?: string;
  approval_department?: string;
  approval_contact?: string;
  approval_email?: string;
  /** 实际生效的全平台 RPM/TPM 限额（与后端管控同源） */
  rate_limit?: { rpm: number; tpm: number };
  /** 并发档位预设（admin 一键提升） */
  rate_limit_presets?: { key: string; name: string; rpm: number; tpm: number; unlimited: boolean }[];
  /** 开发环境假登录开关：后端 ENVIRONMENT != production 时前端显示「开发账号直接登录」 */
  dev_login_enabled?: boolean;
  registration_enabled: boolean;
  password_recovery_enabled: boolean;
  platform_timezone?: string;
  platform_stats?: {
    total_calls: number;
    total_tokens: number;
    active_keys: number;
    /** 库内实时计数（不含基线），便于核对 */
    live_calls?: number;
    live_tokens?: number;
    initial_calls?: number;
    initial_tokens?: number;
    initial_cost?: number;
  };
}

/** 抢先体验计划：none = 从未申请；revoked = 曾获授权但被管理员收回。 */
type EarlyAccessStatus = "none" | "pending" | "approved" | "rejected" | "revoked";

export interface EarlyAccessState {
  status: EarlyAccessStatus;
  submitted_at: string | null;
  reviewed_at: string | null;
  note: string | null;
  agreement_version?: string;
  /** 当前处于抢先体验计划的模型（后端如实返回，不在前端写死） */
  models?: { id: string; name: string }[];
}

interface AdminEarlyAccessList {
  data: AdminEarlyAccessRow[];
  total: number;
  /** 全库待审批数，不受分页与筛选影响 */
  pendingTotal: number;
  approvedTotal: number;
  limit: number;
  offset: number;
  models: { id: string; name: string }[];
}

export interface AdminEarlyAccessRow {
  id: string;
  authId: string;
  name: string;
  department: string;
  status: Exclude<EarlyAccessStatus, "none">;
  agreementVersion: string;
  note: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewer: string | null;
}

interface AdminApplicationList {
  data: AdminApplicationRow[];
  total: number;
  /** 全库待审批数，不受分页与筛选影响 */
  pendingTotal: number;
  limit: number;
  offset: number;
}

export interface AdminApplicationRow {
  id: string;
  authId: string;
  name: string;
  department: string;
  projectName: string;
  projectDesc: string | null;
  sceneType?: string | null;
  models: string[];
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
  reviewer: string | null;
}

/** 高并发升级申请（用户侧视图）。keyId 为 null 表示对应密钥已被删除。 */
export interface UpgradeApplicationRow {
  id: string;
  keyId: string | null;
  keyName: string;
  reason: string;
  targetTier: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
}

export interface AdminUpgradeApplicationRow {
  id: string;
  authId: string;
  name: string;
  department: string;
  keyId: string | null;
  keyName: string;
  projectName: string;
  reason: string;
  targetTier: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
  reviewer: string | null;
  /** 关联密钥当前档位（default|high|unlimited|custom）；密钥已删为 null */
  currentTier?: string | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

/** 场景分类（admin 可增删改；api_keys.scene_type 引用 key） */
export interface AdminSceneTypeRow {
  key: string;
  label: string;
  sortOrder: number;
  keyCount: number;
}

export interface UserSessionResponse {
  /** Bearer API 兼容返回；浏览器只使用服务端同时写入的 HttpOnly cookie。 */
  token?: string;
  expiresIn: number;
  authId: string;
  name: string;
  department: string;
}

function formatApiErrorDetail(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg: string }).msg) : ""))
      .filter(Boolean);
    if (msgs.length) return msgs.join("；");
  }
  if (detail != null) return JSON.stringify(detail);
  return `${status}`;
}

const FETCH_TIMEOUT_MS = 30_000;

function makeTimeoutSignal(ms: number): AbortSignal | undefined {
  const ctrl = createAbortController();
  if (!ctrl) return undefined;
  // 旧版 AbortController.abort 不接受 reason，统一无参调用。
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, signal, ...rest } = init ?? {};
  const r = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    signal: signal ?? makeTimeoutSignal(FETCH_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  if (!r.ok) {
    let detail: unknown = `${r.status}`;
    try {
      const j = await r.json();
      detail = j.detail ?? j;
    } catch {
      /* ignore */
    }
    if (r.status === 404) {
      const detailMsg = formatApiErrorDetail(detail, r.status);
      // FastAPI 业务 404（如「升级申请不存在」）应直接展示；仅路由/代理缺失时用开发提示
      const routeMissing = detailMsg === "404" || detailMsg === `${r.status}`;
      if (!routeMissing) {
        const err = new Error(detailMsg) as Error & { status?: number };
        err.status = r.status;
        throw err;
      }
      const msg = import.meta.env.PROD
        ? "Service unavailable — please verify the backend is running."
        : "Backend API not found — 当前后端未提供该接口，请执行 ./dev.sh --stop && ./dev.sh 重启开发环境（勿复用旧标签页）。";
      throw new Error(msg);
    }
    const err = new Error(formatApiErrorDetail(detail, r.status)) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json() as Promise<T>;
}

/** 登录态失效（401）广播事件名——由 AuthProvider 监听并退出登录。 */
export const AUTH_EXPIRED_EVENT = "apiplatform-auth-expired";
/** 管理员登录态失效（401）广播事件名——由 Admin 页监听并退出。 */
export const ADMIN_EXPIRED_EVENT = "apiplatform-admin-expired";

export interface PlatformStatusData {
  cumulative: { calls: number; tokens: number; active_keys: number };
  today: { calls: number; tokens: number };
  /** 本月（至今）调用/Token */
  month: { calls: number; tokens: number };
  /** 三档同比（去年同期无数据时为 null，前端显示 —） */
  yoy: {
    day: { calls: number | null; tokens: number | null };
    month: { calls: number | null; tokens: number | null };
    cumulative: { calls: number | null; tokens: number | null };
  };
  /** 月活 Key：最近 30 天有调用记录的 Key 数 */
  monthly_active_keys: number;
  trend_days: number;
  dist_days: number;
  trend: { day: string; calls: number; tokens: number }[];
  realtime: {
    recent_5min: { calls: number; tokens: number };
    recent_1h: { calls: number; tokens: number };
  };
  health: {
    success_rate: number | null;
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
    sample_calls: number;
  };
  by_scene: { category: string; label: string; calls: number; tokens: number; pct: number }[];
  by_model: { model_id: string; name: string; calls: number; tokens: number }[];
}

/** 状态页调用热力图（周/月/累计）。 */
export type PlatformHeatmapResponse = CallHeatmapResponse;

/** "查看全部" 抽屉的分组明细行；label 是原始维度值，display_label 是可读展示名
 *  （模型/场景/用户维度会补充，项目/部门维度就是 label 本身）。 */
export interface BreakdownRow {
  label: string;
  display_label?: string;
  department?: string;
  calls: number;
  tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_hit_rate: number;
  /** 明细源没有 status/latency/cost 列时（如 usage_daily_summary 聚合）为 null，前端渲染 — */
  avg_latency_ms: number | null;
  success_rate: number | null;
  cost?: number | null;
}

export interface BreakdownResponse {
  rows: BreakdownRow[];
  total_groups: number;
  totals: BreakdownRow | null;
}

export interface BreakdownParams {
  dimension: string;
  days: number;
  search: string;
  sortField: string;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
  filterDimension?: string;
  filterValue?: string;
}

function breakdownQuery(params: BreakdownParams): URLSearchParams {
  const q = new URLSearchParams({
    dimension: params.dimension, days: String(params.days),
    sort_field: params.sortField, sort_dir: params.sortDir,
    limit: String(params.limit), offset: String(params.offset),
  });
  if (params.search) q.set("search", params.search);
  if (params.filterDimension && params.filterValue) {
    q.set("filter_dimension", params.filterDimension);
    q.set("filter_value", params.filterValue);
  }
  return q;
}

export const api = {
  config: () => req<PlatformConfig>("/api/public/config", { cache: "no-store" }),
  models: () => req<{ data: ModelInfo[] }>("/api/public/models"),
  platformStatus: (params?: { trendDays?: number; distDays?: number }) => {
    const q = new URLSearchParams();
    if (params?.trendDays) q.set("trend_days", String(params.trendDays));
    if (params?.distDays) q.set("dist_days", String(params.distDays));
    const qs = q.toString();
    return req<PlatformStatusData>(`/api/public/platform-status${qs ? `?${qs}` : ""}`);
  },
  platformStatusBreakdown: (params: BreakdownParams) => {
    return req<BreakdownResponse>(`/api/public/platform-status/breakdown?${breakdownQuery(params).toString()}`);
  },
  platformStatusHeatmap: (params?: { mode?: HeatmapMode; date?: string }) => {
    const q = new URLSearchParams();
    if (params?.mode) q.set("mode", params.mode);
    if (params?.date) q.set("date", params.date);
    const qs = q.toString();
    return req<PlatformHeatmapResponse>(`/api/public/platform-status/heatmap${qs ? `?${qs}` : ""}`);
  },
  platformStatusToolCalls: (days = 30) =>
    req<ToolCallsResponse>(`/api/public/platform-status/tool-calls?days=${days}`),
  platformStatusContextLength: (days = 30) =>
    req<ContextLengthResponse>(`/api/public/platform-status/context-length?days=${days}`),
  apply: (token: string, body: unknown) =>
    authReq<{ id: string; status: string; rate_limit: { limit: number; used: number; remaining: number; resets_in: number } }>(
      token, "/api/apply", { method: "POST", body: JSON.stringify(body) },
    ),
  // 高并发升级申请：提交 + 查询自己的申请（API Keys 页状态角标用）
  upgradeApply: (token: string, body: { key_id: string; reason: string; target_tier?: string }) =>
    authReq<{ id: string; keyId: string; keyName: string; targetTier?: string; status: string; createdAt: string | null }>(
      token, "/api/apply/upgrade", { method: "POST", body: JSON.stringify(body) },
    ),
  userChangeTier: (token: string, keyId: string, target_tier: string) =>
    authReq<{ ok: boolean; id: string; tier: string }>(
      token, `/api/user/keys/${keyId}/tier`, { method: "POST", body: JSON.stringify({ target_tier }) },
    ),
  upgradeApplications: (token: string) =>
    authReq<{ data: UpgradeApplicationRow[] }>(token, "/api/apply/upgrade"),
  upgradeUpdate: (token: string, appId: string, body: { reason: string; target_tier: string }) =>
    authReq<UpgradeApplicationRow>(token, `/api/apply/upgrade/${appId}`, { method: "PATCH", body: JSON.stringify(body) }),
  upgradeWithdraw: (token: string, appId: string) =>
    authReq<{ ok: boolean; id: string }>(token, `/api/apply/upgrade/${appId}`, { method: "DELETE" }),

  // ── 账号：登录 / 注册 / 找回密码 ──────────────────────────────────────────
  userLogin: (authId: string, password: string) =>
    req<UserSessionResponse>("/api/user/login", {
      method: "POST",
      body: JSON.stringify({ authId, password }),
    }),
  userRegister: (body: { authId: string; name: string; department: string; password: string }) =>
    req<UserSessionResponse>("/api/user/register", { method: "POST", body: JSON.stringify(body) }),
  userRecover: (authId: string, apiKey: string) =>
    req<{ message: string }>("/api/user/recover", {
      method: "POST",
      body: JSON.stringify({ authId, apiKey }),
    }),
  userResetPassword: (authId: string, apiKey: string, newPassword: string) =>
    req<{ message: string }>("/api/user/reset-password", {
      method: "POST",
      body: JSON.stringify({ authId, apiKey, newPassword }),
    }),

  userSession: () => req<UserSessionResponse>("/api/user/session", { cache: "no-store" }),
  userLogout: () => req<{ ok: boolean }>("/api/user/logout", { method: "POST" }),
  // 开发环境专用假登录（生产后端返回 404；仅当 config.dev_login_enabled 为真时才调用）
  devLogin: () =>
    req<UserSessionResponse>("/api/user/dev-login", { method: "POST" }),

  // 身份取自登录态 JWT（不再凭 body 工号，防越权）。
  userKeys: (token: string) =>
    authReq<{ data: UserKeyRow[] }>(token, "/api/user/keys", { method: "POST" }),
  userUpdateKey: (token: string, id: string, body: { name: string; project_desc?: string | null }) =>
    authReq<{ ok: boolean; id: string; name: string; project_desc: string | null }>(
      token, `/api/user/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) },
    ),
  userDeleteKey: (token: string, id: string) =>
    authReq<{ ok: boolean; id: string }>(token, `/api/user/keys/${id}`, { method: "DELETE" }),
  userRegenerateKey: (token: string, id: string) =>
    authReq<{ id: string; api_key: string; status: string }>(token, `/api/user/keys/${id}/regenerate`, { method: "POST" }),
  userClaimKey: (token: string, id: string) =>
    authReq<{ id: string; api_key: string; status: string }>(token, `/api/user/keys/${id}/claim`, { method: "POST" }),
  applyRateInfo: (token: string) =>
    authReq<{ limit: number; used: number; remaining: number; resets_in: number }>(token, "/api/apply/rate"),

  // ── 账号维度统计 / 日志（登录态，聚合该用户全部密钥）──────────────────────────
  userStats: (token: string, year: number) =>
    authReq<any>(token, `/api/user/stats?year=${year}`),
  userStatsYearly: (token: string) =>
    authReq<{ year: number; calls: number; tokens: number }[]>(token, "/api/user/stats/yearly"),
  userStatsModels: (token: string, opts: { project?: string; days?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.project) p.set("project", opts.project);
    if (opts.days) p.set("days", String(opts.days));
    const qs = p.toString();
    return authReq<{ model_id: string; calls: number; tokens: number }[]>(token, `/api/user/stats/models${qs ? `?${qs}` : ""}`);
  },
  userStatsProjects: (token: string, days?: number) => {
    const qs = days ? `?days=${days}` : "";
    return authReq<{ project: string; calls: number; tokens: number }[]>(token, `/api/user/stats/projects${qs}`);
  },
  userStatsScenes: (token: string, days = 30) =>
    authReq<{ scene: string; label: string; calls: number; tokens: number }[]>(
      token, `/api/user/stats/scenes?days=${days}`,
    ),
  userStatsBreakdown: (token: string, params: BreakdownParams) =>
    authReq<BreakdownResponse>(token, `/api/user/stats/breakdown?${breakdownQuery(params).toString()}`),
  userStatsTimeseries: (
    token: string,
    opts: { days?: number; model_id?: string; project?: string } = {},
  ) => {
    const p = new URLSearchParams({ days: String(opts.days ?? 30) });
    if (opts.model_id) p.set("model_id", opts.model_id);
    if (opts.project) p.set("project", opts.project);
    return authReq<{ data: TimeseriesPoint[] }>(token, `/api/user/stats/timeseries?${p.toString()}`);
  },
  userStatsContextLength: (token: string, days = 30) =>
    authReq<ContextLengthResponse>(token, `/api/user/stats/context-length?days=${days}`),
  userStatsToolCalls: (token: string, days = 30) =>
    authReq<ToolCallsResponse>(token, `/api/user/stats/tool-calls?days=${days}`),
  userStatsHeatmap: (token: string, days = 30) =>
    authReq<{ matrix: number[][]; max: number; days: number; total: number }>(
      token, `/api/user/stats/heatmap?days=${days}`,
    ),
  /** 调用热力图：mode=week|month|cumulative；周/月需 date 锚点（平台本地时区）。 */
  userStatsHeatmapWeek: (token: string, params?: { mode?: HeatmapMode; date?: string }) => {
    const q = new URLSearchParams();
    if (params?.mode) q.set("mode", params.mode);
    if (params?.date) q.set("date", params.date);
    const qs = q.toString();
    return authReq<CallHeatmapResponse>(
      token, `/api/user/stats/heatmap/week${qs ? `?${qs}` : ""}`,
    );
  },
  userLogsPaged: (token: string, params: string) =>
    authReq<{
      total: number; records: any[];
      retention_days?: number; retention_cutoff?: string | null; has_purged_range?: boolean;
    }>(token, `/api/user/logs?${params}`),
  userLogsStats: (token: string, params: string) =>
    authReq<LogStatsResponse>(token, `/api/user/logs/stats?${params}`),
  userRateLimits: (token: string) =>
    authReq<RateLimitResponse>(token, "/api/user/rate-limits"),

  forumPosts: (opts?: {
    limit?: number;
    offset?: number;
    search?: string;
    filter?: string;
    sort?: string;
    token?: string;
  }) => {
    const p = new URLSearchParams();
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    if (opts?.search) p.set("search", opts.search);
    if (opts?.filter) p.set("filter", opts.filter);
    if (opts?.sort) p.set("sort", opts.sort);
    const q = p.toString();
    const headers = bearerHeaders(opts?.token || "");
    return req<{ total: number; limit: number; offset: number; data: any[] }>(
      `/api/forum/posts${q ? `?${q}` : ""}`,
      Object.keys(headers).length ? { headers } : undefined,
    );
  },
  forumOverview: () =>
    req<{
      total: number;
      pending: number;
      recent7_new: number;
      avg_response_hours: number | null;
      hot: { id: string; title: string; view_count: number; reply_count: number; resolved: boolean }[];
    }>("/api/forum/overview"),
  forumPost: (id: string, token?: string) => {
    const headers = bearerHeaders(token || "");
    return req<any>(
      `/api/forum/posts/${id}`,
      Object.keys(headers).length ? { headers } : undefined,
    );
  },
  // 发帖/回复需登录态：身份与 is_admin 由后端按 token 判定。
  forumCreate: (token: string, body: unknown) =>
    authReq<{ id: string }>(token, "/api/forum/posts", { method: "POST", body: JSON.stringify(body) }),
  forumReply: (token: string, id: string, body: unknown) =>
    authReq<{ id: string }>(token, `/api/forum/posts/${id}/replies`, { method: "POST", body: JSON.stringify(body) }),
  forumLike: (token: string, postId: string) =>
    authReq<{ liked: boolean; like_count: number }>(token, `/api/forum/posts/${postId}/like`, { method: "POST" }),
  forumFollow: (token: string, postId: string) =>
    authReq<{ followed: boolean; follow_count: number }>(token, `/api/forum/posts/${postId}/follow`, { method: "POST" }),
  forumResolve: (token: string, postId: string) =>
    authReq<{ ok: boolean }>(token, `/api/forum/posts/${postId}/resolve`, { method: "POST" }),
  forumPin: (token: string, postId: string) =>
    authReq<{ pinned: boolean }>(token, `/api/forum/posts/${postId}/pin`, { method: "POST" }),

  // ── 夜间批量调用登记处 ──────────────────────────────────────────────────────
  nightBatchList: (token: string, opts?: {
    limit?: number; offset?: number; overlap_start?: string; overlap_end?: string; model_id?: string;
  }) => {
    const p = new URLSearchParams();
    p.set("limit", String(opts?.limit ?? 20));
    p.set("offset", String(opts?.offset ?? 0));
    if (opts?.overlap_start) p.set("overlap_start", opts.overlap_start);
    if (opts?.overlap_end) p.set("overlap_end", opts.overlap_end);
    if (opts?.model_id) p.set("model_id", opts.model_id);
    return authReq<{ total: number; limit: number; offset: number; data: NightBatchRegistration[] }>(
      token, `/api/night-batch?${p.toString()}`,
    );
  },
  nightBatchCreate: (token: string, body: NightBatchCreateBody) =>
    authReq<{ series_id: string; count: number; data: NightBatchRegistration[] }>(
      token, "/api/night-batch", { method: "POST", body: JSON.stringify(body) },
    ),
  nightBatchDelete: (token: string, id: string) =>
    authReq<{ ok: boolean; id: string }>(token, `/api/night-batch/${id}`, { method: "DELETE" }),
  nightBatchDeleteSeries: (token: string, seriesId: string) =>
    authReq<{ ok: boolean; series_id: string; deleted: number }>(
      token, `/api/night-batch/series/${seriesId}`, { method: "DELETE" },
    ),
  // 改单场；重复登记里只改这一天用它
  nightBatchUpdate: (token: string, id: string, body: NightBatchUpdateBody) =>
    authReq<{ ok: boolean; id: string; data: NightBatchRegistration }>(
      token, `/api/night-batch/${id}`, { method: "PATCH", body: JSON.stringify(body) },
    ),
  // 改整个重复系列，同 series_id 的所有场次一起改
  nightBatchUpdateSeries: (token: string, seriesId: string, body: NightBatchUpdateBody) =>
    authReq<{ ok: boolean; series_id: string; updated: number; data: NightBatchRegistration[] }>(
      token, `/api/night-batch/series/${seriesId}`, { method: "PATCH", body: JSON.stringify(body) },
    ),

  // ── 文档反馈 ────────────────────────────────────────────────────────────────
  // 不需要登录：文档对未登录用户开放，强制实名会直接压掉反馈量。
  // 带上 token 时后端会顺带记下 auth_id，便于需要时回访。
  docFeedback: (body: { vote: "up" | "down"; section?: string; comment?: string; lang?: string },
                token?: string) =>
    req<{ ok: boolean }>("/api/public/doc-feedback", {
      method: "POST",
      headers: bearerHeaders(token || ""),
      body: JSON.stringify(body),
    }),

  // ── 抢先体验计划 ────────────────────────────────────────────────────────────
  earlyAccess: (token: string) =>
    authReq<EarlyAccessState>(token, "/api/user/early-access"),
  earlyAccessApply: (token: string) =>
    authReq<EarlyAccessState>(token, "/api/user/early-access", {
      method: "POST",
      body: JSON.stringify({ agreed: true }),
    }),

  adminEarlyAccessList: (token: string, opts?: { limit?: number; offset?: number; status?: string }) => {
    const p = new URLSearchParams();
    p.set("limit", String(opts?.limit ?? 50));
    p.set("offset", String(opts?.offset ?? 0));
    if (opts?.status) p.set("status", opts.status);
    return adminReq<AdminEarlyAccessList>(token, `/api/admin/early-access?${p.toString()}`);
  },
  adminEarlyAccessReview: (
    token: string, appId: string, action: "approve" | "reject" | "revoke", note?: string,
  ) =>
    adminReq<{ ok: boolean } & AdminEarlyAccessRow>(
      token, `/api/admin/early-access/${appId}/${action}`,
      { method: "POST", body: JSON.stringify(note ? { note } : {}) },
    ),

  adminLoginStatus: () =>
    req<{ initialized: boolean; bootstrapRequired: boolean; passwordMinLength: number; passwordMaxLength: number }>(
      "/api/admin/login/status",
    ),
  adminLogin: (password: string, passwordConfirmation?: string, bootstrapToken?: string) =>
    req<{ token: string; initializedNow: boolean }>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        password,
        ...(passwordConfirmation !== undefined
          ? { password_confirmation: passwordConfirmation }
          : {}),
        ...(bootstrapToken !== undefined ? { bootstrap_token: bootstrapToken } : {}),
      }),
    }),
  adminSession: () => req<{ ok: boolean }>("/api/admin/session", { cache: "no-store" }),
  adminLogout: () => req<{ ok: boolean }>("/api/admin/logout", { method: "POST" }),
  adminStatsBreakdown: (token: string, params: BreakdownParams) =>
    adminReq<BreakdownResponse>(token, `/api/admin/stats/breakdown?${breakdownQuery(params).toString()}`),
  adminApplicationsList: (
    token: string,
    opts?: { limit?: number; offset?: number; status?: string; scene_type?: string },
  ) => {
    const p = new URLSearchParams();
    p.set("limit", String(opts?.limit ?? 50));
    p.set("offset", String(opts?.offset ?? 0));
    if (opts?.status) p.set("status", opts.status);
    if (opts?.scene_type) p.set("scene_type", opts.scene_type);
    return adminReq<AdminApplicationList>(token, `/api/admin/applications?${p.toString()}`);
  },
  adminApplicationReview: (token: string, appId: string, action: "approve" | "reject", note?: string) =>
    adminReq<{ ok: boolean; key_id?: string; status?: string }>(
      token, `/api/admin/applications/${appId}/${action}`,
      { method: "POST", body: JSON.stringify(note ? { note } : {}) },
    ),

  // ── 高并发升级申请审批（admin） ───────────────────────────────────────────
  adminUpgradeApplicationsList: (
    token: string,
    opts?: {
      limit?: number;
      offset?: number;
      status?: string;
      department?: string;
      tier?: string;
      q?: string;
      sort?: string;
      order?: "asc" | "desc";
    },
  ) => {
    const p = new URLSearchParams();
    p.set("limit", String(opts?.limit ?? 50));
    p.set("offset", String(opts?.offset ?? 0));
    if (opts?.status) p.set("status", opts.status);
    if (opts?.department) p.set("department", opts.department);
    if (opts?.tier) p.set("tier", opts.tier);
    if (opts?.q) p.set("q", opts.q);
    if (opts?.sort) p.set("sort", opts.sort);
    if (opts?.order) p.set("order", opts.order);
    return adminReq<{
      data: AdminUpgradeApplicationRow[];
      total: number;
      pendingTotal: number;
      approvedTotal: number;
      departments: string[];
      limit: number;
      offset: number;
    }>(token, `/api/admin/upgrade-applications?${p.toString()}`);
  },
  adminUpgradeApplicationReview: (
    token: string, appId: string, action: "approve" | "reject", note?: string,
  ) =>
    adminReq<{ ok: boolean; keyId?: string; rpmLimit?: number; tpmLimit?: number }>(
      token, `/api/admin/upgrade-applications/${appId}/${action}`,
      { method: "POST", body: JSON.stringify(note ? { note } : {}) },
    ),


  /** 管理员密钥列表（场景分类页按 scene_type 查看密钥用） */
  adminKeysList: (
    token: string,
    opts?: {
      limit?: number;
      offset?: number;
      status?: string;
      q?: string;
      tier?: string;
      department?: string;
      scene_type?: string;
      sort?: string;
      order?: "asc" | "desc";
    },
  ) => {
    const p = new URLSearchParams();
    p.set("limit", String(opts?.limit ?? 50));
    p.set("offset", String(opts?.offset ?? 0));
    if (opts?.status) p.set("status", opts.status);
    if (opts?.q) p.set("q", opts.q);
    if (opts?.tier) p.set("tier", opts.tier);
    if (opts?.department) p.set("department", opts.department);
    if (opts?.scene_type) p.set("scene_type", opts.scene_type);
    if (opts?.sort) p.set("sort", opts.sort);
    if (opts?.order) p.set("order", opts.order);
    return adminReq<{
      data: Array<{
        id: string;
        name: string;
        authId: string;
        projectName: string;
        projectDesc?: string | null;
        department: string;
        sceneType?: string | null;
        apiKey: string;
        grantedAt: string;
        revoked?: boolean;
        rpmLimit?: number | null;
        tpmLimit?: number | null;
        tier?: string;
      }>;
      total: number;
      departments: string[];
      limit: number;
      offset: number;
    }>(token, `/api/admin/keys?${p.toString()}`);
  },

  // ── 场景分类管理（admin） ──
  adminSceneTypes: (token: string) =>
    adminReq<AdminSceneTypeRow[]>(token, "/api/admin/scene-types"),
  adminSceneTypeCreate: (token: string, body: { key: string; label: string; sort_order: number }) =>
    adminReq<{ ok: boolean; key: string }>(token, "/api/admin/scene-types", { method: "POST", body: JSON.stringify(body) }),
  adminSceneTypeUpdate: (token: string, key: string, body: { label: string; sort_order: number }) =>
    adminReq<{ ok: boolean }>(token, `/api/admin/scene-types/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(body) }),
  adminSceneTypeDelete: (token: string, key: string) =>
    adminReq<{ ok: boolean }>(token, `/api/admin/scene-types/${encodeURIComponent(key)}`, { method: "DELETE" }),

  // 申请表单用：业务场景分类列表（公开）
  sceneTypes: () => req<{ data: { key: string; label: string }[] }>("/api/public/scene-types"),
};

export const COOKIE_SESSION_TOKEN = "__http_only_cookie_session__";

function bearerHeaders(token: string): Record<string, string> {
  return token && token !== COOKIE_SESSION_TOKEN ? { Authorization: `Bearer ${token}` } : {};
}

async function adminReq<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  try {
    return await req<T>(path, { ...init, headers: { ...bearerHeaders(token), ...(init?.headers || {}) } });
  } catch (e) {
    if ((e as { status?: number })?.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
    }
    throw e;
  }
}

/** 浏览器优先走 HttpOnly cookie；传入真实 token 时仍兼容 Bearer API 客户端。 */
async function authReq<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  try {
    return await req<T>(path, { ...init, headers: { ...bearerHeaders(token), ...(init?.headers || {}) } });
  } catch (e) {
    if ((e as { status?: number })?.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    throw e;
  }
}
