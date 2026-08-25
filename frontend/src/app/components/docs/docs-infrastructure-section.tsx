import {
  ListOrdered,
  Server,
  Network,
  Zap,
  Layers,
  Database,
  Shield,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { DocsSection } from "./docs-section";
import { DocsFlowDiagram } from "./docs-flow-diagram";
import { P } from "./docs-shared";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n";

type InfraItem = {
  icon: LucideIcon;
  titleKey: TranslationKey;
  descKey: TranslationKey;
};

const infraItems: InfraItem[] = [
  {
    icon: ListOrdered,
    titleKey: "docsPage.infrastructure.items.rateLimit.title",
    descKey: "docsPage.infrastructure.items.rateLimit.desc",
  },
  {
    icon: Server,
    titleKey: "docsPage.infrastructure.items.roundRobin.title",
    descKey: "docsPage.infrastructure.items.roundRobin.desc",
  },
  {
    icon: Network,
    titleKey: "docsPage.infrastructure.items.forward.title",
    descKey: "docsPage.infrastructure.items.forward.desc",
  },
  {
    icon: Zap,
    titleKey: "docsPage.infrastructure.items.metering.title",
    descKey: "docsPage.infrastructure.items.metering.desc",
  },
  {
    icon: Database,
    titleKey: "docsPage.infrastructure.items.redisSentinel.title",
    descKey: "docsPage.infrastructure.items.redisSentinel.desc",
  },
  {
    icon: Layers,
    titleKey: "docsPage.infrastructure.items.hotCache.title",
    descKey: "docsPage.infrastructure.items.hotCache.desc",
  },
  {
    icon: Shield,
    titleKey: "docsPage.infrastructure.items.disconnectGuard.title",
    descKey: "docsPage.infrastructure.items.disconnectGuard.desc",
  },
  {
    icon: RefreshCw,
    titleKey: "docsPage.infrastructure.items.fallback.title",
    descKey: "docsPage.infrastructure.items.fallback.desc",
  },
];

export function DocsInfrastructureSection() {
  const { t } = useT();

  return (
    <DocsSection
      id="infrastructure"
      eyebrow={t("docsPage.infrastructure.eyebrow")}
      title={t("docsPage.infrastructure.title")}
      desc={t("docsPage.infrastructure.desc")}
    >
      <div className="infra-grid">
        {infraItems.map((item, i) => (
          <div key={i} className="infra-grid__cell">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-soft text-fg">
              <item.icon size={18} strokeWidth={2} />
            </div>
            <h3 className="font-serif text-[15px] font-medium text-fg">
              {t(item.titleKey)}
            </h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">{t(item.descKey)}</p>
          </div>
        ))}
      </div>

      {/* 原「请求流程」小节并入此处；锚点 id 由 DocsFlowDiagram 根节点承载，兼容旧深链 */}
      <h3 className="docs-h3">{t("docsPage.flow.title")}</h3>
      <P htmlKey="docsPage.flow.desc" />
      <DocsFlowDiagram />
    </DocsSection>
  );
}
