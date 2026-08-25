import { lazy, type ComponentType } from "react";

/**
 * React.lazy 的容错版：动态 import 失败（弱网抖动 / 发版后旧 hash 分片 404）时
 * 先原地重试一次，仍失败则整页刷新拿最新 HTML（30 秒内最多自动刷新一次，
 * 防循环），彻底避免“懒加载分片失效 → 白屏”。
 */

const RELOAD_FLAG = "apiplatform-lazy-reload-at";
const RELOAD_COOLDOWN_MS = 30_000;

function retryImport<T>(factory: () => Promise<T>): Promise<T> {
  return factory().catch((err: unknown) => {
    // 稍候重试一次，抹平瞬时网络抖动
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        factory().then(resolve).catch((err2: unknown) => {
          try {
            const last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
            if (Date.now() - last > RELOAD_COOLDOWN_MS) {
              sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
              window.location.reload();
              return; // 页面即将刷新，不再 reject
            }
          } catch {
            /* sessionStorage 不可用则不自动刷新，交给 ErrorBoundary */
          }
          reject(err2 ?? err);
        });
      }, 800);
    });
  });
}

/** 替代 lazy(() => import(...))；importer 返回含默认导出的模块。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
) {
  return lazy(() => retryImport(importer));
}

interface PrefetchConnection {
  saveData?: boolean;
  effectiveType?: string;
}

export function shouldPrefetch(connection?: PrefetchConnection, pageHidden = false): boolean {
  if (pageHidden || connection?.saveData) return false;
  return !connection?.effectiveType || !["slow-2g", "2g", "3g"].includes(connection.effectiveType);
}

/**
 * 空闲时只预热最可能访问的前三个分片。管理后台曾一次拉取全部 Tab，
 * 首页也会争抢字体/首屏图片带宽；限制预算后，其余路由仍会在首次访问时正常加载。
 */
export function prefetchOnIdle(
  importers: Array<() => Promise<unknown>>,
  { maxChunks = 3 }: { maxChunks?: number } = {},
): void {
  try {
    if (document.documentElement.classList.contains("legacy-browser")) return;
    const conn = (navigator as Navigator & { connection?: PrefetchConnection }).connection;
    if (!shouldPrefetch(conn, document.hidden)) return;
  } catch {
    return;
  }
  const candidates = importers.slice(0, Math.max(0, maxChunks));
  if (candidates.length === 0) return;
  const run = () => {
    if (document.hidden) return;
    candidates.forEach((imp, i) => {
      // 逐个错峰加载，避免同时抢占带宽
      setTimeout(() => {
        imp().catch(() => { /* 预取失败无所谓，真正访问时再走 lazyRetry */ });
      }, i * 300);
    });
  };
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 2500);
  }
}
