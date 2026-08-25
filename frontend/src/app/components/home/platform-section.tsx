import {
  ListOrdered,
  Zap,
  Boxes,
  Cpu,
  GitBranch,
  Layers,
  Server,
  Network,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { HomeSection } from "./section-shell";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n";

type InfraItem = {
  icon: LucideIcon;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  badgeKey?: TranslationKey;
};

const infraItems: InfraItem[] = [
  { icon: ListOrdered, titleKey: "platform.infra1.title", descKey: "platform.infra1.desc" },
  { icon: Cpu, titleKey: "platform.infra2.title", descKey: "platform.infra2.desc", badgeKey: "platform.infra2.badge" },
  { icon: Zap, titleKey: "platform.infra3.title", descKey: "platform.infra3.desc" },
  { icon: GitBranch, titleKey: "platform.infra4.title", descKey: "platform.infra4.desc" },
  { icon: Sparkles, titleKey: "platform.infra5.title", descKey: "platform.infra5.desc" },
  { icon: Server, titleKey: "platform.infra6.title", descKey: "platform.infra6.desc" },
  { icon: Network, titleKey: "platform.infra7.title", descKey: "platform.infra7.desc" },
  { icon: Boxes, titleKey: "platform.infra8.title", descKey: "platform.infra8.desc" },
  { icon: Layers, titleKey: "platform.infra9.title", descKey: "platform.infra9.desc", badgeKey: "platform.infra9.badge" },
];

function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function PlatformInfraSection({
  totalCalls,
  totalTokens,
  activeKeys,
}: {
  totalCalls: number;
  totalTokens: number;
  activeKeys: number;
}) {
  const { t } = useT();

  const stats: { label: string; value: string; unit?: string }[] = [
    { label: t("platform.totalCalls"), value: fmtCompact(totalCalls), unit: t("platform.callsUnit") },
    { label: t("platform.totalTokens"), value: fmtCompact(totalTokens), unit: "tokens" },
    { label: t("platform.activeKeys"), value: fmtCompact(activeKeys), unit: t("platform.keysUnit") },
  ];

  return (
    <HomeSection
      eyebrow="Robust Infrastructure"
      title={t("platform.title")}
    >
      <div className="grid gap-6 border-b border-border pb-10 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="home-stat-value tnum text-[32px] leading-none md:text-[40px]">
              {s.value}
              {s.unit && (
                <span className="ml-1.5 text-[15px] font-[450] text-fg-muted md:text-[17px]">{s.unit}</span>
              )}
            </p>
            <p className="mt-2 text-[13px] text-fg-muted">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-10 infra-grid">
        {infraItems.map((item, i) => (
          <div key={i} className="infra-grid__cell">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-soft text-fg">
              <item.icon size={18} strokeWidth={2} />
            </div>
            <h3 className="font-serif text-[15px] font-medium text-fg">
              {t(item.titleKey)}
              {item.badgeKey && (
                <span className="ml-2 inline-flex items-center rounded-full bg-brand-soft px-2 py-[1px] text-[10px] font-semibold tracking-wider text-brand">
                  {t(item.badgeKey)}
                </span>
              )}
            </h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">{t(item.descKey)}</p>
          </div>
        ))}
      </div>
    </HomeSection>
  );
}
