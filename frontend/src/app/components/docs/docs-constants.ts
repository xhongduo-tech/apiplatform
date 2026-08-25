import { publicApiOrigin } from "../../api/public-api-origin";

/**
 * 文档页共享常量。Base URL 此前散落在 index.tsx（renderCode 里硬编码字符串）与
 * docs-hero.tsx（badge 里硬编码主机名）两处，且与代码示例实际使用的
 * publicApiOrigin() 可能漂移。统一从同一来源派生。
 */
export const DOCS_BASE_URL = publicApiOrigin();

/** 不含协议的主机名，用于 Hero badge 等展示场景。 */
export const DOCS_BASE_HOST = DOCS_BASE_URL.replace(/^https?:\/\//, "");

/**
 * 端点总表里，已经在正文有独立详情章节的端点 → 对应锚点 id。
 * 用于让「总览表 → 详情」形成闭环跳转。
 */
export const ENDPOINT_ANCHORS: Record<string, string> = {
  "/v1/chat/completions": "chat-api",
  "/v1/completions": "completions",
  "/v1/embeddings": "embeddings-rerank",
  "/v1/rerank": "embeddings-rerank",
  "/v1/responses": "responses",
  "/v1/messages": "messages",
  "/v1/ocr": "vision",
};

/**
 * 文档「报告问题 / 编辑此页」入口。此处指向内部论坛；若接入了工单系统或
 * 文档仓库，改这一处即可。
 */
export const DOCS_ISSUE_HREF = "/forum";

/** 遵循用户「减少动态效果」偏好的滚动行为。 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** 生成指向某个文档小节的可分享深链（沿用页面已有的 ?section= 约定）。 */
export function sectionDeepLink(id: string): string {
  return `${window.location.origin}${window.location.pathname}?section=${id}`;
}
