import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 控制台主页面标题：与首页/模型页一致——衬线栈 + medium + 正字距 */
export const PAGE_TITLE_CLASS =
  "font-serif text-2xl font-medium tracking-normal text-fg sm:text-3xl";

/** 弹窗 / 内容区块标题：衬线栈，字重与全局 h1/h2 默认一致 */
export const PANEL_TITLE_CLASS = "font-serif font-medium text-fg";

/**
 * 实体展示名（模型名 / 项目名 / 用户姓名 / 场景名等）：
 * 与模型广场一致走衬线栈；技术 ID 仍用 font-mono，勿套此 class。
 */
export const ENTITY_NAME_CLASS = "font-serif font-medium";
