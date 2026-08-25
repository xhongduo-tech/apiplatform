/** 模型广场默认排序规则（管理后台默认列表与之对齐） */

export interface PlazaSortModel {
  id: string;
  name: string;
  category: string;
  status?: string;
  params?: string;
  contextWindow?: string;
  releaseDate?: string;
}

export const PLAZA_CATEGORY_SORT_ORDER: Record<string, number> = {
  flagship: 0,
  chat: 0,
  vision: 1,
  embedding: 2,
  reranker: 3,
  ocr: 4,
  lts: 99,
};

export type PlazaSortKey = "name" | "params" | "context" | "release" | null;
export type PlazaSortDir = "asc" | "desc";

export function parseParams(p?: string): number {
  if (!p) return -1;
  const m = p.match(/~?(\d+(?:\.\d+)?)\s*([BMK])/i);
  if (!m) return -1;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  return u === "B" ? v : u === "M" ? v / 1000 : v / 1_000_000;
}

export function parseCtx(c?: string): number {
  if (!c) return -1;
  const m = c.match(/(\d+(?:\.\d+)?)\s*([KMB])/i);
  if (!m) return -1;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  return u === "K" ? v / 1000 : u === "M" ? v : v * 1000;
}

export function compareModelsPlaza(
  a: PlazaSortModel,
  b: PlazaSortModel,
  sortKey: PlazaSortKey = "release",
  sortDir: PlazaSortDir = "asc",
): number {
  const aOff = a.status === "offline" ? 1 : 0;
  const bOff = b.status === "offline" ? 1 : 0;
  if (aOff !== bOff) return aOff - bOff;

  const catA = PLAZA_CATEGORY_SORT_ORDER[a.category] ?? 99;
  const catB = PLAZA_CATEGORY_SORT_ORDER[b.category] ?? 99;
  if (catA !== catB) return catA - catB;

  if (!sortKey) return 0;

  const dir = sortDir === "asc" ? 1 : -1;
  if (sortKey === "name") return dir * a.name.localeCompare(b.name, "zh");
  if (sortKey === "params") return dir * (parseParams(a.params) - parseParams(b.params));
  if (sortKey === "context") return dir * (parseCtx(a.contextWindow) - parseCtx(b.contextWindow));
  if (sortKey === "release") {
    const r = dir * (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
    if (r !== 0) return r;
    const subA = a.category === "flagship" ? 0 : 1;
    const subB = b.category === "flagship" ? 0 : 1;
    if (subA !== subB) return subA - subB;
    return b.name.localeCompare(a.name, "zh");
  }
  return 0;
}

export function sortModelsPlaza<T extends PlazaSortModel>(
  models: T[],
  sortKey: PlazaSortKey = "release",
  sortDir: PlazaSortDir = "asc",
): T[] {
  return [...models].sort((a, b) => compareModelsPlaza(a, b, sortKey, sortDir));
}
