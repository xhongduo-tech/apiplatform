import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "../code-block";
import { Html } from "./i18n-html";
import { Lightbulb, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { useT, type TranslationKey } from "../../i18n";
import { MONO, tabs, tabLang, type TabKey } from "./scenario-data";
import { scrollBehavior, sectionDeepLink } from "./docs-constants";
import type { TocItem } from "./docs-toc";
import { useDocsLanguage } from "./docs-language-context";
import { copyText } from "../../browser-compat";

/** Hover 时出现的小节锚点：点击复制可分享深链并滚动到该小节。 */
function HeadingAnchor({ id }: { id: string }) {
  const { t } = useT();
  const copyLink = (e: React.MouseEvent) => {
    e.preventDefault();
    const url = sectionDeepLink(id);
    void copyText(url).then((ok) => {
      toast[ok ? "success" : "error"](t(ok ? "docsPage.copyLinkDone" : "common.copyFailed"));
    });
    document.getElementById(id)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    window.history.replaceState(null, "", url);
  };
  return (
    <a
      href={`#${id}`}
      className="docs-heading-anchor"
      aria-label={t("docsPage.copyLink")}
      onClick={copyLink}
    >
      <LinkIcon size={14} aria-hidden="true" />
    </a>
  );
}

/** h2：锚点自动取最近的 `section[id]`，调用点无需重复传 id。 */
export function DocsH2({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  useEffect(() => {
    const sec = ref.current?.closest("section[id]") as HTMLElement | null;
    if (sec?.id) setAnchor(sec.id);
  }, []);
  return (
    <h2 ref={ref} className="docs-h2">
      {children}
      {anchor && <HeadingAnchor id={anchor} />}
    </h2>
  );
}

/** h3：本身就带锚点 id（例如 chat-request），直接复用。 */
export function DocsH3({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="docs-h3">
      {children}
      <HeadingAnchor id={id} />
    </h3>
  );
}

export function buildTocItems(t: (k: TranslationKey) => string): TocItem[] {
  return [
    // Getting started
    { id: "introduction", label: t("docsPage.toc.introduction"), level: 2 },
    { id: "quickstart", label: t("docsPage.toc.quickstart"), level: 2 },
    { id: "authentication", label: t("docsPage.toc.authentication"), level: 2 },
    { id: "base-urls", label: t("docsPage.toc.baseUrls"), level: 2 },
    // Core concepts
    { id: "models", label: t("docsPage.toc.models"), level: 2 },
    { id: "models-list", label: t("docsPage.models.list.title"), level: 3 },
    { id: "models-alias", label: t("docsPage.models.alias.title"), level: 3 },
    { id: "errors", label: t("docsPage.toc.errors"), level: 2 },
    { id: "rate-limits", label: t("docsPage.toc.rateLimits"), level: 2 },
    { id: "rate-tiers", label: t("docsPage.rate.tiers.title"), level: 3 },
    { id: "rate-headers", label: t("docsPage.rate.headers.title"), level: 3 },
    { id: "pagination", label: t("docsPage.toc.pagination"), level: 2 },
    { id: "versioning", label: t("docsPage.toc.versioning"), level: 2 },
    // Capabilities
    { id: "thinking-mode", label: t("docsPage.toc.thinkingMode"), level: 2 },
    { id: "vision", label: t("docsPage.toc.vision"), level: 2 },
    { id: "vision-image", label: t("docsPage.vision.image.title"), level: 3 },
    { id: "vision-ocr", label: t("docsPage.vision.ocr.title"), level: 3 },
    { id: "tool-use", label: t("docsPage.toc.toolUse"), level: 2 },
    { id: "multi-turn", label: t("docsPage.toc.multiTurn"), level: 2 },
    { id: "json-mode", label: t("docsPage.toc.jsonMode"), level: 2 },
    { id: "token-usage", label: t("docsPage.toc.tokenUsage"), level: 2 },
    { id: "context-caching", label: t("docsPage.toc.contextCaching"), level: 2 },
    // API reference
    { id: "chat-api", label: t("docsPage.toc.chatApi"), level: 2 },
    { id: "chat-request", label: t("docsPage.toc.chatRequest"), level: 3 },
    { id: "chat-streaming", label: t("docsPage.toc.chatStreaming"), level: 3 },
    { id: "chat-json", label: t("docsPage.toc.chatJson"), level: 3 },
    { id: "embeddings-rerank", label: t("docsPage.toc.embeddings"), level: 2 },
    { id: "embeddings-vectors", label: t("docsPage.embeddingsRerank.embedding.title"), level: 3 },
    { id: "rerank", label: t("docsPage.embeddingsRerank.rerank.title"), level: 3 },
    { id: "completions", label: t("docsPage.toc.completions"), level: 2 },
    { id: "responses", label: t("docsPage.toc.responses"), level: 2 },
    { id: "messages", label: t("docsPage.toc.messages"), level: 2 },
    { id: "count-tokens", label: t("docsPage.countTokens.title"), level: 2 },
    { id: "api-reference/endpoints", label: t("docsPage.toc.endpointsTable"), level: 2 },
    // Platform & ops
    { id: "infrastructure", label: t("docsPage.toc.infrastructure"), level: 2 },
    { id: "agent-tools", label: t("docsPage.toc.agentTools"), level: 2 },
    { id: "usage-logs", label: t("docsPage.toc.usageLogs"), level: 2 },
    { id: "night-batch", label: t("docsPage.toc.nightBatch"), level: 2 },
    { id: "best-practices", label: t("docsPage.toc.bestPractices"), level: 2 },
    // Help
    { id: "faq", label: t("docsPage.toc.faq"), level: 2 },
    { id: "changelog", label: t("docsPage.toc.changelog"), level: 2 },
  ];
}

/** 方法徽章的底色/字色配对。--primary 在暗色主题下等于 --ink（近乎纯白），
 *  不能像 --ok/--danger 那样默认配白字，必须用 --primary-foreground 保证反色。 */
export function methodBadgeColor(method: string): { bg: string; fg: string } {
  if (method === "GET") return { bg: "var(--ok)", fg: "#fff" };
  if (method === "POST") return { bg: "var(--primary)", fg: "var(--primary-foreground)" };
  if (method === "DELETE") return { bg: "var(--danger)", fg: "#fff" };
  return { bg: "var(--block-peach)", fg: "var(--on-peach)" };
}

export function MethodPill({ method, path }: { method: string; path: string }) {
  const { bg, fg } = methodBadgeColor(method);
  return (
    <div className="docs-method">
      <span className="docs-method__verb" style={{ background: bg, color: fg }}>{method}</span>
      <code className="docs-method__path" style={MONO}>{path}</code>
    </div>
  );
}

export function Note({
  tone = "note",
  icon: Icon = Lightbulb,
  title,
  children,
}: {
  tone?: "note" | "warning" | "important" | "tip";
  icon?: typeof Lightbulb;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <aside className={`docs-admonition docs-admonition--${tone}`}>
      <span className="docs-admonition__icon"><Icon size={15} /></span>
      <div className="docs-admonition__body">
        {title && <p className="docs-admonition__title">{title}</p>}
        <div className="docs-admonition__content">{children}</div>
      </div>
    </aside>
  );
}

export function ParamTable({
  title,
  rows,
}: {
  title?: string;
  rows: { name: string; type: string; required?: boolean; desc: string; def?: string }[];
}) {
  return (
    <div className="docs-paramtable">
      {title && <p className="docs-paramtable__title">{title}</p>}
      <div className="docs-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>
                  <code className="docs-paramtable__name">{r.name}</code>
                  {r.required && <span className="docs-paramtable__required">required</span>}
                </td>
                <td><code className="docs-paramtable__type">{r.type}</code></td>
                <td>{r.desc}{r.def && <span className="docs-paramtable__default"> Default: <code>{r.def}</code></span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function P({ htmlKey, vars }: { htmlKey: TranslationKey; vars?: Record<string, string> }) {
  const { t } = useT();
  return (
    <Html as="p" className="docs-prose" html={t(htmlKey)} vars={vars} />
  );
}

/** 响应字段表：字段名 · 类型 · 说明（对应响应 JSON 的语义）。 */
export function ResponseFields({
  title,
  rows,
}: {
  title?: string;
  rows: { name: string; type: string; desc: string }[];
}) {
  const { t } = useT();
  return (
    <div className="docs-paramtable">
      <p className="docs-paramtable__title">{title ?? t("docsPage.reference.responseFields")}</p>
      <div className="docs-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td><code className="docs-paramtable__name">{r.name}</code></td>
                <td><code className="docs-paramtable__type">{r.type}</code></td>
                <td>{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 「本端点支持流式返回」提示，链回 Chat Completions 的流式小节。 */
export function StreamingHint() {
  const { t } = useT();
  return (
    <p className="docs-prose">
      {t("docsPage.reference.streamingHint")}{" "}
      <a
        href="#chat-streaming"
        className="docs-inline-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("chat-streaming")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        }}
      >
        {t("docsPage.reference.streamingHintLink")}
      </a>
    </p>
  );
}

export function CodeTabs({
  codeMap,
  fileMap,
}: {
  codeMap?: Record<TabKey, string>;
  fileMap?: Record<TabKey, string>;
}) {
  const { activeTab, setActiveTab } = useDocsLanguage();
  const tabCode = codeMap ?? ({} as Record<TabKey, string>);
  const tabFile = fileMap ?? ({} as Record<TabKey, string>);
  return (
    <div className="docs-tabs">
      <div className="docs-tabs__bar">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setActiveTab(tb.key)}
            className={`docs-tabs__tab ${activeTab === tb.key ? "docs-tabs__tab--active" : ""}`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <CodeBlock variant="dark" code={tabCode[activeTab]} lang={tabLang[activeTab]} label={tabFile[activeTab]} />
    </div>
  );
}
