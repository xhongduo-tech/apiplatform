import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus, Pencil, Trash2, KeyRound, X, Check } from "lucide-react";
import { toast } from "sonner";
import { API_BASE, authHeaders, fmtTime, ModalPortal } from "./admin-tab-utils";
import { useT } from "../i18n";

interface UserRecord {
  id: string;
  auth_id: string;
  name: string;
  department: string;
  has_password: boolean;
  created_at: string;
}

export default function UsersTab({ token }: { token: string }) {
  const { t } = useT();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const h = authHeaders(token);
      const res = await fetch(`${API_BASE}/api/admin/users`, { headers: h });
      const data = await res.json();
      // 防御：后端异常返回 null/非对象时不白屏（2026-08 审计）
      setUsers(Array.isArray(data?.data) ? data.data : []);
    } catch { /* silent */ }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">{t("admin.users.count", { n: users.length })}</span>
        <CreateUserDialog token={token} onDone={load} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
        </div>
      ) : users.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-[13px] text-muted-foreground/50">{t("admin.users.empty")}</div>
      ) : (
        <div className="bg-card rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/40 bg-secondary/40">
                  <Th>{t("admin.users.field.authId")}</Th>
                  <Th>{t("admin.users.field.name")}</Th>
                  <Th>{t("admin.users.field.department")}</Th>
                  <Th>{t("admin.users.field.password")}</Th>
                  <Th>{t("admin.users.field.registeredAt")}</Th>
                  <Th>{t("admin.users.field.actions")}</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-border/20 hover:bg-secondary/20 transition-colors">
                    <td className="px-4 py-3 font-medium font-mono text-[12px]">{u.auth_id}</td>
                    <td className="px-4 py-3 font-serif font-medium">{u.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.department || "—"}</td>
                    <td className="px-4 py-3">
                      {u.has_password ? (
                        <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium bg-green-100 text-green-700">{t("admin.users.password.set")}</span>
                      ) : (
                        <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium bg-yellow-100 text-yellow-700">{t("admin.users.password.unset")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtTime(u.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <EditUserDialog token={token} user={u} onDone={load} />
                        <ResetPasswordDialog token={token} user={u} />
                        <DeleteUserDialog token={token} user={u} onDone={load} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-[11px] text-muted-foreground font-medium whitespace-nowrap">
      {children}
    </th>
  );
}

/* ── Create ───────────────────────────────────────────────────────────────── */

function CreateUserDialog({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [authId, setAuthId] = useState("");
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authId.trim() || !name.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/users`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          auth_id: authId.trim(),
          name: name.trim(),
          department: department.trim() || null,
          password: password || null,
        }),
      });
      if (res.ok) {
        toast.success(t("admin.users.create.toast.success"));
        onDone();
        setOpen(false);
        setAuthId(""); setName(""); setDepartment(""); setPassword("");
      } else {
        const err = await res.json();
        toast.error(err.detail || t("admin.users.create.toast.failed"));
      }
    } catch { toast.error(t("admin.users.toast.requestFailed")); }
    setSubmitting(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-[13px] text-primary-foreground hover:opacity-90 transition-opacity"
      >
        <Plus className="w-3.5 h-3.5" /> {t("admin.users.create.btn")}
      </button>
      {open && (
        <DialogOverlay onClose={() => setOpen(false)} ariaLabel={t("admin.users.create.btn")}>
          <form onSubmit={submit} className="bg-card rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 font-serif text-[16px] font-medium">{t("admin.users.create.btn")}</h3>
            <div className="space-y-3">
              <Field label={t("admin.users.create.authIdLabel")} value={authId} onChange={setAuthId} placeholder={t("admin.users.create.authIdPlaceholder")} inputClassName="font-mono" />
              <Field label={t("admin.users.create.nameLabel")} value={name} onChange={setName} placeholder={t("admin.users.create.namePlaceholder")} inputClassName="font-serif" />
              <Field label={t("admin.users.field.department")} value={department} onChange={setDepartment} placeholder={t("admin.users.create.departmentPlaceholder")} />
              <Field label={t("admin.users.create.passwordLabel")} value={password} onChange={setPassword} placeholder={t("admin.users.create.passwordPlaceholder")} type="password" />
            </div>
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl border border-border/40 text-[14px] text-muted-foreground hover:bg-secondary transition-colors">{t("common.cancel")}</button>
              <button type="submit" disabled={submitting || !authId.trim() || !name.trim()} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-[14px] hover:opacity-90 disabled:opacity-60 transition-opacity">
                {submitting ? t("admin.users.create.submitting") : t("admin.users.confirm")}
              </button>
            </div>
          </form>
        </DialogOverlay>
      )}
    </>
  );
}

/* ── Edit ─────────────────────────────────────────────────────────────────── */

function EditUserDialog({ token, user, onDone }: { token: string; user: UserRecord; onDone: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const [department, setDepartment] = useState(user.department);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${user.id}`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ name: name.trim(), department: department.trim() || null }),
      });
      if (res.ok) {
        toast.success(t("admin.users.edit.toast.success"));
        onDone();
        setOpen(false);
      } else {
        const err = await res.json();
        toast.error(err.detail || t("admin.users.edit.toast.failed"));
      }
    } catch { toast.error(t("admin.users.toast.requestFailed")); }
    setSubmitting(false);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" title={t("admin.users.edit.tooltip")}>
        <Pencil className="w-3.5 h-3.5" />
      </button>
      {open && (
        <DialogOverlay onClose={() => setOpen(false)} ariaLabel={t("admin.users.edit.title")}>
          <form onSubmit={submit} className="bg-card rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 font-serif text-[16px] font-medium">{t("admin.users.edit.title")}</h3>
            <p className="mb-4 font-mono text-[12px] text-muted-foreground">{user.auth_id}</p>
            <div className="space-y-3">
              <Field label={t("admin.users.field.name")} value={name} onChange={setName} inputClassName="font-serif" />
              <Field label={t("admin.users.field.department")} value={department} onChange={setDepartment} />
            </div>
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl border border-border/40 text-[14px] text-muted-foreground hover:bg-secondary transition-colors">{t("common.cancel")}</button>
              <button type="submit" disabled={submitting} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-[14px] hover:opacity-90 disabled:opacity-60 transition-opacity">
                {submitting ? t("admin.users.edit.saving") : t("admin.users.edit.save")}
              </button>
            </div>
          </form>
        </DialogOverlay>
      )}
    </>
  );
}

