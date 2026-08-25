import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { copyText } from "../browser-compat";
import { api } from "../api/gateway";
import {
  Pin, ChevronLeft, CheckCircle2, Send, Clock, Eye,
  MessageCircle, Heart, Star, RefreshCw, Shield, EyeOff,
  Link as LinkIcon, Copy, Check, MessageSquarePlus,
} from "lucide-react";
import { ConsolePageShell } from "./console-page-shell";
import { Markdown } from "./Markdown";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import {
  formatDateTime, timeAgo, avatarColor, avatarInitial,
  isAnonymous, decodeJwtRole,
  type ForumPostDetail, type ForumReply,
} from "./forum-utils";

export function ForumDetail() {
  const { postId } = useParams();
  const navigate = useNavigate();
  const { token, name, authId, authed } = useAuth();
  const { t } = useT();
  const [post, setPost] = useState<ForumPostDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reply, setReply] = useState("");
  const [replyAnonymous, setReplyAnonymous] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [likeLoading, setLikeLoading] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [resolveLoading, setResolveLoading] = useState(false);
  const [pinLoading, setPinLoading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const repliesRef = useRef<HTMLDivElement>(null);
  const replyBoxRef = useRef<HTMLTextAreaElement>(null);

  const fetchPost = useCallback(() => {
    if (!postId) return;
    setLoading(true); setLoadError("");
    api.forumPost(postId, token || undefined)
      .then(setPost)
      .catch(e => {
        const msg = e instanceof Error ? e.message : t("common.loadFailed");
        setLoadError(msg);
        toast.error(msg);
      })
      .finally(() => setLoading(false));
  }, [postId, token]);

  useEffect(() => { fetchPost(); }, [fetchPost]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [postId]);

  async function submitReply() {
    if (!postId || !reply.trim()) { toast.error(t("forum.toast.replyContentRequired")); return; }
    if (!token) { toast.error(t("forum.toast.loginToReply")); return; }
    setSubmitting(true);
    try {
      await api.forumReply(token, postId, {
        content: reply.trim(),
        author_name: replyAnonymous ? t("forum.anonymous") : undefined,
      });
      setReply(""); setReplyAnonymous(false);
      fetchPost();
      toast.success(t("forum.toast.replySuccess"));
      setTimeout(() => {
        repliesRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }, 300);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("forum.toast.replyFailed"));
    } finally { setSubmitting(false); }
  }

  function handleReplyKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submitReply(); }
  }

  async function handleLike() {
    if (!authed) { toast.error(t("forum.toast.loginToLike")); return; }
    if (likeLoading) return;
    setLikeLoading(true);
    const prev = post;
    setPost(p => p ? { ...p, liked: !p.liked, like_count: (p.like_count ?? 0) + (p.liked ? -1 : 1) } : p);
    try {
      const res = await api.forumLike(token, postId!);
      setPost(p => p ? { ...p, liked: res.liked, like_count: res.like_count } : p);
    } catch (e) {
      setPost(prev);
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    } finally { setLikeLoading(false); }
  }

  async function handleFollow() {
    if (!authed) { toast.error(t("forum.toast.loginToFollow")); return; }
    if (followLoading) return;
    setFollowLoading(true);
    const prev = post;
    setPost(p => p ? { ...p, followed: !p.followed, follow_count: (p.follow_count ?? 0) + (p.followed ? -1 : 1) } : p);
    try {
      const res = await api.forumFollow(token, postId!);
      setPost(p => p ? { ...p, followed: res.followed, follow_count: res.follow_count } : p);
    } catch (e) {
      setPost(prev);
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    } finally { setFollowLoading(false); }
  }

  async function handleResolve() {
    if (!authed) { toast.error(t("forum.toast.loginRequired")); return; }
    if (resolveLoading) return;
    setResolveLoading(true);
    try {
      await api.forumResolve(token, postId!);
      setPost(p => p ? { ...p, resolved: true } : p);
      toast.success(t("forum.toast.markedSolved"));
    } catch (e) { toast.error(e instanceof Error ? e.message : t("common.operationFailed")); }
    finally { setResolveLoading(false); }
  }

  async function handlePin() {
    if (!authed) { toast.error(t("forum.toast.loginRequired")); return; }
    if (pinLoading) return;
    setPinLoading(true);
    try {
      const res = await api.forumPin(token, postId!);
      setPost(p => p ? { ...p, pinned: res.pinned } : p);
      toast.success(res.pinned ? t("forum.toast.pinned") : t("forum.toast.unpinned"));
    } catch (e) { toast.error(e instanceof Error ? e.message : t("common.operationFailed")); }
    finally { setPinLoading(false); }
  }

  function handleCopyLink() {
    void copyText(window.location.href).then((ok) => {
      if (!ok) {
        toast.error(t("common.copyFailed"));
        return;
      }
      setCopiedLink(true);
      toast.success(t("common.linkCopied"));
      setTimeout(() => setCopiedLink(false), 2000);
    });
  }

  if (loading) {
    return (
      <ConsolePageShell>
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={14} className="animate-spin text-fg-muted" />
        </div>
      </ConsolePageShell>
    );
  }

  if (!post) {
    return (
      <ConsolePageShell>
        <div className="py-20 text-center">
          <p className="font-serif text-[15px] font-medium text-fg">{loadError || t("forum.detail.postNotFound")}</p>
          <button
            type="button"
            onClick={() => navigate("/forum")}
            className="mt-4 inline-flex items-center px-4 py-2 rounded-lg border border-border bg-card text-fg text-[13px] font-medium hover:bg-bg-soft transition-colors"
          >
            {t("forum.backToCommunity")}
          </button>
        </div>
      </ConsolePageShell>
    );
  }

  const replyCount = post.replies?.length || 0;
  const isAuthor = authId === post.author_auth_id;
  const isAdmin = token ? decodeJwtRole(token) === "admin" : false;
  const canResolve = !post.resolved && (isAuthor || isAdmin);
  const postIsAnonymous = isAnonymous(post.author_name);

  function renderAuthorLine(name: string, department: string | undefined, anonymous: boolean, created: string, isAdminFlag?: boolean) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1 font-serif text-[13px] font-medium">
          {anonymous && <EyeOff size={11} className="text-fg-subtle" />}
          {name}
        </span>
        {!anonymous && department && <span className="text-[12px] text-fg-subtle">{department}</span>}
        {isAdminFlag && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-brand-soft text-brand">
            <Shield size={10} />{t("forum.badge.official")}
          </span>
        )}
        <span className="text-[11px] text-fg-subtle flex items-center gap-1">
          <Clock size={10} />{formatDateTime(created)}
        </span>
      </div>
    );
  }

  // Render action bar (reused in both inline and sticky versions)
  function renderActionBar() {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={handleLike}
          disabled={likeLoading}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors ${
            post?.liked ? "text-danger bg-danger/5" : "text-fg-muted hover:text-danger hover:bg-danger/5"
          }`}
        >
          <Heart size={13} className={post?.liked ? "fill-danger" : ""} />
          {post?.like_count ?? 0}
        </button>
        <button
          onClick={handleFollow}
          disabled={followLoading}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors ${
            post?.followed ? "text-warn bg-warn/5" : "text-fg-muted hover:text-warn hover:bg-warn/5"
          }`}
        >
          <Star size={13} className={post?.followed ? "fill-warn" : ""} />
          {post?.follow_count ?? 0}
        </button>
        {isAdmin && (
          <button
            onClick={handlePin}
            disabled={pinLoading}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors ${
              post?.pinned ? "text-brand bg-brand/5" : "text-fg-muted hover:text-brand hover:bg-brand/5"
            }`}
          >
            <Pin size={13} className={post?.pinned ? "fill-brand" : ""} />
            {t("forum.badge.pinned")}
          </button>
        )}
        <button
          onClick={() => replyBoxRef.current?.focus()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-fg-muted hover:text-fg hover:bg-secondary transition-colors"
        >
          <MessageSquarePlus size={13} />{t("forum.reply")}
        </button>
        <div className="flex-1" />
        {canResolve && (
          <button
            onClick={handleResolve}
            disabled={resolveLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] border border-ok/30 bg-ok/10 text-ok hover:bg-ok/15 transition-colors font-medium"
          >
            <CheckCircle2 size={13} />
            {resolveLoading ? t("forum.processing") : t("forum.markSolved")}
          </button>
        )}
      </div>
    );
  }

  return (
    <ConsolePageShell className="space-y-0 pb-20">
      <button
        onClick={() => navigate("/forum")}
        className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg transition-colors mb-6 group"
      >
        <ChevronLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
        {t("forum.backToCommunity")}
      </button>

      <article className="rounded-2xl bg-card border border-border overflow-hidden">
        {/* Post header */}
        <div className="px-6 pt-6 pb-0">
          {/* Tags */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
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
          </div>

          <h1 className="mb-5 font-serif text-2xl font-medium leading-tight tracking-normal text-fg">
            {post.title}
          </h1>

          {/* Author row */}
          <div className="flex items-center gap-3 pb-5 border-b border-border">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-[13px] text-white shrink-0"
              style={{ background: avatarColor(post.author_name), fontWeight: 500 }}
            >
              {avatarInitial(post.author_name)}
            </div>
            <div className="min-w-0">
              {renderAuthorLine(post.author_name, post.author_department, postIsAnonymous, post.created_at, false)}
            </div>
            <div className="flex-1" />
            <button
              onClick={handleCopyLink}
              className="p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-secondary transition-colors"
              title={t("common.copyLink")}
            >
              {copiedLink ? <Check size={13} className="text-ok" /> : <LinkIcon size={13} />}
            </button>
            <div className="flex items-center gap-3 text-[12px] text-fg-subtle">
              <span className="inline-flex items-center gap-1"><Eye size={12} />{post.view_count ?? 0}</span>
              {replyCount > 0 && <span className="inline-flex items-center gap-1"><MessageCircle size={12} />{replyCount}</span>}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6 text-[14px] leading-[1.75] text-fg">
          <Markdown source={post.content} />
        </div>

        {/* Action bar */}
        <div className="px-6 pb-6 pt-3 border-t border-border">
          {renderActionBar()}
        </div>
      </article>

      {/* Replies */}
      <section ref={repliesRef} className="mt-10">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-serif text-[16px] font-medium">
            {replyCount > 0 ? t("forum.replyCount", { n: String(replyCount) }) : t("forum.noReplies")}
          </h2>
          {replyCount > 0 && (
            <button
              onClick={() => replyBoxRef.current?.focus()}
              className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg transition-colors"
            >
              <MessageSquarePlus size={12} />{t("forum.reply")}
            </button>
          )}
        </div>

        {replyCount === 0 ? (
          <div className="py-12 text-center rounded-xl border border-dashed border-border">
            <MessageCircle size={28} className="mx-auto text-fg-subtle mb-3" />
            <p className="text-[15px] text-fg-muted">{t("forum.empty.noRepliesDesc")}</p>
            <p className="text-[11px] text-fg-subtle mt-1">{t("forum.empty.shareSuggestion")}</p>
          </div>
        ) : (
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            {(post.replies ?? []).map((r: ForumReply) => {
              const replyAnonymous = isAnonymous(r.author_name);
              return (
                <div key={r.id} className="flex gap-3 px-5 py-5 border-b border-border last:border-b-0 hover:bg-secondary/20 transition-colors group">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] text-white shrink-0"
                    style={{ background: avatarColor(r.author_name), fontWeight: 500 }}
                  >
                    {avatarInitial(r.author_name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    {renderAuthorLine(r.author_name, undefined, replyAnonymous, r.created_at, !!r.is_admin)}
                    <div className="mt-2 text-[14px] leading-[1.75] text-fg">
                      <Markdown source={r.content} />
                    </div>
                  </div>
                  <span className="text-[10px] text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity shrink-0 tabular-nums pt-1">
                    #{(post.replies ?? []).indexOf(r) + 1}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Reply composer */}
      <section className="mt-12">
          <h2 className="mb-4 font-serif text-[16px] font-medium">
          {authed ? t("forum.writeReply") : t("forum.loginToReplyHeading")}
        </h2>
        <div className="flex gap-3">
          {authed && (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-[13px] text-white shrink-0"
              style={{ background: avatarColor(name || "?"), fontWeight: 500 }}
            >
              {avatarInitial(name || "?")}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <textarea
              ref={replyBoxRef}
              className="w-full px-4 py-3 rounded-lg bg-card border border-border text-[14px] text-fg resize-none focus:outline-none focus:border-fg-muted transition-colors placeholder:text-fg-subtle leading-relaxed"
              rows={4}
              placeholder={authed ? t("forum.replyPlaceholder") : t("forum.toast.loginToReply")}
              value={reply}
              onChange={e => setReply(e.target.value)}
              onKeyDown={handleReplyKey}
              disabled={submitting || !authed}
            />
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer select-none group">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={replyAnonymous}
                      onChange={e => setReplyAnonymous(e.target.checked)}
                      disabled={!authed || submitting}
                      className="sr-only peer"
                    />
                    <div className="w-3.5 h-3.5 rounded border-[1.5px] border-border bg-card peer-checked:bg-brand peer-checked:border-brand transition-colors flex items-center justify-center">
                      {replyAnonymous && (
                        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5l2 2 4-4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </div>
                  <span className="text-[11px] text-fg-subtle group-hover:text-fg-muted transition-colors inline-flex items-center gap-1">
                    <EyeOff size={10} />{t("forum.anonymous")}
                  </span>
                </label>
                <span className="text-[11px] text-fg-subtle">{reply.length > 0 && t("forum.charCount", { n: String(reply.length) })}</span>
              </div>
              <button
                type="button"
                onClick={submitReply}
                disabled={submitting || !reply.trim() || !authed}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ink text-bg text-[13px] font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
                {submitting ? t("forum.sending") : t("forum.send")}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Sticky action bar (shown on scroll) */}
      <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-card/95 backdrop-blur-sm px-4 py-3 md:hidden">
        {renderActionBar()}
      </div>
    </ConsolePageShell>
  );
}
