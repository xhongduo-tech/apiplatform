import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api/gateway";
import {
  Pin, Plus, ChevronLeft, ChevronRight, Search, CheckCircle2,
  Heart, X, RefreshCw, Clock, Eye, MessageCircle, EyeOff,
  MessageSquareText, ArrowUpDown, ChevronDown, Check,
} from "lucide-react";
import { FeedbackModal } from "./feedback-modal";
import { ConsolePageShell } from "./console-page-shell";
import { PAGE_TITLE_CLASS } from "./ui/utils";
import { HotSidebar } from "./forum-sidebar";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import {
  PAGE_SIZE, FORUM_FILTERS, timeAgo, truncate, avatarColor, avatarInitial,
  isAnonymous, stripMarkdownPreview,
  type ForumPostItem, type ForumOverview, type ForumFilter,
} from "./forum-utils";

type SortMode = "latest" | "hot";

/**
 * 轻量下拉：trigger 是触发按钮，children 接收 close 回调渲染菜单项。
 * 复用 ThemeToggle 的「portal + fixed 定位 + 外部点击关闭」模式。
 */
function MenuDropdown({
  trigger,
  open,
  onToggle,
  children,
}: {
  trigger: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return; // 点按钮 → 交给按钮自身 toggle
      if (menuRef.current?.contains(t)) return; // 点菜单内部 → 由选项自行决定
      onToggle(); // 点外部 → 关闭
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open, onToggle]);

  function handleToggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    onToggle();
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-fg-muted hover:text-fg hover:bg-secondary border border-border bg-card transition-colors"
      >
        {trigger}
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="rounded-xl bg-card border border-border p-1 min-w-[150px]"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999, boxShadow: "var(--shadow-pop)" }}
        >
          {children(() => onToggle())}
        </div>,
        document.body,
      )}
    </>
  );
}

