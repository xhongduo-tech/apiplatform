/** 开源演示目录的主推模型卡片条。 */
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Copy, Check } from "lucide-react";
import { useT } from "../../i18n";
import { copyText } from "../../browser-compat";

export function FeaturedStrip({ onOpen, onStableClick }: { onOpen: (id: string) => void; onStableClick: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const FEATURED = useMemo(() => [
    { id: "demo-reasoning-model", badge: t("modelPlaza.featured.badgeFlagship"), name: "Demo Reasoning Model", desc: t("modelPlaza.featured.descDS") },
    { id: "demo-vision-model", badge: t("models.cap.qwen3vl"), name: "Demo Vision Model", desc: t("modelPlaza.featured.descGLM") },
    { id: "demo-chat-model", badge: t("modelPlaza.featured.badgeBalanced"), name: "Demo Chat Model", desc: t("modelPlaza.featured.descQWen") },
    { id: "demo-embedding-model", badge: t("modelPlaza.featured.badgeEmbedding"), name: "Demo Embedding Model", desc: t("modelPlaza.featured.descBGE") },
  ], [t]);

  const copy = (id: string) => {
    void copyText(id).then((ok) => {
      if (!ok) {
        toast.error(t("common.copyFailed"));
        return;
      }
      setCopiedId(id);
      toast.success(`${t("modelPlaza.copied")} ${id}`);
      setTimeout(() => setCopiedId(c => (c === id ? null : c)), 1400);
    });
  };

  return (
    <div className="animate-enter" style={{ marginBottom: 32 }}>
      <h2
        className="font-serif"
        style={{ margin: 0, fontSize: 30, lineHeight: 1.2, fontWeight: 500, color: "var(--fg)" }}
      >
        {t("modelPlaza.featured.title")}
      </h2>
      <p
        className="font-serif"
        style={{
          margin: "8px 0 20px", fontSize: 15, fontWeight: 430,
          lineHeight: 1.75, color: "var(--fg-lead)",
        }}
      >
        {t("modelPlaza.featured.descBefore")}
        <strong style={{ fontWeight: 700, color: "var(--danger, #d94b3d)" }}>{t("modelPlaza.featured.descHighlight")}</strong>
        {t("modelPlaza.featured.descAfter")}<br />{" "}
        {t("modelPlaza.featured.stablePrefix")}
        <button
          type="button"
          onClick={onStableClick}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            background: "none", border: "none", padding: 0, margin: 0,
            fontFamily: "inherit", fontSize: "inherit", fontWeight: 500,
            color: "var(--brand)", cursor: "pointer",
            borderBottom: "1px dashed var(--brand)",
          }}
        >
          {t("modelPlaza.featured.stableName")}
        </button>
        ，{t("modelPlaza.featured.stableDesc")}<br />{" "}
        <strong style={{ fontWeight: 700, color: "var(--danger, #d94b3d)" }}>{t("modelPlaza.featured.docsHintHighlight")}</strong>
        {t("modelPlaza.featured.docsHintAfter")}
        <button
          type="button"
          onClick={() => navigate("/docs?section=chat-api")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            background: "none", border: "none", padding: 0, margin: 0,
            fontFamily: "inherit", fontSize: "inherit", fontWeight: 500,
            color: "var(--brand)", cursor: "pointer",
            borderBottom: "1px dashed var(--brand)",
          }}
        >
          {t("modelPlaza.featured.docsLink")}
        </button>
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        {FEATURED.map((f, i) => {
          const copied = copiedId === f.id;
          return (
            <button
              key={f.id}
              onClick={() => onOpen(f.id)}
              title={t("modelPlaza.featured.viewDetails")}
              className="card-interactive animate-enter"
              style={{
                textAlign: "left", padding: "22px 20px 18px",
                cursor: "pointer", background: "var(--card)",
                animationDelay: `${i * 60}ms`,
              }}
            >
              <p
                style={{
                  margin: 0, fontSize: 10.5, fontWeight: 580,
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  color: "var(--fg-subtle)",
                }}
              >
                {f.badge}
              </p>
              <h3
                className="font-serif"
                style={{
                  margin: "8px 0 4px", fontSize: 26, lineHeight: 1.15,
                  fontWeight: 500, color: "var(--fg)",
                }}
              >
                {f.name}
              </h3>
              <div
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                onClick={(e) => e.stopPropagation()}
              >
                <code
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: 11.5,
                    color: "var(--fg-muted)",
                  }}
                >
                  {f.id}
                </code>
                <span
                  role="button" tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); copy(f.id); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); copy(f.id); } }}
                  aria-label="复制模型 ID"
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    padding: 2, borderRadius: 4, background: "transparent", border: "none",
                    color: "var(--fg-subtle)", cursor: "pointer",
                  }}
                >
                  {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.8} />}
                </span>
              </div>
              <p
                style={{
                  margin: "10px 0 0", fontSize: 13, lineHeight: 1.6,
                  color: "var(--fg-lead)", fontWeight: 430,
                }}
              >
                {f.desc}
              </p>
            </button>
          );
        })}
      </div>

      {/* 主推区 ↔ 全部目录的过渡分隔线(文字居中) */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 16,
          marginTop: 32, marginBottom: 20,
        }}
      >
        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
        <span
          style={{
            fontSize: 11, fontWeight: 580,
            textTransform: "uppercase", letterSpacing: "0.1em",
            color: "var(--fg-subtle)", whiteSpace: "nowrap",
          }}
        >
          {t("modelPlaza.allModels")}
        </span>
        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </div>
    </div>
  );
}
