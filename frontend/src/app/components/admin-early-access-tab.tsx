import { useState, useEffect, useCallback } from "react";
import { Loader2, Check, X, Undo2, ChevronLeft, ChevronRight } from "lucide-react";
import { EarlyAccessIcon } from "./early-access-icon";
import { toast } from "sonner";
import { api, type AdminEarlyAccessRow } from "../api/gateway";
import { fmtTime, ModalPortal } from "./admin-tab-utils";
import { useT } from "../i18n";

/**
 * 抢先体验计划审批。
 *
 * 授权是**用户维度**的（一个账号 ID 一行），不是按模型逐个勾选——计划内有哪些
 * 模型由模型管理里的运营状态决定（status=抢先体验计划），这里只决定"谁能用"。
 * 审批结果落库后后端会清空网关鉴权缓存，无需等待，用户即刻生效。
 *
 * 驳回/撤销必须写理由：用户端只能看到这条备注，不写就等于让人不明不白被拒。
 */

const STATUS_CLS: Record<AdminEarlyAccessRow["status"], string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-gray-100 text-gray-500",
  revoked: "bg-amber-100 text-amber-700",
};

const FILTER_KEYS = ["", "pending", "approved", "rejected", "revoked"] as const;

const PAGE_SIZE = 20;

type ReviewAction = "approve" | "reject" | "revoke";

