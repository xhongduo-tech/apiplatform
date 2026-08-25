import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, KeyRound, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, type AdminSceneTypeRow } from "../api/gateway";
import { fmtTime, ModalPortal } from "./admin-tab-utils";
import { useT } from "../i18n";

/**
 * 场景分类管理（业务场景）：新增 / 修改 / 删除。
 * 申请 API Key 表单与状态页场景分布都从 scene_types 表读取，这里就是维护入口。
 */
export default function SceneTypesTab({ token }: { token: string }) {
  const { t } = useT();
  const [rows, setRows] = useState<AdminSceneTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AdminSceneTypeRow | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [viewingKeys, setViewingKeys] = useState<AdminSceneTypeRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.adminSceneTypes(token));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.loadFailed"));
    }
    setLoading(false);
  }, [token, t]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (row: AdminSceneTypeRow) => {
    setEditing(row);
    setModalOpen(true);
  };

  const handleDelete = async (row: AdminSceneTypeRow) => {
    if (deleting) return;
    if (!window.confirm(t("admin.sceneTypes.confirmDelete", { label: row.label }))) return;
    setDeleting(row.key);
    try {
      await api.adminSceneTypeDelete(token, row.key);
      toast.success(t("admin.sceneTypes.deleted"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    } finally {
      setDeleting(null);
    }
  };

  const nextSortOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 10;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">{t("admin.sceneTypes.desc")}</p>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-[13px] font-medium text-bg transition-opacity hover:opacity-85"
        >
          <Plus size={15} /> {t("admin.sceneTypes.add")}
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-soft text-left">
              <th className="whitespace-nowrap px-4 py-2.5 font-medium text-fg-muted">{t("admin.sceneTypes.sortOrder")}</th>
              <th className="px-4 py-2.5 font-medium text-fg-muted">{t("admin.sceneTypes.label")}</th>
              <th className="px-4 py-2.5 font-medium text-fg-muted">{t("admin.sceneTypes.key")}</th>
              <th className="px-4 py-2.5 font-medium text-fg-muted">{t("admin.sceneTypes.keyCount")}</th>
              <th className="whitespace-nowrap px-4 py-2.5 font-medium text-fg-muted">{t("admin.sceneTypes.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="py-12 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-fg-subtle" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-fg-muted">{t("admin.sceneTypes.empty")}</td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2.5 tabular-nums text-fg-muted">{row.sortOrder}</td>
                <td className="px-4 py-2.5 font-serif font-medium text-fg">{row.label}</td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-fg-muted">{row.key}</td>
                <td className="px-4 py-2.5 tabular-nums text-fg-muted">{row.keyCount}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setViewingKeys(row)}
                      className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-bg-soft hover:text-fg"
                      aria-label={t("admin.sceneTypes.viewKeys")}
                      title={t("admin.sceneTypes.viewKeys")}
                    >
                      <KeyRound size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-bg-soft hover:text-fg"
                      aria-label={t("admin.sceneTypes.edit")}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(row)}
                      disabled={deleting === row.key}
                      className="rounded-lg p-1.5 text-danger/80 transition-colors hover:bg-danger/5 hover:text-danger disabled:opacity-50"
                      aria-label={t("admin.sceneTypes.delete")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <SceneTypeFormModal
          token={token}
          initial={editing}
          defaultSortOrder={nextSortOrder}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); load(); }}
        />
      )}

      {viewingKeys && (
        <SceneKeysModal
          token={token}
          scene={viewingKeys}
          onClose={() => setViewingKeys(null)}
        />
      )}
    </div>
  );
}

const KEY_PAGE_SIZE = 20;

type SceneKeyRow = Awaited<ReturnType<typeof api.adminKeysList>>["data"][number];

