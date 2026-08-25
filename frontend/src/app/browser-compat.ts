/** 浏览器 Web API 降级工具。不得依赖外部 CDN，适配内网旧 Chromium/Edge。 */

/**
 * 写入剪贴板。Clipboard API 仅在安全上下文且较新内核可用；旧浏览器回落到
 * execCommand，返回是否成功，调用方据此展示成功/失败提示。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒绝时继续尝试旧方案
  }

  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(el);
  }
}

/** AbortController 在 Chrome 66 / Edge 16 才可用；旧内核返回 null。 */
export function createAbortController(): AbortController | null {
  try {
    return typeof AbortController === "undefined" ? null : new AbortController();
  } catch {
    return null;
  }
}
