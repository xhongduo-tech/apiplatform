import type { ComponentType, ReactNode } from "react";
import { useT } from "../../i18n";
import { cn } from "./utils";

export interface NavItem {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick?: () => void;
  trailingIcon?: ComponentType<{ className?: string }>;
  newTab?: boolean;
  to?: string;
  /** 侧边栏项尾部角标（如待办数量）；>0 才显示 */
  badge?: number;
}

interface NavGroup {
  title?: string;
  items: NavItem[];
}

interface ConsoleLayoutProps {
  brand: string;
  tag: string;
  groups: NavGroup[];
  bottomItems?: NavItem[];
  user?: { name: string; department?: string };
  onLogout?: () => void;
  /** 调用方决定每一项如何渲染（NavLink / button / a 等） */
  renderItem: (item: NavItem, ctx: { isActive: boolean; isMobile: boolean }) => ReactNode;
  /** 判断 sidebar item 是否激活 */
  isActive: (item: NavItem) => boolean;
  /** 覆盖主内容区默认 max-width / padding（如宽表格页） */
  mainClassName?: string;
  children: ReactNode;
}

export function ConsoleLayout({
  brand,
  tag,
  groups,
  bottomItems = [],
  user,
  onLogout,
  renderItem,
  isActive,
  mainClassName,
  children,
}: ConsoleLayoutProps) {
  const { t } = useT();
  const allItems = groups.flatMap((g) => g.items).concat(bottomItems);

  return (
    <div className="console-shell flex min-h-0 flex-1 overflow-hidden">
      {/* 桌面侧边栏 */}
      <aside
        className="hidden shrink-0 flex-col md:flex"
        style={{
          width: 220,
          borderRight: "1px solid var(--border)",
          background: "var(--bg)",
          padding: "16px 12px",
        }}
      >
        <div className="flex flex-1 min-h-0 flex-col">
          {/* 品牌：与主站 header 一致——黑底英文字标 + 衬线中文副标，不加 icon */}
          <div className="flex items-center gap-2 px-2 pb-5">
            <span className="inline-flex items-center rounded-md bg-black px-2.5 py-1 font-serif text-[15px] font-bold tracking-tight text-white">
              {brand}
            </span>
            <span className="whitespace-nowrap font-serif text-[15px] font-semibold leading-none text-fg">
              {tag}
            </span>
          </div>

          {/* 分组导航 */}
          <div className="flex-1 space-y-5 overflow-y-auto">
            {groups.map((group, groupIdx) => (
              <div key={group.title || `group-${groupIdx}`}>
                {group.title && (
                  <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted/60">
                    {group.title}
                  </p>
                )}
                <nav className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <div key={item.key}>{renderItem(item, { isActive: isActive(item), isMobile: false })}</div>
                  ))}
                </nav>
              </div>
            ))}
          </div>

          {/* 底部项 */}
          {bottomItems.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <nav className="flex flex-col gap-1">
                {bottomItems.map((item) => (
                  <div key={item.key}>{renderItem(item, { isActive: isActive(item), isMobile: false })}</div>
                ))}
              </nav>
            </div>
          )}

          {/* 用户信息 */}
          {user && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-center gap-2.5 px-2 py-1.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-soft text-[12px] font-semibold text-fg">
                  {(user.name || "?").slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-serif text-[13px] font-medium text-fg">{user.name || t("common.unnamed")}</p>
                  <p className="truncate text-[11px] text-fg-muted">{user.department || "—"}</p>
                </div>
                {onLogout && (
                  <button
                    type="button"
                    onClick={onLogout}
                    title={t("header.account.logout")}
                    aria-label={t("header.account.logout")}
                    className="shrink-0 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-soft hover:text-fg"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" x2="9" y1="12" y2="12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 移动端横向导航 */}
      <div className="w-full border-b border-border bg-card md:hidden">
        <div className="flex gap-1 overflow-x-auto px-3 py-2">
          {allItems.map((item) => (
            <div key={item.key} className="shrink-0">
              {renderItem(item, { isActive: isActive(item), isMobile: true })}
            </div>
          ))}
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] text-fg-muted transition-colors hover:bg-bg-soft hover:text-fg"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" x2="9" y1="12" y2="12" />
              </svg>
              {t("header.account.logout")}
            </button>
          )}
        </div>
      </div>

      {/* 主内容区 */}
      <main className={cn("mx-auto w-full max-w-[1200px] flex-1 min-w-0 overflow-auto p-5 md:p-8", mainClassName)}>
        {children}
      </main>
    </div>
  );
}
