import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { type Model, type NotificationItem, MODEL_METADATA } from "./model-data";
import { displayCategoryForModel } from "./catalog-models";
import { autoTagModel } from "./auto-tags";

/** Stub kept for type-import compatibility — health probing is disabled. */
interface ModelHealth {
  health: "healthy" | "degraded" | "down" | "unknown";
  latencyMs: number | null;
  successRate: number | null;
  checkedAt: number | null;
  httpStatus: number | null;
  error: string | null;
}

interface ModelContextType {
  models: Model[];
  setModels: React.Dispatch<React.SetStateAction<Model[]>>;
  notifications: NotificationItem[];
  setNotifications: React.Dispatch<React.SetStateAction<NotificationItem[]>>;
  health: Record<string, ModelHealth>;
}

const ModelContext = createContext<ModelContextType>({
  models: [],
  setModels: () => {},
  notifications: [],
  setNotifications: () => {},
  health: {},
});

// ── Cache helpers ────────────────────────────────────────────────────────────
// Stale-while-revalidate: serve cached data instantly, revalidate in background.
// Cache keys and TTL (5 minutes keeps data fresh without hammering the intranet).
// v2：缓存内容为后端原始行，种子渲染必须先过 parseModelRows；升版本号使
// 旧版写入的缓存自动失效（旧缓存曾被直接当 Model[] 用，缺字段导致刷新白屏）。
const CACHE_KEY_MODELS = "apiplatform_models_cache_v2";
const CACHE_KEY_NOTIFS = "apiplatform_notifs_cache_v2";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  ts: number; // timestamp written
}

function readCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object" || typeof entry.ts !== "number") return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    if (!Array.isArray(entry.data)) return null;
    return entry.data as T;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* storage full — ignore */ }
}

/** 后端原始行 → Model。缓存种子与网络返回共用，保证两条路径产出同一形状。 */
function parseModelRows(data: unknown): Model[] {
  if (!Array.isArray(data)) return [];
  try {
    const rows = data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
    const parsed: Model[] = rows.map((r) => {
      const meta = MODEL_METADATA[String(r.id)] ?? {};
      return {
        id: String(r.id),
        name: String(r.name || r.id),
        provider: String(r.provider || ""),
        status: (r.status as Model["status"]) || "online",
        category: displayCategoryForModel(String(r.id), r.category as string) as Model["category"],
        baseUrl: r.baseUrl as string | undefined,
        modelApiName: r.modelApiName as string | undefined,
        importFormat: (r.importFormat as Model["importFormat"]) || "openai",
        customHeaders: r.customHeaders as Record<string, string> | undefined,
        endpoints: r.endpoints as Model["endpoints"],
        endpointCount: r.endpointCount as number | undefined,
        pricing: "",
        shortDescription: String(meta.shortDescription ?? r.short_desc ?? r.shortDescription ?? ""),
        description: String(meta.description ?? r.description ?? ""),
        contextWindow: String(meta.contextWindow ?? r.context_window ?? r.contextWindow ?? "-"),
        speed: (meta.speed ?? r.speed as Model["speed"]) || "medium",
        arch: (meta.arch ?? r.arch) as Model["arch"],
        params: String(meta.params ?? r.params ?? ""),
        activatedParams: (meta.activatedParams ?? r.activatedParams) as string | undefined,
        dimension: (meta.dimension ?? r.dimension) as string | undefined,
        addedAt: String(meta.addedAt ?? r.addedAt ?? ""),
        releaseDate: (meta.releaseDate ?? r.releaseDate) as string | undefined,
        tags: (meta.tags ?? r.tags) as string[] | undefined,
        badge: (meta.badge ?? r.badge) as Model["badge"],
        scene: (meta.scene ?? r.scene) as Model["scene"],
        scenes: (meta.scenes ?? r.scenes) as Model["scenes"],
        autoApprove: Boolean(meta.autoApprove ?? r.autoApprove),
        resolveToModelId: (r.resolve_to_model_id ?? r.resolveToModelId) as string | null | undefined,
      } as Model;
    });
    return parsed.map((m) => ({ ...m, tags: autoTagModel(m) }));
  } catch (e) {
    console.error("[apiplatform] parseModelRows 失败，忽略该批数据", e);
    return [];
  }
}

/** 后端原始通知行 → NotificationItem，跳过非对象项。 */
function parseNotifRows(data: unknown): NotificationItem[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .map((n) => ({
      id: String(n.id ?? ""),
      title: String(n.title ?? ""),
      description: String(n.description ?? ""),
      type: n.type as NotificationItem["type"],
      date: String(n.date ?? ""),
      isNew: Boolean(n.isNew ?? false),
      details: Array.isArray(n.details) ? n.details.map(String) : undefined,
    }));
}

export function ModelProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<Model[]>(() =>
    // Seed from cache immediately so UI renders without waiting for network.
    // 缓存里是后端原始行，必须过同一套解析，否则缺字段会在渲染期抛错白屏。
    parseModelRows(readCache<unknown[]>(CACHE_KEY_MODELS)),
  );
  const [notifications, setNotifications] = useState<NotificationItem[]>(() =>
    parseNotifRows(readCache<unknown[]>(CACHE_KEY_NOTIFS)),
  );
  // Health probing disabled — use static empty map to avoid backend load
  const health: Record<string, ModelHealth> = {};

  // Stale-while-revalidate: if cached data was used above, still revalidate
  // in the background so next render or next session gets fresh data.
  useEffect(() => {
    fetch("/api/public/models")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((payload: { data?: unknown[] } | unknown[]) => {
        const data = Array.isArray(payload) ? payload : (payload?.data ?? []);
        if (!Array.isArray(data) || data.length === 0) return;
        writeCache(CACHE_KEY_MODELS, data);
        const parsed = parseModelRows(data);
        if (parsed.length > 0) setModels(parsed);
      })
      .catch(() => { /* keep cached data */ });

    fetch("/api/public/notifications")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: unknown) => {
        if (Array.isArray(data) && data.length > 0) {
          writeCache(CACHE_KEY_NOTIFS, data);
          setNotifications(parseNotifRows(data));
        }
      })
      .catch(() => { /* keep cached data */ });
  }, []);

  return (
    <ModelContext.Provider value={{ models, setModels, notifications, setNotifications, health }}>
      {children}
    </ModelContext.Provider>
  );
}

export function useModels() {
  return useContext(ModelContext);
}
