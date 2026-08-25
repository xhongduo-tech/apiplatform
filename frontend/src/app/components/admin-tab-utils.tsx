import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Filter } from "lucide-react";
import { useT } from "../i18n";
import { useModalFocus } from "../accessibility";
import { ADMIN_EXPIRED_EVENT, COOKIE_SESSION_TOKEN } from "../api/gateway";
export { API_BASE } from "../config";

/** 数据看板热力图点击 → 跳转日志 Tab 时写入 sessionStorage 的过滤器键 */
export const ADMIN_LOGS_FILTERS_KEY = "apiplatform-admin-logs-filters";
/** 管理端 Tab 切换事件（detail.tab 为 Tab key） */
export const ADMIN_NAV_TAB_EVENT = "apiplatform-admin-nav-tab";

/** 挂载到 body，避免祖先 transform（如 animate-enter）破坏 fixed 居中。 */
export function ModalPortal({
  open,
  onClose,
  children,
  zIndex = 10000,
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  zIndex?: number;
}) {
  const portalRef = useRef<HTMLDivElement>(null);
  useModalFocus({ open, containerRef: portalRef, onClose });

  if (!open) return null;

  return createPortal(
    <div ref={portalRef} className="fixed inset-0" style={{ zIndex }} role="presentation" tabIndex={-1}>
      {/* 全屏遮罩：独立一层，避免与 flex 居中容器混用导致「中间一条灰带」 */}
      <div
        className="absolute inset-0 bg-ink/40"
        style={{
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
        aria-hidden="true"
        onClick={() => onClose?.()}
      />
      {/* 可滚动居中区：矮弹窗垂直居中，高弹窗可在遮罩内滚动 */}
      <div
        className="absolute inset-0 overflow-y-auto overscroll-contain"
        onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      >
        <div
          className="flex min-h-full items-center justify-center p-4 sm:p-6"
          onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Clipboard helper ───────────────────────────────────────────────────────
export function copyToClipboard(text: string) {
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
  el.focus(); el.select();
  try { document.execCommand("copy"); } catch { /* silent */ }
  document.body.removeChild(el);
}

// ── CSV export helper ──────────────────────────────────────────────────────
export function downloadCsv(filename: string, rows: string[][], headers: string[]) {
  const escape = (v: string) => `"${(v ?? "").toString().replace(/"/g, '""')}"`;
  const safeRows = Array.isArray(rows) ? rows : [];
  const lines = [headers.map(escape).join(","), ...safeRows.map((r) => (Array.isArray(r) ? r : []).map(escape).join(","))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── API helpers ────────────────────────────────────────────────────────────
export function authHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    ...(token && token !== COOKIE_SESSION_TOKEN
      ? { Authorization: `Bearer ${token}` }
      : {}),
  };
}

/** Turn every non-2xx admin mutation into a rejected promise before UI state changes. */
export async function requireOk(response: Response, fallbackMessage: string): Promise<Response> {
  if (response.ok) return response;

  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(ADMIN_EXPIRED_EVENT));
  }

  let detail = "";
  try {
    const body = await response.clone().json() as { detail?: unknown; message?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
    else if (typeof body.message === "string") detail = body.message;
  } catch {
    try {
      detail = (await response.text()).trim();
    } catch {
      /* keep the localized fallback below */
    }
  }

  throw new Error(detail || `${fallbackMessage} (HTTP ${response.status})`);
}

// ── Time formatting ────────────────────────────────────────────────────────
export function fmtTime(iso: string, showSeconds = false) {
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(normalized);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return showSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** 并发档位预设（后端 settings.rate_limit_presets() 下发，前端不硬编码数值） */
export interface RatePreset {
  key: string;
  name: string;
  rpm: number;
  tpm: number;
  unlimited: boolean;
}

/**
 * 按当前 rpm/tpm 值反查所属档位，命中返回该预设，否则 null（=自定义）。
 *
 * 列表与弹窗共用同一份判定，避免"弹窗认得高并发、列表只显示裸数字"。
 * presets 由 /api/public/config 异步拉取，首帧为空数组时一律返回 null，
 * 调用方须能干净回落到裸数值展示，不要闪一次"自定义"再跳成"高并发"。
 */
export function matchPreset(
  presets: RatePreset[],
  rpmLimit: number | null | undefined,
  tpmLimit: number | null | undefined,
): RatePreset | null {
  if (!presets.length) return null;
  for (const p of presets) {
    if (p.unlimited) {
      if (rpmLimit === -1 && tpmLimit === -1) return p;
      continue;
    }
    if (p.key === "default") {
      if (rpmLimit == null && tpmLimit == null) return p;
      continue;
    }
    if (rpmLimit === p.rpm && tpmLimit === p.tpm) return p;
  }
  return null;
}

export interface ApiRecord {
  id: string;
  name: string;
  authId: string;
  projectName: string;
  projectDesc?: string;
  department: string;
  apiKey: string;
  grantedAt: string;
  revoked?: boolean;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** default | high | unlimited | custom —— 与后端 settings.key_tier 同源 */
  tier?: string;
  dataGuardEnabled?: boolean;
  allowedAttributes?: string[];
  systemDatabaseAllowed?: boolean;
  dataGuardStrict?: boolean;
}

/** 管理表头漏斗筛选：按钮 + 固定定位下拉（避开 overflow 裁切）。 */
export function HeaderFilter({
  active,
  open,
  onOpen,
  onClose,
  children,
  width = 200,
}: {
  active: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) { onClose(); return; }
          if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: rect.left });
          }
          onOpen();
        }}
        className="inline-flex items-center justify-center rounded p-0.5 transition-colors"
        style={{
          color: active ? "var(--primary)" : "var(--muted-foreground)",
          background: active ? "var(--primary-tint-12)" : "transparent",
        }}
        aria-expanded={open}
      >
        <Filter className="h-3 w-3" strokeWidth={2} />
      </button>
      {open && pos && createPortal(
        <div
          ref={boxRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: Math.max(8, Math.min(pos.left, window.innerWidth - width - 8)),
            zIndex: 50,
            width,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 8,
            boxShadow: "0 12px 40px rgba(0,0,0,0.15)",
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 单选筛选列表（首项「全部」传空字符串）。 */
export function FilterList({
  options,
  selected,
  onSelect,
  allLabel,
  labelFor,
  emptyText,
}: {
  options: string[];
  selected: string;
  onSelect: (v: string) => void;
  allLabel: string;
  labelFor?: (v: string) => string;
  emptyText: string;
}) {
  const [kw, setKw] = useState("");
  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (!k) return options;
    return options.filter((o) => {
      const label = labelFor ? labelFor(o) : o;
      return label.toLowerCase().includes(k) || o.toLowerCase().includes(k);
    });
  }, [options, kw, labelFor]);

  if (options.length === 0) {
    return <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="space-y-1">
      {options.length > 8 && (
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder={allLabel}
          className="mb-1 w-full rounded-lg border border-border/40 bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-primary/15"
        />
      )}
      <div className="max-h-56 overflow-y-auto">
        {["", ...shown].map((v) => {
          const active = selected === v;
          return (
            <button
              key={v || "__all__"}
              type="button"
              onClick={() => onSelect(v)}
              className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                active
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              }`}
            >
              {v ? (labelFor ? labelFor(v) : v) : allLabel}
            </button>
          );
        })}
        {shown.length === 0 && (
          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">{emptyText}</div>
        )}
      </div>
    </div>
  );
}
