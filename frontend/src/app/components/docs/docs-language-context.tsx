import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import type { TabKey } from "./scenario-data";

interface DocsLangContextValue {
  activeTab: TabKey;
  setActiveTab: (k: TabKey) => void;
}

const DocsLangContext = createContext<DocsLangContextValue | null>(null);

function readPreferredTab(): TabKey {
  try {
    const v = localStorage.getItem("apiplatform-docs-tab");
    if (v === "python" || v === "curl" || v === "nodejs") return v;
  } catch { /* ignore */ }
  return "python";
}

export function DocsLanguageProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTabState] = useState<TabKey>(readPreferredTab);

  const setActiveTab = useCallback((k: TabKey) => {
    setActiveTabState(k);
    try { localStorage.setItem("apiplatform-docs-tab", k); } catch { /* ignore */ }
  }, []);

  const value = useMemo(() => ({ activeTab, setActiveTab }), [activeTab, setActiveTab]);

  return (
    <DocsLangContext.Provider value={value}>
      {children}
    </DocsLangContext.Provider>
  );
}

export function useDocsLanguage() {
  const ctx = useContext(DocsLangContext);
  if (!ctx) throw new Error("useDocsLanguage must be used within DocsLanguageProvider");
  return ctx;
}
