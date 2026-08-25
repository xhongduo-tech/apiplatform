import DOMPurify, { type Config } from "dompurify";
import { createElement, useMemo, type ElementType } from "react";

const SANITIZE_OPTIONS: Config = {
  ALLOWED_TAGS: ["a", "b", "br", "code", "em", "span", "strong"],
  ALLOWED_ATTR: ["class", "href"],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style"],
};

/** 仅用于需要少量内联标记的受控翻译文案；所有运行时插值仍按不可信输入处理。 */
export function sanitizeInlineMarkup(html: string): string {
  return String(DOMPurify.sanitize(html, SANITIZE_OPTIONS));
}

export function SafeHtml({
  html,
  as = "span",
  className,
}: {
  html: string;
  as?: ElementType;
  className?: string;
}) {
  const sanitized = useMemo(() => sanitizeInlineMarkup(html), [html]);
  return createElement(as, {
    className,
    dangerouslySetInnerHTML: { __html: sanitized },
  });
}
