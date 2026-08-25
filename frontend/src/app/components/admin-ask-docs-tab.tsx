import { useState, useEffect, useCallback } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { API_BASE, authHeaders } from "./admin-tab-utils";
import { useT } from "../i18n";

interface AskDocsConfig {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
  updatedAt: string | null;
}

interface AdminModel {
  id: string;
  name: string;
  status: string;
  category: string;
}

export default function AskDocsTab({ token }: { token: string }) {
  const { t } = useT();
  const [config, setConfig] = useState<AskDocsConfig | null>(null);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [legacyMode, setLegacyMode] = useState(false);

  const [form, setForm] = useState({
    modelId: "",
    enabled: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const h = authHeaders(token);
      const [configRes, modelsRes] = await Promise.all([
        fetch(`${API_BASE}/api/admin/ask-docs-config`, { headers: h }),
        fetch(`${API_BASE}/api/admin/models`, { headers: h }),
      ]);
      const modelsData = await modelsRes.json();
      if (Array.isArray(modelsData)) {
        setModels(modelsData);
      }
      const data = await configRes.json();
      if (data.config) {
        setConfig(data.config);
        const isPlatform = data.config.provider === "platform";
        setLegacyMode(!isPlatform);
        setForm({
          modelId: isPlatform ? data.config.model || "" : "",
          enabled: data.config.enabled ?? false,
        });
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.modelId) {
      toast.error(t("admin.askDocs.toast.modelRequired"));
      return;
    }
    setSaving(true);
    try {
      const h = authHeaders(token);
      // 仅配置接入模型；system prompt / max_tokens / temperature 走服务端默认
      const res = await fetch(`${API_BASE}/api/admin/ask-docs-config`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({
          provider: "platform",
          model: form.modelId,
          api_base: "",
          api_key: "",
          system_prompt: null,
          max_tokens: 4096,
          temperature: 0.3,
          enabled: form.enabled,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.config);
        setLegacyMode(false);
        toast.success(t("admin.askDocs.toast.saved"));
      } else {
        toast.error(t("admin.askDocs.toast.saveFailed"));
      }
    } catch {
      toast.error(t("admin.askDocs.toast.saveNetworkError"));
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  // 平台别名（虚拟模型，category === "lts"）置顶，其余按名称排序；下线模型不可选
  const selectable = models
    .filter((m) => m.status !== "offline")
    .sort((a, b) => {
      const aAlias = a.category === "lts" ? 0 : 1;
      const bAlias = b.category === "lts" ? 0 : 1;
      if (aAlias !== bAlias) return aAlias - bAlias;
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3 text-[13px] text-muted-foreground leading-relaxed">
        <p className="mb-1 font-serif font-medium text-foreground">{t("admin.askDocs.intro.title")}</p>
        <p>
          {t("admin.askDocs.intro.desc")}
        </p>
      </div>

      {legacyMode && config && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[12.5px] text-amber-600 dark:text-amber-400 leading-relaxed">
          {t("admin.askDocs.legacyNote")}
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-[12.5px] font-medium text-foreground">{t("admin.askDocs.form.platformModel")}</label>
        <select
          value={form.modelId}
          onChange={(e) => setForm({ ...form, modelId: e.target.value })}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="">{t("admin.askDocs.form.platformModelPlaceholder")}</option>
          {selectable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}（{m.id}）{m.category === "lts" ? ` · ${t("admin.askDocs.form.aliasBadge")}` : ""}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">{t("admin.askDocs.form.platformModelHint")}</p>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 px-4 py-3">
        <button
          type="button"
          onClick={() => setForm({ ...form, enabled: !form.enabled })}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none ${
            form.enabled ? "bg-primary" : "bg-muted-foreground/25"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${
              form.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
            }`}
          />
        </button>
        <div>
          <p className="text-[13px] font-medium text-foreground">{t("admin.askDocs.form.enable")}</p>
          <p className="text-[11px] text-muted-foreground">
            {form.enabled ? t("admin.askDocs.form.enabledDesc") : t("admin.askDocs.form.disabledDesc")}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13.5px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 apiplatform-btn"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {t("admin.askDocs.save")}
      </button>

      {config && (
        <p className="text-[11px] text-muted-foreground">
          {t("admin.askDocs.lastUpdated", { time: config.updatedAt ? new Date(config.updatedAt).toLocaleString() : "—" })}
        </p>
      )}
    </div>
  );
}
