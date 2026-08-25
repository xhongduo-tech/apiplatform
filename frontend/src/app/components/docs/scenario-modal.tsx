import { useT } from "../../i18n";
import { Html } from "./i18n-html";
import { CodeBlock } from "../code-block";
import {
  SCENARIOS, SCENARIO_CODE, SCENARIO_FILE, SCENARIO_HIGHLIGHT, AGENT_LOGOS,
  MONO, tabs, tabLang, type ScenarioKey, type TabKey,
} from "./scenario-data";

export function ScenarioModal({
  scenario,
  tab,
  onTabChange,
  onClose,
  renderCode,
}: {
  scenario: ScenarioKey;
  tab: TabKey;
  onTabChange: (k: TabKey) => void;
  onClose: () => void;
  renderCode: (tpl: string) => string;
}) {
  const { t } = useT();
  const sc = SCENARIOS.find((s) => s.key === scenario);
  if (!sc) return null;
  const modalCode = renderCode(SCENARIO_CODE[scenario][tab]);
  const modalFile = SCENARIO_FILE[scenario][tab];
  const isAgent = sc.group === "agent";
  const highlight = SCENARIO_HIGHLIGHT[scenario];

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex w-full flex-col overflow-hidden rounded-2xl bg-card"
        style={{ maxWidth: isAgent ? 760 : 720, maxHeight: "85vh", boxShadow: "var(--shadow-pop)" }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: sc.iconBg }}>
              {AGENT_LOGOS[sc.key] ? (
                <img src={AGENT_LOGOS[sc.key]} alt={t(sc.titleKey)} className="h-5 w-5 object-contain" />
              ) : (
                <sc.Icon className={`h-5 w-5 ${sc.ic}`} />
              )}
            </div>
            <div>
              <h3 className="font-serif text-[15px] font-medium text-foreground">{t(sc.titleKey)}</h3>
              <p className="text-[12px] text-fg-muted">{t(sc.descKey)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="apiplatform-hover-scale rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={t("docsPage.modal.close")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-4 border-b border-border/50 bg-secondary/20 px-5 py-2.5 text-[12px]">
          <span className="text-fg-muted">
            {isAgent ? t("docsPage.modal.accessLabel") : t("docsPage.modal.apiLabel")}:{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-foreground" style={MONO}>{sc.api}</code>
          </span>
          {sc.tagKey && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-fg-muted">{t(sc.tagKey)}</span>
          )}
        </div>

        {!isAgent && highlight && (
          <div className="mx-5 mt-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-warn/20 bg-warn/10 px-3 py-2.5 dark:border-warn/20 dark:bg-warn/10">
            <span className="mt-px shrink-0 rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-800/40 dark:text-amber-300">{t("docsPage.modal.highlightBadge")}</span>
            <Html
              as="div"
              className="min-w-0 text-[12px] leading-relaxed text-foreground/80 [&_code]:rounded [&_code]:bg-warn/20 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_code]:text-warn"
              html={t(highlight.labelKey) + `：<code>${highlight.snippet}</code>`}
            />
          </div>
        )}

        {isAgent && (
          <div className="shrink-0 space-y-2 border-b border-border/50 px-5 py-3 text-[13px] leading-relaxed text-fg-muted">
            <p>{t(sc.descKey)}</p>
            <p>{t("docsPage.modal.agentDesc")}</p>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-4 pt-1">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => onTabChange(tb.key)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-[12px] transition-colors ${
                tab === tb.key
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-fg-muted hover:text-foreground"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-4">
          <CodeBlock variant="light" code={modalCode} lang={tabLang[tab]} label={modalFile} />
        </div>
      </div>
    </div>
  );
}
