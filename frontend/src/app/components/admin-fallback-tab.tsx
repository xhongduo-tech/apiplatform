import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { API_BASE, authHeaders } from "./admin-tab-utils";
import { PageHeader } from "./ui/page-header";
import { useT } from "../i18n";
import { categoryLabels } from "./model-data";

type CircuitState = { open: boolean; remaining_s: number; trips: number };

type ModelCandidate = {
  modelId: string;
  modelName: string;
  category: string;
  status: string;
  selected?: boolean;
  circuit: CircuitState | null;
};

type FallbackPolicy = {
  enabled: boolean;
  targetModelId: string | null;
  sourceModelIds: string[];
  circuitEnabled: boolean;
  tripFails: number;
  tripRate: number;
  windowS: number;
  cooldownS: number;
  maxCooldownS: number;
  forced: boolean;
  updatedAt?: string;
  candidates: ModelCandidate[];
  targetCandidates: ModelCandidate[];
};

type FallbackLog = {
  id: string;
  requestId: string | null;
  apiKeyId: string;
  modelId: string;
  fallbackFrom: string | null;
  fallbackTrigger: string | null;
  statusCode: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  errorDetail: string | null;
  createdAt: string;
};

const defaultForm = {
  enabled: false,
  targetModelId: "",
  sourceModelIds: [] as string[],
  circuitEnabled: false,
  tripFails: 5,
  tripRate: 0.5,
  windowS: 60,
  cooldownS: 120,
  maxCooldownS: 1800,
  forced: false,
};

function formFromPolicy(data: FallbackPolicy) {
  return {
    enabled: Boolean(data.enabled),
    targetModelId: data.targetModelId || "",
    sourceModelIds: data.sourceModelIds || [],
    circuitEnabled: Boolean(data.circuitEnabled),
    tripFails: data.tripFails ?? 5,
    tripRate: data.tripRate ?? 0.5,
    windowS: data.windowS ?? 60,
    cooldownS: data.cooldownS ?? 120,
    maxCooldownS: data.maxCooldownS ?? 1800,
    forced: Boolean(data.forced),
  };
}

