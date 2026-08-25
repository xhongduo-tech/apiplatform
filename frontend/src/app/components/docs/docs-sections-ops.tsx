import { useT } from "../../i18n";
import { Note, P, ParamTable, DocsH2 } from "./docs-shared";
import { Html } from "./i18n-html";
import { AlertCircle, Lightbulb, ExternalLink, CheckCircle2 } from "lucide-react";

export function DocsSectionsOps() {
  const { t } = useT();

  return (
    <>
      <section id="usage-logs" className="docs-section">
        <p className="docs-section__eyebrow">Observability</p>
        <DocsH2>{t("docsPage.usageLogs.title")}</DocsH2>
        <P htmlKey="docsPage.usageLogs.desc" />

        <h3 className="docs-h3">{t("docsPage.usageLogs.recording.title")}</h3>
        <P htmlKey="docsPage.usageLogs.recording.body" />

        <Note tone="tip" icon={Lightbulb} title={t("docsPage.usageLogs.troubleshoot.title")}>
          <p>{t("docsPage.usageLogs.troubleshoot.body")}</p>
        </Note>

        <h3 className="docs-h3">{t("docsPage.usageLogs.retention.title")}</h3>
        <P htmlKey="docsPage.usageLogs.retention.body" />

        <h3 className="docs-h3">{t("docsPage.usageLogs.cost.title")}</h3>
        <P htmlKey="docsPage.usageLogs.cost.body" />

        <h3 className="docs-h3">{t("docsPage.usageLogs.streaming.title")}</h3>
        <P htmlKey="docsPage.usageLogs.streaming.body" />

        <h3 className="docs-h3">{t("docsPage.usageLogs.analytics.title")}</h3>
        <P htmlKey="docsPage.usageLogs.analytics.body" />

        <h3 className="docs-h3">{t("docsPage.usageLogs.fallback.title")}</h3>
        <P htmlKey="docsPage.usageLogs.fallback.body" />

        <div className="docs-console-links">
          <a href="/usage" className="docs-console-link">
            <span className="docs-console-link__title">{t("docsPage.usageLogs.usage.title")}</span>
            <span className="docs-console-link__desc">{t("docsPage.usageLogs.usage.body")}</span>
            <ExternalLink size={12} />
          </a>
          <a href="/logs" className="docs-console-link">
            <span className="docs-console-link__title">{t("docsPage.usageLogs.logs.title")}</span>
            <span className="docs-console-link__desc">{t("docsPage.usageLogs.logs.body")}</span>
            <ExternalLink size={12} />
          </a>
        </div>
      </section>

      <section id="night-batch" className="docs-section">
        <p className="docs-section__eyebrow">Night batch</p>
        <DocsH2>{t("docsPage.nightBatch.title")}</DocsH2>
        <P htmlKey="docsPage.nightBatch.desc" />
        <Note tone="important" icon={AlertCircle} title={t("docsPage.nightBatch.notice.title")}>
          <Html as="p" html={t("docsPage.nightBatch.notice.body")} />
        </Note>
        <ParamTable
          title={t("docsPage.nightBatch.endpoints.title")}
          rows={[
            { name: "GET /api/night-batch", type: "list", desc: t("docsPage.nightBatch.row0") },
            { name: "POST /api/night-batch", type: "register", desc: t("docsPage.nightBatch.row1") },
            { name: "PATCH /api/night-batch/{reg_id}", type: "update", desc: t("docsPage.nightBatch.row3") },
            { name: "DELETE /api/night-batch/{reg_id}", type: "delete", desc: t("docsPage.nightBatch.row4") },
            { name: "PATCH /api/night-batch/series/{series_id}", type: "update", desc: t("docsPage.nightBatch.row3") },
            { name: "DELETE /api/night-batch/series/{series_id}", type: "delete", desc: t("docsPage.nightBatch.row2") },
          ]}
        />
      </section>

      <section id="best-practices" className="docs-section">
        <p className="docs-section__eyebrow">Best practices</p>
        <DocsH2>{t("docsPage.bestPractices.title")}</DocsH2>
        <div className="docs-best-practices">
          {[
            { t: t("docsPage.bestPractices.streaming.title"), b: t("docsPage.bestPractices.streaming.body") },
            { t: t("docsPage.bestPractices.retry.title"), b: t("docsPage.bestPractices.retry.body") },
            { t: t("docsPage.bestPractices.context.title"), b: t("docsPage.bestPractices.context.body") },
            { t: t("docsPage.bestPractices.security.title"), b: t("docsPage.bestPractices.security.body") },
            { t: t("docsPage.bestPractices.alias.title"), b: t("docsPage.bestPractices.alias.body") },
            { t: t("docsPage.bestPractices.monitor.title"), b: t("docsPage.bestPractices.monitor.body") },
          ].map((x) => (
            <div key={x.t} className="docs-best-practices__item">
              <CheckCircle2 size={14} className="text-ok" />
              <div>
                <p>{x.t}</p>
                <span>{x.b}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
