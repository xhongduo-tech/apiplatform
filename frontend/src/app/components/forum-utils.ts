// ── Types ────────────────────────────────────────────────────────────────

export interface ForumReply {
  id: string;
  author_name: string;
  author_auth_id?: string;
  is_admin?: boolean;
  content: string;
  created_at: string;
}

export interface ForumPostItem {
  id: string;
  title: string;
  content?: string;
  author_name: string;
  author_department?: string;
  author_auth_id?: string;
  pinned?: boolean;
  resolved?: boolean;
  view_count?: number;
  reply_count?: number;
  like_count?: number;
  follow_count?: number;
  last_reply_at?: string | null;
  created_at: string | null;
}

export interface ForumPostDetail {
  id: string;
  title: string;
  content: string;
  author_name: string;
  author_department?: string;
  author_auth_id?: string;
  pinned?: boolean;
  resolved?: boolean;
  view_count?: number;
  like_count?: number;
  follow_count?: number;
  liked?: boolean;
  followed?: boolean;
  created_at: string;
  replies: ForumReply[];
}

export interface ForumOverview {
  total: number;
  pending: number;
  recent7_new: number;
  avg_response_hours: number | null;
  hot: Array<{
    id: string;
    title: string;
    view_count: number;
    reply_count: number;
    resolved: boolean;
  }>;
}

export type ForumFilter = "all" | "mine" | "commented" | "resolved" | "unresolved" | "followed";

export const PAGE_SIZE = 20;

// ── Constants ────────────────────────────────────────────────────────────

export const FORUM_FILTERS: Array<{ key: ForumFilter; labelKey: string; needsAuth: boolean; group: "status" | "user" }> = [
  { key: "all", labelKey: "forum.filter.all", needsAuth: false, group: "status" },
  { key: "unresolved", labelKey: "forum.filter.unresolved", needsAuth: false, group: "status" },
  { key: "resolved", labelKey: "forum.filter.resolved", needsAuth: false, group: "status" },
  { key: "mine", labelKey: "forum.filter.mine", needsAuth: true, group: "user" },
  { key: "commented", labelKey: "forum.filter.commented", needsAuth: true, group: "user" },
  { key: "followed", labelKey: "forum.filter.followed", needsAuth: true, group: "user" },
];

// ── Time helpers ─────────────────────────────────────────────────────────

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

export function timeAgo(iso: string | null, t: (key: string, params?: Record<string, string>) => string): string {
  const d = toDate(iso);
  if (!d) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return t("forum.timeAgo.justNow");
  if (diff < 3600) return t("forum.timeAgo.minutesAgo", { n: String(Math.floor(diff / 60)) });
  if (diff < 86400) return t("forum.timeAgo.hoursAgo", { n: String(Math.floor(diff / 3600)) });
  if (diff < 86400 * 7) return t("forum.timeAgo.daysAgo", { n: String(Math.floor(diff / 86400)) });
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDateTime(iso: string | null): string {
  const d = toDate(iso);
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Anonymous helpers ────────────────────────────────────────────────────

// 匿名名检测：兼容中英文常见写法，避免切语言后「匿名徽标/头像」判定失效
const ANON_NAMES = new Set(["匿名用户", "匿名", "Anonymous", "anonymous", "anon"]);

export function isAnonymous(name: string): boolean {
  return ANON_NAMES.has(name);
}

// ── Avatar helpers ───────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--ok)",
  "var(--block-peach)",
];

export function avatarColor(name: string): string {
  if (isAnonymous(name)) return "var(--fg-subtle)";
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

export function avatarInitial(name: string): string {
  if (isAnonymous(name)) return "匿";
  return name.charAt(0).toUpperCase();
}

// ── JWT helpers ──────────────────────────────────────────────────────────

export function decodeJwtRole(t: string): string | null {
  try {
    const payload = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role || null;
  } catch {
    return null;
  }
}

// ── String helpers ───────────────────────────────────────────────────────

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export function stripMarkdownPreview(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/---+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
