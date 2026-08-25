import { useState } from "react";
import { X, Info, ChevronRight } from "lucide-react";
import { ModalPortal } from "./admin-tab-utils";
import {
  APPLICATION_LAYER_ITEMS,
  HARDWARE_NODES,
  INFRA_TECH_BY_ID,
  INFERENCE_TECH_IDS,
  MODEL_DEPLOYMENTS,
  RUNTIME_TECH_IDS,
  type InfraTechDetail,
  type InfraTechId,
} from "./infra-stack-data";
import { InfraTechDetailModal } from "./infra-tech-detail-modal";
import {
  InfraDeploymentIcon,
  InfraHardwareIcon,
  InfraLayerBanner,
  InfraTechBadge,
} from "./infra-visuals";
import { useT, type TranslationKey } from "../i18n";

export type InfraLayerId = "application" | "hardware" | "runtime" | "inference" | "model";

const LAYER_TITLE: Record<InfraLayerId, TranslationKey> = {
  application: "admin.infra.layer.application.title",
  hardware: "admin.infra.layer.hardware.title",
  runtime: "admin.infra.layer.runtime.title",
  inference: "admin.infra.layer.inference.title",
  model: "admin.infra.layer.model.title",
};

const LAYER_DESC: Record<InfraLayerId, TranslationKey> = {
  application: "admin.infra.layer.application.desc",
  hardware: "admin.infra.layer.hardware.desc",
  runtime: "admin.infra.layer.runtime.desc",
  inference: "admin.infra.layer.inference.desc",
  model: "admin.infra.layer.model.desc",
};

function ModelDeploymentRow({
  dep,
  onEngineClick,
}: {
  dep: (typeof MODEL_DEPLOYMENTS)[number];
  onEngineClick: (id: InfraTechId) => void;
}) {
  const { t } = useT();

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4">
      <div className="flex gap-3">
        <InfraDeploymentIcon depId={dep.id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="font-serif text-[13px] font-medium text-foreground">{t(dep.modelKey)}</h4>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t(dep.quantKey)}</p>
            </div>
            <button
              type="button"
              onClick={() => onEngineClick(dep.engineId)}
              className="flex items-center gap-1.5 rounded-lg bg-secondary/80 px-2 py-1 hover:bg-secondary"
            >
              <InfraTechBadge techId={dep.engineId} size="sm" />
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">{t(dep.hardwareKey)}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {[
          { label: t("admin.infra.dep.col.kv"), value: t(dep.kvKey) },
          { label: t("admin.infra.dep.col.concurrency"), value: t(dep.concurrencyKey) },
          { label: t("admin.infra.dep.col.context"), value: t(dep.contextKey) },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg bg-secondary/40 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-0.5 text-[11.5px] font-medium tabular-nums text-foreground">{value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-1.5 border-t border-border/30 pt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        {t(dep.scriptKey)}
      </p>
    </div>
  );
}

function LayerBody({
  layer,
  onTechClick,
}: {
  layer: InfraLayerId;
  onTechClick: (tech: InfraTechDetail) => void;
}) {
  const { t } = useT();

  if (layer === "application") {
    return (
      <div className="space-y-3">
        <p className="rounded-lg bg-secondary/40 px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {t("admin.infra.layer.application.hint")}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {APPLICATION_LAYER_ITEMS.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-border/40 bg-card px-3.5 py-3"
              style={{ borderLeftWidth: 3, borderLeftColor: item.accent }}
            >
              <p className="font-serif text-[13px] font-medium text-foreground">{t(item.sceneKey)}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{t(item.descKey)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (layer === "hardware") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {HARDWARE_NODES.map((node) => (
          <div
            key={node.id}
            className="flex gap-3 rounded-xl border border-border/40 bg-card px-3.5 py-3"
            style={{ borderLeftWidth: 3, borderLeftColor: node.accent }}
          >
            <InfraHardwareIcon nodeId={node.id} accent={node.accent} />
            <div className="min-w-0">
              <p className="font-serif text-[13px] font-medium text-foreground">{t(node.specKey)}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{t(node.roleKey)}</p>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (layer === "runtime") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {RUNTIME_TECH_IDS.map((id) => {
          const tech = INFRA_TECH_BY_ID[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTechClick(tech)}
              className="flex gap-3 rounded-xl border border-border/40 bg-card p-4 text-left transition-all hover:border-primary/30 hover:shadow-sm"
            >
              <InfraTechBadge techId={id} size="md" />
              <div className="min-w-0 flex-1">
                <p className="font-serif text-[13px] font-medium text-foreground">{t(tech.labelKey)}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground line-clamp-2">{t(tech.summaryKey)}</p>
                <p className="mt-2 text-[11px] font-medium text-primary">{t("admin.infra.tech.clickDetail")}</p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  if (layer === "inference") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {INFERENCE_TECH_IDS.map((id) => {
          const tech = INFRA_TECH_BY_ID[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTechClick(tech)}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-card px-3.5 py-3 text-left transition-all hover:border-primary/40 hover:shadow-sm"
            >
              <InfraTechBadge techId={id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="font-serif text-[13px] font-medium text-foreground">{t(tech.labelKey)}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t(tech.tagKey)}</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {MODEL_DEPLOYMENTS.map((dep) => (
        <ModelDeploymentRow
          key={dep.id}
          dep={dep}
          onEngineClick={(id) => onTechClick(INFRA_TECH_BY_ID[id])}
        />
      ))}
    </div>
  );
}

export function InfraLayerDetailModal({
  layer,
  onClose,
}: {
  layer: InfraLayerId | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [techDetail, setTechDetail] = useState<InfraTechDetail | null>(null);

  if (!layer) return null;

  return (
    <>
      <ModalPortal open={!!layer} onClose={onClose} zIndex={10065}>
        <div
          className="relative flex max-h-[min(88vh,720px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="shrink-0 border-b border-border/40 px-5 py-4 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-serif text-[17px] font-medium text-foreground">{t(LAYER_TITLE[layer])}</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{t(LAYER_DESC[layer])}</p>
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
            <InfraLayerBanner layer={layer} />
            <LayerBody layer={layer} onTechClick={setTechDetail} />
          </div>
        </div>
      </ModalPortal>
      <InfraTechDetailModal detail={techDetail} onClose={() => setTechDetail(null)} />
    </>
  );
}