/* ── Reset Password ───────────────────────────────────────────────────────── */

function ResetPasswordDialog({ token, user }: { token: string; user: UserRecord }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${user.id}/reset-password`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ password: password.trim() }),
      });
      if (res.ok) {
        toast.success(t("admin.users.reset.toast.success"));
        setOpen(false);
        setPassword("");
      } else {
        toast.error(t("admin.users.reset.toast.failed"));
      }
    } catch { toast.error(t("admin.users.toast.requestFailed")); }
    setSubmitting(false);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" title={t("admin.users.reset.tooltip")}>
        <KeyRound className="w-3.5 h-3.5" />
      </button>
      {open && (
        <DialogOverlay onClose={() => setOpen(false)} ariaLabel={t("admin.users.reset.tooltip")}>
          <form onSubmit={submit} className="bg-card rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 font-serif text-[16px] font-medium">{t("admin.users.reset.tooltip")}</h3>
            <p className="mb-4 text-[12px] text-muted-foreground"><span className="font-mono">{user.auth_id}</span> — <span className="font-serif font-medium text-foreground">{user.name}</span></p>
            <Field label={t("admin.users.reset.newPasswordLabel")} value={password} onChange={setPassword} type="password" placeholder={t("admin.users.reset.newPasswordPlaceholder")} />
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl border border-border/40 text-[14px] text-muted-foreground hover:bg-secondary transition-colors">{t("common.cancel")}</button>
              <button type="submit" disabled={submitting || !password.trim()} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-[14px] hover:opacity-90 disabled:opacity-60 transition-opacity">
                {submitting ? t("admin.users.reset.submitting") : t("admin.users.confirm")}
              </button>
            </div>
          </form>
        </DialogOverlay>
      )}
    </>
  );
}

/* ── Delete ───────────────────────────────────────────────────────────────── */

function DeleteUserDialog({ token, user, onDone }: { token: string; user: UserRecord; onDone: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${user.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      if (res.ok) {
        toast.success(t("admin.users.delete.toast.success"));
        onDone();
        setOpen(false);
      } else {
        toast.error(t("admin.users.delete.toast.failed"));
      }
    } catch { toast.error(t("admin.users.toast.requestFailed")); }
    setSubmitting(false);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 hover:bg-danger/10 transition-colors" title={t("admin.users.delete.tooltip")}>
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      {open && (
        <DialogOverlay onClose={() => setOpen(false)} ariaLabel={t("admin.users.delete.title")}>
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 font-serif text-[16px] font-medium text-red-600">{t("admin.users.delete.title")}</h3>
            <p className="text-[13px] text-muted-foreground mt-2">
              {t("admin.users.delete.confirmPrefix")} <span className="font-serif font-medium text-foreground">{user.name}</span>{t("admin.users.delete.confirmSuffix", { authId: user.auth_id })}
            </p>
            <div className="mt-4">
              <label className="text-[12px] text-muted-foreground">{t("admin.users.delete.confirmInputLabel")}</label>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border/40 px-3 py-2 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-red-500/20"
                placeholder={user.auth_id}
              />
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl border border-border/40 text-[14px] text-muted-foreground hover:bg-secondary transition-colors">{t("common.cancel")}</button>
              <button
                onClick={submit}
                disabled={submitting || confirm !== user.auth_id}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-primary-foreground text-[14px] hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting ? t("admin.users.delete.submitting") : t("admin.users.delete.confirmBtn")}
              </button>
            </div>
          </div>
        </DialogOverlay>
      )}
    </>
  );
}

/* ── Shared helpers ───────────────────────────────────────────────────────── */

function DialogOverlay({ children, onClose, ariaLabel }: { children: React.ReactNode; onClose: () => void; ariaLabel: string }) {
  return (
    <ModalPortal open onClose={onClose}>
      <div
        className="relative z-10 flex w-full justify-center"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      >
        {children}
      </div>
    </ModalPortal>
  );
}

function Field({ label, value, onChange, placeholder, type, inputClassName }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  inputClassName?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <input
        type={type || "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2.5 rounded-xl border border-border/40 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/15${inputClassName ? ` ${inputClassName}` : ""}`}
      />
    </label>
  );
}
