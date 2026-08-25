/**
 * 启动时注入的旧浏览器运行时兜底（统信 360 / 麒麟 奇安信 / 旧 Chromium）。
 * 特性检测 + 版本探测 + 性能降级，不依赖任何外部 CDN。
 */

import {
  parseBrowserProfile,
  shouldReduceEffects,
  supportsBackdropFilter,
  supportsColorMix,
  supportsCssVariables,
  supportsFlexGap,
} from "./compat-utils";

export function initCompat(): void {
  // 全局错误捕获：记录 .map crash 的完整调用栈
  const _onerror = window.onerror;
  window.onerror = function (msg, src, line, col, err) {
    if (typeof msg === "string" && msg.includes("map is not a function")) {
      console.error("[apiplatform] .map crash — 完整堆栈:", err?.stack || msg, { src, line, col });
    }
    if (_onerror) return _onerror.apply(this, arguments as any);
    return false;
  };

  const root = document.documentElement;
  const profile = parseBrowserProfile(navigator.userAgent);

  // 1) flex gap（Chrome < 84 不支持 flex gap；默认 row 方向最多）
  if (!supportsFlexGap(document)) {
    root.classList.add("no-gap-support");
  }

  // 2) backdrop-filter（Chromium < 76）
  if (!supportsBackdropFilter()) {
    root.classList.add("no-backdrop-filter");
  }

  // 3) color-mix()（Chrome < 111）
  if (!supportsColorMix()) {
    root.classList.add("no-color-mix");
  }

  // 4) 老旧 / 低性能 / 国产壳内核：关闭高开销动效
  let hasReadableStream = true;
  try {
    hasReadableStream = typeof ReadableStream !== "undefined";
  } catch {
    hasReadableStream = false;
  }
  if (
    shouldReduceEffects(profile, {
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      hasReadableStream,
      hasAbortController: typeof AbortController !== "undefined",
    })
  ) {
    root.classList.add("legacy-browser", "reduce-motion");
  }

  // 5) 系统“减少动态效果”
  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      root.classList.add("reduce-motion");
    }
  } catch {
    /* 老浏览器无 matchMedia */
  }

  // 6) requestAnimationFrame 兜底
  if (!("requestAnimationFrame" in window)) {
    const w = window as Window & { requestAnimationFrame?: (cb: FrameRequestCallback) => number };
    w.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16);
  }

  // 7) CSS 自定义属性不支持 → 兜底背景
  if (!supportsCssVariables()) {
    try {
      document.body.style.background = "#fbfaf6";
      document.body.style.color = "#16161d";
    } catch {
      /* ignore */
    }
  }

  // 8) IntersectionObserver 缺失时标记（供 CSS / 组件按需降级）
  if (typeof IntersectionObserver === "undefined") {
    root.classList.add("no-intersection-observer");
  }

  // 9) 标记国产壳，供 CSS 按需微调（字体渲染等）
  if (profile.isDomesticShell) {
    root.classList.add("domestic-shell");
  }
}
