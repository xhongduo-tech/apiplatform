import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { usePlatformConfig } from "../hooks/use-platform-config";
import { useT, type TranslationKey } from "../i18n";
import { API_BASE, authHeaders } from "./admin-tab-utils";

interface BrandingForm {
  brandName: string;
  platformName: string;
  browserTitle: string;
  heroTitle: string;
  slogan: string;
  organizationName: string;
  footerText: string;
  supportDepartment: string;
  supportContact: string;
  supportEmail: string;
  approvalDepartment: string;
  approvalContact: string;
  approvalEmail: string;
  updatedAt?: string | null;
}

const EMPTY_FORM: BrandingForm = {
  brandName: "",
  platformName: "",
  browserTitle: "",
  heroTitle: "",
  slogan: "",
  organizationName: "",
  footerText: "",
  supportDepartment: "",
  supportContact: "",
  supportEmail: "",
  approvalDepartment: "",
  approvalContact: "",
  approvalEmail: "",
};

function Field({
  label,
  value,
  onChange,
  type = "text",
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  multiline?: boolean;
}) {
  const cls = "w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20";
  return (
    <label className="space-y-1.5">
      <span className="block text-[12.5px] font-medium text-foreground">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          required
          className={`${cls} resize-y`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          className={cls}
        />
      )}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-4 font-serif text-[15px] font-medium text-foreground">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export default function AdminBrandingTab({ token }: { token: string }) {
  const { t } = useT();
  const { refresh } = usePlatformConfig();
  const [form, setForm] = useState<BrandingForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof BrandingForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/branding-config`, {
        headers: authHeaders(token),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as { config: BrandingForm };
      setForm(body.config);
    } catch {
      toast.error(t("admin.branding.toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/branding-config`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({
          brand_name: form.brandName,
          platform_name: form.platformName,
          browser_title: form.browserTitle,
          hero_title: form.heroTitle,
          slogan: form.slogan,
          organization_name: form.organizationName,
          footer_text: form.footerText,
          support_department: form.supportDepartment,
          support_contact: form.supportContact,
          support_email: form.supportEmail,
          approval_department: form.approvalDepartment,
          approval_contact: form.approvalContact,
          approval_email: form.approvalEmail,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as { config: BrandingForm };
      setForm(body.config);
      await refresh();
      toast.success(t("admin.branding.toast.saved"));
    } catch {
      toast.error(t("admin.branding.toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  const label = (key: TranslationKey) => t(key);

  return (
    <form onSubmit={save} className="max-w-3xl space-y-5">
      <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
        {t("admin.branding.intro")}
      </div>

      <Section title={t("admin.branding.section.identity")}>
        <Field label={label("admin.branding.field.brandName")} value={form.brandName} onChange={(v) => set("brandName", v)} />
        <Field label={label("admin.branding.field.platformName")} value={form.platformName} onChange={(v) => set("platformName", v)} />
        <Field label={label("admin.branding.field.browserTitle")} value={form.browserTitle} onChange={(v) => set("browserTitle", v)} />
        <Field label={label("admin.branding.field.slogan")} value={form.slogan} onChange={(v) => set("slogan", v)} />
        <div className="sm:col-span-2">
          <Field label={label("admin.branding.field.heroTitle")} value={form.heroTitle} onChange={(v) => set("heroTitle", v)} multiline />
        </div>
      </Section>

      <Section title={t("admin.branding.section.organization")}>
        <Field label={label("admin.branding.field.organizationName")} value={form.organizationName} onChange={(v) => set("organizationName", v)} />
        <Field label={label("admin.branding.field.footerText")} value={form.footerText} onChange={(v) => set("footerText", v)} />
      </Section>

      <Section title={t("admin.branding.section.support")}>
        <Field label={label("admin.branding.field.department")} value={form.supportDepartment} onChange={(v) => set("supportDepartment", v)} />
        <Field label={label("admin.branding.field.contact")} value={form.supportContact} onChange={(v) => set("supportContact", v)} />
        <div className="sm:col-span-2">
          <Field label={label("admin.branding.field.email")} value={form.supportEmail} onChange={(v) => set("supportEmail", v)} type="email" />
        </div>
      </Section>

      <Section title={t("admin.branding.section.approval")}>
        <Field label={label("admin.branding.field.department")} value={form.approvalDepartment} onChange={(v) => set("approvalDepartment", v)} />
        <Field label={label("admin.branding.field.contact")} value={form.approvalContact} onChange={(v) => set("approvalContact", v)} />
        <div className="sm:col-span-2">
          <Field label={label("admin.branding.field.email")} value={form.approvalEmail} onChange={(v) => set("approvalEmail", v)} type="email" />
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13.5px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 apiplatform-btn"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? t("admin.branding.saving") : t("admin.branding.save")}
        </button>
        {form.updatedAt && (
          <span className="text-[11px] text-muted-foreground">
            {t("admin.branding.updatedAt", { time: new Date(form.updatedAt).toLocaleString() })}
          </span>
        )}
      </div>
    </form>
  );
}
