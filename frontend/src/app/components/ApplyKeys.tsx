import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Loader2, Copy, Check, Pencil, Trash2, X, KeyRound, ChevronDown, Zap, RefreshCw, AlertTriangle, Clock, PowerOff,
} from "lucide-react";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { api, type UserKeyRow, type PlatformConfig, type UpgradeApplicationRow } from "../api/gateway";
import { useAuth } from "../hooks/use-auth";
import { useT, type TranslationKey } from "../i18n";
import { PAGE_TITLE_CLASS } from "./ui/utils";
import { usePlatformConfig } from "../hooks/use-platform-config";
import { SafeHtml } from "../safe-html";

/** 场景分类兜底选项：后台 scene_types 接口拉取失败时使用（正常路径以接口数据为准）。 */
const SCENE_TYPE_FALLBACK: { key: string; labelKey: TranslationKey }[] = [
  { key: "key", labelKey: "sceneType.key" },
  { key: "labor_contest", labelKey: "sceneType.labor_contest" },
  { key: "innovation", labelKey: "sceneType.innovation" },
  { key: "explore", labelKey: "sceneType.explore" },
  { key: "dept_explore", labelKey: "sceneType.dept_explore" },
];

/** 名称作为富文本占位值前先转义；SafeHtml 会再执行统一白名单清洗。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function copyToClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text: string) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try { document.execCommand("copy"); } catch { /* silent */ }
  document.body.removeChild(el);
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type UserTier = "default" | "high" | "unlimited";

function normalizeTier(tier?: string): UserTier {
  if (tier === "high" || tier === "unlimited") return tier;
  return "default";
}

function tierRank(tier: UserTier): number {
  return ({ default: 0, high: 1, unlimited: 2 } as const)[tier];
}

/** 密钥并发档位：图标色 + 行内操作按钮样式（仅 default / high / unlimited 三档）。 */
function keyTierDisplay(tier: string | undefined, t: ReturnType<typeof useT>["t"]) {
  switch (normalizeTier(tier)) {
    case "high":
      return {
        label: t("keys.highConcurrency"),
        iconCls: "text-brand",
        textCls: "text-brand",
        actionCls: "text-brand hover:text-brand hover:bg-brand/10",
      };
    case "unlimited":
      return {
        label: t("keys.ultraConcurrency"),
        iconCls: "text-violet-600",
        textCls: "text-violet-600",
        actionCls: "text-violet-600 hover:text-violet-600 hover:bg-violet-50",
      };
    default:
      return {
        label: t("keys.default"),
        iconCls: "text-fg",
        textCls: "text-fg",
        actionCls: "text-fg hover:text-brand hover:bg-brand/10",
      };
  }
}

function tierLabelFor(tier: UserTier, t: ReturnType<typeof useT>["t"]) {
  return keyTierDisplay(tier, t).label;
}

/** 申请中 / 已驳回 / 已吊销等不可操作时的统一提示。 */
function rowActionDisabledHint(status: string, t: ReturnType<typeof useT>["t"]) {
  if (status === "revoked") return t("keys.revokedReapplyHint");
  if (status === "pending") return t("keys.actionDisabledPending");
  if (status === "rejected") return t("keys.actionDisabledRejected");
  return t("keys.rotateNotAvailable");
}

/** 行内操作按钮外层：单一 title 提示，禁用时也能悬停展示原因。 */
function RowActionWrap({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex" title={title}>
      {children}
    </span>
  );
}

const ROW_ACTION_BASE = "p-1.5 rounded-md transition-colors inline-flex items-center justify-center";
const ROW_ACTION_DISABLED = `${ROW_ACTION_BASE} text-fg-muted opacity-40 cursor-not-allowed pointer-events-none`;

/** 行内四图标：禁用时不用原生 disabled（避免浏览器强制深色），靠 aria-disabled + 置灰样式。 */
function RowActionButton({
  enabled,
  title,
  hoverCls,
  enabledCls,
  onClick,
  children,
}: {
  enabled: boolean;
  title: string;
  hoverCls: string;
  enabledCls?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <RowActionWrap title={title}>
      <button
        type="button"
        aria-label={title}
        aria-disabled={!enabled}
        tabIndex={enabled ? 0 : -1}
        className={
          enabled
            ? (enabledCls ?? `${ROW_ACTION_BASE} text-fg-subtle ${hoverCls} apiplatform-hover-scale cursor-pointer`)
            : ROW_ACTION_DISABLED
        }
        onClick={(e) => {
          e.stopPropagation();
          if (enabled) onClick?.();
        }}
      >
        {children}
      </button>
    </RowActionWrap>
  );
}

