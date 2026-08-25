/**
 * 旧浏览器 / 国产 Chromium 壳检测（纯函数，可单测）。
 * 覆盖：IE、EdgeHTML、360/奇虎/QQ/UC 等内网常见内核。
 */

export type BrowserProfile = {
  /** Chromium 主版本（含 Edg/、360 极速核等）；无法解析时为 null */
  chromeMajor: number | null;
  isIE: boolean;
  /** 旧版 Edge（EdgeHTML，UA 含 Edge/ 但不含 Edg/） */
  isEdgeHtml: boolean;
  /** 360 安全/极速、奇虎、QQ、UC 等国产 Chromium 壳 */
  isDomesticShell: boolean;
};

const DOMESTIC_SHELL_RE =
  /360(?:SE|EE|Browser|Chrome)|QIHU|QihooBrowser|QHBrowser|QAXBrowser|KylinBrowser|UOSBrowser|UnionTech|QtWebEngine|QQBrowser|MQQBrowser|UCBrowser|UBrowser|MetaSr|SogouMobileBrowser/i;

/** 从 UA 解析浏览器画像（不访问 DOM） */
export function parseBrowserProfile(ua: string): BrowserProfile {
  const isIE = /MSIE |Trident\//.test(ua);
  const isEdgeHtml = /Edge\//.test(ua) && !/Edg\//.test(ua);
  const isDomesticShell = DOMESTIC_SHELL_RE.test(ua);
  const chromeMajor = detectChromiumMajor(ua);
  return { chromeMajor, isIE, isEdgeHtml, isDomesticShell };
}

/** 解析 Chromium 系主版本：Chrome/CriOS、Edg/，360 等壳同样带 Chrome/x */
export function detectChromiumMajor(ua: string): number | null {
  const edge = /Edg\/(\d+)/.exec(ua);
  if (edge) return parseInt(edge[1], 10);
  const chrome = /(?:Chrome|Chromium|CriOS)\/(\d+)/.exec(ua);
  return chrome ? parseInt(chrome[1], 10) : null;
}

/** IE 无法运行现代 SPA，应展示静态降级页；EdgeHTML 由 legacy nomodule 包承接 */
export function shouldBlockLegacyEngine(profile: BrowserProfile): boolean {
  return profile.isIE;
}

/** 是否应注入 legacy-browser / reduce-motion 降级类 */
export function shouldReduceEffects(
  profile: BrowserProfile,
  opts?: {
    hardwareConcurrency?: number;
    deviceMemory?: number;
    hasReadableStream?: boolean;
    hasAbortController?: boolean;
  },
): boolean {
  // EdgeHTML（旧 Edge）性能与特性均弱于 Chromium，一律降级
  if (profile.isEdgeHtml) return true;

  const major = profile.chromeMajor;
  if (major !== null && major < 90) return true;
  // 国产壳常滞后上游 Chromium，保守多降一级
  if (profile.isDomesticShell && major !== null && major < 100) return true;

  const cores = opts?.hardwareConcurrency;
  if (typeof cores === "number" && cores > 0 && cores <= 2) return true;

  const mem = opts?.deviceMemory;
  if (typeof mem === "number" && mem > 0 && mem <= 4) return true;

  if (opts?.hasReadableStream === false) return true;
  if (opts?.hasAbortController === false) return true;
  return false;
}

/** flex gap 特性检测（需 DOM） */
export function supportsFlexGap(doc: Document): boolean {
  try {
    const el = doc.createElement("div");
    el.style.display = "flex";
    (el.style as CSSStyleDeclaration & { gap?: string }).gap = "1px";
    doc.documentElement.appendChild(el);
    const ok = doc.defaultView?.getComputedStyle(el).gap === "1px";
    doc.documentElement.removeChild(el);
    return !!ok;
  } catch {
    return false;
  }
}

/** backdrop-filter 特性检测 */
export function supportsBackdropFilter(): boolean {
  try {
    return !!(window.CSS?.supports?.("backdrop-filter", "blur(1px)") ||
      window.CSS?.supports?.("-webkit-backdrop-filter", "blur(1px)"));
  } catch {
    return false;
  }
}

/** color-mix() 特性检测（Chrome < 111 不支持） */
export function supportsColorMix(): boolean {
  try {
    return !!window.CSS?.supports?.("color", "color-mix(in srgb, #000 50%, #fff)");
  } catch {
    return false;
  }
}

/** CSS 自定义属性特性检测 */
export function supportsCssVariables(): boolean {
  try {
    return !!window.CSS?.supports?.("color", "var(--x)");
  } catch {
    return false;
  }
}
