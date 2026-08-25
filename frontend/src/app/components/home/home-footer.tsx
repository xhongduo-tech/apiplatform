import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useT } from "../../i18n";
import { useContactDialog } from "../../hooks/use-contact-dialog";
import { usePlatformConfig } from "../../hooks/use-platform-config";

export function HomeFooter() {
  const { t } = useT();
  const { openDialog } = useContactDialog();
  const { branding } = usePlatformConfig();

  return (
    <footer className="relative overflow-hidden bg-bg-soft">
      {/* 顶部渐变发丝线：与上方页面衔接更柔和，不突兀 */}
      <div
        aria-hidden
        className="h-px w-full"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--border) 20%, var(--border) 80%, transparent)",
        }}
      />
      {/* 顶部品牌色柔光：灰底不单调，带一点暖意与层次 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-44"
        style={{
          background:
            "radial-gradient(55% 100% at 50% 0%, rgba(var(--brand-rgb), 0.07), transparent 70%)",
        }}
      />

      <div className="relative mx-auto w-full max-w-[1200px] px-6 md:px-8 lg:px-10 py-12 md:py-16">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center rounded-lg bg-black px-3 py-1.5 font-serif text-[0.9375rem] font-bold tracking-tight text-white">
                {branding.brand}
              </span>
              <span className="whitespace-nowrap font-serif text-[15px] font-semibold leading-none text-fg">
                {branding.platform_name}
              </span>
            </div>
            <span className="footer-slogan">{branding.slogan}</span>
            <p className="mt-3 max-w-[26ch] font-serif text-[13px] leading-relaxed text-fg-muted">
              {t("footer.desc")}
            </p>
          </div>

          <FootCol
            title={t("footer.platform")}
            links={[
              [t("footer.models"), "/models"],
              [t("footer.keys"), "/keys"],
              [t("footer.usage"), "/usage"],
            ]}
          />
          <FootCol
            title={t("footer.resources")}
            links={[
              [t("footer.docs"), "/docs"],
              [t("footer.feedback"), "/forum"],
            ]}
          />
          <FootCol
            title={t("footer.support")}
            links={[
              [t("footer.logs"), "/logs"],
              [t("footer.status"), "/logs"],
            ]}
            extra={
              <li key="contact">
                <button
                  type="button"
                  className="group inline-flex items-center gap-1.5 text-[13.5px] text-fg-muted transition-colors hover:text-fg"
                  onClick={openDialog}
                >
                  {t("header.contact")}
                  <ArrowRight
                    size={12}
                    className="opacity-0 -translate-x-1 text-fg-subtle transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                  />
                </button>
              </li>
            }
          />
        </div>
      </div>

      <div className="relative border-t border-border">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-2 px-6 py-5 text-[12px] text-fg-subtle md:px-8 lg:px-10">
          <span>{branding.footer_text}</span>
          <span>{t("footer.internal")}</span>
        </div>
      </div>
    </footer>
  );
}

function FootCol({ title, links, extra }: { title: string; links: [string, string][]; extra?: ReactNode }) {
  return (
    <div>
      <div className="mb-4 text-[12px] font-medium uppercase tracking-wider text-fg-muted">{title}</div>
      <ul className="flex flex-col gap-2.5">
        {links.map(([label, to]) => (
          <li key={label + to}>
            <Link
              to={to}
              className="group inline-flex items-center gap-1.5 text-[13.5px] text-fg-muted transition-colors hover:text-fg"
            >
              {label}
              <ArrowRight
                size={12}
                className="opacity-0 -translate-x-1 text-fg-subtle transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
              />
            </Link>
          </li>
        ))}
        {extra}
      </ul>
    </div>
  );
}
