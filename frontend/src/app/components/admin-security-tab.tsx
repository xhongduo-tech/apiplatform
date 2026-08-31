import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { api } from "../api/gateway";
import { useT } from "../i18n";

export default function AdminSecurityTab({ token }: { token: string }) {
  const { t } = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      toast.error(t("admin.security.passwordMismatch"));
      return;
    }
    setSaving(true);
    try {
      await api.adminChangePassword(token, currentPassword, newPassword, confirmation);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      toast.success(t("admin.security.success"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.security.failed"));
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = "w-full rounded-lg border border-border bg-card px-3 py-2.5 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20";

  return (
    <div className="max-w-2xl space-y-5">
      <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
        {t("admin.security.intro")}
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-5">
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-foreground">{t("admin.security.currentPassword")}</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            minLength={1}
            maxLength={128}
            required
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-foreground">{t("admin.security.newPassword")}</span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-foreground">{t("admin.security.confirmPassword")}</span>
          <input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            className={fieldClass}
          />
        </label>
        <p className="text-[12px] leading-5 text-muted-foreground">{t("admin.passwordPolicy")}</p>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {t("admin.security.sessionNotice")}
        </div>
        <button
          type="submit"
          disabled={saving || !currentPassword || !newPassword || !confirmation}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13.5px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 apiplatform-btn"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {saving ? t("admin.security.submitting") : t("admin.security.submit")}
        </button>
      </form>
    </div>
  );
}