export function ForumList() {
  const navigate = useNavigate();
  const { token, authed } = useAuth();
  const { t } = useT();
  const timeAgoT = (key: string, params?: Record<string, string>) => t(key as any, params as any);
  const [showFeedback, setShowFeedback] = useState(false);
  const [posts, setPosts] = useState<ForumPostItem[]>([]);
  const [total, setTotal] = useState(0);
  const [overview, setOverview] = useState<ForumOverview | null>(null);
  const [page, setPage] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [filter, setFilter] = useState<ForumFilter>("all");
  const [sort, setSort] = useState<SortMode>("latest");
  const [sortOpen, setSortOpen] = useState(false);
  const [myOpen, setMyOpen] = useState(false);
  const [likePending, setLikePending] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listTopRef = useRef<HTMLDivElement>(null);

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const fetchPosts = useCallback(async (pageIndex: number, opts?: { refresh?: boolean }) => {
    const isRefresh = opts?.refresh;
    if (isRefresh) setRefreshing(true);
    else if (pageIndex !== 0 || posts.length > 0) setPageLoading(true);
    else setInitialLoading(true);

    try {
      const p: any = { limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE, sort };
      if (committedSearch) p.search = committedSearch;
      if (filter !== "all") p.filter = filter;
      if (authed && token) p.token = token;

      const [list, ov] = await Promise.all([api.forumPosts(p), api.forumOverview()]);
      setPosts(Array.isArray(list.data) ? list.data : []);
      setTotal(list.total ?? 0);
      setOverview(ov);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.loadFailed"));
      setPosts([]);
      setTotal(0);
    } finally {
      setInitialLoading(false);
      setPageLoading(false);
      setRefreshing(false);
    }
  }, [committedSearch, filter, sort, token, authed, posts.length]);

  useEffect(() => { fetchPosts(page); }, [page, fetchPosts]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); searchInputRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  function handleSearch() { setPage(0); setCommittedSearch(searchText.trim()); }
  function handleSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSearch();
    if (e.key === "Escape") { setSearchText(""); setCommittedSearch(""); setPage(0); }
  }
  function clearSearch() { setSearchText(""); setCommittedSearch(""); setPage(0); }

  function handleFilter(k: ForumFilter) {
    const f = FORUM_FILTERS.find(x => x.key === k);
    if (f?.needsAuth && !authed) {
      toast.error(t("forum.toast.loginToFilter"));
      return;
    }
    setFilter(k); setPage(0);
    setMyOpen(false);
  }

  function handleSort(k: SortMode) {
    setSort(k); setPage(0); setSortOpen(false);
  }

  async function handleLike(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!authed) { toast.error(t("forum.toast.loginToLike")); return; }
    if (likePending.has(id)) return;
    setLikePending(s => new Set(s).add(id));
    const post = posts.find(p => p.id === id);
    const prev = post?.like_count ?? 0;
    setPosts(prevPosts => prevPosts.map(p => p.id === id ? { ...p, like_count: prev + 1 } : p));
    try {
      const res = await api.forumLike(token, id);
      setPosts(prevPosts => prevPosts.map(p => p.id === id ? { ...p, like_count: res.like_count } : p));
    } catch (err) {
      setPosts(prevPosts => prevPosts.map(p => p.id === id ? { ...p, like_count: prev } : p));
      toast.error(err instanceof Error ? err.message : t("common.operationFailed"));
    } finally {
      setLikePending(s => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  function changePage(next: number) {
    setPage(next);
    listTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const statusFilters = FORUM_FILTERS.filter(f => f.group === "status");
  const userFilters = FORUM_FILTERS.filter(f => f.group === "user");
  // commented 对应的既有文案是「我回复的」(forum.filter.replied)，比 labelKey 的「我评论的」更贴切
  type MyFilterKey = "mine" | "commented" | "followed";
  const MY_LABEL: Record<MyFilterKey, string> = {
    mine: "forum.filter.mine",
    commented: "forum.filter.replied",
    followed: "forum.filter.followed",
  };
  const myFilter = userFilters.find(f => f.key === filter);
  const myTriggerLabel = myFilter ? t(MY_LABEL[myFilter.key as MyFilterKey] as any) : t("forum.my");

  return (
    <>
      <ConsolePageShell className="space-y-6">
        {/* Page header */}
        <div ref={listTopRef} className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className={PAGE_TITLE_CLASS}>
              {t("forum.title")}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("forum.desc")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                ref={searchInputRef}
                type="text"
                className="w-56 pl-9 pr-7 py-2 bg-card border border-border rounded-lg text-[14px] text-fg placeholder:text-fg-subtle outline-none focus:border-fg-muted transition-colors"
                placeholder={t("forum.searchPlaceholder")}
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                onKeyDown={handleSearchKey}
              />
              {searchText && (
                <button onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg">
                  <X size={13} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowFeedback(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ink text-bg text-[13px] font-medium hover:opacity-90 transition-colors"
            >
              <Plus size={14} />{t("forum.publishBtn")}
            </button>
          </div>
        </div>

        {/* Search feedback banner */}
        {committedSearch && (
          <div className="flex items-center gap-2 text-[13px] text-fg-muted bg-brand-soft/50 rounded-lg px-3 py-2">
            <Search size={12} />
            {t("forum.searchResult", { keyword: committedSearch })}
            <button onClick={clearSearch} className="ml-auto text-fg-subtle hover:text-fg inline-flex items-center gap-1">
              <X size={11} />{t("common.clear")}
            </button>
          </div>
        )}

        {/* Filters & Sort row */}
        <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Status segmented control */}
            <div className="inline-flex items-center gap-0.5 rounded-xl p-1" style={{ background: "var(--bg-soft)" }}>
              {statusFilters.map(f => {
                const active = filter === f.key;
                return (
                  <button
                    key={f.key}
                    onClick={() => handleFilter(f.key)}
                    className="px-3 py-1.5 rounded-lg text-[13px] transition-all duration-200"
                    style={{
                      background: active ? "var(--card)" : "transparent",
                      color: active ? "var(--fg)" : "var(--fg-muted)",
                      fontWeight: active ? 600 : 400,
                      boxShadow: active ? "var(--shadow-sm)" : "none",
                    }}
                  >
                    {f.key === "all" ? t("forum.filter.all") : f.key === "unresolved" ? t("forum.filter.unsolved") : t("forum.filter.solved")}
                  </button>
                );
              })}
            </div>

            {(pageLoading || refreshing) && (
              <span className="text-[11px] text-fg-subtle inline-flex items-center gap-1">
                <RefreshCw size={11} className="animate-spin" />{t("common.loading")}
              </span>
            )}
          </div>

          {/* 排序 + 我的：下拉收纳，避免状态/个人/排序三种概念挤在同一层级 */}
          <div className="flex items-center gap-2">
            <MenuDropdown
              trigger={<><ArrowUpDown size={13} />{sort === "hot" ? t("forum.sort.hottest") : t("forum.sort.newest")}<ChevronDown size={12} className={`transition-transform ${sortOpen ? "rotate-180" : ""}`} /></>}
              open={sortOpen}
              onToggle={() => setSortOpen(o => !o)}
            >
              {close => (
                <>
                  {([
                    { key: "latest" as SortMode, label: t("forum.sort.newest") },
                    { key: "hot" as SortMode, label: t("forum.sort.hottest") },
                  ]).map(s => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => { handleSort(s.key); close(); }}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-[13px] text-left transition-colors ${
                        sort === s.key ? "text-fg font-medium bg-secondary" : "text-fg-muted hover:text-fg hover:bg-secondary"
                      }`}
                    >
                      {s.label}
                      {sort === s.key && <Check size={13} className="text-brand" />}
                    </button>
                  ))}
                </>
              )}
            </MenuDropdown>

            {/* 个人筛选：未登录整体隐藏，避免灰色死按钮 */}
            {authed && (
              <MenuDropdown
                trigger={<><MessageSquareText size={13} />{myTriggerLabel}<ChevronDown size={12} className={`transition-transform ${myOpen ? "rotate-180" : ""}`} /></>}
                open={myOpen}
                onToggle={() => setMyOpen(o => !o)}
              >
                {close => (
                  <>
                    {userFilters.map(f => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => { handleFilter(f.key); close(); }}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-[13px] text-left transition-colors ${
                          filter === f.key ? "text-fg font-medium bg-secondary" : "text-fg-muted hover:text-fg hover:bg-secondary"
                        }`}
                      >
                        {t(MY_LABEL[f.key as MyFilterKey] as any)}
                        {filter === f.key && <Check size={13} className="text-brand" />}
                      </button>
                    ))}
                  </>
                )}
              </MenuDropdown>
            )}
          </div>
        </div>

        {/* Page loading bar */}
        {pageLoading && !initialLoading && (
          <div className="h-[2px] w-full bg-transparent overflow-hidden">
            <div className="h-full w-1/3 animate-pulse" style={{ background: "var(--brand)" }} />
          </div>
        )}

        {/* Main content */}
        <div className="flex gap-8 items-start">
          <div className="flex-1 min-w-0">
            {initialLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex gap-4 p-4 rounded-xl bg-card border border-border">
                    <div className="skeleton w-10 h-10 rounded-full shrink-0" />
                    <div className="flex-1 space-y-2.5">
                      <div className="skeleton h-4 w-2/3 rounded" />
                      <div className="skeleton h-3 w-full rounded" />
                      <div className="skeleton h-3 w-1/3 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : posts.length === 0 ? (
              <div className="text-center py-20">
                <div className="w-16 h-16 mx-auto rounded-2xl bg-card border border-border flex items-center justify-center mb-4">
                  <MessageSquareText size={28} className="text-fg-subtle" />
                </div>
                <p className="font-serif text-[14px] font-medium text-fg">
                  {committedSearch ? t("forum.empty.noMatch") : filter !== "all" ? t("forum.empty.noCategory") : t("forum.empty.noPosts")}
                </p>
                <p className="text-[13px] text-fg-muted mt-1">
                  {committedSearch ? t("forum.empty.tryOtherKeywords") : t("forum.empty.beFirst")}
                </p>
                <button
                  type="button"
                  onClick={() => setShowFeedback(true)}
                  className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 rounded-lg border border-border bg-card text-fg text-[13px] font-medium hover:bg-bg-soft transition-colors"
                >
                  <Plus size={14} />{t("forum.publishBtn")}
                </button>
              </div>
            ) : (
              <div>
                <div className="space-y-2">
                  {posts.map(post => (
                    <article
                      key={post.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/forum/${post.id}`)}
                      onKeyDown={e => e.key === "Enter" && navigate(`/forum/${post.id}`)}
                      className="flex gap-4 p-4 rounded-xl bg-card border border-border hover:border-fg-muted/40 transition-colors cursor-pointer group"
                    >
                      <div className="shrink-0">
                        <div
                          className="w-10 h-10 rounded-full flex items-center justify-center text-[13px] text-white"
                          style={{ background: avatarColor(post.author_name), fontWeight: 500 }}
                        >
                          {avatarInitial(post.author_name)}
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          {post.pinned && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-brand-soft text-brand">
                              <Pin size={10} />{t("forum.badge.pinned")}
                            </span>
                          )}
                          {post.resolved && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-ok/10 text-ok">
                              <CheckCircle2 size={10} />{t("forum.badge.solved")}
                            </span>
                          )}
                          <h3 className="font-serif text-[15px] font-medium leading-snug transition-colors group-hover:text-brand">
                            {post.title}
                          </h3>
                        </div>
                        {post.content && (
                          <p className="text-[13px] text-fg-muted leading-relaxed line-clamp-2 mb-2">
                            {truncate(stripMarkdownPreview(post.content.replace(/\n/g, " ")), 160)}
                          </p>
                        )}
                        <div className="flex items-center gap-x-3 gap-y-1 text-[12px] text-fg-subtle flex-wrap">
                          <span className="font-serif font-medium" style={{ color: "var(--fg)" }}>
                            {isAnonymous(post.author_name) ? (
                              <span className="inline-flex items-center gap-1"><EyeOff size={10} />{post.author_name}</span>
                            ) : post.author_name}
                          </span>
                          {!isAnonymous(post.author_name) && post.author_department && <span>{post.author_department}</span>}
                          <span className="inline-flex items-center gap-1"><Clock size={10} />{timeAgo(post.created_at, timeAgoT)}</span>
                          {post.reply_count != null && post.reply_count > 0 && (
                            <span className="inline-flex items-center gap-1"><MessageCircle size={10} />{post.reply_count}</span>
                          )}
                          {post.view_count != null && post.view_count > 0 && (
                            <span className="inline-flex items-center gap-1"><Eye size={10} />{post.view_count}</span>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 self-center" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={e => handleLike(e, post.id)}
                          disabled={likePending.has(post.id)}
                          className="flex flex-col items-center gap-0.5 px-2.5 py-1.5 text-[11px] text-fg-subtle hover:text-danger rounded-lg hover:bg-danger/5 transition-colors disabled:opacity-50"
                        >
                          <Heart size={14} />
                          <span className="tabular-nums">{post.like_count ?? 0}</span>
                        </button>
                      </div>
                    </article>
                  ))}
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-5 text-[12px]">
                    <span className="text-fg-muted tabular-nums">
                      {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} / {total}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        disabled={page === 0}
                        onClick={() => changePage(page - 1)}
                        className="p-1.5 rounded-md border border-border hover:bg-secondary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <span className="px-2 tabular-nums text-fg-muted">{page + 1} / {totalPages}</span>
                      <button
                        disabled={page >= totalPages - 1}
                        onClick={() => changePage(page + 1)}
                        className="p-1.5 rounded-md border border-border hover:bg-secondary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="hidden lg:block w-[240px] shrink-0" style={{ position: "sticky", top: "80px" }}>
            <HotSidebar overview={overview} onSelect={id => navigate(`/forum/${id}`)} />
          </aside>
        </div>
      </ConsolePageShell>

      <FeedbackModal
        open={showFeedback}
        onClose={() => setShowFeedback(false)}
        onSuccess={() => { setPage(0); fetchPosts(0, { refresh: true }); }}
      />
    </>
  );
}
