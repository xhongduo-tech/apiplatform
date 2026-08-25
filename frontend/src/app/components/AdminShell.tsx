import { ReactNode } from "react";

/** 管理后台页面容器：无顶栏，仅留白与背景 */
export function AdminShell({
  children,
  bare = false,
}: {
  children: ReactNode;
  bare?: boolean;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className={bare ? "" : "mx-auto max-w-[1200px] px-5 py-8 sm:px-6"}>{children}</main>
    </div>
  );
}
