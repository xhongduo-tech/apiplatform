import { useT, type TranslationKey } from "../../i18n";
import { CodeTabs, Note, P, MethodPill, DocsH2 } from "./docs-shared";
import { Html } from "./i18n-html";
import { SCENARIO_CODE, SCENARIO_FILE, type ScenarioKey } from "./scenario-data";
import { DocsInfrastructureSection } from "./docs-infrastructure-section";
import { AgentToolsSection } from "./agent-tools-section";
import { CheckCircle2, AlertCircle } from "lucide-react";

/** Capabilities（续）—— 基于 chat/completions 的用法指南。 */
export function DocsGuidesCapabilities() {
  const { t } = useT();

  return (
    <>
      <section id="multi-turn" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.multiTurn.eyebrow")}</p>
        <DocsH2>{t("docsPage.multiTurn.title")}</DocsH2>
        <P htmlKey="docsPage.multiTurn.desc" />
        <MethodPill method="POST" path="/v1/chat/completions" />
        <P htmlKey="docsPage.multiTurn.intro" />
        <CodeTabs codeMap={SCENARIO_CODE.multiturn} fileMap={SCENARIO_FILE.multiturn} />
      </section>

      <section id="json-mode" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.jsonMode.eyebrow")}</p>
        <DocsH2>{t("docsPage.jsonMode.title")}</DocsH2>
        <P htmlKey="docsPage.jsonMode.desc" />
        <MethodPill method="POST" path="/v1/chat/completions" />
        <P htmlKey="docsPage.jsonMode.intro" />
        <Note tone="note" title={t("docsPage.jsonMode.strict.title")}>
          <Html as="p" html={t("docsPage.jsonMode.strict.body")} />
        </Note>
        <CodeTabs codeMap={SCENARIO_CODE.json} fileMap={SCENARIO_FILE.json} />
      </section>

      <section id="token-usage" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.tokenUsage.eyebrow")}</p>
        <DocsH2>{t("docsPage.tokenUsage.title")}</DocsH2>
        <P htmlKey="docsPage.tokenUsage.desc" />
        <P htmlKey="docsPage.tokenUsage.intro" />
        <P htmlKey="docsPage.tokenUsage.where" />
        <P htmlKey="docsPage.tokenUsage.streaming" />
      </section>

      <section id="context-caching" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.contextCaching.eyebrow")}</p>
        <DocsH2>{t("docsPage.contextCaching.title")}</DocsH2>
        <P htmlKey="docsPage.contextCaching.desc" />
        <P htmlKey="docsPage.contextCaching.intro" />
        <P htmlKey="docsPage.contextCaching.how" />
      </section>
    </>
  );
}

/** Platform —— 网关架构与 Agent 工具接入。 */
export function DocsPlatform({ openScenario }: { openScenario: (k: ScenarioKey) => void }) {
  return (
    <>
      <DocsInfrastructureSection />
      <AgentToolsSection openScenario={openScenario} />
    </>
  );
}

/** Help —— 常见问题 + 更新日志。 */
export function DocsHelp() {
  const { t } = useT();

  return (
    <>
      <section id="faq" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.faq.eyebrow")}</p>
        <DocsH2>{t("docsPage.faq.title")}</DocsH2>
        <P htmlKey="docsPage.faq.desc" />
        <div className="docs-best-practices">
          {[
            { t: t("docsPage.faq.q1.title"), b: t("docsPage.faq.q1.body") },
            { t: t("docsPage.faq.q2.title"), b: t("docsPage.faq.q2.body") },
            { t: t("docsPage.faq.q3.title"), b: t("docsPage.faq.q3.body") },
            { t: t("docsPage.faq.q4.title"), b: t("docsPage.faq.q4.body") },
            { t: t("docsPage.faq.q5.title"), b: t("docsPage.faq.q5.body") },
          ].map((x) => (
            <div key={x.t} className="docs-best-practices__item">
              <CheckCircle2 size={14} className="text-ok" />
              <div>
                <p>{x.t}</p>
                <Html html={x.b} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="changelog" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.changelog.eyebrow")}</p>
        <DocsH2>{t("docsPage.changelog.title")}</DocsH2>
        <P htmlKey="docsPage.changelog.desc" />
        <Note tone="note" icon={AlertCircle}>
          <Html as="p" html={t("docsPage.changelog.note")} />
        </Note>
        <ul className="docs-changelog">
          {[
            { date: "docsPage.changelog.v3.date", tag: "docsPage.changelog.v3.tag", body: "docsPage.changelog.v3.body" },
            { date: "docsPage.changelog.v2.date", tag: "docsPage.changelog.v2.tag", body: "docsPage.changelog.v2.body" },
            { date: "docsPage.changelog.v1.date", tag: "docsPage.changelog.v1.tag", body: "docsPage.changelog.v1.body" },
          ].map((entry) => (
            <li key={entry.date} className="docs-changelog__entry">
              <div className="docs-changelog__meta">
                <span className="docs-changelog__date">{t(entry.date as TranslationKey)}</span>
                <span className="docs-changelog__tag">{t(entry.tag as TranslationKey)}</span>
              </div>
              <Html as="p" className="docs-changelog__body" html={t(entry.body as TranslationKey)} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
