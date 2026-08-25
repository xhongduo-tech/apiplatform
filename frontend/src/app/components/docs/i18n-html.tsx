import { SafeHtml } from "../../safe-html";
import type { ElementType } from "react";

/**
 * 渲染带内联 <code>/<a>/<strong> 的翻译文案。vars 用于替换翻译文案里的 {{key}} 占位符
 * （用于 base_url 等运行时才知道的值），文案本身来自受控的 3 份 locale 文件。
 */
export function Html({
  html,
  vars,
  as = "span",
  className,
}: {
  html: string;
  vars?: Record<string, string>;
  as?: ElementType;
  className?: string;
}) {
  const resolved = vars
    ? Object.entries(vars).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(v), html)
    : html;
  return <SafeHtml as={as} className={className} html={resolved} />;
}
