import { Rocket, Hammer, ShieldCheck, Gauge, ChevronRight } from "lucide-react";
import { NewTabLink } from "../NewTabLink";
import { HomeSection } from "./section-shell";
import { useT } from "../../i18n";

export function WorkflowSection() {
  const { t } = useT();

  const columns = [
    {
      icon: Rocket,
      title: t("workflow.start"),
      links: [
        { label: t("workflow.applyKey"), desc: t("workflow.applyKeyDesc"), to: "/keys" },
        { label: t("workflow.config"), desc: t("workflow.configDesc"), to: "/docs" },
        { label: t("workflow.poc"), desc: t("workflow.pocDesc"), to: "/models" },
      ],
    },
    {
      icon: Hammer,
      title: t("workflow.build"),
      links: [
        { label: t("workflow.chat"), desc: t("workflow.chatDesc"), to: "/docs?section=api-reference" },
        { label: t("workflow.vector"), desc: t("workflow.vectorDesc"), to: "/docs?section=more-capabilities" },
        { label: t("workflow.agent"), desc: t("workflow.agentDesc"), to: "/docs?section=agent-tools" },
      ],
    },
    {
      icon: ShieldCheck,
      title: t("workflow.eval"),
      links: [
        { label: t("workflow.ratelimit"), desc: t("workflow.ratelimitDesc"), to: "/docs?section=api-reference" },
        { label: t("workflow.context"), desc: t("workflow.contextDesc"), to: "/docs?section=api-reference" },
        { label: t("workflow.night"), desc: t("workflow.nightDesc"), to: "/night-batch" },
      ],
    },
    {
      icon: Gauge,
      title: t("workflow.observe"),
      links: [
        { label: t("workflow.usageTitle"), desc: t("workflow.usageTitleDesc"), to: "/usage" },
        { label: t("workflow.logTitle"), desc: t("workflow.logTitleDesc"), to: "/logs" },
        { label: t("workflow.statusTitle"), desc: t("workflow.statusTitleDesc"), to: "/status" },
      ],
    },
  ] as const;

  return (
    <HomeSection
      eyebrow="From idea to production"
      title={t("workflow.title")}
      desc={t("workflow.desc")}
    >
      <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {columns.map((col) => (
          <div key={col.title}>
            <div className="flex items-center gap-2.5 border-b border-border pb-3">
              <col.icon size={16} className="text-fg-muted" strokeWidth={2} />
              <h3 className="font-serif text-[15px] font-medium text-fg">{col.title}</h3>
            </div>
            <ul className="mt-4 space-y-3.5">
              {col.links.map((link) => (
                <li key={link.label}>
                  <NewTabLink to={link.to} className="group flex items-start gap-1.5">
                    <ChevronRight size={14} className="mt-[3px] shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
                    <span>
                      <span className="block text-[13.5px] font-medium text-fg transition-colors group-hover:text-brand-hover">
                        {link.label}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-fg-subtle">{link.desc}</span>
                    </span>
                  </NewTabLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </HomeSection>
  );
}
