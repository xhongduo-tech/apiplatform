import type { ReactNode } from "react";
import { DocsH2 } from "./docs-shared";

export function DocsSection({
  id,
  eyebrow,
  title,
  desc,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="docs-section">
      <p className="docs-section__eyebrow">{eyebrow}</p>
      <DocsH2>{title}</DocsH2>
      {desc && (
        <p className="docs-prose">{desc}</p>
      )}
      {children}
    </section>
  );
}