export default function FallbackTab({ token }: { token: string }) {
  const { t } = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [candidates, setCandidates] = useState<ModelCandidate[]>([]);
  const [targetCandidates, setTargetCandidates] = useState<ModelCandidate[]>([]);
  const [form, setForm] = useState(defaultForm);
  /** 启用后展开的配置区；保存成功后收起，避免整块内容一直撑开 */
  const [configOpen, setConfigOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [logs, setLogs] = useState<FallbackLog[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logTrigger, setLogTrigger] = useState<"circuit" | "retry" | "all">("circuit");

  const inputClass = "w-full px-4 py-3 rounded-xl bg-bg-soft text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15 border border-border/40 transition-all";

  /** 完整加载（含表单）：仅首屏与保存/恢复后调用，避免轮询覆盖用户未保存的勾选。 */
  const loadPolicy = useCallback(async (opts?: { collapse?: boolean }) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/fallback/policy`, { headers: authHeaders(token) });
      if (!res.ok) throw new Error(String(res.status));
      const data: FallbackPolicy = await res.json();
      setForm(formFromPolicy(data));
      if (opts?.collapse) {
        // 保存后收起启用展开的全部内容（目标模型 / 源模型 / 高级参数）
        setConfigOpen(false);
        setAdvancedOpen(false);
      } else {
        setConfigOpen(Boolean(data.enabled));
        setAdvancedOpen(Boolean(data.circuitEnabled) || Boolean(data.forced));
      }
      setCandidates(data.candidates || []);
      setTargetCandidates(data.targetCandidates || []);
    } catch {
      toast.error(t("admin.fallback.toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  /** 轻量刷新：只更新候选列表与熔断态，不动表单草稿。 */
  const refreshMeta = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/fallback/policy`, { headers: authHeaders(token) });
      if (!res.ok) return;
      const data: FallbackPolicy = await res.json();
      setCandidates(data.candidates || []);
      setTargetCandidates(data.targetCandidates || []);
    } catch { /* silent */ }
  }, [token]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const qs = new URLSearchParams({ trigger: logTrigger, limit: "50", offset: "0" });
      const res = await fetch(`${API_BASE}/api/admin/fallback/logs?${qs}`, { headers: authHeaders(token) });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setLogs(body.data ?? []);
      setLogsTotal(body.total ?? 0);
    } catch {
      toast.error(t("admin.fallback.toast.logsFailed"));
    } finally {
      setLogsLoading(false);
    }
  }, [token, logTrigger, t]);

  useEffect(() => {
    loadPolicy();
    const id = setInterval(refreshMeta, 15000);
    return () => clearInterval(id);
  }, [loadPolicy, refreshMeta]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const selectableSources = useMemo(() => {
    if (!form.targetModelId) return [];
    // 全部可兜底的大语言模型（排除 embedding/reranker/ocr 等），不限同类别
    return candidates.filter((m) => m.modelId !== form.targetModelId);
  }, [candidates, form.targetModelId]);

  const activeSources = useMemo(
    () => candidates.filter((m) => form.sourceModelIds.includes(m.modelId)),
    [candidates, form.sourceModelIds],
  );

  const toggleSource = (modelId: string) => {
    setForm((f) => ({
      ...f,
      sourceModelIds: f.sourceModelIds.includes(modelId)
        ? f.sourceModelIds.filter((id) => id !== modelId)
        : [...f.sourceModelIds, modelId],
    }));
  };

  const allSelectableIds = useMemo(
    () => selectableSources.map((m) => m.modelId),
    [selectableSources],
  );
  const allSourcesSelected =
    allSelectableIds.length > 0
    && allSelectableIds.every((id) => form.sourceModelIds.includes(id));

  const toggleSelectAllSources = () => {
    setForm((f) => ({
      ...f,
      sourceModelIds: allSourcesSelected ? [] : allSelectableIds,
    }));
  };

  const onTargetChange = (targetModelId: string) => {
    setForm((f) => ({
      ...f,
      targetModelId,
      sourceModelIds: f.sourceModelIds.filter((id) => id !== targetModelId),
    }));
  };

  const savePolicy = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/fallback/policy`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(form.enabled ? form : { ...form, enabled: false, sourceModelIds: [] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(t("admin.fallback.toast.saveFailed", { detail: err?.detail || String(res.status) }));
        return;
      }
      toast.success(t("admin.fallback.toast.saved"));
      await loadPolicy({ collapse: true });
    } catch {
      toast.error(t("admin.fallback.toast.saveNetworkError"));
    } finally {
      setSaving(false);
    }
  };

  const forceRecover = async (modelId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/models/${modelId}/circuit/close`, {
        method: "POST",
        headers: authHeaders(token),
      });
      if (!res.ok) {
        toast.error(t("admin.models.toast.forceRecoverFailed"));
        return;
      }
      toast.success(t("admin.models.toast.recovered", { id: modelId }));
      await loadPolicy();
    } catch {
      toast.error(t("admin.models.toast.forceRecoverNetworkError"));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("admin.fallback.title")}
        description={t("admin.fallback.desc")}
        subline={t("admin.fallback.summaryUnified", {
          enabled: form.enabled ? form.sourceModelIds.length : 0,
          total: selectableSources.length,
        })}
      />

      <div className="bg-card rounded-2xl shadow-sm p-6 space-y-5">
        <div>
          <h2 className="font-serif text-[15px] font-medium text-foreground">{t("admin.fallback.policiesTitle")}</h2>
          <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{t("admin.fallback.policiesHintUnified")}</p>
        </div>

        <div className="flex items-start justify-between gap-3">
          <label className="flex items-start gap-2.5 cursor-pointer min-w-0">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => {
                const on = e.target.checked;
                setForm((f) => ({ ...f, enabled: on }));
                setConfigOpen(on);
                if (!on) setAdvancedOpen(false);
              }}
              className="mt-0.5 accent-primary"
            />
            <span>
              <span className="text-[13px] font-medium block">{t("admin.models.fallback.enable")}</span>
              <span className="text-[11px] text-muted-foreground leading-relaxed">{t("admin.models.fallback.enableDesc")}</span>
            </span>
          </label>
          {form.enabled && !configOpen && (
            <button
              type="button"
              onClick={() => setConfigOpen(true)}
              className="shrink-0 text-[12px] font-medium text-primary hover:underline"
            >
              {t("admin.fallback.expandConfig")}
            </button>
          )}
        </div>

        {form.enabled && configOpen && (
          <div className="space-y-5 pl-6 border-l-2 border-border/40">
            <div>
              <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.fallback.targetModel")}</label>
              <select
                value={form.targetModelId}
                onChange={(e) => onTargetChange(e.target.value)}
                className={inputClass}
              >
                <option value="">{t("admin.models.fallback.selectModel")}</option>
                {targetCandidates.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.modelName || m.modelId} ({m.modelId})
                  </option>
                ))}
              </select>
            </div>

            {form.targetModelId && (
              <div>
                <div className="flex items-center justify-between gap-3 mb-2">
                  <label className="text-[12px] text-muted-foreground">{t("admin.fallback.sourceModels")}</label>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {t("admin.fallback.sourceSelected", { n: form.sourceModelIds.length })}
                    </span>
                    {selectableSources.length > 0 && (
                      <button
                        type="button"
                        onClick={toggleSelectAllSources}
                        className="text-[11px] font-medium text-primary hover:underline"
                      >
                        {allSourcesSelected
                          ? t("admin.fallback.sourceClearAll")
                          : t("admin.fallback.sourceSelectAll")}
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">{t("admin.fallback.sourceModelsHint")}</p>
                <div className="rounded-xl border border-border/40 divide-y divide-border/30 max-h-64 overflow-y-auto">
                  {selectableSources.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">{t("admin.fallback.noSourceModels")}</div>
                  ) : selectableSources.map((m) => {
                    const checked = form.sourceModelIds.includes(m.modelId);
                    return (
                      <label
                        key={m.modelId}
                        className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-secondary/30 ${checked ? "bg-secondary/20" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSource(m.modelId)}
                          className="accent-primary"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-serif text-[13px] font-medium">{m.modelName || m.modelId}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{m.modelId}</div>
                        </div>
                        <span className="text-[10px] bg-secondary px-2 py-0.5 rounded shrink-0">
                          {categoryLabels[m.category as keyof typeof categoryLabels] || m.category}
                        </span>
                        {m.circuit && (
                          <span className="text-[10px] text-amber-700 shrink-0">{t("admin.fallback.status.tripped")}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-xl border border-border/40 overflow-hidden">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
              >
                <span>
                  <span className="text-[13px] font-medium block">{t("admin.fallback.advanced.title")}</span>
                  <span className="text-[11px] text-muted-foreground">{t("admin.fallback.advanced.hint")}</span>
                </span>
                <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </button>
              {advancedOpen && (
                <div className="px-4 pb-4 pt-1 space-y-4 border-t border-border/30">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.circuitEnabled}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        circuitEnabled: e.target.checked,
                        forced: e.target.checked ? f.forced : false,
                      }))}
                      className="mt-0.5 accent-primary"
                    />
                    <span>
                      <span className="text-[13px] font-medium block">{t("admin.fallback.circuitEnable")}</span>
                      <span className="text-[11px] text-muted-foreground leading-relaxed">{t("admin.fallback.circuitEnableDesc")}</span>
                    </span>
                  </label>
                  {form.circuitEnabled && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.fallback.tripFails")}</label>
                          <input type="number" min={1} value={form.tripFails} onChange={(e) => setForm((f) => ({ ...f, tripFails: Number(e.target.value) }))} className={inputClass} />
                        </div>
                        <div>
                          <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.fallback.tripRate")}</label>
                          <input type="number" min={0} max={1} step={0.05} value={form.tripRate} onChange={(e) => setForm((f) => ({ ...f, tripRate: Number(e.target.value) }))} className={inputClass} />
                        </div>
                        <div>
                          <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.fallback.windowS")}</label>
                          <input type="number" min={1} value={form.windowS} onChange={(e) => setForm((f) => ({ ...f, windowS: Number(e.target.value) }))} className={inputClass} />
                        </div>
                        <div>
                          <label className="text-[12px] text-muted-foreground block mb-1.5">{t("admin.models.fallback.cooldownS")}</label>
                          <input type="number" min={1} value={form.cooldownS} onChange={(e) => setForm((f) => ({ ...f, cooldownS: Number(e.target.value) }))} className={inputClass} />
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{t("admin.models.fallback.policyDesc", { cooldownMin: Math.round(form.maxCooldownS / 60) })}</p>
                      <label className="flex items-start gap-2.5 cursor-pointer">
                        <input type="checkbox" checked={form.forced} onChange={(e) => setForm((f) => ({ ...f, forced: e.target.checked }))} className="mt-0.5 accent-primary" />
                        <span>
                          <span className="text-[13px] block">{t("admin.models.fallback.forced")}</span>
                          <span className="text-[11px] text-muted-foreground">{t("admin.models.fallback.forcedDesc")}</span>
                        </span>
                      </label>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={savePolicy}
            disabled={saving}
            className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-[13px] disabled:opacity-50"
          >
            {saving ? t("keys.saving") : t("keys.save")}
          </button>
        </div>
      </div>

      {form.enabled && activeSources.length > 0 && (
        <div className="bg-card rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-border/40 bg-secondary/30">
            <h2 className="font-serif text-[13px] font-medium text-foreground">{t("admin.fallback.monitorTitle")}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/40 bg-secondary/40">
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.col.source")}</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.col.status")}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-muted-foreground">{t("admin.fallback.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {activeSources.map((m) => (
                  <tr key={m.modelId} className="border-b border-border/20">
                    <td className="px-4 py-3">
                      <div className="font-serif font-medium">{m.modelName || m.modelId}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{m.modelId}</div>
                    </td>
                    <td className="px-4 py-3">
                      {m.circuit ? (
                        <span className="inline-flex items-center gap-1 text-[11px] bg-warn/15 text-amber-700 px-2 py-0.5 rounded-full">
                          <ShieldAlert className="w-3 h-3" />
                          {t("admin.models.fallback.circuitBypassing", { remaining: m.circuit.remaining_s, trips: m.circuit.trips })}
                        </span>
                      ) : (
                        <span className="text-[11px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full">{t("admin.fallback.status.normal")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {m.circuit && (
                        <button type="button" onClick={() => forceRecover(m.modelId)} className="p-2 rounded-lg text-amber-600 hover:bg-warn/10" title={t("admin.models.fallback.forceRecoverTitle")}>
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-card rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-border/40 bg-secondary/30 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-[13px] font-medium text-foreground">{t("admin.fallback.logsTitle")}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">{t("admin.fallback.logsHint")}</p>
          </div>
          <select
            value={logTrigger}
            onChange={(e) => setLogTrigger(e.target.value as typeof logTrigger)}
            className="rounded-lg border border-border/40 bg-background px-3 py-1.5 text-[12px]"
          >
            <option value="circuit">{t("admin.fallback.logTrigger.circuit")}</option>
            <option value="retry">{t("admin.fallback.logTrigger.retry")}</option>
            <option value="all">{t("admin.fallback.logTrigger.all")}</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border/40 bg-secondary/40">
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.time")}</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.requestId")}</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.from")}</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.to")}</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.trigger")}</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.status")}</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-muted-foreground">{t("admin.fallback.logCol.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {logsLoading ? (
                <tr><td colSpan={7} className="py-12 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">{t("admin.fallback.logsEmpty")}</td></tr>
              ) : logs.map((log) => (
                <tr key={log.id} className="border-b border-border/20 hover:bg-secondary/20">
                  <td className="px-4 py-2.5 whitespace-nowrap text-[12px] text-muted-foreground">{log.createdAt.replace("T", " ").slice(0, 19)}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px]">{log.requestId || "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px]">{log.fallbackFrom || "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px]">{log.modelId}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-[11px] bg-secondary px-2 py-0.5 rounded">
                      {log.fallbackTrigger === "circuit" ? t("admin.fallback.logTrigger.circuit") : log.fallbackTrigger === "retry" ? t("admin.fallback.logTrigger.retry") : log.fallbackTrigger || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{log.statusCode ?? "—"}</td>
                  <td className="px-4 py-2.5 max-w-[280px] truncate text-[11px] text-muted-foreground" title={log.errorDetail || undefined}>
                    {log.errorDetail || (log.totalTokens != null ? `${log.totalTokens} tok` : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!logsLoading && logsTotal > logs.length && (
          <div className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border/30">
            {t("admin.fallback.logsMore", { shown: logs.length, total: logsTotal })}
          </div>
        )}
      </div>
    </div>
  );
}
