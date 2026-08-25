export const CATEGORY_COLORS: Record<string, { bg: string; text: string; ring: string }> = {
  chat:      { bg: "var(--chart-4)", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  vision:    { bg: "var(--chart-5)", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  embedding: { bg: "var(--ok)", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  reranker:  { bg: "var(--block-peach)", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  ocr:       { bg: "var(--warn)", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  // 业务场景分类（api_keys.scene_type）固定配色
  key:            { bg: "#5B8DEF", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  dept_explore:   { bg: "#E87461", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  innovation:     { bg: "#7BC47F", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  labor_contest:  { bg: "#F0B954", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  explore:        { bg: "#9B8EC4", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
  // 已被删除分类仍被引用的残余 key 归入「其他」桶
  other:          { bg: "#8A8F98", text: "var(--card)", ring: "rgba(var(--brand-rgb), 0.3)" },
};
