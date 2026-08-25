import { ChevronRight } from "lucide-react";
import { DocsSection } from "./docs-section";
import { useT } from "../../i18n";
import { SCENARIOS, AGENT_LOGOS, type ScenarioKey } from "./scenario-data";

export function AgentToolsSection({ openScenario }: { openScenario: (k: ScenarioKey) => void }) {
  const { t } = useT();

  return (
    <DocsSection
      id="agent-tools"
      eyebrow={t("docsPage.agentTools.eyebrow")}
      title={t("docsPage.agentTools.title")}
      desc={t("docsPage.agentTools.desc")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {SCENARIOS.filter((sc) => sc.group === "agent").map((sc) => (
          <button
            key={sc.key}
            onClick={() => openScenario(sc.key)}
            className="card-interactive apiplatform-btn flex flex-col items-start p-5 text-left"
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-bg-soft">
              {AGENT_LOGOS[sc.key] ? (
                <img src={AGENT_LOGOS[sc.key]} alt={t(sc.titleKey)} className="h-6 w-6 object-contain" />
              ) : (
                <sc.Icon className={`h-6 w-6 ${sc.ic}`} />
              )}
            </div>
            <h3 className="font-serif text-[16px] font-medium text-foreground">
              {t(sc.titleKey)}
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">{t(sc.descKey)}</p>
            <div className="mt-4 flex items-center gap-1 text-[12px] font-medium text-primary">
              {t("docsPage.agentTools.viewMore")}
              <ChevronRight className="h-3.5 w-3.5" />
            </div>
          </button>
        ))}
      </div>
    </DocsSection>
  );
}
