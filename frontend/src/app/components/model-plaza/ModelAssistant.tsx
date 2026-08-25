/**
 * ModelAssistant — 模型助手（按场景推荐模型）
 *
 * 从 ModelPlaza.tsx 抽出，提供收起/展开两种状态：
 *   - 收起：引导卡片 + CTA 按钮
 *   - 展开：场景按钮 + 推荐模型小卡
 */
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Lightbulb, ArrowRight, X } from "lucide-react";
import { useT, type TranslationKey } from "../../i18n";
import type { Model } from "../model-types";
import { SCENARIOS, type ScenarioKey } from "./plaza-constants";
import { ProviderIcon } from "../provider-logos";

export function ModelAssistant({ models }: { models: Model[] }) {
  const navigate = useNavigate();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ScenarioKey | null>(null);

  const scenarioI18n = useMemo(() => ({
    chat:   { label: t("modelPlaza.scenario.chat.label"),   reason: t("modelPlaza.scenario.chat.reason") },
    reason: { label: t("modelPlaza.scenario.reason.label"), reason: t("modelPlaza.scenario.reason.reason") },
    best:   { label: t("modelPlaza.scenario.best.label"),   reason: t("modelPlaza.scenario.best.reason") },
    fast:   { label: t("modelPlaza.scenario.fast.label"),   reason: t("modelPlaza.scenario.fast.reason") },
    vision: { label: t("modelPlaza.scenario.vision.label"), reason: t("modelPlaza.scenario.vision.reason") },
    rag:    { label: t("modelPlaza.scenario.rag.label"),    reason: t("modelPlaza.scenario.rag.reason") },
    ocr:    { label: t("modelPlaza.scenario.ocr.label"),    reason: t("modelPlaza.scenario.ocr.reason") },
  }), [t]);

  const scenario = SCENARIOS.find(s => s.key === picked);
  const recs = scenario ? scenario.pick(models) : [];
  const modelDesc = (id: string, fallback: string) => {
    const key = `modelPlaza.modelDesc.${id}`;
    const translated = t(key as TranslationKey);
    return translated === key ? fallback : translated;
  };

  return (
    <div
      className="animate-enter"
      style={{
        marginTop: 40,
        borderRadius: 14,
        border: "1px solid var(--border-strong)",
        background: "var(--card)",
        padding: open ? "20px 22px" : "16px 20px",
        transition: "padding 0.2s ease",
      }}
    >
      {!open ? (
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div
            style={{
              width: 38, height: 38, borderRadius: 10, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "var(--brand-soft)", color: "var(--brand)",
            }}
          >
            <Lightbulb size={18} strokeWidth={2} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 15, fontWeight: 550, color: "var(--fg)" }}>
              {t("modelPlaza.assistant.title")}
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 3, lineHeight: 1.5 }}>
              {t("modelPlaza.assistant.subtitle")}
            </div>
          </div>
          <button
            onClick={() => setOpen(true)}
            className="btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
          >
            {t("modelPlaza.assistant.cta")}
            <ArrowRight size={14} />
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Lightbulb size={17} strokeWidth={2} style={{ color: "var(--brand)" }} />
            <span style={{ fontSize: 15, fontWeight: 550, color: "var(--fg)" }}>{t("modelPlaza.assistant.header")}</span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => { setOpen(false); setPicked(null); }}
              style={{ padding: 4, borderRadius: 6, background: "none", border: "none", cursor: "pointer", color: "var(--fg-subtle)" }}
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>

          <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0 }}>
            {t("modelPlaza.assistant.question")}
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SCENARIOS.map(s => {
              const active = picked === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setPicked(s.key)}
                  style={{
                    padding: "7px 14px", borderRadius: 8, fontSize: 13, fontWeight: active ? 550 : 450,
                    border: `1px solid ${active ? "var(--brand)" : "var(--border-strong)"}`,
                    background: active ? "var(--brand-soft)" : "var(--card)",
                    color: active ? "var(--brand)" : "var(--fg)",
                    cursor: "pointer", whiteSpace: "nowrap",
                    transition: "all 0.15s var(--ease-out)",
                  }}
                >
                  {scenarioI18n[s.key].label}
                </button>
              );
            })}
          </div>

          {scenario && (
            <div className="animate-enter space-y-3">
              <p
                style={{
                  fontSize: 11, fontWeight: 580,
                  textTransform: "uppercase", letterSpacing: "0.08em",
                  color: "var(--fg-subtle)", margin: 0,
                }}
              >
                {t("modelPlaza.assistant.recommendation")}
              </p>
              <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: 0, lineHeight: 1.6 }}>
                {scenarioI18n[scenario.key].reason}
              </p>
              {recs.length > 0 ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: 10, marginTop: 6,
                  }}
                >
                  {recs.map(m => (
                    <div
                      key={m.id}
                      className="card-interactive"
                      style={{ padding: "12px 14px", cursor: "pointer" }}
                      onClick={() => navigate(`/models/${m.id}`)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <ProviderIcon provider={m.provider} id={m.id} size="sm" />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            className="truncate font-serif"
                            style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}
                          >
                            {m.name}
                          </div>
                          <div
                            className="truncate"
                            style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 3 }}
                          >
                            {modelDesc(m.id, m.shortDescription)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 12.5, color: "var(--fg-subtle)", margin: 0 }}>
                  {t("modelPlaza.noScenarioModels")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
