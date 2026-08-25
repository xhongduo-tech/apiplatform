/**
 * status-badge.tsx — 模型状态徽章（抢先体验/升级中/即将下线/已下线/部门独占）
 *
 * 在线（online）状态不渲染任何徽标，由表格行内的绿点+文字代替。
 */
import type { CSSProperties } from "react";
import { EarlyAccessIcon } from "../early-access-icon";
import type { Model } from "../model-types";

const STATUS_STYLE: Record<string, CSSProperties> = {
  upcoming:    { background: "var(--brand-soft)",   color: "var(--brand)",     border: "1px solid var(--brand-soft)" },
  upgrading:   { background: "var(--warn-soft)",    color: "var(--warn)",      border: "1px solid var(--warn-soft-border)" },
  sunsetting:  { background: "var(--warn-soft)",    color: "var(--warn)",      border: "1px solid var(--warn-soft-border)" },
  offline:     { background: "var(--bg-soft)",      color: "var(--fg-muted)",  border: "1px solid var(--border)" },
  exclusive:   { background: "var(--brand-soft)",   color: "var(--brand)",     border: "1px solid var(--brand-soft)" },
};

export function StatusBadge({ status, label }: { status: Model["status"]; label?: string }) {
  if (status === "online") return null;
  const style = STATUS_STYLE[status ?? ""];
  if (!style || !label) return null;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        flexShrink: 0, fontSize: 10.5, fontWeight: 500,
        padding: "2px 7px", borderRadius: 5,
        ...style,
      }}
    >
      {status === "upcoming" && <EarlyAccessIcon size={11} strokeWidth={2.2} />}
      {label}
    </span>
  );
}