export default function EarlyAccessTab({ token }: { token: string }) {
  const { t } = useT();

  function statusLabel(s: AdminEarlyAccessRow["status"]) {
    const map: Record<AdminEarlyAccessRow["status"], string> = {
      pending: t("admin.earlyAccess.status.pending"),
      approved: t("admin.earlyAccess.status.approved"),
      rejected: t("admin.earlyAccess.status.rejected"),
      revoked: t("admin.earlyAccess.status.revoked"),
    };
    return map[s];
  }

  function filterLabel(k: string) {
    if (k === "") return t("admin.earlyAccess.filter.all");
    return statusLabel(k as AdminEarlyAccessRow["status"]);
  }

  const [rows, setRows] = useState<AdminEarlyAccessRow[]>([]);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [approvedTotal, setApprovedTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<{ row: AdminEarlyAccessRow; action: ReviewAction } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.adminEarlyAccessList(token, { limit: PAGE_SIZE, offset, status: filter || undefined });
      setRows(d.data ?? []);
      setModels(d.models ?? []);
      setTotal(d.total ?? 0);
      setPendingTotal(d.pendingTotal ?? 0);
      setApprovedTotal(d.approvedTotal ?? 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.loadFailed"));
    }
    setLoading(false);
  }, [token, offset, filter]);

  useEffect(() => { load(); }, [load]);

  async function runReview(row: AdminEarlyAccessRow, action: ReviewAction, note?: string) {
    setBusy(row.id);
    try {
      await api.adminEarlyAccessReview(token, row.id, action, note);
      toast.success(
        action === "approve" ? t("admin.earlyAccess.toast.approved", { name: row.name })
          : action === "revoke" ? t("admin.earlyAccess.toast.revoked", { name: row.name })
            : t("admin.earlyAccess.toast.rejected", { name: row.name }),
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    }
    setBusy(null);
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-muted-foreground">
          {t("admin.earlyAccess.stats", { pendingTotal, approvedTotal })}
        </span>
        <div className="flex items-center gap-1">
          {FILTER_KEYS.map((key) => (
            <button
              key={key || "all"}
              type="button"
              onClick={() => { setFilter(key); setOffset(0); }}
              className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
                filter === key
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {filterLabel(key)}
            </button>
          ))}
        </div>
      </div>

      {/* 计划内模型：审批的是"谁能用"，能用什么在模型管理里配 */}
      <div className="rounded-2xl bg-card px-5 py-4 shadow-sm">
        <div className="flex items-center gap-2 font-serif text-[13px] font-medium text-foreground">
          <EarlyAccessIcon className="h-4 w-4 text-primary" />
          {t("admin.earlyAccess.includedModels")}
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {t("admin.earlyAccess.includedModelsDesc")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {models.length === 0 ? (
            <span className="text-[12px] text-muted-foreground/60">{t("admin.earlyAccess.noEarlyAccessModels")}</span>
          ) : (
            models.map((m) => (
              <span key={m.id} className="rounded-lg border border-border bg-secondary/40 px-2.5 py-1 text-[12px]">
                <span className="font-serif">{m.name}</span> <code className="ml-1 font-mono text-[11px] text-muted-foreground">{m.id}</code>
              </span>
            ))
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-[13px] text-muted-foreground/50">
          {filter ? t("admin.earlyAccess.empty.filtered") : t("admin.earlyAccess.empty.all")}
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-card shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border/40 bg-secondary/40">
                    <Th>{t("admin.earlyAccess.th.authId")}</Th>
                    <Th>{t("admin.earlyAccess.th.name")}</Th>
                    <Th>{t("admin.earlyAccess.th.department")}</Th>
                    <Th>{t("admin.earlyAccess.th.status")}</Th>
                    <Th>{t("admin.earlyAccess.th.submittedAt")}</Th>
                    <Th>{t("admin.earlyAccess.th.reviewedAt")}</Th>
                    <Th>{t("admin.earlyAccess.th.note")}</Th>
                    <Th>{t("admin.earlyAccess.th.actions")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const cls = STATUS_CLS[r.status];
                    const working = busy === r.id;
                    return (
                      <tr key={r.id} className="border-b border-border/20 transition-colors hover:bg-secondary/20">
                        <td className="px-4 py-3 font-mono text-[12px] font-medium">{r.authId}</td>
                        <td className="px-4 py-3 font-serif font-medium">{r.name || "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{r.department || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-medium ${cls}`}>
                            {statusLabel(r.status)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {r.submittedAt ? fmtTime(r.submittedAt) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {r.reviewedAt ? fmtTime(r.reviewedAt) : "—"}
                        </td>
                        <td className="max-w-[220px] truncate px-4 py-3 text-muted-foreground" title={r.note || ""}>
                          {r.note || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {working && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                            {!working && r.status === "pending" && (
                              <>
                                <ActionBtn onClick={() => runReview(r, "approve")} tone="ok">
                                  <Check className="h-3.5 w-3.5" /> {t("admin.earlyAccess.action.approve")}
                                </ActionBtn>
                                <ActionBtn onClick={() => setReviewing({ row: r, action: "reject" })} tone="muted">
                                  <X className="h-3.5 w-3.5" /> {t("admin.earlyAccess.action.reject")}
                                </ActionBtn>
                              </>
                            )}
                            {!working && r.status === "approved" && (
                              <ActionBtn onClick={() => setReviewing({ row: r, action: "revoke" })} tone="muted">
                                <Undo2 className="h-3.5 w-3.5" /> {t("admin.earlyAccess.action.revoke")}
                              </ActionBtn>
                            )}
                            {!working && (r.status === "rejected" || r.status === "revoked") && (
                              <ActionBtn onClick={() => runReview(r, "approve")} tone="ok">
                                <Check className="h-3.5 w-3.5" /> {t("admin.earlyAccess.action.changeToApproved")}
                              </ActionBtn>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between text-[12px] text-muted-foreground">
            <span>{t("admin.earlyAccess.pagination", { start: pageStart, end: pageEnd, total })}</span>
            <div className="flex items-center gap-1">
              <PageBtn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft className="h-3.5 w-3.5" /> {t("admin.earlyAccess.prevPage")}
              </PageBtn>
              <PageBtn disabled={pageEnd >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                {t("admin.earlyAccess.nextPage")} <ChevronRight className="h-3.5 w-3.5" />
              </PageBtn>
            </div>
          </div>
        </>
      )}

      <ReviewNoteDialog
        pending={reviewing}
        onCancel={() => setReviewing(null)}
        onConfirm={(note) => {
          const r = reviewing!;
          setReviewing(null);
          runReview(r.row, r.action, note);
        }}
      />
    </div>
  );
}

/** 驳回/撤销必填理由——这条备注是用户端唯一能看到的解释。 */
function ReviewNoteDialog({
  pending, onCancel, onConfirm,
}: {
  pending: { row: AdminEarlyAccessRow; action: ReviewAction } | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const { t } = useT();
  const [note, setNote] = useState("");
  useEffect(() => { setNote(""); }, [pending]);
  if (!pending) return null;

  const isRevoke = pending.action === "revoke";
  const title = isRevoke
    ? t("admin.earlyAccess.modal.revokeTitle")
    : t("admin.earlyAccess.modal.rejectTitle");
  const hint = isRevoke
    ? t("admin.earlyAccess.modal.revokeHint", { name: pending.row.name, authId: pending.row.authId })
    : t("admin.earlyAccess.modal.rejectHint", { name: pending.row.name, authId: pending.row.authId });

  return (
    <ModalPortal open onClose={onCancel}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-lg">
        <h3 className="font-serif text-[15px] font-medium text-foreground">{title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{hint}</p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          autoFocus
          placeholder={isRevoke
            ? t("admin.earlyAccess.modal.revokePlaceholder")
            : t("admin.earlyAccess.modal.rejectPlaceholder")}
          className="mt-4 w-full resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/15"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!note.trim()}
            onClick={() => onConfirm(note.trim())}
            className="rounded-xl bg-primary px-4 py-2 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 apiplatform-btn"
          >
            {isRevoke ? t("admin.earlyAccess.confirmRevoke") : t("admin.earlyAccess.confirmReject")}
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground">{children}</th>;
}

function PageBtn({
  children, disabled, onClick,
}: { children: React.ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-0.5 rounded-lg px-2.5 py-1 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ActionBtn({
  children, onClick, tone,
}: { children: React.ReactNode; onClick: () => void; tone: "ok" | "muted" }) {
  const cls = tone === "ok"
    ? "text-green-700 hover:bg-green-50 dark:hover:bg-green-950/30"
    : "text-muted-foreground hover:bg-secondary hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition-colors ${cls}`}
    >
      {children}
    </button>
  );
}
