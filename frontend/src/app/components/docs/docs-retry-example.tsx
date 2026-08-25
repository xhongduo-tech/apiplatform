import { useState } from "react";
import { CodeBlock } from "../code-block";
import { useT } from "../../i18n";
import { retryCode, retryFile, tabs, tabLang, type TabKey } from "./scenario-data";

export function DocsRetryExample({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>("python");

  return (
    <div className={`docs-retry ${compact ? "docs-retry--compact" : ""}`}>
      {!compact && (
        <>
          <p className="docs-section__eyebrow">{t("docsPage.reference.eyebrow")}</p>
          <h2 className="docs-h2">{t("docsPage.reference.retry.title")}</h2>
          <p className="docs-prose">{t("docsPage.reference.retry.desc")}</p>
        </>
      )}
      <div className="docs-tabs">
        <div className="docs-tabs__bar">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`docs-tabs__tab ${tab === tb.key ? "docs-tabs__tab--active" : ""}`}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <CodeBlock variant="dark" code={retryCode[tab]} lang={tabLang[tab]} label={retryFile[tab]} />
      </div>
    </div>
  );
}
