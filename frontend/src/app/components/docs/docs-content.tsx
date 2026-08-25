import { type ScenarioKey } from "./scenario-data";
import { DocsEndpointsTable } from "./docs-endpoints-table";
import { DocsFeedback } from "./docs-feedback";
import { DocsSectionsCore } from "./docs-sections-core";
import { DocsApiCapabilities, DocsApiReference } from "./docs-sections-api";
import { DocsGuidesCapabilities, DocsPlatform, DocsHelp } from "./docs-sections-guides";
import { DocsSectionsOps } from "./docs-sections-ops";

export { buildTocItems } from "./docs-shared";

export function DocsContent({
  openScenario,
}: {
  openScenario: (k: ScenarioKey) => void;
}) {
  return (
    <article className="docs-article">
      {/* Getting started + Core concepts */}
      <DocsSectionsCore />

      {/* Capabilities（都建立在 chat/completions 之上） */}
      <DocsApiCapabilities />
      <DocsGuidesCapabilities />

      {/* API reference（真正独立的端点 + 完整端点表） */}
      <DocsApiReference />
      <DocsEndpointsTable />

      {/* Platform & ops */}
      <DocsPlatform openScenario={openScenario} />
      <DocsSectionsOps />

      {/* Help */}
      <DocsHelp />

      <DocsFeedback />
    </article>
  );
}
