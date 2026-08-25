/**
 * ModelDetail — 模型详情页(以「怎么用」为核心)
 *
 * 展示顺序:
 *   1. 面包屑
 *   2. Hero: 标题 / 副标题 / 模型 ID
 *   3. 标签徽章(badges)
 *   4. ━━ 接入配置(三个值 + 一键复制) ━━  ← 最优先
 *   5. ━━ 示例代码(多 tab CodeBlock) ━━   ← 紧接着
 *   6. 模型简介
 *   7. 进阶使用(sections, 含代码片段)
 *   8. 核心特性(highlights)
 *   9. 模型基本信息(modelInfo table)
 *  10. 使用技巧(tips)
 *  11. 注意事项(limitations)
 *
 *  没收录的模型自动 fallback 到纯描述段落。
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, Check, Sparkles, Zap, Brain, Code2, Layers,
  Image as ImageIcon, Wrench, Globe2, Search, ListFilter, FileText, Key, Link2, Settings,
  Info, Terminal, BookOpen, Lightbulb, AlertTriangle } from "lucide-react";
import { api } from "../api/gateway";
import { useT } from "../i18n";
import type { Model } from "./model-types";
import { toModel } from "./model-adapter";
import { findCatalogPreset } from "./catalog-models";
import { getModelArticle, type ModelArticle, type FeatureSpotlight, type CodeSnippet } from "./model-readme-data";
import { ProviderIcon } from "./provider-logos";
import { EarlyAccessIcon } from "./early-access-icon";
import { CodeBlock } from "./code-block";
import { toast } from "sonner";
import { copyText } from "../browser-compat";
import { publicApiOrigin } from "../api/public-api-origin";

const HIGHLIGHT_ICON: Record<FeatureSpotlight["icon"], typeof Sparkles> = {
  brain: Brain, code: Code2, speed: Zap, context: Layers,
  vision: ImageIcon, tool: Wrench, multi: Sparkles, lang: Globe2,
  search: Search, ocr: FileText, rank: ListFilter,
};

const API_BASE = `${publicApiOrigin()}/v1`;

export function ModelDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, lang } = useT();
  const [model, setModel] = useState<Model | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    const preset = findCatalogPreset(id);
    if (preset) { setModel(toModel(preset)); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.models().then((r) => {
      if (cancelled) return;
      const info = (r.data ?? []).find((x) => x.id.toLowerCase() === id.toLowerCase());
      setModel(info ? toModel(info) : null);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const article = useMemo(() => (id ? getModelArticle(id, lang) : undefined), [id, lang]);

  const [copiedField, setCopiedField] = useState<string | null>(null);
  const copyValue = (field: string, value: string) => {
    void copyText(value).then((ok) => {
      if (!ok) {
        toast.error(t("common.copyFailed"));
        return;
      }
      setCopiedField(field);
      toast.success(t("modelDetail.toast.copied", { value }));
      setTimeout(() => setCopiedField(null), 1500);
    });
  };

  if (loading) {
    return <div style={{ padding: "48px", textAlign: "center", color: "var(--fg-muted)" }}>{t("common.loading")}</div>;
  }
  if (!model) {
    return (
      <div style={{ padding: "48px", textAlign: "center" }}>
        <h1 className="font-serif font-medium" style={{ fontSize: 22, marginBottom: 8 }}>{t("modelDetail.notFound.title")}</h1>
        <p style={{ color: "var(--fg-muted)", marginBottom: 16 }}>
          ID <code style={{ fontFamily: "var(--font-mono)" }}>{id}</code> {t("modelDetail.notFound.body")}
        </p>
        <button className="btn-primary" onClick={() => navigate("/models")}>{t("modelDetail.backToPlaza")}</button>
      </div>
    );
  }

  return (
    <article style={{ maxWidth: 820, margin: "0 auto" }}>
      <button
        onClick={() => navigate("/models")}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: "none", border: "none", padding: 0,
          color: "var(--fg-subtle)", cursor: "pointer",
          fontSize: 13, marginBottom: 36,
        }}
      >
        <ArrowLeft size={14} /> <span>{t("header.models")}</span>
      </button>

      {article ? (
        <ArticleBody
          article={article}
          model={model}
          copiedField={copiedField}
          onCopy={copyValue}
        />
      ) : (
        <FallbackBody model={model} copiedField={copiedField} onCopy={copyValue} />
      )}
    </article>
  );
}

/** 抢先体验计划模型的准入提示：非授权用户调用会 403，这里先在详情页说清楚。 */
function EarlyAccessNotice() {
  const { t } = useT();
  return (
    <div
      style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "14px 16px", marginBottom: 32, borderRadius: 10,
        background: "var(--brand-soft)", border: "1px solid var(--brand-soft)",
      }}
    >
      <EarlyAccessIcon size={17} style={{ color: "var(--brand)", flexShrink: 0, marginTop: 1 }} />
      <div>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--brand)" }}>
          {t("earlyAccess.badge")}
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.65, color: "var(--fg-lead)" }}>
          {t("earlyAccess.detailBanner")}
        </p>
      </div>
    </div>
  );
}

