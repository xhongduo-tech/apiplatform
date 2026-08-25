import { CodeBlock } from "../code-block";

export function ResponseBlock({ label, json }: { label: string; json: string }) {
  return (
    <details className="docs-response" open>
      <summary className="docs-response__toggle">{label}</summary>
      <CodeBlock
        variant="light"
        code={json}
        lang="javascript"
        label="response.json"
      />
    </details>
  );
}
