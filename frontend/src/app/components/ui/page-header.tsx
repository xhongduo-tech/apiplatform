import { cn, PAGE_TITLE_CLASS } from "./utils";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** 描述下方的补充行（如统计摘要），与 actions 底对齐 */
  subline?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, subline, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-6 animate-enter", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-fg-muted">{description}</p>
          )}
          {subline && (
            <p className="mt-0.5 text-sm text-fg-muted">{subline}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
