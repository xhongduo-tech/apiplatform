import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, KeyRound, BookOpen, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useT, type TranslationKey } from "../../i18n";
import { buildTocItems } from "./docs-shared";

interface NavGroup {
  title: string;
  items: NavItem[];
}

interface NavItem {
  id: string;
  label: string;
  badge?: string;
}

const CONSOLE_LINKS: { id: string; labelKey: TranslationKey; href: string }[] = [
  { id: "keys", labelKey: "docsPage.nav.apiKeys", href: "/keys" },
  { id: "model-plaza", labelKey: "docsPage.nav.modelPlaza", href: "/models" },
  { id: "usage", labelKey: "docsPage.nav.usageConsole", href: "/usage" },
  { id: "logs", labelKey: "docsPage.nav.logs", href: "/logs" },
];

export function DocsSidebar({
  active,
  onJump,
}: {
  active: string;
  onJump: (id: string) => void;
}) {
  const { t } = useT();

  const groups: NavGroup[] = [
    {
      title: t("docsPage.nav.gettingStarted"),
      items: [
        { id: "introduction", label: t("docsPage.nav.introduction") },
        { id: "quickstart", label: t("docsPage.nav.quickstart") },
        { id: "authentication", label: t("docsPage.nav.authentication") },
        { id: "base-urls", label: t("docsPage.nav.baseUrls") },
      ],
    },
    {
      title: t("docsPage.nav.coreConcepts"),
      items: [
        { id: "models", label: t("docsPage.nav.models") },
        { id: "errors", label: t("docsPage.nav.errors") },
        { id: "rate-limits", label: t("docsPage.nav.rateLimits") },
        { id: "pagination", label: t("docsPage.nav.pagination") },
        { id: "versioning", label: t("docsPage.nav.versioning") },
      ],
    },
    {
      title: t("docsPage.nav.capabilities"),
      items: [
        { id: "thinking-mode", label: t("docsPage.nav.thinkingMode") },
        { id: "vision", label: t("docsPage.nav.vision") },
        { id: "tool-use", label: t("docsPage.nav.toolUse") },
        { id: "multi-turn", label: t("docsPage.nav.multiTurn") },
        { id: "json-mode", label: t("docsPage.nav.jsonMode") },
        { id: "token-usage", label: t("docsPage.nav.tokenUsage") },
        { id: "context-caching", label: t("docsPage.nav.contextCaching") },
      ],
    },
    {
      title: t("docsPage.nav.apiReference"),
      items: [
        { id: "chat-api", label: t("docsPage.nav.chatCompletions") },
        { id: "embeddings-rerank", label: t("docsPage.nav.embeddingsRerank") },
        { id: "completions", label: t("docsPage.nav.completions") },
        { id: "responses", label: t("docsPage.nav.responses") },
        { id: "messages", label: t("docsPage.nav.messages"), badge: "Anthropic" },
        { id: "count-tokens", label: t("docsPage.countTokens.title") },
        { id: "api-reference/endpoints", label: t("docsPage.toc.endpointsTable") },
      ],
    },
    {
      title: t("docsPage.nav.platformOps"),
      items: [
        { id: "infrastructure", label: t("docsPage.nav.infrastructure") },
        { id: "agent-tools", label: t("docsPage.nav.agentTools") },
        { id: "usage-logs", label: t("docsPage.nav.usageLogs") },
        { id: "night-batch", label: t("docsPage.nav.nightBatch") },
        { id: "best-practices", label: t("docsPage.nav.bestPractices") },
      ],
    },
    {
      title: t("docsPage.nav.help"),
      items: [
        { id: "faq", label: t("docsPage.nav.faq") },
        { id: "changelog", label: t("docsPage.nav.changelog") },
      ],
    },
  ];

  // 每个 section 的 h3 子锚点（用于展开当前激活项）
  const childrenMap = useMemo(() => {
    const map: Record<string, { id: string; label: string }[]> = {};
    let parent: string | null = null;
    for (const item of buildTocItems(t)) {
      if (item.level === 2) {
        parent = item.id;
      } else if (item.level === 3 && parent) {
        (map[parent] ??= []).push({ id: item.id, label: item.label });
      }
    }
    return map;
  }, [t]);

  // 含激活项的组始终展开；其余可手动折叠
  const activeGroupTitle = useMemo(
    () => groups.find((g) => g.items.some((i) => i.id === active))?.title,
    [groups, active],
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (activeRef.current && containerRef.current) {
      const c = containerRef.current;
      const el = activeRef.current;
      const top = el.offsetTop - c.offsetTop;
      if (top < c.scrollTop || top > c.scrollTop + c.clientHeight - 40) {
        c.scrollTo({ top: top - 80, behavior: "smooth" });
      }
    }
  }, [active]);

  return (
    <nav className="docs-sidenav" aria-label="Documentation navigation">
      <div ref={containerRef} className="docs-sidenav__scroll">
        {groups.map((g) => {
          const isOpen = g.title === activeGroupTitle || !collapsed[g.title];
          return (
            <div key={g.title} className="docs-sidenav__group">
              <button
                type="button"
                className="docs-sidenav__group-title"
                aria-expanded={isOpen}
                onClick={() => setCollapsed((p) => ({ ...p, [g.title]: !(p[g.title] ?? false) }))}
              >
                <ChevronRight
                  size={12}
                  className={`docs-sidenav__group-chev ${isOpen ? "is-open" : ""}`}
                />
                <span>{g.title}</span>
              </button>
              {isOpen && (
                <ul className="docs-sidenav__list">
                  {g.items.map((item) => {
                    const isActive = active === item.id;
                    const kids = isActive ? childrenMap[item.id] : undefined;
                    return (
                      <li key={item.id}>
                        <a
                          ref={isActive ? activeRef : undefined}
                          href={`#${item.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onJump(item.id);
                          }}
                          className={`docs-sidenav__link ${isActive ? "docs-sidenav__link--active" : ""}`}
                          aria-current={isActive ? "location" : undefined}
                        >
                          <span className="docs-sidenav__label">{item.label}</span>
                          {item.badge && <span className="docs-sidenav__badge">{item.badge}</span>}
                        </a>
                        {kids && kids.length > 0 && (
                          <ul className="docs-sidenav__sublist">
                            {kids.map((k) => (
                              <li key={k.id}>
                                <a
                                  href={`#${k.id}`}
                                  className="docs-sidenav__sublink"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    onJump(k.id);
                                  }}
                                >
                                  {k.label}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}

        <div className="docs-sidenav__footer">
          <a href="/keys" className="docs-sidenav__cta">
            <KeyRound size={13} />
            {t("docsPage.nav.cta.getKey")}
          </a>
          <a href="#quickstart" className="docs-sidenav__cta docs-sidenav__cta--ghost">
            <BookOpen size={13} />
            {t("docsPage.nav.cta.quickstart")}
          </a>

          <p className="docs-sidenav__console-title">{t("docsPage.nav.console")}</p>
          <ul className="docs-sidenav__console">
            {CONSOLE_LINKS.map((c) => (
              <li key={c.id}>
                <Link to={c.href} className="docs-sidenav__console-link">
                  <span>{t(c.labelKey)}</span>
                  <ExternalLink size={11} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </nav>
  );
}
