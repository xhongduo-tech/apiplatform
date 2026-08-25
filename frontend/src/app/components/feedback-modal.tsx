import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { X, PenLine, EyeOff } from "lucide-react";
import { api } from "../api/gateway";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import { useModalFocus } from "../accessibility";

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function FeedbackModal({ open, onClose, onSuccess }: FeedbackModalProps) {
  const { token } = useAuth();
  const { t } = useT();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setTitle(""); setContent(""); setAnonymous(false); setLoading(false); }
  }, [open]);

  useModalFocus({ open, containerRef: dialogRef, onClose });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) { toast.error(t("forum.toast.loginFirst")); return; }
    if (!title.trim()) { toast.error(t("forum.toast.titleRequired")); return; }
    if (!content.trim()) { toast.error(t("forum.toast.contentRequired")); return; }
    setLoading(true);
    try {
      await api.forumCreate(token, {
        title: title.trim(),
        content: content.trim(),
        author_name: anonymous ? t("forum.anonymous") : undefined,
      });
      toast.success(t("forum.toast.publishSuccess"));
      onSuccess?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("forum.toast.submitFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const isValid = title.trim().length > 0 && content.trim().length > 0;
  const titleRemain = 100 - title.length;

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto overscroll-contain bg-ink/45">
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="animate-enter bg-card rounded-2xl w-full max-h-[calc(100vh-2rem)] overflow-y-auto"
        style={{
          maxWidth: "540px",
          boxShadow: "var(--shadow-pop)",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        aria-describedby="feedback-dialog-description"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-brand/10 flex items-center justify-center text-brand">
              <PenLine className="w-4 h-4" />
            </div>
            <div>
              <h2 id="feedback-dialog-title" className="font-serif text-[16px] font-medium leading-tight text-foreground">
                {t("forum.publish.title")}
              </h2>
              <p id="feedback-dialog-description" className="text-[12px] text-fg-muted mt-0.5">
                {t("forum.publish.subtitle")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Title */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="feedback-post-title" className="text-[13px] text-muted-foreground font-medium">
                {t("forum.publish.titleLabel")} <span className="text-brand">*</span>
              </label>
              <span className={`text-[11px] tabular-nums transition-colors ${
                titleRemain < 10 ? "text-warn font-medium" : titleRemain < 20 ? "text-fg-subtle" : "text-fg-subtle"
              }`}>
                {title.length}<span className="opacity-40">/100</span>
              </span>
            </div>
            <input
              id="feedback-post-title"
              className="w-full rounded-xl border border-border bg-secondary px-4 py-2.5 font-serif text-[14px] text-foreground placeholder:text-muted-foreground transition-all focus:border-brand focus:outline-none"
              style={{ boxShadow: "none" }}
              placeholder={t("forum.publish.titlePlaceholder")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              disabled={loading}
            />
          </div>

          {/* Content */}
          <div>
            <label htmlFor="feedback-post-content" className="block text-[13px] text-muted-foreground mb-1.5 font-medium">
                {t("forum.publish.contentLabel")} <span className="text-brand">*</span>
            </label>
            <textarea
              id="feedback-post-content"
              className="w-full px-4 py-3 rounded-xl bg-secondary text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none border border-border focus:border-brand transition-all"
              placeholder={t("forum.publish.contentPlaceholder")}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              disabled={loading}
              style={{ resize: "none", minHeight: "120px", lineHeight: "1.75" }}
            />
            <p className="text-[11px] text-fg-subtle mt-1.5 flex items-center gap-1">
              {t("forum.publish.markdownHint")}
            </p>
          </div>

          {/* Anonymous toggle */}
          <label className="flex items-center gap-2.5 cursor-pointer select-none group py-1">
            <div className="relative">
              <input
                type="checkbox"
                checked={anonymous}
                onChange={e => setAnonymous(e.target.checked)}
                disabled={loading}
                className="sr-only peer"
              />
              <div className={`w-4 h-4 rounded border-2 transition-colors flex items-center justify-center ${
                anonymous ? "bg-brand border-brand" : "border-border bg-card"
              }`}>
                {anonymous && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[13px] text-fg-muted group-hover:text-fg transition-colors">
              <EyeOff size={13} />
              {t("forum.publish.anonymous")}
            </div>
          </label>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-muted-foreground border border-border hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-40"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={loading || !isValid}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin inline-block" />
                  {t("common.publishing")}
                </span>
              ) : (
                t("forum.publish.submit")
              )}
            </button>
          </div>
        </form>
      </div>
      </div>
    </div>,
    document.body
  );
}
