import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { useT } from "../../i18n";
import { PYTHON, CURL, NODEJS, SCENARIOS, type ScenarioKey, type TabKey } from "./scenario-data";
import { DocsHero } from "./docs-hero";
import { DocsSidebar } from "./docs-sidebar";
import { DocsContent, buildTocItems } from "./docs-content";
import { ScenarioModal } from "./scenario-modal";
import { DocsFooter } from "./docs-footer";
import { DocsLanguageProvider } from "./docs-language-context";
import { DOCS_BASE_URL, scrollBehavior } from "./docs-constants";
import "./docs-page.css";

import { DocsSearchModal } from "./docs-search";
import { SECTION_CONTENT_KEYS } from "./docs-search-data";
import { chooseActiveSection } from "./active-section";

function DocsPageInner() {
  const { t } = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeSection, setActiveSection] = useState<string>("introduction");
  const [scenario, setScenario] = useState<ScenarioKey | null>(null);
  const [scenarioTab, setScenarioTab] = useState<TabKey>("python");
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const navTriggerRef = useRef<HTMLButtonElement>(null);

  const tocItems = useMemo(() => buildTocItems(t), [t]);

  const sidebarSections = useMemo(
    () => tocItems.filter(i => i.level === 2).map(i => ({ id: i.id, label: i.label })),
    [tocItems],
  );

  const searchItems = useMemo(
    () => tocItems
      .filter(i => i.level === 2)
      .map(i => {
        const keys = SECTION_CONTENT_KEYS[i.id] ?? [];
        const content = keys.map(k => {
          try { return t(k as Parameters<typeof t>[0]); } catch { return ""; }
        }).join(" ");
        return { id: i.id, label: i.label, content };
      }),
    [tocItems, t],
  );

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      setSearchParams({ section: id }, { replace: true });
    }
    setNavOpen(false);
  }, [setSearchParams]);

  const currentSectionLabel = useMemo(
    () => sidebarSections.find((s) => s.id === activeSection)?.label ?? "",
    [sidebarSections, activeSection],
  );

  useEffect(() => {
    const sectionParam = searchParams.get("section");
    if (sectionParam) {
      setTimeout(() => {
        const el = document.getElementById(sectionParam);
        if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      }, 150);
    }
  }, [searchParams]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      let frame = 0;
      const update = () => {
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(() => {
          const positions = sidebarSections.flatMap(({ id }) => {
            const element = document.getElementById(id);
            return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
          });
          const next = chooseActiveSection(positions);
          if (next) setActiveSection(next);
        });
      };
      update();
      window.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", update);
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener("scroll", update);
        window.removeEventListener("resize", update);
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: [0, 0.2, 1] },
    );
    sidebarSections.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sidebarSections]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // 移动端抽屉打开时锁定背景滚动
  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [navOpen]);

  // 移动端抽屉：焦点管理（打开时移入抽屉、Tab 焦点陷阱、关闭时归还触发按钮）
  useEffect(() => {
    if (!navOpen) return;
    const trigger = navTriggerRef.current;
    const drawer = drawerRef.current;
    const focusables = () =>
      Array.from(
        drawer?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    drawer?.addEventListener("keydown", onKeyDown);
    return () => {
      drawer?.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [navOpen]);

  const openScenario = useCallback((k: ScenarioKey) => setScenario(k), []);

  return (
    <div className="docs-page">
      <DocsHero onSearchClick={() => setSearchOpen(true)} />

      <button
        ref={navTriggerRef}
        type="button"
        className="docs-mobile-navbar"
        onClick={() => setNavOpen(true)}
        aria-label={t("docsPage.nav.mobileMenu")}
        aria-expanded={navOpen}
      >
        <Menu size={16} />
        <span className="docs-mobile-navbar__label">
          {currentSectionLabel || t("docsPage.nav.mobileMenu")}
        </span>
      </button>

      <div className="docs-page__shell">
        {navOpen && (
          <div
            className="docs-page__overlay"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
        )}
        <div
          ref={drawerRef}
          className={`docs-page__left${navOpen ? " is-open" : ""}`}
          role={navOpen ? "dialog" : undefined}
          aria-modal={navOpen ? true : undefined}
          aria-label={navOpen ? t("docsPage.nav.mobileMenu") : undefined}
        >
          <button
            type="button"
            className="docs-drawer-close"
            onClick={() => setNavOpen(false)}
            aria-label={t("docsPage.nav.close")}
          >
            <X size={18} />
          </button>
          <DocsSidebar active={activeSection} onJump={jumpTo} />
        </div>

        <main className="docs-page__main">
          <DocsContent openScenario={openScenario} />
          <DocsFooter />
        </main>
      </div>

      {searchOpen && (
        <DocsSearchModal
          items={searchItems}
          onSelect={jumpTo}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {scenario && (
        <ScenarioModal
          scenario={scenario}
          tab={scenarioTab}
          onTabChange={setScenarioTab}
          onClose={() => setScenario(null)}
          renderCode={(tpl: string) => tpl.replace(/\{\{BASE_URL\}\}/g, DOCS_BASE_URL)}
        />
      )}
    </div>
  );
}

export function DocsPage() {
  return (
    <DocsLanguageProvider>
      <DocsPageInner />
    </DocsLanguageProvider>
  );
}
