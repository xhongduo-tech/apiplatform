import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { useT } from "../../i18n";
import { usePlatformConfig } from "../../hooks/use-platform-config";

export function DocsFooter() {
  const { t } = useT();
  const { branding } = usePlatformConfig();
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto w-full max-w-[1200px] px-6 md:px-8 lg:px-10 py-12">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div>
            <div className="flex items-center gap-2 text-[18px] font-semibold text-foreground">
              <BookOpen className="h-5 w-5 text-primary" />
              {branding.brand} {branding.platform_name} Docs
            </div>
            <p className="mt-1 text-[13px] text-fg-muted">{t("docsPage.footer.desc")}</p>
          </div>
          <div className="flex flex-wrap gap-6 text-[13px] text-fg-muted">
            <Link to="/" className="transition-colors hover:text-foreground">{t("docsPage.footer.home")}</Link>
            <Link to="/models" className="transition-colors hover:text-foreground">{t("docsPage.footer.models")}</Link>
            <Link to="/keys" className="transition-colors hover:text-foreground">API Keys</Link>
            <Link to="/usage" className="transition-colors hover:text-foreground">{t("docsPage.footer.usage")}</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
