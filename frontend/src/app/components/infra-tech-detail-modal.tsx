import { X, Lightbulb, Cpu } from "lucide-react";
import { ModalPortal } from "./admin-tab-utils";
import { type InfraTechDetail } from "./infra-stack-data";
import { InfraTechBadge, InfraTechFlowDiagram, InfraTechHeroImage } from "./infra-visuals";
import { useT } from "../i18n";

export function InfraTechDetailModal({
  detail,
  onClose,
}: {
  detail: InfraTechDetail | null;
  onClose: () => void;
}) {
  const { t } = useT();
  if (!detail) return null;

  return (
    <ModalPortal open={!!detail} onClose={onClose} zIndex={10070}>
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border/50 bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <InfraTechHeroImage techId={detail.id} />

        <div className="border-b border-border/40 px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex gap-3">
              <InfraTechBadge techId={detail.id} size="lg" />
              <div>
                <span className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {t(detail.tagKey)}
                </span>
                <h3 className="mt-2 font-serif text-[17px] font-medium text-foreground">{t(detail.titleKey)}</h3>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{t(detail.summaryKey)}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
              aria-label={t("docsPage.modal.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <InfraTechFlowDiagram techId={detail.id} />

          <div className="flex items-start gap-2 rounded-lg border border-border/40 bg-bg-soft/50 px-3 py-2.5 text-[12px] text-muted-foreground">
            <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
            <span>{t(detail.fitKey)}</span>
          </div>

          <div>
            <p className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Lightbulb className="h-3.5 w-3.5" />
              {t("admin.infra.tech.pointsTitle")}
            </p>
            <ul className="space-y-2">
              {detail.pointKeys.map((key) => (
                <li key={key} className="flex gap-2 text-[12.5px] leading-relaxed text-foreground/90">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
