import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { X, Moon, User, ChevronDown, Pencil, AlertTriangle } from "lucide-react";
import {
  api,
  type ModelInfo,
  type NightBatchRegistration,
  type NightBatchUpdateBody,
} from "../api/gateway";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import { categoryLabels } from "./model-data";

interface NightBatchModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  editTarget?: NightBatchEditTarget | null;
}

const MAX_OCCURRENCES = 60;

export interface NightBatchEditTarget {
  mode: "single" | "series";
  reg: NightBatchRegistration;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultRepeatUntil(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function combineLocal(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
}

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function expandOccurrencesLocal(
  startDate: string, startTime: string, endTime: string,
  repeatWeekdays: number[], repeatUntil: string | null,
): { start: Date; end: Date }[] | null {
  if (!startDate || !startTime || !endTime || startTime === endTime) return null;
  const crossesMidnight = endTime <= startTime;

  let dates: string[];
  if (repeatWeekdays.length === 0) {
    dates = [startDate];
  } else {
    if (!repeatUntil || repeatUntil < startDate) return null;
    dates = [];
    let cur = combineLocal(startDate, "00:00");
    const until = combineLocal(repeatUntil, "00:00");
    while (cur <= until) {
      const p = (n: number) => String(n).padStart(2, "0");
      const iso = `${cur.getFullYear()}-${p(cur.getMonth() + 1)}-${p(cur.getDate())}`;
      const weekday = (cur.getDay() + 6) % 7;
      if (repeatWeekdays.includes(weekday)) dates.push(iso);
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    if (dates.length === 0) return null;
  }
  if (dates.length > MAX_OCCURRENCES) return null;

  return dates.map((d) => {
    const s = combineLocal(d, startTime);
    const endDateStr = crossesMidnight ? addDaysStr(d, 1) : d;
    const e = combineLocal(endDateStr, endTime);
    return { start: s, end: e };
  });
}

function calcEndTime(startTime: string, hours: number): string {
  const [h, m] = startTime.split(":").map(Number);
  const totalMinutes = h * 60 + m + hours * 60;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

function isValidNightTime(timeStr: string): boolean {
  const [h, m] = timeStr.split(":").map(Number);
  const totalMinutes = h * 60 + m;
  const start = 19 * 60;
  const end = 7 * 60 + 30;
  return totalMinutes >= start || totalMinutes <= end;
}

function buildAllDayTimeOptions(): { value: string; label: string; disabled: boolean }[] {
  const options: { value: string; label: string; disabled: boolean }[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of ["00", "30"]) {
      const value = `${String(h).padStart(2, "0")}:${m}`;
      const disabled = !isValidNightTime(value);
      options.push({ value, label: value, disabled });
    }
  }
  return options;
}

const ALL_DAY_TIME_OPTIONS = buildAllDayTimeOptions();

function calcMaxDuration(startTime: string): number {
  const [h, m] = startTime.split(":").map(Number);
  const startMinutes = h * 60 + m;
  const nightEnd = 7 * 60 + 30;
  const nextDayEnd = 24 * 60 + nightEnd;

  const maxMinutes = startMinutes >= 19 * 60
    ? nextDayEnd - startMinutes
    : nightEnd - startMinutes;

  return Math.floor(maxMinutes / 30) * 0.5;
}

export function NightBatchModal({ open, onClose, onSuccess }: NightBatchModalProps) {
  const { t } = useT();
  const { token, authId, name, department } = useAuth();

  const [startDate, setStartDate] = useState(todayStr());
  const [startTime, setStartTime] = useState("22:00");
  const [durationInput, setDurationInput] = useState("8");
  const durationHours = parseFloat(durationInput) || 0;
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>([]);
  const [repeatUntil, setRepeatUntil] = useState(defaultRepeatUntil());
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [intensityNote, setIntensityNote] = useState("");
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [loading, setLoading] = useState(false);

  const maxDurationHours = useMemo(() => calcMaxDuration(startTime), [startTime]);

  const weekdayLabels = useMemo(() => [t("usage.weekday.mon"), t("usage.weekday.tue"), t("usage.weekday.wed"), t("usage.weekday.thu"), t("usage.weekday.fri"), t("usage.weekday.sat"), t("usage.weekday.sun")], [t]);

  const occurrenceCount = useMemo(() => {
    if (repeatWeekdays.length === 0) return 1;
    const endTime = calcEndTime(startTime, durationHours);
    const occ = expandOccurrencesLocal(startDate, startTime, endTime, repeatWeekdays, repeatUntil);
    return occ ? occ.length : 0;
  }, [startDate, startTime, durationInput, repeatWeekdays, repeatUntil]);

  const totalOccurrences = occurrenceCount * (modelIds.length || 1);

  useEffect(() => {
    if (durationHours > maxDurationHours) setDurationInput(String(maxDurationHours));
  }, [startTime]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setStartDate(todayStr());
    setStartTime("22:00");
    setDurationInput("8");
    setRepeatWeekdays([]);
    setRepeatUntil(defaultRepeatUntil());
    setModelIds([]);
    setDescription("");
    setIntensityNote("");
    setLoading(false);
  }, [open, name]);

  useEffect(() => {
    if (!open) return;
    api.models()
      .then((res) => setModels(Array.isArray(res.data) ? res.data : []))
      .catch(() => setModels([]));
  }, [open]);

  useEffect(() => {
    if (!open || !token) return;
    api.userKeys(token)
      .then((res) => {
        const names = [...new Set((res.data || []).map((k: { name: string }) => k.name).filter(Boolean))];
        setProjectNames(names);
      })
      .catch(() => setProjectNames([]));
  }, [open, token]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!showProjectDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".project-combobox")) setShowProjectDropdown(false);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [showProjectDropdown]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function toggleWeekday(w: number) {
    setRepeatWeekdays((prev) => (prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort((a, b) => a - b)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) { toast.error(t("nightBatch.modal.toast.loginRequired")); return; }
    if (!startDate || !startTime) { toast.error(t("nightBatch.modal.toast.incompleteTime")); return; }
    if (!isValidNightTime(startTime)) { toast.error(t("nightBatch.modal.toast.invalidTime")); return; }
    if (!durationHours || durationHours < 0.5) { toast.error(t("nightBatch.modal.toast.durationTooShort")); return; }
    if (repeatWeekdays.length > 0 && !repeatUntil) { toast.error(t("nightBatch.modal.toast.repeatUntilRequired")); return; }
    if (modelIds.length === 0) { toast.error(t("nightBatch.modal.toast.noModel")); return; }
    if (!description.trim()) { toast.error(t("nightBatch.modal.toast.noDescription")); return; }

    const endTime = calcEndTime(startTime, durationHours);

    setLoading(true);
    try {
      const totalModels = modelIds.length;
      let count = 0;
      const created: string[] = [];
      for (const mid of modelIds) {
        const res = await api.nightBatchCreate(token, {
          start_date: startDate,
          start_time: startTime,
          end_time: endTime,
          repeat_weekdays: repeatWeekdays,
          repeat_until: repeatWeekdays.length ? repeatUntil : null,
          model_id: mid,
          description: description.trim(),
          contact_name: name || authId || "",
          intensity_note: intensityNote.trim() || null,
        });
        count += res.count || 1;
        const modelName = models.find((m) => m.id === mid)?.name || mid;
        created.push(`${modelName} ×${res.count || 1}`);
      }
      if (count > 1) {
        toast.success(t("nightBatch.modal.toast.successMulti").replace("{n}", String(count)).replace("{detail}", created.join(" / ")));
      } else {
        toast.success(t("nightBatch.modal.toast.success"));
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("nightBatch.modal.toast.failed"));
    } finally {
      setLoading(false);
    }
  }

  const onlineModels = useMemo(() => {
    return models.filter((m) => m.status === "online");
  }, [models]);

  const groupedModels = useMemo(() => {
    const order = ["lts", "flagship", "chat", "vision", "embedding", "reranker", "ocr"];
    const groups: { category: string; label: string; models: ModelInfo[] }[] = [];
    for (const cat of order) {
      const items = onlineModels.filter((m) => m.category === cat);
      if (items.length > 0) {
        groups.push({ category: cat, label: categoryLabels[cat as keyof typeof categoryLabels] || cat, models: items });
      }
    }
    const categorized = new Set(order);
    const rest = onlineModels.filter((m) => !categorized.has(m.category));
    if (rest.length > 0) {
      groups.push({ category: "other", label: t("common.other"), models: rest });
    }
    return groups;
  }, [onlineModels]);

  const filteredProjectNames = useMemo(() => {
    if (!description.trim()) return projectNames;
    const lower = description.toLowerCase();
    return projectNames.filter((n) => n.toLowerCase().includes(lower));
  }, [projectNames, description]);

  if (!open) return null;

  const inputCls =
    "w-full px-3.5 py-2.5 rounded-xl bg-secondary text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 border border-border transition-all";

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="animate-enter bg-card rounded-2xl w-full mx-4 overflow-hidden"
        style={{
          maxWidth: "600px",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "var(--shadow-pop)",
        }}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-primary">
              <Moon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-serif text-[16px] font-medium leading-tight text-foreground">
                {t("nightBatch.modal.title")}
              </h2>
              <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {t("nightBatch.modal.subtitle")}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto">
          {/* ── 时间设置 ── */}
          <div className="rounded-xl border border-border bg-secondary/40 p-4">
            <h3 className="mb-3 flex items-center gap-1.5 font-serif text-[12px] font-medium text-foreground">
              <span className="w-1 h-4 rounded-full bg-primary inline-block" />
              {t("nightBatch.modal.timeSection")}
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="date" className={inputCls} style={{ width: 150 }} value={startDate}
                onChange={(e) => setStartDate(e.target.value)} disabled={loading} />
              <select className={inputCls} style={{ width: 110 }} value={startTime}
                onChange={(e) => setStartTime(e.target.value)} disabled={loading}>
                {ALL_DAY_TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={opt.disabled}
                    title={opt.disabled ? t("nightBatch.modal.timeSlotDisabled") : undefined}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-muted-foreground">{t("nightBatch.modal.duration")}</span>
              <input
                type="number"
                className={inputCls}
                style={{ width: 72 }}
                value={durationInput}
                min={0.5}
                max={maxDurationHours}
                step={0.5}
                onChange={(e) => setDurationInput(e.target.value)}
                disabled={loading}
              />
              <span className="text-[12px] text-muted-foreground">{t("nightBatch.modal.hours")}</span>
            </div>
            <div className="mt-2 text-[11px]">
              {(() => {
                const endTime = calcEndTime(startTime, durationHours);
                const [h, m] = endTime.split(":").map(Number);
                const total = h * 60 + m;
                const exceeded = total > 7 * 60 + 30 && total < 19 * 60;
                if (exceeded) {
                  return <span className="text-warn flex items-center gap-1"><AlertTriangle className="w-3 h-3 shrink-0" />{t("nightBatch.modal.exceeded").replace("{time}", endTime)}</span>;
                }
                return <span className="text-muted-foreground">{t("nightBatch.modal.expectedEnd").replace("{time}", endTime)}</span>;
              })()}
            </div>
          </div>

          {/* ── 重复规则 ── */}
          <div className="rounded-xl border border-border bg-secondary/40 p-4">
            <h3 className="mb-3 flex items-center gap-1.5 font-serif text-[12px] font-medium text-foreground">
              <span className="w-1 h-4 rounded-full bg-primary inline-block" />
              {t("nightBatch.modal.repeatSection")}
              <span className="font-normal text-muted-foreground text-[11px]">{t("nightBatch.modal.optional")}</span>
            </h3>
            <div className="flex items-center gap-1.5 flex-wrap">
              {weekdayLabels.map((label, w) => {
                const active = repeatWeekdays.includes(w);
                return (
                  <button
                    key={w}
                    type="button"
                    disabled={loading}
                    onClick={() => toggleWeekday(w)}
                    className="w-9 h-9 rounded-lg text-[13px] transition-colors"
                    style={{
                      border: `1.5px solid ${active ? "var(--primary)" : "var(--border)"}`,
                      background: active ? "var(--primary)" : "var(--card)",
                      color: active ? "var(--primary-foreground)" : "var(--muted-foreground)",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
              {repeatWeekdays.length > 0 && (
                <div className="flex items-center gap-1.5 ml-2">
                  <span className="text-[12px] text-muted-foreground">{t("nightBatch.modal.until")} <span className="text-primary text-[11px]">*</span></span>
                  <input type="date" className={inputCls} style={{ width: 150 }} value={repeatUntil}
                    min={startDate} onChange={(e) => setRepeatUntil(e.target.value)} disabled={loading} required />
                </div>
              )}
            </div>
            {repeatWeekdays.length > 0 && (
              <div className="mt-2 text-[11px] text-muted-foreground">
                {t("nightBatch.modal.repeatSummary").replace("{days}", repeatWeekdays.map((w) => weekdayLabels[w]).join("、")).replace("{until}", repeatUntil).replace("{n}", String(occurrenceCount))}
                {modelIds.length > 1 && <span>{t("nightBatch.modal.repeatSummaryWithModels").replace("{models}", String(modelIds.length)).replace("{total}", String(totalOccurrences))}</span>}
              </div>
            )}
          </div>

          {/* ── 目标模型 ── */}
          <div className="rounded-xl border border-border bg-secondary/40 p-4">
            <h3 className="mb-3 flex items-center gap-1.5 font-serif text-[12px] font-medium text-foreground">
              <span className="w-1 h-4 rounded-full bg-primary inline-block" />
              {t("nightBatch.modal.targetModel")} <span className="text-primary text-[11px]">*</span>
            </h3>
            <div className="max-h-44 overflow-y-auto rounded-xl border border-border bg-card p-2 space-y-1">
              {groupedModels.map((group) => (
                <div key={group.category}>
                  <p className="text-[11px] text-muted-foreground px-2 pt-1 pb-0.5 font-medium">{group.label}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {group.models.map((m) => {
                      const checked = modelIds.includes(m.id);
                      const longName = m.name.length > 18;
                      return (
                        <label
                          key={m.id}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-secondary transition-colors truncate ${longName ? "col-span-2" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setModelIds((prev) =>
                                prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                              );
                            }}
                            disabled={loading}
                            className="w-3.5 h-3.5 accent-primary shrink-0"
                          />
                          <span className="truncate font-serif text-[13px] font-medium text-foreground">{m.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {modelIds.length > 0 && (
              <div className="mt-2 text-[11px] text-muted-foreground">
                {t("nightBatch.modal.selectedModels").replace("{n}", String(modelIds.length))}
              </div>
            )}
          </div>

          {/* ── 调用说明 ── */}
          <div className="rounded-xl border border-border bg-secondary/40 p-4">
            <h3 className="mb-3 flex items-center gap-1.5 font-serif text-[12px] font-medium text-foreground">
              <span className="w-1 h-4 rounded-full bg-primary inline-block" />
              {t("nightBatch.modal.description")} <span className="text-primary text-[11px]">*</span>
            </h3>
            <div className="relative project-combobox">
              <input
                className={inputCls + " pr-8 font-serif"}
                placeholder={t("nightBatch.modal.descriptionPlaceholder")}
                value={description}
                onChange={(e) => { setDescription(e.target.value); setShowProjectDropdown(true); }}
                onFocus={() => setShowProjectDropdown(true)}
                maxLength={100}
                disabled={loading}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-secondary/80 transition-colors"
                onClick={() => setShowProjectDropdown((v) => !v)}
              >
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              {showProjectDropdown && filteredProjectNames.length > 0 && (
                <div
                  className="absolute left-0 right-0 top-full mt-1 z-50 bg-card rounded-xl border border-border overflow-hidden"
                  style={{ boxShadow: "var(--shadow-pop)", maxHeight: 200, overflowY: "auto" }}
                >
                  {filteredProjectNames.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="w-full px-3.5 py-2 text-left font-serif text-[13px] font-medium text-foreground transition-colors hover:bg-secondary"
                      onClick={() => { setDescription(n); setShowProjectDropdown(false); }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative mt-2.5">
              <select
                className={inputCls + " pr-8 appearance-none" + (intensityNote ? "" : " text-muted-foreground")}
                value={intensityNote}
                onChange={(e) => setIntensityNote(e.target.value)}
                disabled={loading}
              >
                <option value="">{t("nightBatch.modal.intensity.placeholder")}</option>
                <option value="low_high_token">{t("nightBatch.intensity.lowHighToken")}</option>
                <option value="low_low_token">{t("nightBatch.intensity.lowLowToken")}</option>
                <option value="high_concurrency">{t("nightBatch.intensity.highConcurrency")}</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            </div>
          </div>

          {/* ── 登记人信息 ── */}
          <div className="rounded-xl border border-border bg-secondary/30 p-4">
            <h3 className="mb-3 flex items-center gap-1.5 font-serif text-[12px] font-medium text-muted-foreground">
              <User className="w-3.5 h-3.5" />
              {t("nightBatch.modal.creatorInfo")}
            </h3>
            <div className="grid grid-cols-3 gap-3 text-[12px]">
              <div>
                <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.modal.authId")}</div>
                <div className="font-mono text-[12px] font-medium text-foreground">{authId || "—"}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.modal.name")}</div>
                <div className="font-serif font-medium text-foreground">{name || "—"}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground mb-0.5">{t("nightBatch.modal.department")}</div>
                <div className="text-foreground font-medium">{department || "—"}</div>
              </div>
            </div>
          </div>

          <div className="flex gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-muted-foreground border border-border hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-40"
            >
              {t("nightBatch.modal.cancel")}
            </button>
            <button
              type="submit"
              disabled={loading || modelIds.length === 0 || !description.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3.5 h-3.5 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin inline-block" />
                  {t("nightBatch.modal.submitting")}
                </span>
              ) : (
                t("nightBatch.modal.submit")
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export function NightBatchEditDialog({
  target,
  token,
  onClose,
  onSuccess,
}: {
  target: NightBatchEditTarget;
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useT();
  const { name, authId } = useAuth();
  const [description, setDescription] = useState(target.reg.description);
  const [intensityNote, setIntensityNote] = useState(target.reg.intensity_note ?? "");
  const [contactName, setContactName] = useState(target.reg.contact_name);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !loading) onClose(); };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [onClose, loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) { toast.error(t("nightBatch.modal.toast.noDescription")); return; }
    setLoading(true);
    try {
      // 强度说明清空时要发空串而不是 null：后端用 `is not None` 区分「不改这个字段」
      // 与「改成空」，发 null 会被当成不改，用户清空后保存看到「更新成功」但旧值还在。
      const body: NightBatchUpdateBody = {
        description: description.trim(),
        intensity_note: intensityNote.trim(),
        contact_name: contactName.trim() || name || authId || "",
      };
      if (target.mode === "series") {
        await api.nightBatchUpdateSeries(token, target.reg.series_id, body);
      } else {
        await api.nightBatchUpdate(token, target.reg.id, body);
      }
      toast.success(t("nightBatch.modal.toast.updateSuccess"));
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("nightBatch.modal.toast.updateFailed"));
      setLoading(false);
    }
  }

  const inputCls =
    "w-full px-3.5 py-2.5 rounded-xl bg-secondary text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 border border-border transition-all";

  const isSeries = target.mode === "series";

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div
        className="animate-enter bg-card rounded-2xl w-full max-w-[460px] overflow-hidden"
        style={{ boxShadow: "var(--shadow-pop)" }}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-primary">
              <Pencil className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-serif text-[16px] font-medium leading-tight text-foreground">
                {t("nightBatch.modal.editTitle")}
                {isSeries && (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    ({t("nightBatch.seriesBadge").replace("{n}", String(target.reg.series_total))})
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {t("nightBatch.modal.editSubtitle")}
              </p>
            </div>
          </div>
          <button onClick={onClose} disabled={loading} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-foreground mb-1.5">
              {t("nightBatch.modal.description")} <span className="text-primary">*</span>
            </label>
            <input
              className={inputCls + " font-serif"}
              placeholder={t("nightBatch.modal.descriptionPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-foreground mb-1.5">
              {t("nightBatch.modal.intensity.placeholder")}
            </label>
            <div className="relative">
              <select
                className={inputCls + " pr-8 appearance-none" + (intensityNote ? "" : " text-muted-foreground")}
                value={intensityNote}
                onChange={(e) => setIntensityNote(e.target.value)}
                disabled={loading}
              >
                <option value="">{t("nightBatch.modal.intensity.placeholder")}</option>
                <option value="low_high_token">{t("nightBatch.intensity.lowHighToken")}</option>
                <option value="low_low_token">{t("nightBatch.intensity.lowLowToken")}</option>
                <option value="high_concurrency">{t("nightBatch.intensity.highConcurrency")}</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-foreground mb-1.5">
              {t("nightBatch.label.contact")}
            </label>
            <input
              className={inputCls + " font-serif"}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              maxLength={50}
              disabled={loading}
            />
          </div>

          <div className="rounded-lg bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
            {isSeries
              ? t("nightBatch.confirmSeriesBody").replace("{n}", String(target.reg.series_total))
              : t("nightBatch.confirmSingleBody").replace("{window}", target.reg.model_name + " · " + target.reg.start_at.slice(11, 16) + "–" + target.reg.end_at.slice(11, 16))}
          </div>

          <div className="flex gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium text-muted-foreground border border-border hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-40"
            >
              {t("nightBatch.cancel")}
            </button>
            <button
              type="submit"
              disabled={loading || !description.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-3.5 h-3.5 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin inline-block" />
                  {t("nightBatch.modal.updating")}
                </span>
              ) : (
                t("nightBatch.modal.editSubmit")
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
