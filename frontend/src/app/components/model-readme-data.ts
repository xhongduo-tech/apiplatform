/**
 * model-readme-data.ts
 *
 * 模型详情页内容——以「怎么用」为核心导向：
 *   1. 接入配置（base_url / api_key / model 名称，一键复制）
 *   2. 示例代码（Python SDK / cURL / 流式 / 工具调用 等）
 *   3. 进阶配置与使用技巧
 *   4. 模型基本信息（上下文窗口、参数量、能力标签）
 *   5. 注意事项
 *
 * 本文件只导出：
 *   - 类型定义（CodeSnippet / FeatureSpotlight / ArticleSection / Badge / ModelInfo / ModelArticle）
 *   - getModelArticle(id, lang)
 *
 * 每种语言的文章数据分别在：
 *   - model-readme-zh.ts     (zh-CN，权威简体内容)
 *   - model-readme-zh-tw.ts  (zh-TW，由 scripts/gen-model-readme-zh-tw.mjs 从上面自动生成的繁体字符级转换，不要手改)
 *   - model-readme-en.ts     (en)
 */

import type { CodeSnippet } from "./model-readme-snippets";

export type { CodeSnippet } from "./model-readme-snippets";

export interface FeatureSpotlight {
  icon: "brain" | "code" | "speed" | "context" | "vision" | "tool" | "multi" | "lang" | "search" | "ocr" | "rank";
  title: string;
  body: string;
}

interface ArticleSection {
  heading: string;
  paragraphs: string[];
  code?: CodeSnippet;
}

interface Badge {
  label: string;
  value: string;
  unit?: string;
}

interface ModelInfo {
  label: string;
  value: string;
}

export interface ModelArticle {
  kicker: string;
  title: string;
  subtitle: string;
  badges: Badge[];
  modelInfo: ModelInfo[];
  lead: string;
  highlights: FeatureSpotlight[];
  sections?: ArticleSection[];
  examples: CodeSnippet[];
  tips?: string[];
  limitations?: string[];
}

// ── Article registry ────────────────────────────────────────────────────────
import { ARTICLES_ZH } from "./model-readme-zh";
import { ARTICLES_ZH_TW } from "./model-readme-zh-tw";
import { ARTICLES_EN } from "./model-readme-en";
import type { Lang } from "../i18n";
import { publicApiOrigin } from "../api/public-api-origin";

const ALIAS_MAP: Record<string, string> = {
  "demo-reasoning-model": "platform-sota",
  "demo-chat-model": "platform-flash",
};

function articlesForLang(lang: Lang): Record<string, ModelArticle> {
  if (lang === "en") return ARTICLES_EN;
  if (lang === "zh-TW") return ARTICLES_ZH_TW;
  return ARTICLES_ZH;
}

export function getModelArticle(id: string, lang: Lang = "zh-CN"): ModelArticle | undefined {
  const key = id.toLowerCase();
  const articles = articlesForLang(lang);
  const article = articles[key] ?? articles[ALIAS_MAP[key] ?? ""] ?? ARTICLES_ZH[key] ?? ARTICLES_ZH[ALIAS_MAP[key] ?? ""];
  if (!article) return undefined;
  const replacements: Record<string, string> = {
    "{{API_BASE_URL}}": `${publicApiOrigin()}/v1`,
    "{{API_KEY}}": "sk-platform-…",
  };
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [token, replacement] of Object.entries(replacements)) {
        out = out.split(token).join(replacement);
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    }
    return value;
  };
  return replace(article) as ModelArticle;
}
