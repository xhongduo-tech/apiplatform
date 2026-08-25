import { useCallback, useEffect, useState } from "react";
import { Loader2, Download, BarChart3, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { API_BASE, authHeaders, requireOk } from "./admin-tab-utils";
import { useT } from "../i18n";

interface Baseline {
  initial_calls: number;
  initial_tokens: number;
  initial_cost: number;
  source_env_calls?: number;
  source_env_tokens?: number;
  source_env_cost?: number;
}

function fmtNum(n: number) {
  return n.toLocaleString("zh-CN");
}

function fmtCost(n: number) {
  return `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseNonNegInt(raw: string) {
  return Math.max(0, parseInt(raw.replace(/,/g, ""), 10) || 0);
}

function parseNonNegFloat(raw: string) {
  const v = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

export default function MigrationTab({ token }: { token: string }) {
  const { t } = useT();
  const [backingUp, setBackingUp] = useState(false);

  // 默认只下载受限字段的脱敏 CSV 包；原始灾备快照不通过常规 UI 分发。
  const downloadBackup = async () => {
    setBackingUp(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/backup/export`, { headers: authHeaders(token) });
      await requireOk(res, t("admin.migration.backup.toast.failed"));
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const name = cd.match(/filename="?([^";]+)"?/)?.[1]
        || `platform_sanitized_export_${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("admin.migration.backup.toast.success"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.migration.backup.toast.networkError"));
    }
    setBackingUp(false);
  };

  const [baseline, setBaseline] = useState<Baseline>({ initial_calls: 0, initial_tokens: 0, initial_cost: 0 });
  const [callsInput, setCallsInput] = useState("");
  const [tokensInput, setTokensInput] = useState("");
  const [costInput, setCostInput] = useState("");
  const [baselineLoading, setBaselineLoading] = useState(true);
  const [baselineSaving, setBaselineSaving] = useState(false);

  const loadBaseline = useCallback(async () => {
    setBaselineLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/migration/baseline`, { headers: authHeaders(token) });
      if (res.ok) {
        const data = await res.json();
        setBaseline(data);
        setCallsInput(String(data.initial_calls ?? 0));
        setTokensInput(String(data.initial_tokens ?? 0));
        setCostInput(String(data.initial_cost ?? 0));
      }
    } catch {
      toast.error(t("admin.migration.baseline.toast.loadFailed"));
    }
    setBaselineLoading(false);
  }, [token, t]);

  useEffect(() => { loadBaseline(); }, [loadBaseline]);

  const saveBaseline = async () => {
    const initial_calls = parseNonNegInt(callsInput);
    const initial_tokens = parseNonNegInt(tokensInput);
    const initial_cost = parseNonNegFloat(costInput);
    setBaselineSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/migration/baseline`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ initial_calls, initial_tokens, initial_cost }),
      });
      if (res.ok) {
        const data = await res.json();
        setBaseline(data);
        toast.success(t("admin.migration.baseline.toast.saved"));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("admin.migration.baseline.toast.saveFailed"));
      }
    } catch {
      toast.error(t("admin.migration.baseline.toast.saveFailed"));
    }
    setBaselineSaving(false);
  };

  return (
    <div className="space-y-6">
      {/* 累计基准数据 */}
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-serif text-[15px] font-medium text-foreground">{t("admin.migration.baseline.title")}</h2>
        </div>
        <p className="mb-4 text-[13px] text-muted-foreground">
          {t("admin.migration.baseline.desc")}
        </p>
        {baselineLoading ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-[12px] text-muted-foreground">{t("admin.migration.baseline.callsLabel")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={callsInput}
                  onChange={(e) => setCallsInput(e.target.value)}
                  placeholder={t("admin.migration.baseline.callsPlaceholder")}
                  className="mt-1.5 w-full rounded-xl border border-border/40 bg-background px-4 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
              </label>
              <label className="block">
                <span className="text-[12px] text-muted-foreground">{t("admin.migration.baseline.tokensLabel")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={tokensInput}
                  onChange={(e) => setTokensInput(e.target.value)}
                  placeholder={t("admin.migration.baseline.tokensPlaceholder")}
                  className="mt-1.5 w-full rounded-xl border border-border/40 bg-background px-4 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
              </label>
              <label className="block">
                <span className="text-[12px] text-muted-foreground">{t("admin.migration.baseline.costLabel")}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                  placeholder={t("admin.migration.baseline.costPlaceholder")}
                  className="mt-1.5 w-full rounded-xl border border-border/40 bg-background px-4 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
              </label>
            </div>
            <p className="mt-3 text-[12px] text-muted-foreground">
              {t("admin.migration.baseline.current", {
                calls: fmtNum(baseline.initial_calls),
                tokens: fmtNum(baseline.initial_tokens),
                cost: fmtCost(baseline.initial_cost ?? 0),
              })}
            </p>
            <button
              type="button"
              disabled={baselineSaving}
              onClick={saveBaseline}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {baselineSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("admin.migration.baseline.saveBtn")}
            </button>
          </>
        )}
      </section>

      {/* 默认导出脱敏迁移包；包内仍含不可公开分享的业务/个人数据。 */}
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Download className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-serif text-[15px] font-medium text-foreground">{t("admin.migration.backup.title")}</h2>
        </div>
        <p className="mb-4 text-[13px] text-muted-foreground">
          {t("admin.migration.backup.desc")}
        </p>
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-[12px] leading-relaxed text-foreground">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>{t("admin.migration.backup.sensitiveWarning")}</span>
        </div>
        <button
          type="button"
          disabled={backingUp}
          onClick={downloadBackup}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {backingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {backingUp ? t("admin.migration.backup.exporting") : t("admin.migration.backup.downloadBtn")}
        </button>
      </section>
    </div>
  );
}