/* ── 正文 ──────────────────────────────────────────────────────────── */
function ArticleBody({
  article, model, copiedField, onCopy,
}: {
  article: ModelArticle;
  model: Model;
  copiedField: string | null;
  onCopy: (field: string, value: string) => void;
}) {
  const { t } = useT();

  return (
    <>
      {/* ── Hero ── */}
      <header style={{ marginBottom: 32 }}>
        <p style={{
          fontSize: 12, fontWeight: 600, letterSpacing: "0.12em",
          textTransform: "uppercase", color: "var(--brand)",
          margin: "0 0 12px",
        }}>
          {article.kicker}
        </p>
        <h1 className="font-serif" style={{
          fontSize: 40, lineHeight: 1.15, fontWeight: 500,
          color: "var(--fg)", margin: "0 0 12px", letterSpacing: "-0.01em",
        }}>
          {article.title}
        </h1>
        <p className="font-serif" style={{
          fontSize: 18, lineHeight: 1.55, fontWeight: 400,
          color: "var(--fg-lead)", margin: "0 0 20px",
        }}>
          {article.subtitle}
        </p>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <ProviderIcon provider={model.provider} id={model.id} size="sm" />
          <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>{model.provider}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
              {model.id}
            </code>
            <button
              onClick={() => onCopy("model_id", model.id)}
              aria-label={t("modelDetail.copyModelId")}
              style={{
                display: "inline-flex", padding: 3, borderRadius: 4,
                background: "none", border: "none", color: "var(--fg-subtle)", cursor: "pointer",
              }}
            >
              {copiedField === "model_id" ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={1.8} />}
            </button>
          </span>
        </div>
      </header>

      {/* ── 抢先体验计划提示（status=upcoming）── */}
      {model.status === "upcoming" && <EarlyAccessNotice />}

      {/* ── Badges ── */}
      {article.badges?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 36 }}>
          {article.badges.map((b) => (
            <div key={b.label} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 12px", borderRadius: 999,
              background: "var(--bg-soft)", border: "1px solid var(--border)",
              fontSize: 12.5, color: "var(--fg)",
            }}>
              <span style={{ color: "var(--fg-subtle)" }}>{b.label}</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                {b.value}{b.unit ?? ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          模型基本信息（放到第一位）
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {article.modelInfo?.length > 0 && (
        <section style={{ marginBottom: 40 }}>
          <SectionHeading>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Info size={22} /> {t("modelDetail.section.modelInfo")}
            </span>
          </SectionHeading>
          <div style={{ borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <tbody>
                {article.modelInfo.map((info, i) => (
                  <tr key={info.label} style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}>
                    <td style={{
                      padding: "11px 16px", color: "var(--fg-subtle)", fontSize: 13,
                      width: 160, whiteSpace: "nowrap",
                    }}>
                      {info.label}
                    </td>
                    <td style={{
                      padding: "11px 16px", fontFamily: "var(--font-mono)",
                      fontWeight: 500, color: "var(--fg)", fontSize: 13,
                    }}>
                      {info.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          接入配置 — 三个核心值
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section style={{ marginBottom: 40 }}>
        <SectionHeading>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <Settings size={22} /> {t("modelDetail.section.setup")}
          </span>
        </SectionHeading>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-muted)", margin: "0 0 20px" }}>
          {t("modelDetail.section.setupDesc")}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ConfigRow
            icon={<Link2 size={15} />}
            label="Base URL"
            value={API_BASE}
            copied={copiedField === "base_url"}
            onCopy={() => onCopy("base_url", API_BASE)}
          />
          <ApiKeyRow copiedField={copiedField} />
          <ConfigRow
            icon={<Code2 size={15} />}
            label="Model"
            value={model.id}
            copied={copiedField === "model_name"}
            onCopy={() => onCopy("model_name", model.id)}
          />
        </div>
      </section>

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          示例代码
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {article.examples?.length > 0 && (
        <section style={{ marginBottom: 48 }}>
          <SectionHeading>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Terminal size={22} /> {t("modelDetail.section.example")}
            </span>
          </SectionHeading>
          <CodeTabs snippets={article.examples} />
        </section>
      )}

      {/* ── 模型简介 ── */}
      <div style={{ marginBottom: 40 }}>
        <p className="font-serif" style={{
          fontSize: 17, lineHeight: 1.75, fontWeight: 430,
          color: "var(--fg)", margin: 0,
        }}>
          {article.lead}
        </p>
      </div>

      {/* ── 进阶使用 ── */}
      {article.sections?.map((sec) => (
        <section key={sec.heading} style={{ marginBottom: 40 }}>
          <SectionHeading>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <BookOpen size={22} /> {sec.heading}
            </span>
          </SectionHeading>
          {sec.paragraphs.map((p, i) => (
            <p key={i} style={{ fontSize: 15, lineHeight: 1.8, color: "var(--fg)", margin: "0 0 16px" }}>
              {p}
            </p>
          ))}
          {sec.code && (
            <div style={{ marginTop: 16 }}>
              <CodeBlock code={sec.code.code} lang={sec.code.language} label={sec.code.title} />
            </div>
          )}
        </section>
      ))}

      {/* ── 核心特性 ── */}
      {article.highlights?.length > 0 && (
        <section style={{ marginBottom: 48 }}>
          <SectionHeading>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Sparkles size={22} /> {t("modelDetail.section.highlights")}
            </span>
          </SectionHeading>
          <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {article.highlights.map((h) => {
              const Icon = HIGHLIGHT_ICON[h.icon] ?? Sparkles;
              return (
                <div key={h.title} style={{
                  padding: "18px 20px", borderRadius: 12,
                  background: "var(--bg-soft)", border: "1px solid var(--border)",
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8, marginBottom: 12,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    background: "var(--brand-soft)", color: "var(--brand)",
                  }}>
                    <Icon size={16} strokeWidth={2} />
                  </div>
                  <h3 className="font-serif" style={{ fontSize: 16, fontWeight: 500, margin: "0 0 6px", color: "var(--fg)" }}>
                    {h.title}
                  </h3>
                  <p style={{ fontSize: 13.5, lineHeight: 1.65, color: "var(--fg-lead)", margin: 0 }}>
                    {h.body}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 使用技巧 ── */}
      {article.tips && article.tips.length > 0 && (
        <section style={{ marginBottom: 40 }}>
          <SectionHeading>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Lightbulb size={22} /> {t("modelDetail.section.tips")}
            </span>
          </SectionHeading>
          <ul style={{ margin: 0, paddingLeft: 20, color: "var(--fg-lead)", fontSize: 14, lineHeight: 1.8 }}>
            {article.tips.map((tip, i) => (
              <li key={i} style={{ marginBottom: 8 }}>{tip}</li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 注意事项 ── */}
      {article.limitations && article.limitations.length > 0 && (
        <section style={{ marginBottom: 40, paddingTop: 24, borderTop: "1px solid var(--border)" }}>
          <SectionHeading>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={22} /> {t("modelDetail.section.limitations")}
            </span>
          </SectionHeading>
          <ul style={{ margin: 0, paddingLeft: 20, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.8 }}>
            {article.limitations.map((item, i) => (
              <li key={i} style={{ marginBottom: 6 }}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/* ── fallback:没有长文的模型 ─────────────────────────────────────── */
function FallbackBody({
  model, copiedField, onCopy,
}: {
  model: Model;
  copiedField: string | null;
  onCopy: (field: string, value: string) => void;
}) {
  const { t } = useT();
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, marginBottom: 24 }}>
        <ProviderIcon provider={model.provider} id={model.id} size="lg" />
        <div style={{ flex: 1 }}>
          <h1 className="font-serif" style={{ fontSize: 32, fontWeight: 500, margin: "0 0 6px", color: "var(--fg)" }}>
            {model.name}
          </h1>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>
              {model.id}
            </code>
            <button onClick={() => onCopy("model_id", model.id)} style={{
              display: "inline-flex", padding: 3, borderRadius: 4,
              background: "none", border: "none", color: "var(--fg-subtle)", cursor: "pointer",
            }}>
              {copiedField === "model_id" ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </span>
        </div>
      </div>

      {/* 未收录长文的模型同样要给出准入提示，否则用户只会在调用时撞到 403 */}
      {model.status === "upcoming" && <EarlyAccessNotice />}

      <section style={{ marginBottom: 36 }}>
        <SectionHeading>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <Settings size={22} /> {t("modelDetail.section.setup")}
          </span>
        </SectionHeading>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ConfigRow icon={<Link2 size={15} />} label="Base URL" value={API_BASE}
            copied={copiedField === "base_url"} onCopy={() => onCopy("base_url", API_BASE)} />
          <ApiKeyRow copiedField={copiedField} />
          <ConfigRow icon={<Code2 size={15} />} label="Model" value={model.id}
            copied={copiedField === "model_name"} onCopy={() => onCopy("model_name", model.id)} />
        </div>
      </section>

      <section style={{ marginBottom: 36 }}>
        <SectionHeading>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <Terminal size={22} /> {t("modelDetail.section.example")}
          </span>
        </SectionHeading>
        <CodeTabs snippets={[{
          title: "Python SDK",
          language: "python",
          code: `from openai import OpenAI

client = OpenAI(
    base_url="${API_BASE}",
    api_key="sk-platform-…",
)
resp = client.chat.completions.create(
    model="${model.id}",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)`,
        }]} />
      </section>

      <div style={{ marginTop: 32 }}>
        <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--fg-lead)" }}>
          {model.description || model.shortDescription || t("modelDetail.noDescription")}
        </p>
      </div>
    </div>
  );
}

/* ── 小组件 ──────────────────────────────────────────────────────── */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 className="font-serif" style={{
        fontSize: 24, fontWeight: 500, margin: 0, color: "var(--fg)", letterSpacing: "-0.005em",
      }}>
        {children}
      </h2>
    </div>
  );
}

function ConfigRow({
  icon, label, value, copied, onCopy, placeholder,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  placeholder?: boolean;
}) {
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "12px 16px", borderRadius: 10,
      background: "var(--bg-soft)", border: "1px solid var(--border)",
    }}>
      <span style={{ color: "var(--fg-subtle)", display: "inline-flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 12.5, color: "var(--fg-subtle)", width: 72, flexShrink: 0 }}>{label}</span>
      <code style={{
        flex: 1, fontFamily: "var(--font-mono)", fontSize: 13,
        color: placeholder ? "var(--fg-muted)" : "var(--fg)",
        fontStyle: placeholder ? "italic" : "normal",
        wordBreak: "break-all",
      }}>
        {value}
      </code>
      {!placeholder && (
        <button
          onClick={onCopy}
          aria-label={t("modelDetail.copyLabel", { label })}
          style={{
            display: "inline-flex", padding: 5, borderRadius: 6, flexShrink: 0,
            background: copied ? "var(--brand-soft)" : "none",
            border: "none", color: copied ? "var(--brand)" : "var(--fg-subtle)", cursor: "pointer",
          }}
        >
          {copied ? <Check size={15} strokeWidth={2.5} /> : <Copy size={15} strokeWidth={1.8} />}
        </button>
      )}
    </div>
  );
}

function ApiKeyRow({ copiedField }: { copiedField: string | null }) {
  const navigate = useNavigate();
  const { t } = useT();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "12px 16px", borderRadius: 10,
      background: "var(--bg-soft)", border: "1px solid var(--border)",
    }}>
      <span style={{ color: "var(--fg-subtle)", display: "inline-flex", flexShrink: 0 }}><Key size={15} /></span>
      <span style={{ fontSize: 12.5, color: "var(--fg-subtle)", width: 72, flexShrink: 0 }}>API Key</span>
      <code style={{
        flex: 1, fontFamily: "var(--font-mono)", fontSize: 13,
        color: "var(--fg-muted)", fontStyle: "italic",
      }}>
        sk-platform-…
      </code>
      <button
        onClick={() => navigate("/keys")}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "5px 12px", borderRadius: 7, flexShrink: 0,
          background: "var(--brand-solid)", border: "none",
          color: "#fff", fontSize: 12.5, fontWeight: 500, cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <Key size={13} /> {t("modelDetail.applyKey")}
      </button>
    </div>
  );
}

function CodeTabs({ snippets }: { snippets: CodeSnippet[] }) {
  const [active, setActive] = useState(0);
  const s = snippets[active];
  if (!s) return null;
  return (
    <div>
      <div style={{
        display: "flex", gap: 2, padding: 4, marginBottom: -1, width: "fit-content",
        borderRadius: "10px 10px 0 0",
        background: "var(--bg-soft)",
        border: "1px solid var(--border)",
        borderBottom: "none",
      }}>
        {snippets.map((sn, i) => (
          <button
            key={sn.title}
            onClick={() => setActive(i)}
            style={{
              padding: "6px 14px", borderRadius: 7, fontSize: 12.5,
              fontWeight: i === active ? 550 : 450, cursor: "pointer", border: "none",
              background: i === active ? "var(--card)" : "transparent",
              color: i === active ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            {sn.title}
          </button>
        ))}
      </div>
      <CodeBlock code={s.code} lang={s.language} label={s.title} />
    </div>
  );
}
