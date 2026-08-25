import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 全局渲染错误兜底：任何组件抛错都不再整页白屏。
 * - 疑似发版后旧 chunk 失效（动态 import 404）：清缓存后自动整页刷新一次；
 * - 其余错误：展示恢复卡片，提供「刷新重试」与「清除本地缓存并刷新」。
 * 自动刷新用 sessionStorage 记一次性标记，防止刷新循环。
 */

const RELOAD_FLAG = "apiplatform-auto-reload-at";
const RELOAD_COOLDOWN_MS = 30_000;

/** Authentication uses the legacy `platform_*` prefix; UI/cache keys use `apiplatform-*`. */
export function isPlatformStorageKey(key: string): boolean {
  return /^(?:apiplatform[-_]|platform[-_])/.test(key) && key !== "apiplatform-theme";
}

/** 清除本平台写入的本地数据（保留主题偏好），等价于用户手动“删除历史数据”。 */
export function clearPlatformStorage(): void {
  try {
    const kill = (store: Storage) => {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && isPlatformStorageKey(k)) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
    };
    kill(sessionStorage);
    kill(localStorage);
  } catch {
    /* ignore */
  }
}

const errorCopy: Record<string, Record<string, string>> = {
  "zh-CN": {
    "error.loadError": "页面加载出现问题",
    "error.cacheIncompatible": "可能是本地缓存数据与当前版本不兼容。点击下方按钮清除缓存后重新加载，无需手动删除浏览器历史数据。",
    "error.retryRefresh": "刷新重试",
    "error.clearCacheAndRefresh": "清除本地缓存并刷新",
    "error.contactAdmin": "若多次出现，请联系平台管理员并附上浏览器控制台截图",
  },
  "zh-TW": {
    "error.loadError": "頁面載入出現問題",
    "error.cacheIncompatible": "可能是本機快取資料與目前版本不相容。點擊下方按鈕清除快取後重新載入，無需手動刪除瀏覽器歷史資料。",
    "error.retryRefresh": "重新整理重試",
    "error.clearCacheAndRefresh": "清除本機快取並重新整理",
    "error.contactAdmin": "若多次出現，請聯繫平台管理員並附上瀏覽器主控台截圖",
  },
  en: {
    "error.loadError": "There was a problem loading the page",
    "error.cacheIncompatible": "Local cache data may be incompatible with the current version. Clear the cache below and reload.",
    "error.retryRefresh": "Retry",
    "error.clearCacheAndRefresh": "Clear Cache & Reload",
    "error.contactAdmin": "If this persists, contact the platform admin with a browser console screenshot.",
  },
};

function t(key: string): string {
  try {
    const lang = localStorage.getItem("apiplatform-lang") || "zh-CN";
    return errorCopy[lang]?.[key] ?? errorCopy["zh-CN"]?.[key] ?? key;
  } catch {
    return errorCopy["zh-CN"]?.[key] ?? key;
  }
}

function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || "");
  return (
    /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|Loading CSS chunk|error loading dynamically imported module/i.test(msg)
  );
}

/** 30 秒内只允许自动刷新一次，避免持续故障时进入刷新循环。 */
function tryAutoReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    /* sessionStorage 不可用时仍然刷新（无循环保护，但至少可恢复） */
  }
  window.location.reload();
  return true;
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[apiplatform] 页面渲染异常", error, info.componentStack);
    if (isChunkLoadError(error)) {
      // 发版后旧页面引用的 hash 分片已不存在：刷新拿新 HTML 即可恢复
      tryAutoReload();
    }
  }

  private refresh = () => {
    window.location.reload();
  };

  private clearAndRefresh = () => {
    clearPlatformStorage();
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            width: "100%",
            textAlign: "center",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "40px 32px",
            boxShadow: "var(--shadow-card)",
            color: "var(--fg)",
          }}
        >
          <div style={{ fontSize: 40, lineHeight: 1 }}>⚠️</div>
          <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 500, margin: "16px 0 8px" }}>
            {t("error.loadError")}
          </h1>
          <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: "0 0 24px", lineHeight: 1.7 }}>
            {t("error.cacheIncompatible")}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={this.refresh}
              style={{
                padding: "9px 20px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--card)",
                color: "var(--fg)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {t("error.retryRefresh")}
            </button>
            <button
              type="button"
              onClick={this.clearAndRefresh}
              style={{
                padding: "9px 20px",
                borderRadius: 10,
                border: "none",
                background: "var(--ink)",
                color: "var(--bg)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {t("error.clearCacheAndRefresh")}
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 20 }}>
            {t("error.contactAdmin")}
          </p>
        </div>
      </div>
    );
  }
}
