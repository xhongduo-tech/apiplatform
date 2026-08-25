/** 文档与示例中展示的 public API origin；可在构建时显式覆盖，默认使用当前站点。 */
export function publicApiOrigin(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_API_ORIGIN as string | undefined;
  if (fromEnv?.trim()) return fromEnv.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") {
    return window.location.origin.replace(/\/$/, "");
  }
  return "http://localhost";
}
