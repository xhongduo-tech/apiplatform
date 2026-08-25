import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import zhCN from "./zh-CN";
import { usePlatformConfig } from "../hooks/use-platform-config";

type Lang = "zh-CN" | "zh-TW" | "en";
export type { Lang };
export type TranslationKey = keyof typeof zhCN;

type Dictionary = Record<string, string>;
const dictionaries: Partial<Record<Lang, Dictionary>> = {
  "zh-CN": zhCN as Dictionary,
};

async function loadDictionary(lang: Lang): Promise<Dictionary> {
  const cached = dictionaries[lang];
  if (cached) return cached;
  const module = lang === "zh-TW" ? await import("./zh-TW") : await import("./en");
  const dictionary = module.default as Dictionary;
  dictionaries[lang] = dictionary;
  return dictionary;
}

function readLang(): Lang {
  try {
    const v = localStorage.getItem("apiplatform-lang");
    if (v === "zh-CN" || v === "zh-TW" || v === "en") return v;
  } catch { /* ignore */ }
  return "zh-CN";
}

function render(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  const [activeDictionary, setActiveDictionary] = useState<{
    lang: Lang;
    value: Dictionary;
  }>(() => ({ lang: "zh-CN", value: zhCN as Dictionary }));
  const { branding } = usePlatformConfig();

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem("apiplatform-lang", l); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let active = true;
    void loadDictionary(lang).then((value) => {
      if (active) setActiveDictionary({ lang, value });
    }).catch(() => {
      if (active) setActiveDictionary({ lang: "zh-CN", value: zhCN as Dictionary });
    });
    if (lang === "zh-TW") {
      void import("@fontsource-variable/noto-sans-tc").catch(() => {
        /* system Traditional Chinese fonts remain the fallback */
      });
    }
    return () => { active = false; };
  }, [lang]);

  // Keep the document language aligned with the dictionary actually rendered;
  // a cached non-default locale loads as a small async chunk on first mount.
  useEffect(() => {
    document.documentElement.lang = activeDictionary.lang;
  }, [activeDictionary.lang]);

  const t = useCallback<TFn>(
    (key, vars) => {
      const raw = activeDictionary.value[key] ?? (zhCN as Dictionary)[key] ?? key;
      return render(raw, {
        brand: branding.brand,
        platformName: branding.platform_name,
        organization: branding.organization_name,
        supportDepartment: branding.support_department,
        supportContact: branding.support_contact,
        supportEmail: branding.support_email,
        approvalDepartment: branding.approval_department,
        approvalContact: branding.approval_contact,
        approvalEmail: branding.approval_email,
        ...vars,
      });
    },
    [activeDictionary.value, branding],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx;
}