/** 查看某场景分类下的全部 API Key（与列表 keyCount 同源）。 */
function SceneKeysModal({
  token, scene, onClose,
}: {
  token: string;
  scene: AdminSceneTypeRow;
  onClose: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<SceneKeyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.adminKeysList(token, {
        limit: KEY_PAGE_SIZE,
        offset,
        scene_type: scene.key,
      });
      setRows(d.data ?? []);
      setTotal(d.total ?? 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.loadFailed"));
    }
    setLoading(false);
  }, [token, scene.key, offset, t]);

  useEffect(() => { load(); }, [load]);

  const page = Math.floor(offset / KEY_PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / KEY_PAGE_SIZE));

  return (
    <ModalPortal open onClose={onClose}>
      <div
        className="modal-panel-enter relative flex max-h-[min(85vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scene-keys-title"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 id="scene-keys-title" className="font-serif text-[16px] font-medium text-fg">
              {t("admin.sceneTypes.keysTitle", { label: scene.label })}
            </h3>
            <p className="mt-0.5 text-[12px] text-fg-subtle">
              {t("admin.sceneTypes.keysTotal", { count: total })}
              <span className="ml-2 font-mono text-fg-muted">{scene.key}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-bg-soft hover:text-fg"
            aria-label={t("keys.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-muted-foreground">
              {t("admin.sceneTypes.keysEmpty")}
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-bg-soft">
                <tr className="border-b border-border text-left text-[12px] text-fg-muted">
                  <th className="px-4 py-2.5 font-medium">{t("admin.keys.col.project")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("admin.keys.col.department")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("admin.keys.col.authId")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("admin.keys.col.status")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("admin.keys.col.issuedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-border/40 last:border-b-0 ${r.revoked ? "opacity-50" : ""}`}>
                    <td className="max-w-[200px] px-4 py-2.5">
                      <div className="truncate font-serif font-medium text-fg" title={r.projectName || r.name}>
                        {r.projectName || r.name}
                      </div>
                      {r.projectDesc && (
                        <div className="mt-0.5 truncate text-[11px] text-fg-subtle" title={r.projectDesc}>{r.projectDesc}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted">{r.department || "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-fg-muted">{r.authId}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                        r.revoked ? "bg-gray-100 text-gray-500" : "bg-green-100 text-green-700"
                      }`}>
                        {r.revoked ? t("admin.keys.status.revoked") : t("admin.keys.status.active")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-[12px] text-fg-muted">
                      {r.grantedAt ? fmtTime(r.grantedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {total > KEY_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-[12px] text-fg-muted">
            <span>{t("admin.sceneTypes.keysPage", { page, pageCount })}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={offset <= 0 || loading}
                onClick={() => setOffset((o) => Math.max(0, o - KEY_PAGE_SIZE))}
                className="rounded-lg p-1.5 transition-colors hover:bg-bg-soft disabled:opacity-40"
                aria-label={t("admin.earlyAccess.prevPage")}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                disabled={offset + KEY_PAGE_SIZE >= total || loading}
                onClick={() => setOffset((o) => o + KEY_PAGE_SIZE)}
                className="rounded-lg p-1.5 transition-colors hover:bg-bg-soft disabled:opacity-40"
                aria-label={t("admin.earlyAccess.nextPage")}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalPortal>
  );
}

function SceneTypeFormModal({
  token, initial, defaultSortOrder, onClose, onSaved,
}: {
  token: string;
  initial: AdminSceneTypeRow | null;
  defaultSortOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [key, setKey] = useState(initial?.key ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? defaultSortOrder));
  const [saving, setSaving] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) { toast.error(t("admin.sceneTypes.labelRequired")); return; }
    if (!initial && !key.trim()) { toast.error(t("admin.sceneTypes.keyRequired")); return; }
    setSaving(true);
    try {
      const order = parseInt(sortOrder || "0", 10) || 0;
      if (initial) {
        await api.adminSceneTypeUpdate(token, initial.key, { label: label.trim(), sort_order: order });
        toast.success(t("admin.sceneTypes.saved"));
      } else {
        await api.adminSceneTypeCreate(token, { key: key.trim(), label: label.trim(), sort_order: order });
        toast.success(t("admin.sceneTypes.created"));
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.operationFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal open onClose={onClose}>
      <form
        onSubmit={handle}
        className="modal-panel-enter relative w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 className="font-serif text-[16px] font-medium text-fg">
          {initial ? t("admin.sceneTypes.edit") : t("admin.sceneTypes.add")}
        </h3>
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-fg">{t("admin.sceneTypes.label")} *</label>
          <input
            className="w-full rounded-xl border border-border bg-bg-soft px-3.5 py-2.5 font-serif text-[14px] text-fg outline-none"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
        </div>
        {!initial && (
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-fg">{t("admin.sceneTypes.key")} *</label>
            <input
              className="w-full rounded-xl border border-border bg-bg-soft px-3.5 py-2.5 font-mono text-[13px] text-fg outline-none"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="scene_key"
            />
            <p className="mt-1 text-[11.5px] text-fg-subtle">{t("admin.sceneTypes.keyHint")}</p>
          </div>
        )}
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-fg">{t("admin.sceneTypes.sortOrder")}</label>
          <input
            type="number"
            className="w-full rounded-xl border border-border bg-bg-soft px-3.5 py-2.5 text-[14px] text-fg outline-none"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-border py-2.5 text-[13px] text-fg-muted transition-colors hover:bg-bg-soft"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-85 disabled:opacity-60"
          >
            {saving ? t("keys.saving") : initial ? t("keys.save") : t("admin.sceneTypes.create")}
          </button>
        </div>
      </form>
    </ModalPortal>
  );
}