/** 并发档位 RPM/TPM 对照表：创建申请与高并发升级弹窗共用。 */
function RateLimitPresetsTable({
  config,
  compact = false,
}: {
  config: PlatformConfig | null;
  compact?: boolean;
}) {
  const { t } = useT();
  const rateLimit = config?.rate_limit;
  const presets = config?.rate_limit_presets ?? [];
  const cellPad = compact ? "px-3 py-2" : "px-4 py-2.5";
  const textSize = compact ? "text-[12px]" : "text-[13px]";

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className={`w-full ${textSize}`}>
        <thead>
          <tr className="border-b border-border bg-bg-soft">
            <th className={`${cellPad} text-left font-medium text-fg-muted`}>{t("keys.tier")}</th>
            <th className={`${cellPad} text-left font-medium text-fg-muted`}>{t("keys.rpm")}</th>
            <th className={`${cellPad} text-left font-medium text-fg-muted`}>{t("keys.tpm")}</th>
          </tr>
        </thead>
        <tbody>
          {presets.length > 0 ? presets.map((p) => {
            const isDefault = p.key === "default";
            const isUltra = p.unlimited;
            const isHigh = !isDefault && !isUltra;
            return (
              <tr key={p.key} className={isDefault ? "border-b border-border" : undefined}>
                <td className={`${cellPad} text-fg`}>
                  <span className="inline-flex items-center gap-1.5">
                    <Zap className={`w-3.5 h-3.5 ${isUltra ? "text-violet-600" : isHigh ? "text-brand" : "text-fg"}`} />
                    {p.key === "default" ? t("keys.default") : p.key === "high" ? t("keys.highConcurrency") : p.key === "unlimited" ? t("keys.ultraConcurrency") : p.name}
                  </span>
                </td>
                <td className={`${cellPad} text-fg font-mono`}>
                  {p.unlimited ? t("keys.unlimited") : p.key === "default" && rateLimit ? rateLimit.rpm.toLocaleString() : p.rpm.toLocaleString()}
                </td>
                <td className={`${cellPad} text-fg font-mono`}>
                  {p.unlimited ? t("keys.unlimited") : p.key === "default" && rateLimit ? rateLimit.tpm.toLocaleString() : p.tpm.toLocaleString()}
                </td>
              </tr>
            );
          }) : (
            <>
              <tr className="border-b border-border">
                <td className={`${cellPad} text-fg`}>
                  <span className="inline-flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-fg" />
                    {t("keys.default")}
                  </span>
                </td>
                <td className={`${cellPad} text-fg font-mono`}>{rateLimit ? rateLimit.rpm.toLocaleString() : "600"}</td>
                <td className={`${cellPad} text-fg font-mono`}>{rateLimit ? rateLimit.tpm.toLocaleString() : "6,000,000"}</td>
              </tr>
              <tr>
                <td className={`${cellPad} text-fg`}>
                  <span className="inline-flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-brand" />
                    {t("keys.highConcurrency")}
                  </span>
                </td>
                <td className={`${cellPad} text-fg font-mono`}>3,000</td>
                <td className={`${cellPad} text-fg font-mono`}>60,000,000</td>
              </tr>
              <tr>
                <td className={`${cellPad} text-fg`}>
                  <span className="inline-flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-violet-600" />
                    {t("keys.ultraConcurrency")}
                  </span>
                </td>
                <td className={`${cellPad} text-fg`}>{t("keys.unlimited")}</td>
                <td className={`${cellPad} text-fg`}>{t("keys.unlimited")}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function UltraConcurrencyNotice({ className = "" }: { className?: string }) {
  const { t } = useT();
  const { branding } = usePlatformConfig();
  const approval = escapeHtml(`${branding.approval_department} - ${branding.approval_contact} (${branding.approval_email})`);
  const support = escapeHtml(`${branding.support_department} - ${branding.support_contact} (${branding.support_email})`);
  return (
    <SafeHtml
      as="div"
      className={`rounded-xl bg-danger/5 border border-danger/20 px-3.5 py-3 text-[13px] text-fg leading-[1.75] ${className}`}
      html={t("keys.ultraConcurrencyManual", { approval, support })}
    />
  );
}

function HighConcurrencyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { branding } = usePlatformConfig();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-[420px] rounded-2xl bg-card p-6 shadow-pop animate-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{t("keys.highConcurrencyTitle")}</h3>
        <p className="mt-3 text-[14px] text-fg leading-[1.75] m-0">
          {t("keys.highConcurrencyTip", {
            approval: `${branding.approval_department} - ${branding.approval_contact}`,
          })}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full h-10 rounded-lg bg-ink text-bg text-[13px] font-medium hover:bg-ink/80 transition-colors apiplatform-btn"
        >
           {t("keys.gotIt")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function UltraConcurrencyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-[480px] rounded-2xl bg-card p-6 shadow-pop animate-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{t("keys.ultraConcurrency")}</h3>
        <UltraConcurrencyNotice className="mt-3" />
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full h-10 rounded-lg bg-ink text-bg text-[13px] font-medium hover:bg-ink/80 transition-colors apiplatform-btn"
        >
          {t("keys.gotIt")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function TierChangeModal({
  rec, token, config, pendingApp, rejectedApp, onClose, onSuccess, onViewStatus,
}: {
  rec: UserKeyRow;
  token: string;
  config: PlatformConfig | null;
  pendingApp: UpgradeApplicationRow | null;
  rejectedApp: UpgradeApplicationRow | null;
  onClose: () => void;
  onSuccess: () => void;
  onViewStatus: (app: UpgradeApplicationRow) => void;
}) {
  const { t } = useT();
  const currentTier = normalizeTier(rec.tier);
  const isEditPending = pendingApp?.status === "pending";
  const [targetTier, setTargetTier] = useState<UserTier | null>(() =>
    isEditPending ? normalizeTier(pendingApp?.targetTier) : null,
  );
  const [reason, setReason] = useState(() => (isEditPending ? pendingApp?.reason ?? "" : ""));
  const [loading, setLoading] = useState(false);
  const [submittedApp, setSubmittedApp] = useState<UpgradeApplicationRow | null>(null);
  const [showRateLimit, setShowRateLimit] = useState(false);

  const tierOptions: UserTier[] = ["default", "high", "unlimited"];
  const targetRank = targetTier !== null ? tierRank(targetTier) : null;
  const currentRank = tierRank(currentTier);
  const isDowngrade = !isEditPending && targetTier !== null && targetRank! < currentRank;
  const isUpgrade = targetTier !== null && targetRank! > currentRank;
  const isCurrent = targetTier === currentTier;
  const isUltraEmailOnly = targetTier === "unlimited" && (isUpgrade || isEditPending);
  const needsUpgradeReason = (isUpgrade || isEditPending) && targetTier !== "unlimited";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !loading) onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose, loading]);

  const inputCls =
    "w-full px-4 py-3 rounded-xl bg-bg-soft text-[14px] text-fg placeholder:text-fg-subtle outline-none border border-border";

  async function withdrawPending() {
    if (!pendingApp) return;
    setLoading(true);
    try {
      await api.upgradeWithdraw(token, pendingApp.id);
      toast.success(t("keys.upgradeWithdrawSuccess"));
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("keys.operationFailed"));
      setLoading(false);
    }
  }

  async function dismissRejected() {
    if (!rejectedApp) return;
    setLoading(true);
    try {
      await api.upgradeWithdraw(token, rejectedApp.id);
      toast.success(t("keys.upgradeDismissRejectedSuccess"));
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("keys.operationFailed"));
      setLoading(false);
    }
  }

  async function applyChange(e: React.FormEvent) {
    e.preventDefault();
    if (!targetTier || isCurrent || isUltraEmailOnly) return;
    setLoading(true);
    try {
      if (isEditPending && pendingApp) {
        const reasonTrim = reason.trim();
        if (reasonTrim.length < 10) { toast.error(t("keys.upgradeReasonRequired")); setLoading(false); return; }
        if (targetRank! <= currentRank) {
          toast.error(t("keys.upgradeEditMustBeHigher"));
          setLoading(false);
          return;
        }
        await api.upgradeUpdate(token, pendingApp.id, { reason: reasonTrim, target_tier: targetTier });
        toast.success(t("keys.upgradeUpdateSuccess"));
        onSuccess();
        onClose();
      } else if (isDowngrade) {
        await api.userChangeTier(token, rec.id, targetTier);
        toast.success(t("keys.tierDowngradeSuccess", { tier: tierLabelFor(targetTier, t) }));
        onSuccess();
        onClose();
      } else if (isUpgrade) {
        const reasonTrim = reason.trim();
        if (reasonTrim.length < 10) { toast.error(t("keys.upgradeReasonRequired")); setLoading(false); return; }
        const res = await api.upgradeApply(token, {
          key_id: rec.id,
          reason: reasonTrim,
          target_tier: targetTier,
        });
        const app: UpgradeApplicationRow = {
          id: res.id,
          keyId: res.keyId,
          keyName: res.keyName,
          reason: reasonTrim,
          targetTier: res.targetTier ?? targetTier,
          status: res.status as UpgradeApplicationRow["status"],
          note: null,
          createdAt: res.createdAt,
          reviewedAt: null,
        };
        setSubmittedApp(app);
        onSuccess();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isDowngrade ? t("keys.tierDowngradeFailed") : t("keys.upgradeSubmitFailed")));
      setLoading(false);
    }
  }

  const modalTitle = isEditPending ? t("keys.tierEditPendingTitle") : t("keys.tierChangeTitle");
  const modalSubtext = isEditPending
    ? t("keys.tierEditPendingSubtext", { name: rec.name, tier: tierLabelFor(currentTier, t) })
    : t("keys.tierChangeSubtext", { name: rec.name, tier: tierLabelFor(currentTier, t) });

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="animate-enter w-full rounded-2xl bg-card overflow-hidden" style={{ maxWidth: 480, boxShadow: "var(--shadow-pop)" }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center text-brand">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h2 className="m-0 font-serif text-[16px] font-medium leading-tight text-fg">{modalTitle}</h2>
              <p className="text-[12px] text-fg-muted leading-tight mt-0.5 m-0">{modalSubtext}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors" aria-label={t("keys.close")}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {submittedApp ? (
          <div className="px-6 pt-3 pb-6 space-y-4">
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <div className="w-12 h-12 rounded-full bg-ok/10 flex items-center justify-center">
                <Check className="w-6 h-6 text-ok" />
              </div>
              <div>
                <h3 className="m-0 font-serif text-[15px] font-medium text-fg">{t("keys.upgradeSuccessTitle")}</h3>
                <p className="mt-1.5 text-[13px] text-fg-muted leading-relaxed m-0">{t("keys.upgradeSuccessDesc")}</p>
              </div>
            </div>
            <div className="flex gap-2.5">
              <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors apiplatform-btn">
                {t("keys.done")}
              </button>
              <button type="button" onClick={() => { onViewStatus(submittedApp); onClose(); }} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn">
                {t("keys.viewUpgradeStatus")}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={applyChange} className="p-6 space-y-4">
            {rejectedApp && !isEditPending && (
              <div className="rounded-xl bg-danger/5 border border-danger/20 px-3 py-2.5 space-y-2">
                <p className="text-[12px] text-danger font-medium m-0">{t("keys.upgradeRejectedBanner")}</p>
                {rejectedApp.note && (
                  <p className="text-[12px] text-fg leading-relaxed m-0">{rejectedApp.note}</p>
                )}
                <p className="text-[12px] text-fg-muted leading-relaxed m-0">{t("keys.upgradeRejectedHint")}</p>
                <button type="button" onClick={dismissRejected} disabled={loading} className="text-[12px] font-medium text-fg-muted hover:text-fg underline underline-offset-2">
                  {t("keys.upgradeDismissRejected")}
                </button>
              </div>
            )}
            <div>
              <button
                type="button"
                onClick={() => setShowRateLimit(!showRateLimit)}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-fg-muted hover:text-fg transition-colors"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showRateLimit ? "rotate-180" : ""}`} />
                {t("keys.upgradeRateLimitInfo")}
              </button>
              {showRateLimit && (
                <div className="mt-2">
                  <RateLimitPresetsTable config={config} compact />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-[13px] font-medium text-fg m-0">{t("keys.tierSelectTarget")}</p>
              {tierOptions.map((tier) => {
                const vis = keyTierDisplay(tier, t);
                const selected = targetTier === tier;
                const isCur = tier === currentTier;
                const tierDisabled = isEditPending
                  ? tierRank(tier) <= currentRank
                  : loading;
                return (
                  <button
                    key={tier}
                    type="button"
                    disabled={tierDisabled}
                    onClick={() => setTargetTier(tier)}
                    className={`w-full flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                      selected ? "border-brand bg-brand/5" : "border-border hover:bg-bg-soft"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <Zap className={`w-4 h-4 shrink-0 ${vis.iconCls}`} />
                      <span className={`text-[13px] font-medium ${vis.textCls}`}>{vis.label}</span>
                    </span>
                    {isCur && (
                      <span className="shrink-0 rounded-full bg-bg-soft px-2 py-0.5 text-[11px] font-medium text-fg-subtle">
                        {t("keys.tierCurrentBadge")}
                      </span>
                    )}
                    {isEditPending && selected && (
                      <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                        {t("keys.upgradeStatusPending")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {(isUpgrade || isEditPending) && targetTier === "unlimited" && (
              <UltraConcurrencyNotice />
            )}
            {needsUpgradeReason && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[13px] font-medium text-fg">
                    {t("keys.upgradeReasonLabel")} <span className="text-danger">*</span>
                    <span className="font-normal text-fg-subtle">{t("keys.min10CharsHint")}</span>
                  </label>
                  <span className="text-[11px] tabular-nums" style={{ color: reason.trim().length >= 10 ? "var(--ok)" : "var(--fg-subtle)" }}>
                    {reason.trim().length} / 10
                  </span>
                </div>
                <p className="mt-1 mb-1.5 text-[12px] text-fg-subtle leading-relaxed">{t("keys.upgradeReasonHint")}</p>
                <textarea
                  className={inputCls + " resize-none"}
                  placeholder={t("keys.upgradeReasonPlaceholder")}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  disabled={loading}
                />
              </div>
            )}
            {!isEditPending && isCurrent && targetTier !== null && (
              <p className="text-[12px] text-fg-muted m-0">{t("keys.tierAlreadyCurrent")}</p>
            )}
            <div className="flex gap-2.5 pt-1">
              {isUltraEmailOnly && !isEditPending ? (
                <button type="button" onClick={onClose} className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn">
                  {t("keys.gotIt")}
                </button>
              ) : (
                <>
                  {isEditPending ? (
                    <button type="button" onClick={withdrawPending} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-danger border border-danger/30 hover:bg-danger/5 transition-colors disabled:opacity-40 apiplatform-btn">
                      {t("keys.upgradeWithdraw")}
                    </button>
                  ) : (
                    <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 apiplatform-btn">
                      {t("keys.cancel")}
                    </button>
                  )}
                  {isUltraEmailOnly && isEditPending ? (
                    <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors disabled:opacity-40 apiplatform-btn">
                      {t("keys.gotIt")}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={
                        loading || !targetTier || isCurrent
                        || (needsUpgradeReason && reason.trim().length < 10)
                        || (isEditPending && targetRank !== null && targetRank <= currentRank)
                      }
                      className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors disabled:opacity-50 apiplatform-btn"
                    >
                      {loading ? (
                        <span className="inline-flex items-center justify-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {isEditPending ? t("keys.upgradeUpdateSubmitting") : isDowngrade ? t("keys.processing") : t("keys.upgradeSubmitting")}
                        </span>
                      ) : isEditPending ? t("keys.upgradeUpdateSubmit") : isDowngrade ? t("keys.tierDowngradeSubmit") : t("keys.upgradeSubmit")}
                    </button>
                  )}
                </>
              )}
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 高并发升级申请的审批状态详情弹窗：点击列表里的升级状态胶囊打开。 */
function UpgradeStatusModal({ app, onClose }: { app: UpgradeApplicationRow; onClose: () => void }) {
  const { t } = useT();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const isPending = app.status === "pending";
  const isApproved = app.status === "approved";
  const statusCls = isPending ? "bg-amber-50 text-amber-600" : isApproved ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger";
  const StatusIcon = isPending ? Clock : isApproved ? Check : X;
  const statusLabel = isPending ? t("keys.upgradeStatusPending") : isApproved ? t("keys.upgradeStatusApproved") : t("keys.upgradeStatusRejected");
  const tierLabel = app.targetTier === "unlimited" ? t("keys.ultraConcurrency") : app.targetTier === "high" ? t("keys.highConcurrency") : app.targetTier;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="animate-enter w-full rounded-2xl bg-card overflow-hidden" style={{ maxWidth: 440, boxShadow: "var(--shadow-pop)" }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center text-brand">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h2 className="m-0 font-serif text-[16px] font-medium leading-tight text-fg">{t("keys.upgradeStatusViewTitle")}</h2>
              <p className="m-0 mt-0.5 font-serif text-[12px] font-medium leading-tight text-fg-muted">{app.keyName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors"
            aria-label={t("keys.close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-3.5 text-[13px]">
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-muted shrink-0">{t("keys.upgradeDetailStatus")}</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${statusCls}`}>
              <StatusIcon className="w-3 h-3" />
              {statusLabel}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-muted shrink-0">{t("keys.upgradeDetailTier")}</span>
            <span className="font-medium text-fg text-right">{tierLabel}</span>
          </div>
          <div>
            <div className="text-fg-muted mb-1">{t("keys.upgradeDetailReason")}</div>
            <div className="text-fg leading-relaxed bg-bg-soft rounded-lg px-3 py-2.5 whitespace-pre-wrap">{app.reason}</div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-muted shrink-0">{t("keys.upgradeDetailCreated")}</span>
            <span className="font-medium text-fg">{app.createdAt ? formatDate(app.createdAt) : "—"}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-muted shrink-0">{t("keys.upgradeDetailReviewed")}</span>
            <span className="font-medium text-fg">{app.reviewedAt ? formatDate(app.reviewedAt) : t("keys.upgradeNotReviewedYet")}</span>
          </div>
          {app.status === "rejected" && app.note && (
            <div>
              <div className="text-fg-muted mb-1">{t("keys.upgradeDetailNote")}</div>
              <div className="text-danger leading-relaxed bg-danger/5 rounded-lg px-3 py-2.5 whitespace-pre-wrap">{app.note}</div>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-full mt-2 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn"
          >
            {t("keys.done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CreateKeyModal({
  open,
  onClose,
  onSuccess,
  token,
  authId,
  config,
  applyRate,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  token: string;
  authId: string;
  config: PlatformConfig | null;
  applyRate: { limit: number; used: number; remaining: number; resets_in: number } | null;
}) {
  const { t } = useT();
  const [projectName, setProjectName] = useState("");
  const [projectDesc, setProjectDesc] = useState("");
  const [sceneType, setSceneType] = useState("explore");
  // 场景分类由后台 scene_types 表下发（admin 可增删改）；拉取失败时用内置兜底选项
  const [sceneTypes, setSceneTypes] = useState<{ key: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHighTip, setShowHighTip] = useState(false);
  const [showUltraTip, setShowUltraTip] = useState(false);
  const [showRateLimit, setShowRateLimit] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const concurrencyTipRef = useRef<HTMLTableRowElement>(null);
  const [concurrencyTipVisible, setConcurrencyTipVisible] = useState(false);
  const [concurrencyTipPos, setConcurrencyTipPos] = useState<React.CSSProperties>({});
  const ultraTipRef = useRef<HTMLTableRowElement>(null);
  const [ultraTipVisible, setUltraTipVisible] = useState(false);
  const [ultraTipPos, setUltraTipPos] = useState<React.CSSProperties>({});
  const rateLimit = config?.rate_limit;
  const presets = config?.rate_limit_presets ?? [];

  useEffect(() => {
    if (open) {
      setProjectName("");
      setProjectDesc("");
      setSceneType("explore");
      setLoading(false);
      setShowHighTip(false);
      setShowUltraTip(false);
      setShowRateLimit(false);
      setSubmitted(false);
      setConcurrencyTipVisible(false);
      setUltraTipVisible(false);
    }
  }, [open]);

  // 打开弹窗时拉取场景分类；若当前选中项不在列表里（如被 admin 删除）则切到第一项
  useEffect(() => {
    if (!open) return;
    api.sceneTypes()
      .then((d) => {
        const list = d.data ?? [];
        setSceneTypes(list);
        setSceneType((cur) => (list.length && !list.some((o) => o.key === cur)) ? list[0].key : cur);
      })
      .catch(() => { /* 拉取失败：回落到内置兜底选项 */ });
  }, [open]);

  const updateConcurrencyTipPos = useCallback(() => {
    if (!concurrencyTipRef.current) return;
    const r = concurrencyTipRef.current.getBoundingClientRect();
    setConcurrencyTipPos({
      position: "fixed",
      left: r.left + 16,
      top: r.bottom + 2,
      zIndex: 10002,
    });
  }, []);

  useEffect(() => {
    if (!concurrencyTipVisible) return;
    updateConcurrencyTipPos();
    window.addEventListener("scroll", updateConcurrencyTipPos, true);
    window.addEventListener("resize", updateConcurrencyTipPos);
    return () => {
      window.removeEventListener("scroll", updateConcurrencyTipPos, true);
      window.removeEventListener("resize", updateConcurrencyTipPos);
    };
  }, [concurrencyTipVisible, updateConcurrencyTipPos]);

  const updateUltraTipPos = useCallback(() => {
    if (!ultraTipRef.current) return;
    const r = ultraTipRef.current.getBoundingClientRect();
    setUltraTipPos({
      position: "fixed",
      left: r.left + 16,
      top: r.bottom + 2,
      zIndex: 10002,
    });
  }, []);

  useEffect(() => {
    if (!ultraTipVisible) return;
    updateUltraTipPos();
    window.addEventListener("scroll", updateUltraTipPos, true);
    window.addEventListener("resize", updateUltraTipPos);
    return () => {
      window.removeEventListener("scroll", updateUltraTipPos, true);
      window.removeEventListener("resize", updateUltraTipPos);
    };
  }, [ultraTipVisible, updateUltraTipPos]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showHighTip) setShowHighTip(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, showHighTip]);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const inputCls =
    "w-full px-4 py-3 rounded-xl bg-bg-soft text-[14px] text-fg placeholder:text-fg-subtle outline-none border border-border";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!authId.trim()) { toast.error(t("keys.pleaseLoginFirst")); return; }
    if (projectName.trim().length < 5) { toast.error(t("keys.nameMin5Chars")); return; }
    if (projectDesc.trim().length < 30) { toast.error(t("keys.descMin30Chars")); return; }
    setLoading(true);
    try {
      // 身份与部门后端一律以登录态 JWT 为准，请求体不再携带
      await api.apply(token, {
        project_name: projectName.trim(),
        project_desc: projectDesc.trim(),
        scene_type: sceneType,
        models: [],
      });
      setSubmitted(true);
      onSuccess();
    } catch (err) {
      const e = err as Error & { status?: number; detail?: unknown };
      if (e.status === 429 && e.detail && typeof e.detail === "object" && "code" in e.detail && (e.detail as Record<string,unknown>).code === "apply_rate_limited") {
        const d = e.detail as unknown as { retry_minutes: number; limit: number };
        toast.error(t("keys.applyRateLimited", { retryMinutes: d.retry_minutes, limit: d.limit }));
      } else {
        toast.error(e instanceof Error ? e.message : t("keys.createFailed"));
      }
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return createPortal(
    <>
      {showHighTip && <HighConcurrencyDialog onClose={() => setShowHighTip(false)} />}
      {showUltraTip && <UltraConcurrencyDialog onClose={() => setShowUltraTip(false)} />}
      {concurrencyTipVisible && createPortal(
        <span
          className="pointer-events-none whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-bg shadow-md"
          style={concurrencyTipPos}
        >
           {t("keys.clickToLearnUpgrade")}
        </span>,
        document.body,
      )}
      {ultraTipVisible && createPortal(
        <span
          className="pointer-events-none whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-bg shadow-md"
          style={ultraTipPos}
        >
           {t("keys.clickToLearnUpgrade")}
        </span>,
        document.body,
      )}
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink/40 px-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          className="animate-enter bg-card rounded-2xl w-full overflow-hidden"
          style={{
            maxWidth: 480,
            boxShadow: "var(--shadow-pop)",
          }}
        >
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-bg-soft flex items-center justify-center text-fg">
                <KeyRound className="w-4 h-4" />
              </div>
              <div>
                <h2 className="m-0 font-serif text-[16px] font-medium leading-tight text-fg">{t("keys.createApiKey")}</h2>
                <p className="text-[12px] text-fg-muted leading-tight mt-0.5 m-0">{t("keys.createKeySubtext")}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors"
              aria-label={t("keys.close")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {submitted ? (
            <div className="px-6 pt-3 pb-6 space-y-4">
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <div className="w-12 h-12 rounded-full bg-ok/10 flex items-center justify-center">
                  <Check className="w-6 h-6 text-ok" />
                </div>
                <div>
                  <h3 className="m-0 font-serif text-[15px] font-medium text-fg">{t("keys.submittedPendingTitle")}</h3>
                  <p className="mt-1.5 text-[13px] text-fg-muted leading-relaxed m-0">{t("keys.submittedPendingDesc")}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn"
              >
                {t("keys.done")}
              </button>
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-fg mb-1.5">
                {t("keys.scenario")} <span className="text-danger">*</span>
                <span className="font-normal text-fg-subtle">{t("keys.min5CharsHint")}</span>
              </label>
              <input
                className={inputCls + " font-serif"}
                placeholder={t("keys.scenarioPlaceholder")}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-[13px] font-medium text-fg mb-1.5">
                {t("keys.sceneType")} <span className="text-danger">*</span>
                <span className="font-normal text-fg-subtle">{t("keys.sceneTypeHint")}</span>
              </label>
              <select
                className={inputCls}
                value={sceneType}
                onChange={(e) => setSceneType(e.target.value)}
                disabled={loading}
              >
                {(sceneTypes.length > 0
                  ? sceneTypes
                  : SCENE_TYPE_FALLBACK.map((f) => ({ key: f.key, label: t(f.labelKey) }))
                ).map((opt) => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[13px] font-medium text-fg">
                  {t("keys.backgroundRequirement")} <span className="text-danger">*</span>
                  <span className="font-normal text-fg-subtle">{t("keys.min30CharsHint")}</span>
                </label>
                <span className="text-[11px] tabular-nums" style={{ color: projectDesc.trim().length >= 30 ? "var(--ok)" : "var(--fg-subtle)" }}>
                  {projectDesc.trim().length} / 30
                </span>
              </div>
              <p className="mt-1 mb-1.5 text-[12px] text-fg-subtle leading-relaxed">
                {t("keys.backgroundRequirementHint")}
              </p>
              <textarea
                className={inputCls + " resize-none"}
                placeholder={t("keys.requirementPlaceholder")}
                value={projectDesc}
                onChange={(e) => setProjectDesc(e.target.value)}
                rows={4}
                disabled={loading}
              />
            </div>

            <button
              type="button"
              onClick={() => setShowRateLimit(!showRateLimit)}
              className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showRateLimit ? "rotate-180" : ""}`} />
               {t("keys.viewRateLimitInfo")}
            </button>

              {showRateLimit && (
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border bg-bg-soft">
                      <th className="px-4 py-2.5 text-left font-medium text-fg-muted">{t("keys.tier")}</th>
                      <th className="px-4 py-2.5 text-left font-medium text-fg-muted">{t("keys.rpm")}</th>
                      <th className="px-4 py-2.5 text-left font-medium text-fg-muted">{t("keys.tpm")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {presets.length > 0 ? presets.map((p) => {
                      const isDefault = p.key === "default";
                      const isHigh = !isDefault && !p.unlimited;
                      const isUltra = p.unlimited;
                      const RowRef = isUltra ? ultraTipRef : isHigh ? concurrencyTipRef : undefined;
                      return (
                        <tr
                          key={p.key}
                          ref={RowRef}
                          className={isDefault ? "border-b border-border" : "cursor-pointer hover:bg-brand/5 transition-colors"}
                          onClick={isDefault ? undefined : () => (isUltra ? setShowUltraTip(true) : setShowHighTip(true))}
                          onMouseEnter={isDefault ? undefined : () => {
                            if (isUltra) setUltraTipVisible(true);
                            else setConcurrencyTipVisible(true);
                          }}
                          onMouseLeave={isDefault ? undefined : () => {
                            if (isUltra) setUltraTipVisible(false);
                            else setConcurrencyTipVisible(false);
                          }}
                        >
                          <td className="px-4 py-2.5 text-fg">
                            <span className="inline-flex items-center gap-1.5">
                              <Zap className={`w-3.5 h-3.5 ${isUltra ? "text-violet-600" : isHigh ? "text-brand" : "text-fg"}`} />
                              {p.key === "default" ? t("keys.default") : p.key === "high" ? t("keys.highConcurrency") : p.key === "unlimited" ? t("keys.ultraConcurrency") : p.name}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-fg font-mono">
                            {p.unlimited ? t("keys.unlimited") : p.key === "default" && rateLimit ? rateLimit.rpm.toLocaleString() : p.rpm.toLocaleString()}
                          </td>
                          <td className="px-4 py-2.5 text-fg font-mono">
                            {p.unlimited ? t("keys.unlimited") : p.key === "default" && rateLimit ? rateLimit.tpm.toLocaleString() : p.tpm.toLocaleString()}
                          </td>
                        </tr>
                      );
                    }) : (
                      <>
                        <tr className="border-b border-border">
                          <td className="px-4 py-2.5 text-fg">
                            <span className="inline-flex items-center gap-1.5">
                              <Zap className="w-3.5 h-3.5 text-fg" />
                              {t("keys.default")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-fg font-mono">{rateLimit ? rateLimit.rpm.toLocaleString() : "600"}</td>
                          <td className="px-4 py-2.5 text-fg font-mono">{rateLimit ? rateLimit.tpm.toLocaleString() : "6,000,000"}</td>
                        </tr>
                        <tr
                          ref={concurrencyTipRef}
                          className="cursor-pointer hover:bg-brand/5 transition-colors"
                          onClick={() => setShowHighTip(true)}
                          onMouseEnter={() => setConcurrencyTipVisible(true)}
                          onMouseLeave={() => setConcurrencyTipVisible(false)}
                        >
                          <td className="px-4 py-2.5 text-fg">
                            <span className="inline-flex items-center gap-1.5">
                              <Zap className="w-3.5 h-3.5 text-brand" />
                              {t("keys.highConcurrency")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-fg font-mono">3,000</td>
                          <td className="px-4 py-2.5 text-fg font-mono">60,000,000</td>
                        </tr>
                        <tr
                          ref={ultraTipRef}
                          className="cursor-pointer hover:bg-violet-50/50 transition-colors"
                          onClick={() => setShowUltraTip(true)}
                          onMouseEnter={() => setUltraTipVisible(true)}
                          onMouseLeave={() => setUltraTipVisible(false)}
                        >
                          <td className="px-4 py-2.5 text-fg">
                            <span className="inline-flex items-center gap-1.5">
                              <Zap className="w-3.5 h-3.5 text-violet-600" />
                              {t("keys.ultraConcurrency")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-fg">{t("keys.unlimited")}</td>
                          <td className="px-4 py-2.5 text-fg">{t("keys.unlimited")}</td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {applyRate && applyRate.remaining < applyRate.limit && (
              <p className="text-[12px] text-fg-muted m-0">
                {t("keys.applyRateHint")
                  .replace("{remaining}", String(applyRate.remaining))
                  .replace("{limit}", String(applyRate.limit))}
              </p>
            )}

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 apiplatform-btn"
              >
                {t("keys.cancel")}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors disabled:opacity-50 apiplatform-btn"
              >
                {loading ? (
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                     {t("keys.submitting")}
                  </span>
                ) : (
                  t("keys.createApiKey")
                )}
              </button>
            </div>
          </form>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** 名称下方截断描述：悬停提示、点击打开查看/编辑。 */
function RequirementDescLine({
  desc,
  canEdit,
  onEdit,
  onView,
}: {
  desc: string;
  canEdit: boolean;
  onEdit: () => void;
  onView: () => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      className="block w-full min-w-0 text-left truncate text-[12px] font-normal text-fg-subtle mt-0.5 hover:text-fg transition-colors cursor-pointer"
      title={canEdit ? t("keys.descClickToEdit") : t("keys.descClickToView")}
      onClick={(e) => {
        e.stopPropagation();
        if (canEdit) onEdit();
        else onView();
      }}
    >
      {desc}
    </button>
  );
}

/** 只读查看完整背景需求（不可编辑时）。 */
function RequirementViewModal({
  rec,
  onClose,
}: {
  rec: UserKeyRow;
  onClose: () => void;
}) {
  const { t } = useT();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="animate-enter bg-card rounded-2xl w-full overflow-hidden" style={{ maxWidth: 520, boxShadow: "var(--shadow-pop)" }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div>
            <h2 className="m-0 font-serif text-[16px] font-medium leading-tight text-fg">{t("keys.requirementViewTitle")}</h2>
            <p className="m-0 mt-0.5 truncate font-serif text-[12px] font-medium leading-tight text-fg" title={rec.name}>{rec.name}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors" aria-label={t("keys.close")}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6">
          <p className="text-[14px] text-fg leading-[1.75] whitespace-pre-wrap m-0">{rec.project_desc}</p>
          <button type="button" onClick={onClose} className="mt-5 w-full px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn">
            {t("keys.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EditKeyModal({
  rec, token, onClose, onSuccess,
}: { rec: UserKeyRow; token: string; onClose: () => void; onSuccess: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(rec.name || "");
  const [desc, setDesc] = useState(rec.project_desc || "");
  const [loading, setLoading] = useState(false);
  const isPending = rec.status === "pending";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const inputCls =
    "w-full px-4 py-3 rounded-xl bg-bg-soft text-[14px] text-fg placeholder:text-fg-subtle outline-none border border-border";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 5) { toast.error(t("keys.nameMin5Chars")); return; }
    if (desc.trim().length < 30) { toast.error(t("keys.descMin30Chars")); return; }
    setLoading(true);
    try {
      await api.userUpdateKey(token, rec.id, { name: name.trim(), project_desc: desc.trim() || null });
      toast.success(isPending ? t("keys.applicationUpdateSuccess") : t("keys.saved"));
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("keys.saveFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function withdrawApplication() {
    setLoading(true);
    try {
      await api.userDeleteKey(token, rec.id);
      toast.success(t("keys.applicationRevoked"));
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("keys.operationFailed"));
      setLoading(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="animate-enter bg-card rounded-2xl w-full overflow-hidden" style={{ maxWidth: 480, boxShadow: "var(--shadow-pop)" }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-bg-soft flex items-center justify-center text-fg">
              <Pencil className="w-4 h-4" />
            </div>
            <div>
              <h2 className="m-0 font-serif text-[16px] font-medium leading-tight text-fg">
                {isPending ? t("keys.editApplication") : t("keys.editApiKey")}
              </h2>
              <p className="text-[12px] text-fg-muted leading-tight mt-0.5 m-0">{t("keys.scenarioAndRequirement")}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors" aria-label={t("keys.close")}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-fg mb-1.5">
              {t("keys.scenario")} <span className="text-danger">*</span>
              <span className="font-normal text-fg-subtle">{t("keys.min5CharsHint")}</span>
            </label>
            <input className={inputCls + " font-serif"} value={name} onChange={(e) => setName(e.target.value)} disabled={loading} placeholder={t("keys.scenarioPlaceholder")} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[13px] font-medium text-fg">
                {t("keys.backgroundRequirement")} <span className="text-danger">*</span>
                <span className="font-normal text-fg-subtle">{t("keys.min30CharsHint")}</span>
              </label>
              <span className="text-[11px] tabular-nums" style={{ color: desc.trim().length >= 30 ? "var(--ok)" : "var(--fg-subtle)" }}>
                {desc.trim().length} / 30
              </span>
            </div>
            <textarea className={inputCls + " resize-none"} value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} disabled={loading} placeholder={t("keys.requirementPlaceholder")} />
          </div>
          <div className="flex gap-2.5 pt-1">
            {isPending ? (
              <>
                <button type="button" onClick={withdrawApplication} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-danger border border-danger/30 hover:bg-danger/5 transition-colors disabled:opacity-40 apiplatform-btn">
                  {t("keys.upgradeWithdraw")}
                </button>
                <button type="submit" disabled={loading || name.trim().length < 5 || desc.trim().length < 30} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors disabled:opacity-50 apiplatform-btn">
                  {loading ? (
                    <span className="inline-flex items-center justify-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("keys.upgradeUpdateSubmitting")}</span>
                  ) : t("keys.upgradeUpdateSubmit")}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 apiplatform-btn">{t("keys.cancel")}</button>
                <button type="submit" disabled={loading || name.trim().length < 5 || desc.trim().length < 30} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors disabled:opacity-50 apiplatform-btn">
                  {loading ? (
                    <span className="inline-flex items-center justify-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("keys.saving")}</span>
                  ) : t("keys.save")}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function DeleteKeyDialog({
  rec, token, onClose, onSuccess,
}: { rec: UserKeyRow; token: string; onClose: () => void; onSuccess: () => void }) {
  const { t } = useT();
  const [loading, setLoading] = useState(false);
  const isPending = rec.status === "pending";
  const isRejected = rec.status === "rejected";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !loading) onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose, loading]);

  async function confirm() {
    setLoading(true);
    try {
      await api.userDeleteKey(token, rec.id);
      toast.success(isRejected ? t("keys.dismissedRejected") : isPending ? t("keys.applicationRevoked") : t("keys.deleted"));
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("keys.operationFailed"));
      setLoading(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="animate-enter w-full max-w-[440px] rounded-2xl bg-card p-6 shadow-pop">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-danger/10 flex items-center justify-center text-danger">
            <Trash2 className="w-4 h-4" />
          </div>
          <h3 className="m-0 font-serif text-[16px] font-medium text-fg">
            {isRejected ? t("keys.dismissRejected") : isPending ? t("keys.revokeApplication") : t("keys.deleteApiKey")}
          </h3>
        </div>
        <div className="space-y-3">
          <SafeHtml
            as="p"
            className="text-[14px] text-fg leading-[1.75] m-0"
            html={
              isRejected
                ? t("keys.dismissRejectedBody").replace("{name}", escapeHtml(rec.name))
                : isPending
                  ? t("keys.confirmRevokeBody").replace("{name}", escapeHtml(rec.name))
                  : t("keys.confirmDeleteBody").replace("{name}", escapeHtml(rec.name))
            }
          />
          {!isPending && !isRejected && (
            <div className="rounded-xl bg-red-50 p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <SafeHtml
                as="p"
                className="text-[12px] text-red-700 leading-relaxed m-0"
                html={t("keys.deleteWarningBody")}
              />
            </div>
          )}
        </div>
        <div className="flex gap-2.5 mt-5">
          <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 apiplatform-btn">{t("keys.cancel")}</button>
          <button type="button" onClick={confirm} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-danger text-primary-foreground hover:bg-danger-hover transition-colors disabled:opacity-50 apiplatform-btn">
            {loading ? (
              <span className="inline-flex items-center justify-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("keys.processing")}</span>
            ) : (isRejected ? t("keys.dismissRejected") : isPending ? t("keys.confirmRevoke") : t("keys.confirmDelete"))}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ApprovedKeyDialog({
  name, apiKey, onClose,
}: { name: string; apiKey: string; onClose: () => void }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [confirmedSaved, setConfirmedSaved] = useState(false);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  function handleCopy() {
    copyToClipboard(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-ink/40 px-4">
      <div className="animate-enter w-full max-w-[460px] rounded-2xl bg-card p-6 shadow-pop">
        <div className="space-y-4">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-lg bg-ok/10 flex items-center justify-center text-ok">
              <KeyRound className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{t("keys.approvedKeyReady")}</h3>
              <p className="m-0 mt-0.5 text-[12px] text-fg-muted truncate" title={name}>{name}</p>
            </div>
          </div>
          <div className="rounded-xl bg-danger/10 p-3 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <SafeHtml
              as="div"
              className="text-[13px] text-fg leading-relaxed m-0"
              html={t("keys.approvedKeyWarning")}
            />
          </div>
          <div className="rounded-xl bg-bg-soft px-4 py-3 font-mono text-[12px] text-fg break-all">{apiKey}</div>
          <button
            type="button"
            onClick={handleCopy}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? t("keys.copied") : t("keys.copyKey")}
          </button>
          <label className="flex items-start gap-2.5 cursor-pointer text-[13px] text-fg">
            <input
              type="checkbox"
              checked={confirmedSaved}
              onChange={(e) => setConfirmedSaved(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border/60 shrink-0"
            />
            <SafeHtml className="leading-snug" html={t("keys.confirmSaved")} />
          </label>
          <button
            type="button"
            onClick={onClose}
            disabled={!confirmedSaved}
            className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed apiplatform-btn"
          >
            {t("keys.done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RegenerateKeyDialog({
  rec, token, onClose, onSuccess,
}: { rec: UserKeyRow; token: string; onClose: () => void; onSuccess: () => void }) {
  const { t } = useT();
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmedSaved, setConfirmedSaved] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !loading) onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose, loading]);

  async function confirm() {
    setLoading(true);
    try {
      const r = await api.userRegenerateKey(token, rec.id);
      setNewKey(r.api_key);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("keys.operationFailed"));
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!newKey) return;
    copyToClipboard(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-ink/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="animate-enter w-full max-w-[460px] rounded-2xl bg-card p-6 shadow-pop">
        {newKey ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2.5 mb-1">
              <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center text-brand">
                <RefreshCw className="w-4 h-4" />
              </div>
              <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{t("keys.rotateSuccess")}</h3>
            </div>
            <div className="rounded-xl bg-danger/10 p-3 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <SafeHtml
                as="div"
                className="text-[13px] text-fg leading-relaxed m-0"
                html={t("keys.rotateNewKeyWarning")}
              />
            </div>
            <div className="rounded-xl bg-bg-soft px-4 py-3 font-mono text-[12px] text-fg break-all">{newKey}</div>
            <button
              type="button"
              onClick={handleCopy}
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:bg-ink/80 transition-colors apiplatform-btn"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? t("keys.copied") : t("keys.copyKey")}
            </button>
            <label className="flex items-start gap-2.5 cursor-pointer text-[13px] text-fg">
              <input
                type="checkbox"
                checked={confirmedSaved}
                onChange={(e) => setConfirmedSaved(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border/60 shrink-0"
              />
              <SafeHtml className="leading-snug" html={t("keys.confirmSaved")} />
            </label>
            <button
              type="button"
              onClick={onClose}
              disabled={!confirmedSaved}
              className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed apiplatform-btn"
            >
              {t("keys.done")}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
                <RefreshCw className="w-4 h-4" />
              </div>
              <h3 className="m-0 font-serif text-[16px] font-medium text-fg">{t("keys.rotateKey")}</h3>
            </div>
            <div className="space-y-3">
              <SafeHtml
                as="p"
                className="text-[14px] text-fg leading-[1.75] m-0"
                html={t("keys.confirmRotateBody").replace("{name}", escapeHtml(rec.name))}
              />
              <div className="rounded-xl bg-amber-50 p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <SafeHtml
                  as="p"
                  className="text-[12px] text-amber-700 leading-relaxed m-0"
                  html={t("keys.rotateWarningBody")}
                />
              </div>
            </div>
            <div className="flex gap-2.5 mt-5">
              <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-fg-muted border border-border hover:bg-bg-soft transition-colors disabled:opacity-40 apiplatform-btn">{t("keys.cancel")}</button>
              <button type="button" onClick={confirm} disabled={loading} className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-ink text-bg hover:opacity-90 transition-colors disabled:opacity-50 apiplatform-btn">
                {loading ? (
                  <span className="inline-flex items-center justify-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("keys.processing")}</span>
                ) : t("keys.confirmRotate")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}


function RecordsView({ authId, token, config, refreshKey }: { authId: string; token: string; config: PlatformConfig | null; refreshKey: number }) {
  const { t } = useT();
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<UserKeyRow[]>([]);
  const [fetched, setFetched] = useState(false);
  const [editing, setEditing] = useState<UserKeyRow | null>(null);
  const [viewingDesc, setViewingDesc] = useState<UserKeyRow | null>(null);
  const [deleting, setDeleting] = useState<UserKeyRow | null>(null);
  const [rotating, setRotating] = useState<UserKeyRow | null>(null);
  const [claimedKeys, setClaimedKeys] = useState<Array<{ id: string; name: string; apiKey: string }>>([]);
  const claimAttemptedRef = useRef(new Set<string>());
  // 高并发升级申请：当前要升级的密钥 + 用户全部申请（用于行内状态角标）
  const [tierChanging, setTierChanging] = useState<UserKeyRow | null>(null);
  const [upgradeView, setUpgradeView] = useState<UpgradeApplicationRow | null>(null);
  const [upgradeApps, setUpgradeApps] = useState<UpgradeApplicationRow[]>([]);

  const fetchRecords = useCallback(async () => {
    if (!authId.trim()) {
      setRecords([]);
      setFetched(true);
      return;
    }
    setLoading(true);
    try {
      const res = await api.userKeys(token);
      let rows = Array.isArray(res.data) ? res.data : [];
      const claimable = rows.filter((row) => row.needs_claim && !claimAttemptedRef.current.has(row.id));
      const newlyClaimed: Array<{ id: string; name: string; apiKey: string }> = [];
      for (const row of claimable) {
        claimAttemptedRef.current.add(row.id);
        try {
          const claimed = await api.userClaimKey(token, row.id);
          newlyClaimed.push({ id: row.id, name: row.name, apiKey: claimed.api_key });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : t("keys.claimFailed"));
        }
      }
      if (newlyClaimed.length > 0) {
        setClaimedKeys((current) => [...current, ...newlyClaimed]);
        const refreshed = await api.userKeys(token);
        rows = Array.isArray(refreshed.data) ? refreshed.data : [];
      }
      setRecords(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("keys.queryFailed"));
      setRecords([]);
    }
    setFetched(true);
    setLoading(false);
  }, [authId, token]);

  useEffect(() => { fetchRecords(); }, [fetchRecords, refreshKey]);

  // 拉取高并发升级申请：失败静默（行内角标查不到就不展示，不打断主列表）
  const fetchUpgradeApps = useCallback(async () => {
    if (!token) { setUpgradeApps([]); return; }
    try {
      const res = await api.upgradeApplications(token);
      setUpgradeApps(Array.isArray(res.data) ? res.data : []);
    } catch { /* 静默 */ }
  }, [token]);

  // 升级申请状态轮询：审批是人工动作，60s 一次 + 切回页面即刷，避免用户等刷新才看到结果
  useEffect(() => {
    if (!token) return;
    fetchUpgradeApps();
    const id = setInterval(fetchUpgradeApps, 60000);
    const onVisible = () => { if (document.visibilityState === "visible") fetchUpgradeApps(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, fetchUpgradeApps, refreshKey]);

  // keyId → 在途 / 已驳回的升级申请（各取最新一条；已通过的不展示角标）
  const { pendingUpgradeByKey, rejectedUpgradeByKey } = useMemo(() => {
    const pending = new Map<string, UpgradeApplicationRow>();
    const rejected = new Map<string, UpgradeApplicationRow>();
    for (const app of upgradeApps) {
      if (!app.keyId) continue;
      if (app.status === "pending" && !pending.has(app.keyId)) pending.set(app.keyId, app);
      if (app.status === "rejected" && !rejected.has(app.keyId)) rejected.set(app.keyId, app);
    }
    return { pendingUpgradeByKey: pending, rejectedUpgradeByKey: rejected };
  }, [upgradeApps]);

  const thClass = "px-5 py-3 text-left text-[13px] font-medium text-fg-muted whitespace-nowrap";
  const tdClass = "px-5 py-4 text-[13px] text-fg align-middle";

  return (
    <>
      <div className="rounded-xl border border-border bg-bg-soft overflow-hidden apiplatform-card-hover">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[640px]">
          <thead>
            <tr className="border-b border-border">
              <th className={thClass}>{t("keys.name")}</th>
              <th className={thClass}>{t("keys.key")}</th>
              <th className={thClass}>{t("keys.createdDate")}</th>
              <th className={thClass}>{t("keys.lastUsedDate")}</th>
              <th className={`${thClass} w-[7.5rem]`} aria-label={t("keys.actions")} />
            </tr>
          </thead>
          <tbody>
            {loading && !fetched && (
              <tr className="bg-card">
                <td colSpan={5} className="px-5 py-16 text-center">
                  <Loader2 className="w-5 h-5 animate-spin text-fg-subtle mx-auto" />
                </td>
              </tr>
            )}
            {fetched && records.length === 0 && (
              <tr className="bg-card">
                <td colSpan={5} className="px-5 py-14 text-center text-[13px] text-fg-muted">
                  {t("keys.noApiKeys")}
                </td>
              </tr>
            )}
            {fetched && records.map((rec) => {
              const isPending = rec.status === "pending";
              const isRejected = rec.status === "rejected";
              const isRevoked = rec.status === "revoked";
              // 仅审批通过且已发放的密钥展示掩码；申请中/已驳回不会有 Key
              const isIssuedKey = rec.status === "active" && !!rec.key_masked;
              const canManageKey = isIssuedKey && !isRevoked;
              const canOpenTier = canManageKey;
              const pendingUpg = pendingUpgradeByKey.get(rec.id) ?? null;
              const rejectedUpg = !pendingUpg ? (rejectedUpgradeByKey.get(rec.id) ?? null) : null;
              const upgradePending = !!pendingUpg;
              const upgradeRejected = !!rejectedUpg;
              const canRotate = canManageKey;
              const canEdit = canManageKey || isPending;
              const tierVis = keyTierDisplay(rec.tier, t);
              const disabledActionHint = rowActionDisabledHint(rec.status ?? "", t);

              const upgradeBtnTitle = canOpenTier
                ? upgradePending
                  ? `${tierVis.label} · ${t("keys.tierEditPendingHint")}`
                  : upgradeRejected
                    ? `${tierVis.label} · ${t("keys.upgradeRejectedHintShort")}`
                    : `${tierVis.label} · ${t("keys.tierChangeHint")}`
                : disabledActionHint;
              const rotateBtnTitle = canRotate ? t("keys.rotateKey") : disabledActionHint;
              const editBtnTitle = canEdit ? t("keys.edit") : disabledActionHint;
              const deleteBtnTitle = isRejected
                ? t("keys.dismissRejected")
                : isPending
                  ? t("keys.revokeApplication")
                  : t("keys.delete");

              return (
                <tr key={rec.id} className="bg-card border-t border-border hover:bg-card-hover transition-colors">
                  <td className={`${tdClass} font-medium text-fg max-w-[240px]`}>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="block truncate font-serif font-medium" title={rec.name}>{rec.name}</span>
                        {isRejected && rec.note ? (
                          <span className="block truncate text-[12px] font-normal text-danger mt-0.5" title={rec.note}>
                            {t("keys.rejectionReason")}{rec.note}
                          </span>
                        ) : rec.project_desc && (
                          <RequirementDescLine
                            desc={rec.project_desc}
                            canEdit={canEdit}
                            onEdit={() => setEditing(rec)}
                            onView={() => setViewingDesc(rec)}
                          />
                        )}
                      </div>
                    </div>
                  </td>
                  <td className={`${tdClass} max-w-[280px]`}>
                    {isIssuedKey ? (
                      <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full" title={rec.key_masked || undefined}>
                        <Check className="w-3.5 h-3.5 text-ok shrink-0" strokeWidth={3} />
                        <span className="font-mono text-[13px] text-fg truncate">{rec.key_masked}</span>
                      </span>
                    ) : isPending ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                        <Clock className="w-3 h-3" />
                        {t("keys.pendingApproval")}
                      </span>
                    ) : isRejected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                        <X className="w-3 h-3" />
                        {t("keys.applicationRejected")}
                      </span>
                    ) : isRevoked ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger" title={t("keys.revokedKeyHint")}>
                        <PowerOff className="w-3 h-3" />
                        {t("keys.keyRevoked")}
                      </span>
                    ) : (
                      <span className="text-fg-muted">—</span>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>{formatDate(rec.created_at)}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {isPending || isRejected ? "—" : formatDate(rec.last_used_at)}
                  </td>
                  <td className={`${tdClass} text-right whitespace-nowrap`}>
                    <div className="inline-flex items-center gap-1">
                      <RowActionButton
                        enabled={canOpenTier}
                        title={upgradeBtnTitle}
                        hoverCls="hover:text-brand hover:bg-brand/10"
                        enabledCls={`relative ${ROW_ACTION_BASE} ${tierVis.actionCls} apiplatform-hover-scale cursor-pointer`}
                        onClick={() => setTierChanging(rec)}
                      >
                        <Zap className="w-4 h-4" />
                        {canOpenTier && upgradePending && (
                          <Clock className="absolute -top-0.5 -right-0.5 w-3 h-3 text-amber-600 bg-card rounded-full" />
                        )}
                        {canOpenTier && upgradeRejected && (
                          <X className="absolute -top-0.5 -right-0.5 w-3 h-3 text-danger bg-card rounded-full" />
                        )}
                      </RowActionButton>
                      <RowActionButton
                        enabled={canRotate}
                        title={rotateBtnTitle}
                        hoverCls="hover:text-amber-600 hover:bg-amber-50"
                        onClick={() => setRotating(rec)}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </RowActionButton>
                      <RowActionButton
                        enabled={canEdit}
                        title={editBtnTitle}
                        hoverCls="hover:text-ink hover:bg-ink/5"
                        onClick={() => setEditing(rec)}
                      >
                        <Pencil className="w-4 h-4" />
                      </RowActionButton>
                      <RowActionButton
                        enabled
                        title={deleteBtnTitle}
                        hoverCls="hover:text-danger hover:bg-danger/10"
                        onClick={() => setDeleting(rec)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </RowActionButton>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && (
        <EditKeyModal
          rec={editing}
          token={token}
          onClose={() => setEditing(null)}
          onSuccess={fetchRecords}
        />
      )}
      {viewingDesc && (
        <RequirementViewModal
          rec={viewingDesc}
          onClose={() => setViewingDesc(null)}
        />
      )}
      {deleting && (
        <DeleteKeyDialog
          rec={deleting}
          token={token}
          onClose={() => setDeleting(null)}
          onSuccess={fetchRecords}
        />
      )}
      {rotating && (
        <RegenerateKeyDialog
          rec={rotating}
          token={token}
          onClose={() => setRotating(null)}
          onSuccess={fetchRecords}
        />
      )}
      {claimedKeys[0] && (
        <ApprovedKeyDialog
          name={claimedKeys[0].name}
          apiKey={claimedKeys[0].apiKey}
          onClose={() => setClaimedKeys((current) => current.slice(1))}
        />
      )}
      {tierChanging && (
        <TierChangeModal
          rec={tierChanging}
          token={token}
          config={config}
          pendingApp={pendingUpgradeByKey.get(tierChanging.id) ?? null}
          rejectedApp={pendingUpgradeByKey.has(tierChanging.id) ? null : (rejectedUpgradeByKey.get(tierChanging.id) ?? null)}
          onClose={() => setTierChanging(null)}
          onSuccess={() => { fetchRecords(); fetchUpgradeApps(); }}
          onViewStatus={(app) => setUpgradeView(app)}
        />
      )}
      {upgradeView && (
        <UpgradeStatusModal
          app={upgradeView}
          onClose={() => setUpgradeView(null)}
        />
      )}
    </div>
    </>
  );
}

export function ApplyKeys() {
  const { t } = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const { authId, token } = useAuth();
  const [showCreateModal, setShowCreateModal] = useState(searchParams.get("mode") === "apply");
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [applyRate, setApplyRate] = useState<{ limit: number; used: number; remaining: number; resets_in: number } | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  const fetchApplyRate = useCallback(() => {
    if (!token) return;
    api.applyRateInfo(token).then(setApplyRate).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (showCreateModal && token) fetchApplyRate();
  }, [showCreateModal, token, fetchApplyRate]);

  useEffect(() => {
    if (searchParams.get("mode") === "apply") {
      setShowCreateModal(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <>
      <div className="animate-enter w-full max-w-[960px] mx-auto space-y-6">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>API keys</h1>
          {/* 统一描述：列表说明 + 密钥安全须知（始终可见） */}
          <p className="mt-3 text-[14px] text-fg leading-[1.75] m-0">
            {t("keys.pageDescription")}
            <SafeHtml
              className="block mt-2 text-[14px] text-fg leading-[1.75]"
              html={t("keys.securityNotice")}
            />
          </p>
        </div>

        <RecordsView authId={authId} token={token} config={config} refreshKey={recordsRefreshKey} />

        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center px-5 py-2.5 rounded-lg bg-ink text-bg text-[13px] font-medium hover:bg-ink/80 transition-colors apiplatform-btn"
        >
          {t("keys.createApiKey")}
        </button>
      </div>

      <CreateKeyModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={() => { setRecordsRefreshKey((k) => k + 1); fetchApplyRate(); }}
        token={token}
        authId={authId}
        config={config}
        applyRate={applyRate}
      />

    </>
  );
}
