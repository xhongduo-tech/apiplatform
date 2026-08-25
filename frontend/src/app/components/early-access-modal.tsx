import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { X, Clock, CheckCircle2, XCircle, ShieldOff, Loader2 } from "lucide-react";
import { EarlyAccessIcon } from "./early-access-icon";
import { api, type EarlyAccessState } from "../api/gateway";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import { useModalFocus } from "../accessibility";

/**
 * 抢先体验计划申请弹窗。
 *
 * 状态数据由 Layout 的 useEarlyAccess 统一持有（那里同时负责轮询与未读红点），
 * 这里只负责呈现与提交——两处各自 fetch 会导致红点与弹窗内容不同步。
 *
 * 从未申请 → 展示协议与提交按钮；已提交 → 「等待管理员审批」；已通过 → 授权说明；
 * 被驳回/被撤销 → 展示管理员备注并允许重新提交。计划内模型由后端如实返回。
 */
export function EarlyAccessModal({
  open, onClose, state, loading, onRefresh, onSeen,
}: {
  open: boolean;
  onClose: () => void;
  state: EarlyAccessState | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
  /** 打开弹窗即视为已读，清掉红点 */
  onSeen: () => void;
}) {
  const { token } = useAuth();
  const { t } = useT();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setAgreed(false);
    setSubmitting(false);
    onSeen();
    onRefresh();
    // onRefresh/onSeen 每次渲染都是新引用，列进依赖会导致弹窗打开期间反复拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useModalFocus({ open, containerRef: dialogRef, onClose });

  async function submit() {
    if (!token) return;
    if (!agreed) { toast.error(t("earlyAccess.needAgree")); return; }
    setSubmitting(true);
    try {
      await api.earlyAccessApply(token);
      await onRefresh();
      onSeen();
      toast.success(t("earlyAccess.submitted"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const status = state?.status ?? "none";
  const canSubmit = status === "none" || status === "rejected" || status === "revoked";

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto overscroll-contain bg-ink/45">
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="animate-enter bg-card rounded-2xl w-full max-h-[calc(100vh-2rem)] overflow-hidden"
        style={{ maxWidth: 560, boxShadow: "var(--shadow-pop)" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="early-access-title"
        aria-describedby="early-access-description"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-primary">
              <EarlyAccessIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 id="early-access-title" className="font-serif text-[15px] font-medium text-foreground">{t("earlyAccess.title")}</h2>
              <p id="early-access-description" className="text-[12px] text-muted-foreground">{t("earlyAccess.subtitle")}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("earlyAccess.close")}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {loading && !state ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
            </div>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {t("earlyAccess.intro")}
              </p>

              {/* 计划内模型 */}
              {state?.models?.length ? (
                <div className="rounded-xl border border-border bg-secondary/50 px-4 py-3">
                  <p className="text-[12px] text-muted-foreground mb-2">{t("earlyAccess.currentModel")}</p>
                  <div className="flex flex-wrap gap-2">
                    {state.models.map((m) => (
                      <span
                        key={m.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-card border border-border px-2.5 py-1 text-[12.5px] text-foreground"
                      >
                        {m.name.toLowerCase().includes("glm") ? (
                          <img src="/img/logos/glm.png" alt="" className="w-3.5 h-3.5 object-contain rounded dark:invert" />
                        ) : (
                          <EarlyAccessIcon className="w-3.5 h-3.5 text-primary" />
                        )}
                        <span className="font-serif font-medium">{m.name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {status !== "none" && <StatusPanel state={state!} />}

              {canSubmit && (
                <>
                  <div className="rounded-xl border border-border px-4 py-3">
                    <p className="text-[12.5px] font-medium text-foreground mb-2">
                      {t("earlyAccess.agreementTitle")}
                    </p>
                    <ol className="space-y-2 text-[12.5px] leading-relaxed text-muted-foreground list-decimal pl-4">
                      <li>{t("earlyAccess.agreement1")}</li>
                      <li>{t("earlyAccess.agreement2")}</li>
                      <li>{t("earlyAccess.agreement3")}</li>
                    </ol>
                  </div>

                  <label className="flex items-start gap-2.5 cursor-pointer text-[13px] text-foreground">
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                    />
                    <span>{t("earlyAccess.confirm")}</span>
                  </label>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("earlyAccess.close")}
          </button>
          {canSubmit && (
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !agreed}
              className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 apiplatform-btn"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {submitting
                ? t("earlyAccess.submitting")
                : status === "rejected"
                  ? t("earlyAccess.resubmit")
                  : t("earlyAccess.submit")}
            </button>
          )}
        </div>
      </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusPanel({ state }: { state: EarlyAccessState }) {
  const { t } = useT();
  const conf = {
    pending: { Icon: Clock, cls: "text-amber-700 dark:text-amber-400", bg: "bg-warn/10 border-warn/20" },
    approved: { Icon: CheckCircle2, cls: "text-green-700 dark:text-green-400", bg: "bg-ok/10 border-ok/20" },
    rejected: { Icon: XCircle, cls: "text-muted-foreground", bg: "bg-secondary border-border" },
    // 被收回 ≠ 没通过：文案与图标都要跟驳回区分开
    revoked: { Icon: ShieldOff, cls: "text-amber-700 dark:text-amber-400", bg: "bg-warn/10 border-warn/20" },
  }[state.status as "pending" | "approved" | "rejected" | "revoked"];
  if (!conf) return null;
  const { Icon } = conf;

  return (
    <div className={`rounded-xl border px-4 py-3 ${conf.bg}`}>
      <div className={`flex items-center gap-2 text-[13px] font-medium ${conf.cls}`}>
        <Icon className="w-4 h-4 shrink-0" />
        {t(`earlyAccess.state.${state.status}` as "earlyAccess.state.pending")}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {t(`earlyAccess.state.${state.status}Hint` as "earlyAccess.state.pendingHint")}
      </p>
      {state.submitted_at && (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {t("earlyAccess.submittedAt")}：{new Date(state.submitted_at).toLocaleString()}
        </p>
      )}
      {state.note && (
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          {t("earlyAccess.adminNote")}：{state.note}
        </p>
      )}
    </div>
  );
}
