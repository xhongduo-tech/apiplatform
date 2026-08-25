import type { ReactNode } from "react";
import { cn } from "./ui/utils";

/** 控制台内容区容器：统一 1200px 居中布局。 */
export function ConsolePageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1200px] animate-enter", className)}>
      {children}
    </div>
  );
}
