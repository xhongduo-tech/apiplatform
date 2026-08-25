import { useState } from "react";
import { ChevronRight, ArrowRight, Copy, Check, Info } from "lucide-react";
import { NewTabLink } from "../NewTabLink";
import { HomeSection } from "./section-shell";
import { EarlyAccessIcon } from "../early-access-icon";
import { useT } from "../../i18n";
import { copyText } from "../../browser-compat";

function CopyOnHover({ name, id }: { name: string; id: string }) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  const copy = () => {
    void copyText(name).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="relative inline-flex items-center gap-2.5" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className="text-[12px] text-fg-muted cursor-pointer select-none" onClick={copy}>{id}</span>
      <button
        type="button"
        onClick={copy}
        className="flex-shrink-0 rounded p-0.5 transition-colors hover:opacity-70"
        style={{ color: "var(--fg-muted)" }}
        aria-label="复制模型名称"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {hover && (
        <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] leading-none text-white shadow-md">
          复制模型名称 <code className="font-mono text-[11px]" style={{ color: "var(--chart-2)" }}>model_name</code>
        </span>
      )}
    </div>
  );
}

function StatLabel({ label, hint }: { label: string; hint?: string }) {
  const [hover, setHover] = useState(false);
  if (!hint) return <>{label}</>;
  return (
    <span className="relative inline-flex items-center gap-1" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {label}
      <Info size={11} className="text-fg-subtle" />
      {hover && (
        <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-56 whitespace-normal rounded bg-ink px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-md z-10">
          {hint}
        </span>
      )}
    </span>
  );
}

export function ModelFamilySection() {
  const { t } = useT();

  const family: {
    id: string; name: string; provider: string; tagline: string;
    tint: string; accent: string; stats: string[][];
    /** 抢先体验计划模型（后端 status=upcoming） */
    earlyAccess?: boolean;
  }[] = [
    {
      id: "demo-reasoning-model",
      name: "Demo Reasoning Model",
      provider: "Example Provider",
      tagline: t("models.deepseek.tagline"),
      tint: "rgba(217, 119, 87, 0.14)",
      accent: "#c6613f",
      stats: [
        [t("models.contextWindow"), "64K tokens"],
        [t("models.paramScale"), t("models.deepseek.params")],
        [t("models.stableAlias"), "platform-sota"],
      ],
    },
    {
      id: "demo-chat-model",
      name: "Demo Chat Model",
      provider: "Example Provider",
      tagline: t("models.qwen.tagline"),
      tint: "rgba(130, 125, 189, 0.16)",
      accent: "#6d68a8",
      stats: [
        [t("models.contextWindow"), "32K tokens"],
        [t("models.paramScale"), t("models.qwen.params")],
        [t("models.stableAlias"), "platform-flash"],
      ],
    },
    {
      id: "demo-vision-model",
      name: "Demo Vision Model",
      provider: "Example Provider",
      tagline: t("models.glm.tagline"),
      tint: "rgba(98, 153, 135, 0.16)",
      accent: "#4a7d6c",
      stats: [
        [t("models.contextWindow"), "16K tokens"],
        [t("models.paramScale"), t("models.glm.params")],
        [t("models.license"), "Demo"],
      ],
    },
  ];

  const moreCapabilities = [
    { label: t("models.cap.bge"), to: "/models/demo-embedding-model" },
    { label: t("models.cap.reranker"), to: "/models/demo-reranker-model" },
    { label: t("models.cap.qwen3vl"), to: "/models/demo-vision-model" },
    { label: t("models.cap.ocr"), to: "/models/demo-ocr-model" },
  ];

  return (
    <HomeSection
      eyebrow="The model family"
      title={t("models.title")}
      desc={t("models.desc")}
    >
      <div className="grid gap-5 md:grid-cols-3">
        {family.map((m) => (
          <div key={m.id} className="card group flex flex-col overflow-hidden transition-colors">
            <div className="px-6 pb-5 pt-6" style={{ background: m.tint }}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-medium" style={{ color: m.accent }}>{m.provider}</p>
                {m.earlyAccess && (
                  <span
                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px] font-medium"
                    style={{ background: "var(--card)", color: m.accent, border: `1px solid ${m.accent}33` }}
                  >
                    <EarlyAccessIcon size={11} strokeWidth={2.2} />
                    {t("earlyAccess.badge")}
                  </span>
                )}
              </div>
              <h3 className="mt-1 font-serif text-[22px] leading-tight text-fg" style={{ fontWeight: 500 }}>
                {m.name}
              </h3>
              <div className="mt-1.5">
                <CopyOnHover name={m.name} id={m.id} />
              </div>
            </div>
            <div className="flex flex-1 flex-col p-6">
              <p className="text-[13.5px] leading-relaxed text-fg-muted">{m.tagline}</p>
              <dl className="mt-5 flex-1">
                {m.stats.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between border-t border-border py-2.5 text-[13px]">
                    <dt className="text-fg-subtle">
                      <StatLabel label={k} hint={k === t("models.stableAlias") ? t("models.stableAliasHint") : undefined} />
                    </dt>
                    <dd className="tnum font-medium text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
              <a href={`/models/${m.id}`} className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-fg transition-colors group-hover:text-brand-hover">
                {t("models.detail")}
                <ChevronRight size={14} className="text-fg-subtle transition-transform group-hover:translate-x-0.5" />
              </a>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-fg-subtle">{t("models.more")}</span>
          {moreCapabilities.map((c) => (
            <NewTabLink key={c.to} to={c.to} className="chip transition-colors hover:text-fg">
              {c.label}
            </NewTabLink>
          ))}
        </div>
        <a
          href="/models"
          className="group inline-flex items-center gap-1.5 text-[14px] font-medium text-fg transition-colors hover:text-brand-hover"
        >
          {t("models.all")}
          <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>
    </HomeSection>
  );
}
