import { KeyRound, Code2, Sparkles, ArrowRight } from "lucide-react";
import { NewTabLink } from "../NewTabLink";
import { useT } from "../../i18n";

/* 首页收尾区：品牌色柔光面板 + 三步连接线。
   作为 footer 之前的最后一个内容区，视觉上要与上方正文（纸白底）拉开层次。 */
export function GetStartedSection() {
  const { t } = useT();

  const steps = [
    {
      icon: KeyRound,
      titleKey: "cta.step1.title",
      descKey: "cta.step1.desc",
      to: "/keys",
      ctaKey: "cta.step1.cta",
    },
    {
      icon: Code2,
      titleKey: "cta.step2.title",
      descKey: "cta.step2.desc",
      to: "/docs",
      ctaKey: "cta.step2.cta",
    },
    {
      icon: Sparkles,
      titleKey: "cta.step3.title",
      descKey: "cta.step3.desc",
      to: "/models",
      ctaKey: "cta.step3.cta",
    },
  ];

  return (
    <section className="apiplatform-reveal relative mx-auto w-full max-w-[1200px] px-6 md:px-8 lg:px-10 py-10 md:py-16">
      {/* 品牌色柔光：直接铺在页面底色上、四周自然淡出，与背景融为一体，不设面板盒子 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, rgba(var(--brand-rgb), 0.12), transparent 72%)",
        }}
      />

        <div className="relative text-center">
          <p className="section-label">Ready to Build</p>
          <h2
            className="mx-auto mt-3 max-w-[22ch] font-serif text-[30px] leading-snug md:text-[38px]"
            style={{ fontWeight: 500 }}
          >
            {t("cta.title")}
          </h2>
          <p className="mx-auto mt-4 max-w-[48ch] font-serif text-[17px] font-[430] leading-relaxed text-fg-lead md:text-[18px]">
            {t("cta.desc")}
          </p>
        </div>

        <div className="relative mt-12 grid gap-4 md:grid-cols-3 md:gap-6">
          {/* 桌面端步骤连接虚线：穿过图标行高度（top 44px = p-6 24 + 图标半高 20），
             三个品牌色图标「坐」在虚线上，串成三步旅程；隐藏于图标之后、在卡片间隙露出 */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-[16.66%] right-[16.66%] top-[44px] hidden border-t border-dashed border-border md:block"
          />
          {steps.map((s, i) => {
            const inner = (
              <>
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-white"
                  style={{ background: "var(--brand-solid)" }}
                >
                  <s.icon size={18} strokeWidth={2} />
                </div>
                <div className="mt-4 flex items-center justify-between gap-2">
                  <h3 className="font-serif text-[17px] font-medium text-fg">{t(s.titleKey as any)}</h3>
                  <span
                    aria-hidden
                    className="font-serif text-[34px] font-[600] leading-none text-fg"
                    style={{ opacity: 0.16 }}
                  >
                    {i + 1}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">{t(s.descKey as any)}</p>
                <div className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-fg transition-colors group-hover:text-brand">
                  {t(s.ctaKey as any)}
                  <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                </div>
              </>
            );
            const cls = "group flex h-full flex-col rounded-xl p-5 transition-colors hover:bg-bg-soft/70 md:p-6";
            return <NewTabLink key={s.to} to={s.to} className={cls}>{inner}</NewTabLink>;
          })}
        </div>
    </section>
  );
}
