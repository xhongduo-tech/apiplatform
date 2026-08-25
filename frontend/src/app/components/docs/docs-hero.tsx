import { Search, KeyRound } from "lucide-react";
import { Link } from "react-router-dom";

import { useT } from "../../i18n";
import { DOCS_BASE_HOST } from "./docs-constants";
import { usePlatformConfig } from "../../hooks/use-platform-config";

export function DocsHero({ onSearchClick }: { onSearchClick?: () => void }) {
  const { t } = useT();
  const { branding } = usePlatformConfig();

  return (
    <header className="docs-header">
      <div className="docs-header__inner">
        <div className="docs-header__left">
          <nav className="docs-breadcrumb" aria-label="Breadcrumb">
            <a href="/" className="docs-breadcrumb__link">{branding.brand}</a>
            <span className="docs-breadcrumb__sep">/</span>
            <span className="docs-breadcrumb__current">API Reference</span>
          </nav>
          <h1 className="docs-header__title">{t("docsPage.header.title")}</h1>
        </div>
        <div className="docs-header__right">
          <div className="docs-header__actions">
            <button
              type="button"
              onClick={onSearchClick}
              className="docs-search-trigger"
            >
              <Search className="h-3.5 w-3.5" />
              <span>{t("docsPage.header.searchHint")}</span>
              <kbd className="docs-search-trigger__kbd">⌘K</kbd>
            </button>
            <Link to="/keys" className="docs-header__cta">
              <KeyRound size={14} />
              <span>{t("docsPage.nav.cta.getKey")}</span>
            </Link>
          </div>
          <div className="docs-header__badges">
            <span className="docs-badge docs-badge--ok">v1 · Stable</span>
            <span className="docs-badge">Base URL: <code>{DOCS_BASE_HOST}</code></span>
          </div>
        </div>
      </div>
    </header>
  );
}
