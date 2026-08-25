import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Moon, Sun, Monitor } from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";

type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "apiplatform-theme";

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* ignore */ }
  return "system";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

function applyTheme(mode: ThemeMode) {
  const isDark = resolveTheme(mode) === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
}

const OPTIONS: { mode: ThemeMode; labelKey: TranslationKey; icon: typeof Sun }[] = [
  { mode: "light", labelKey: "theme.light", icon: Sun },
  { mode: "dark", labelKey: "theme.dark", icon: Moon },
  { mode: "system", labelKey: "theme.system", icon: Monitor },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { t } = useT();
  const [mode, setMode] = useState<ThemeMode>(readMode);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen(!open);
  };

  const current = OPTIONS.find((o) => o.mode === mode) ?? OPTIONS[2];
  const Icon = current.icon;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`header-nav__icon-btn ${className}`}
        onClick={toggle}
        aria-label={t("theme.toggle")}
        title={t(current.labelKey)}
      >
        <Icon size={16} strokeWidth={2} />
      </button>
      {open && pos && createPortal(
        <div className="theme-toggle__dropdown" style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}>
          {OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              className={`theme-toggle__option${mode === opt.mode ? " theme-toggle__option--active" : ""}`}
              onClick={() => { setMode(opt.mode); setOpen(false); }}
            >
              <opt.icon size={14} strokeWidth={2} />
              <span>{t(opt.labelKey)}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
