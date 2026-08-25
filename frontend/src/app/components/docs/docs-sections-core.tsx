import { useT } from "../../i18n";
import { BASE_URL } from "./scenario-data";
import { CodeTabs, Note, ParamTable, ResponseFields, P, MethodPill, DocsH2, DocsH3 } from "./docs-shared";
import { DocsRetryExample } from "./docs-retry-example";
import { CodeBlock } from "../code-block";
import { ResponseBlock } from "./response-block";
import { SCENARIO_CODE, SCENARIO_FILE } from "./scenario-data";
import { AlertCircle, ShieldAlert, CheckCircle2, Link as LinkIcon } from "lucide-react";
import { Html } from "./i18n-html";

export function DocsSectionsCore() {
  const { t } = useT();

  return (
    <>
      <section id="introduction" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.intro.eyebrow")}</p>
        <DocsH2>{t("docsPage.intro.title")}</DocsH2>
        <P htmlKey="docsPage.intro.p1" />
        <div className="docs-feature-grid">
          <div>
            <h4>{t("docsPage.intro.f1.title")}</h4>
            <p>{t("docsPage.intro.f1.body")}</p>
          </div>
          <div>
            <h4>{t("docsPage.intro.f2.title")}</h4>
            <p>{t("docsPage.intro.f2.body")}</p>
          </div>
          <div>
            <h4>{t("docsPage.intro.f3.title")}</h4>
            <p>{t("docsPage.intro.f3.body")}</p>
          </div>
          <div>
            <h4>{t("docsPage.intro.f4.title")}</h4>
            <p>{t("docsPage.intro.f4.body")}</p>
          </div>
          <div>
            <h4>{t("docsPage.intro.f5.title")}</h4>
            <p>{t("docsPage.intro.f5.body")}</p>
          </div>
          <div>
            <h4>{t("docsPage.intro.f6.title")}</h4>
            <p>{t("docsPage.intro.f6.body")}</p>
          </div>
        </div>
        <Note icon={LinkIcon} title={t("docsPage.intro.newHere.title")}>
          <Html as="p" html={t("docsPage.intro.newHere.body")} />
        </Note>
      </section>

      <section id="quickstart" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.qs.eyebrow")}</p>
        <DocsH2>{t("docsPage.qs.title")}</DocsH2>
        <P htmlKey="docsPage.qs.p1" />
        <ol className="docs-steps">
          <li>
            <p className="docs-steps__label">{t("docsPage.qs.s1.title")}</p>
            <Html as="p" className="docs-steps__body" html={t("docsPage.qs.s1.body")} />
          </li>
          <li>
            <p className="docs-steps__label">{t("docsPage.qs.s2.title")}</p>
            <p className="docs-steps__body">{t("docsPage.qs.s2.body")}</p>
          </li>
          <li>
            <p className="docs-steps__label">{t("docsPage.qs.s3.title")}</p>
            <p className="docs-steps__body">{t("docsPage.qs.s3.body")}</p>
          </li>
        </ol>
        <CodeTabs codeMap={SCENARIO_CODE.chat} fileMap={SCENARIO_FILE.chat} />
      </section>

      <section id="authentication" className="docs-section">
        <p className="docs-section__eyebrow">Authentication</p>
        <DocsH2>{t("docsPage.auth.title")}</DocsH2>
        <P htmlKey="docsPage.auth.desc" />
        <ParamTable
          title={t("docsPage.auth.headersTitle")}
          rows={[
            { name: "Authorization", type: "string", required: true, desc: t("docsPage.auth.row1"), def: "Bearer sk-platform-..." },
            { name: "x-api-key", type: "string", desc: t("docsPage.auth.row2") },
            { name: "anthropic-version", type: "string", desc: t("docsPage.auth.row3"), def: "2023-06-01" },
          ]}
        />
        <Note tone="warning" icon={ShieldAlert} title={t("docsPage.auth.tip.title")}>
          <Html as="p" html={t("docsPage.auth.tip.body")} />
        </Note>

        <h3 className="docs-h3">{t("docsPage.auth.verify.title")}</h3>
        <Html as="p" className="docs-prose" html={t("docsPage.auth.verify.body")} />
        <CodeBlock
          variant="dark"
          lang="bash"
          label="cURL"
          code={`curl ${BASE_URL}/v1/models \\
  -H "Authorization: Bearer $PLATFORM_API_KEY"`}
        />

        <h3 className="docs-h3">{t("docsPage.auth.responseHeaders.title")}</h3>
        <ParamTable
          rows={[
            { name: "X-Request-Id", type: "string", desc: t("docsPage.auth.responseHeaders.requestId") },
            { name: "X-Resolved-Model", type: "string", desc: t("docsPage.auth.responseHeaders.resolvedModel") },
            { name: "X-Fallback-From", type: "string", desc: t("docsPage.auth.responseHeaders.fallbackFrom") },
          ]}
        />
      </section>

      <section id="base-urls" className="docs-section">
        <p className="docs-section__eyebrow">Base URL</p>
        <DocsH2>{t("docsPage.baseUrl.title")}</DocsH2>
        <P htmlKey="docsPage.baseUrl.desc" />
        <div className="docs-baseurl-table">
          <div className="docs-table-scroll">
            <table>
              <thead><tr><th>SDK</th><th>base_url</th></tr></thead>
              <tbody>
                <tr><td>OpenAI Python / Node</td><td><code>{BASE_URL}/v1</code></td></tr>
                <tr><td>Anthropic SDK</td><td><code>{BASE_URL}</code></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <Note tone="note" icon={AlertCircle}>
          <Html html={t("docsPage.baseUrl.note")} vars={{ baseUrl: BASE_URL }} />
        </Note>
      </section>

      <section id="models" className="docs-section">
        <p className="docs-section__eyebrow">Models</p>
        <DocsH2>{t("docsPage.models.title")}</DocsH2>
        <P htmlKey="docsPage.models.desc" />

        <h3 className="docs-h3">{t("docsPage.models.matrix.title")}</h3>
        <Note tone="note" icon={AlertCircle}>
          <Html as="p" html={t("docsPage.models.matrix.note")} />
        </Note>
        <div className="docs-paramtable">
          <div className="docs-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("docsPage.models.matrix.colModel")}</th>
                  <th>{t("docsPage.models.matrix.colContext")}</th>
                  <th>{t("docsPage.models.matrix.colOutput")}</th>
                  <th>{t("docsPage.models.matrix.colModalities")}</th>
                  <th>{t("docsPage.models.matrix.colEndpoints")}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code className="docs-paramtable__name">platform-flash</code></td>
                  <td>—</td>
                  <td>—</td>
                  <td>{t("docsPage.models.matrix.rowModalities")}</td>
                  <td><code>/v1/chat/completions</code></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <DocsH3 id="models-list">{t("docsPage.models.list.title")}</DocsH3>
        <P htmlKey="docsPage.models.list.body" />
        <MethodPill method="GET" path="/v1/models" />
        <DocsH3 id="models-alias">{t("docsPage.models.alias.title")}</DocsH3>
        <P htmlKey="docsPage.models.alias.body" />
        <Note tone="tip">
          <Html as="p" html={t("docsPage.models.linkBody")} /> <a href="/models" className="docs-inline-link">{t("docsPage.models.gotoPlaza")}</a>
        </Note>
      </section>

      <section id="errors" className="docs-section">
        <p className="docs-section__eyebrow">Errors</p>
        <DocsH2>{t("docsPage.errors.title")}</DocsH2>
        <P htmlKey="docsPage.errors.desc" />
        <div className="docs-errors-table">
          <div className="docs-table-scroll">
            <table>
              <thead><tr><th>Status</th><th>Type</th><th>{t("docsPage.errors.when")}</th></tr></thead>
              <tbody>
              {(() => {
                const rows = [
                  { c: 200, t: "success", d: t("docsPage.errors.e200") },
                  { c: 400, t: "invalid_request_error", d: t("docsPage.errors.e400") },
                  { c: 401, t: "authentication_error", d: t("docsPage.errors.e401") },
                  { c: 403, t: "permission_error", d: t("docsPage.errors.e403") },
                  { c: 404, t: "not_found_error", d: t("docsPage.errors.e404") },
                  { c: 422, t: "unprocessable_entity", d: t("docsPage.errors.e422") },
                  { c: 429, t: "rate_limit_error", d: t("docsPage.errors.e429") },
                  { c: 500, t: "server_error", d: t("docsPage.errors.e500") },
                  { c: 503, t: "service_unavailable", d: t("docsPage.errors.e503") },
                ];
                const statusColor = (code: number) => code < 300 ? "var(--ok)" : code < 500 ? "var(--warn)" : "var(--danger)";
                return rows.map((e) => (
                  <tr key={e.c}>
                    <td><code style={{ color: statusColor(e.c), fontWeight: 700 }}>{e.c}</code></td>
                    <td><code style={{ color: statusColor(e.c) }}>{e.t}</code></td>
                    <td>{e.d}</td>
                  </tr>
                ));
              })()}
            </tbody>
            </table>
          </div>
        </div>

        <h3 className="docs-h3">{t("docsPage.errors.object.title")}</h3>
        <P htmlKey="docsPage.errors.object.desc" />
        <ResponseBlock
          label="Error"
          json={`{\n  "error": {\n    "message": "Invalid 'messages': field required",\n    "type": "invalid_request_error",\n    "param": "messages",\n    "code": null\n  }\n}`}
        />
        <ResponseFields
          rows={[
            { name: "error.message", type: "string", desc: t("docsPage.errors.object.message") },
            { name: "error.type", type: "string", desc: t("docsPage.errors.object.type") },
            { name: "error.code", type: "string | null", desc: t("docsPage.errors.object.code") },
            { name: "error.param", type: "string | null", desc: t("docsPage.errors.object.param") },
          ]}
        />
      </section>

      <section id="rate-limits" className="docs-section">
        <p className="docs-section__eyebrow">Rate limits</p>
        <DocsH2>{t("docsPage.rate.title")}</DocsH2>
        <P htmlKey="docsPage.rate.desc" />
        <div className="docs-callout-inline">
          <CheckCircle2 size={14} />
          <Html html={t("docsPage.rate.night")} />
        </div>
        <DocsH3 id="rate-tiers">{t("docsPage.rate.tiers.title")}</DocsH3>
        <P htmlKey="docsPage.rate.tiers.desc" />
        <div className="docs-errors-table">
          <table>
            <thead>
              <tr>
                <th>{t("docsPage.rate.tiers.colLevel")}</th>
                <th>{t("docsPage.rate.tiers.colRpm")}</th>
                <th>{t("docsPage.rate.tiers.colTpm")}</th>
                <th>{t("docsPage.rate.tiers.colApply")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ color: "var(--fg)" }}>{t("docsPage.rate.tiers.default")}</td>
                <td><strong style={{ color: "var(--primary)" }}>600</strong></td>
                <td><strong style={{ color: "var(--primary)" }}>6,000,000</strong></td>
                <td>{t("docsPage.rate.tiers.defaultApply")}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--fg)" }}>{t("docsPage.rate.tiers.high")}</td>
                <td><strong style={{ color: "var(--ok)" }}>3,000</strong></td>
                <td><strong style={{ color: "var(--ok)" }}>60,000,000</strong></td>
                <td>{t("docsPage.rate.tiers.highApply")}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--fg)" }}>{t("docsPage.rate.tiers.unlimited")}</td>
                <td colSpan={2}><strong style={{ color: "var(--warn)" }}>{t("docsPage.rate.tiers.unlimitedValue")}</strong></td>
                <td>{t("docsPage.rate.tiers.unlimitedApply")}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <DocsH3 id="rate-headers">{t("docsPage.rate.headers.title")}</DocsH3>
        <ParamTable
          rows={[
            { name: "x-ratelimit-limit-requests", type: "integer", desc: t("docsPage.rate.h1") },
            { name: "x-ratelimit-remaining-requests", type: "integer", desc: t("docsPage.rate.h2") },
            { name: "x-ratelimit-limit-tokens", type: "integer", desc: t("docsPage.rate.h3") },
            { name: "retry-after", type: "integer", desc: t("docsPage.rate.h4") },
          ]}
        />
        <DocsRetryExample compact />
      </section>

      <section id="pagination" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.pagination.eyebrow")}</p>
        <DocsH2>{t("docsPage.pagination.title")}</DocsH2>
        <P htmlKey="docsPage.pagination.desc" />
        <P htmlKey="docsPage.pagination.intro" />
      </section>

      <section id="versioning" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.versioning.eyebrow")}</p>
        <DocsH2>{t("docsPage.versioning.title")}</DocsH2>
        <P htmlKey="docsPage.versioning.desc" />
        <P htmlKey="docsPage.versioning.intro" />

        <h4 className="docs-h4">{t("docsPage.versioning.header.title")}</h4>
        <Html as="p" className="docs-prose" html={t("docsPage.versioning.header.body")} />

        <h4 className="docs-h4">{t("docsPage.versioning.stability.title")}</h4>
        <Html as="p" className="docs-prose" html={t("docsPage.versioning.stability.body")} />

        <h4 className="docs-h4">{t("docsPage.versioning.deprecation.title")}</h4>
        <Html as="p" className="docs-prose" html={t("docsPage.versioning.deprecation.body")} />
      </section>
    </>
  );
}
