import { Link } from "react-router-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  children: ReactNode;
};

/** 文档页路径（/docs 及其子路径 / 锚点）判定：这类链接固定新开标签页 */
export function isDocsPath(path: string) {
  return path === "/docs" || path.startsWith("/docs/") || path.startsWith("/docs?");
}

/** 智能链接：
 *   - 文档页（/docs*）→ 新浏览器标签页打开，保留当前页浏览状态
 *   - 其余内部链接 → 当前页面 SPA 导航，不新开标签页 */
export function NewTabLink({ to, href, children, ...rest }: Props) {
  if (isDocsPath(to)) {
    return (
      <a href={to} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} {...rest}>
      {children}
    </Link>
  );
}
