/**
 * capability-chips.tsx — 能力标签（chip）定义、解析与渲染组件
 *
 * 从 ModelPlaza.tsx 抽出：chip 定义、标签→chip 映射、tooltip、排序与可见性逻辑。
 * chip 的文案（label/desc）全部走 i18n，不再硬编码中文。
 */
import { createPortal } from "react-dom";
import {
  MessageSquare, Sparkles, Image, Database, SlidersHorizontal,
  Wrench, Code2, Globe2, Search, ScanLine, Table,
  Zap, Brain, Calculator, FileText, Braces, Layers, Layout,
  type LucideIcon,
} from "lucide-react";
import { useTooltip } from "../../hooks/use-tooltip";
import type { TranslationKey } from "../../i18n";
import type { Model } from "../model-types";

export interface TaskChip {
  key: ChipKey;
  label: string;
  desc: string;
  Icon: LucideIcon;
  color: string;
  bg: string;
}

type ChipKey =
  | "toolCall" | "reasoning" | "chainOfThought" | "math" | "vision" | "code"
  | "longContext" | "docUnderstanding" | "structuredOutput" | "multilingual"
  | "highSpeed" | "textGen" | "embedding" | "hybridSearch" | "multilingualSearch"
  | "rerank" | "ocr" | "structured" | "tableOcr" | "layout" | "multimodal";

const CHIP_ICON: Record<ChipKey, TaskChip["Icon"]> = {
  toolCall: Wrench,
  reasoning: Sparkles,
  chainOfThought: Brain,
  math: Calculator,
  vision: Image,
  code: Code2,
  longContext: Layers,
  docUnderstanding: FileText,
  structuredOutput: Braces,
  multilingual: Globe2,
  highSpeed: Zap,
  textGen: MessageSquare,
  embedding: Database,
  hybridSearch: Search,
  multilingualSearch: Globe2,
  rerank: SlidersHorizontal,
  ocr: ScanLine,
  structured: Table,
  tableOcr: Table,
  layout: Layout,
  multimodal: Image,
};

const CHIP_COLOR: Record<ChipKey, { color: string; bg: string }> = {
  toolCall:          { color: "var(--chart-5)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  reasoning:         { color: "var(--chart-3)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  chainOfThought:    { color: "var(--brand)",        bg: "rgba(var(--brand-rgb), 0.10)" },
  math:              { color: "var(--danger)",       bg: "var(--danger-soft)" },
  vision:            { color: "var(--warn)",         bg: "var(--warn-soft)" },
  code:              { color: "var(--chart-4)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  longContext:       { color: "var(--chart-5)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  docUnderstanding:  { color: "var(--fg-muted)",     bg: "var(--bg-soft)" },
  structuredOutput:  { color: "var(--block-peach)",  bg: "rgba(var(--brand-rgb), 0.10)" },
  multilingual:      { color: "var(--chart-5)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  highSpeed:         { color: "var(--chart-5)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  textGen:           { color: "var(--chart-2)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  embedding:         { color: "var(--chart-4)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  hybridSearch:      { color: "var(--chart-4)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  multilingualSearch:{ color: "var(--chart-5)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  rerank:            { color: "var(--brand)",        bg: "rgba(var(--brand-rgb), 0.10)" },
  ocr:               { color: "var(--chart-5)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  structured:        { color: "var(--brand)",        bg: "rgba(var(--brand-rgb), 0.10)" },
  tableOcr:          { color: "var(--chart-4)",      bg: "rgba(var(--brand-rgb), 0.10)" },
  layout:            { color: "var(--fg-muted)",     bg: "var(--bg-soft)" },
  multimodal:        { color: "var(--warn)",         bg: "var(--warn-soft)" },
};

const LABEL_KEY: Record<ChipKey, TranslationKey> = {
  toolCall:          "modelPlaza.chip.toolCall.label",
  reasoning:         "modelPlaza.chip.reasoning.label",
  chainOfThought:    "modelPlaza.chip.chainOfThought.label",
  math:              "modelPlaza.chip.math.label",
  vision:            "modelPlaza.chip.vision.label",
  code:              "modelPlaza.chip.code.label",
  longContext:       "modelPlaza.chip.longContext.label",
  docUnderstanding:  "modelPlaza.chip.docUnderstanding.label",
  structuredOutput:  "modelPlaza.chip.structuredOutput.label",
  multilingual:      "modelPlaza.chip.multilingual.label",
  highSpeed:         "modelPlaza.chip.highSpeed.label",
  textGen:           "modelPlaza.chip.textGen.label",
  embedding:         "modelPlaza.chip.embedding.label",
  hybridSearch:      "modelPlaza.chip.hybridSearch.label",
  multilingualSearch:"modelPlaza.chip.multilingualSearch.label",
  rerank:            "modelPlaza.chip.rerank.label",
  ocr:               "modelPlaza.chip.ocr.label",
  structured:        "modelPlaza.chip.structured.label",
  tableOcr:          "modelPlaza.chip.tableOcr.label",
  layout:            "modelPlaza.chip.layout.label",
  multimodal:        "modelPlaza.chip.multimodal.label",
};

const DESC_KEY: Record<ChipKey, TranslationKey> = {
  toolCall:          "modelPlaza.chip.toolCall.desc",
  reasoning:         "modelPlaza.chip.reasoning.desc",
  chainOfThought:    "modelPlaza.chip.chainOfThought.desc",
  math:              "modelPlaza.chip.math.desc",
  vision:            "modelPlaza.chip.vision.desc",
  code:              "modelPlaza.chip.code.desc",
  longContext:       "modelPlaza.chip.longContext.desc",
  docUnderstanding:  "modelPlaza.chip.docUnderstanding.desc",
  structuredOutput:  "modelPlaza.chip.structuredOutput.desc",
  multilingual:      "modelPlaza.chip.multilingual.desc",
  highSpeed:         "modelPlaza.chip.highSpeed.desc",
  textGen:           "modelPlaza.chip.textGen.desc",
  embedding:         "modelPlaza.chip.embedding.desc",
  hybridSearch:      "modelPlaza.chip.hybridSearch.desc",
  multilingualSearch:"modelPlaza.chip.multilingualSearch.desc",
  rerank:            "modelPlaza.chip.rerank.desc",
  ocr:               "modelPlaza.chip.ocr.desc",
  structured:        "modelPlaza.chip.structured.desc",
  tableOcr:          "modelPlaza.chip.tableOcr.desc",
  layout:            "modelPlaza.chip.layout.desc",
  multimodal:        "modelPlaza.chip.multimodal.desc",
};

const TAG_TO_KEY: Record<string, ChipKey> = {
  "工具调用":   "toolCall",
  "推理":       "reasoning",
  "思维链":     "chainOfThought",
  "数学":       "math",
  "图文理解":   "vision",
  "代码":       "code",
  "长上下文":   "longContext",
  "文档理解":   "docUnderstanding",
  "结构化输出": "structuredOutput",
  "多语言":     "multilingual",
  "高速":       "highSpeed",
  "文本生成":   "textGen",
  "向量化":     "embedding",
  "混合检索":   "hybridSearch",
  "多语言检索": "multilingualSearch",
  "重排序":     "rerank",
  "文字识别":   "ocr",
  "结构化":     "structured",
  "表格识别":   "tableOcr",
  "版面分析":   "layout",
  "图文":       "multimodal",
};

function buildChip(key: ChipKey, t: (k: TranslationKey) => string): TaskChip {
  const { color, bg } = CHIP_COLOR[key];
  return {
    key,
    label: t(LABEL_KEY[key]),
    desc: t(DESC_KEY[key]),
    Icon: CHIP_ICON[key],
    color,
    bg,
  };
}

const CHAT_ORDER: ChipKey[] = [
  "toolCall", "reasoning", "chainOfThought", "math", "vision", "code",
  "longContext", "docUnderstanding", "structuredOutput", "multilingual",
  "highSpeed", "textGen",
];
const EMBED_ORDER: ChipKey[] = ["hybridSearch", "multilingualSearch", "longContext", "multimodal"];
const RERANK_ORDER: ChipKey[] = ["multilingualSearch", "longContext", "multimodal"];
const OCR_ORDER: ChipKey[] = ["tableOcr", "layout", "docUnderstanding", "structured"];

const MAX_TASK_CHIPS = 3;

export function visibleTaskChips(all: TaskChip[]): { chips: TaskChip[]; overflow: number } {
  if (all.length <= MAX_TASK_CHIPS) return { chips: all, overflow: 0 };
  const limit = MAX_TASK_CHIPS - 1;
  return { chips: all.slice(0, limit), overflow: all.length - limit };
}

function chipTipTitle(chip: TaskChip): string {
  return `${chip.label}：${chip.desc}`;
}

export function getTaskChips(m: Model, t: (k: TranslationKey) => string): TaskChip[] {
  const tags = m.tags ?? [];

  if (m.category === "embedding") {
    const extra = tags.some(x => ["图文检索", "多模态"].includes(x)) || m.id.includes("vl");
    const order = extra ? EMBED_ORDER : EMBED_ORDER.filter(k => k !== "multimodal");
    return chipsFromTags(tags, order, buildChip("embedding", t), t);
  }
  if (m.category === "reranker") {
    const extra = tags.some(x => ["图文重排", "多模态"].includes(x)) || m.id.includes("vl");
    const order = extra ? RERANK_ORDER : RERANK_ORDER.filter(k => k !== "multimodal");
    return chipsFromTags(tags, order, buildChip("rerank", t), t);
  }
  if (m.category === "ocr") {
    return chipsFromTags(tags, OCR_ORDER, buildChip("ocr", t), t);
  }

  const merged = new Set(tags);
  if (merged.has("视觉") || merged.has("多模态") || m.category === "vision") merged.add("图文理解");
  if (merged.has("推理") || m.id.includes("r1")) merged.add("推理");
  if (merged.has("思维链") || m.id.includes("r1")) merged.add("思维链");
  const ctx = m.contextWindow || "";
  if (/128[kK]/.test(ctx)) merged.add("长上下文");

  return chipsFromTags([...merged], CHAT_ORDER, undefined, t);
}

function chipsFromTags(
  tags: string[], order: ChipKey[], base: TaskChip | undefined,
  t: (k: TranslationKey) => string,
): TaskChip[] {
  const tagSet = new Set(tags);
  const chips: TaskChip[] = base ? [base] : [];
  const seen = new Set(chips.map(c => c.key));
  for (const key of order) {
    const chineseLabel = Object.entries(TAG_TO_KEY).find(([, v]) => v === key)?.[0];
    if (!chineseLabel || !tagSet.has(chineseLabel) || seen.has(key)) continue;
    chips.push(buildChip(key, t));
    seen.add(key);
  }
  if (!seen.has("textGen") && !base) {
    chips.push(buildChip("textGen", t));
  }
  return chips;
}

function ChipTooltipBody({ chips, compact }: { chips: TaskChip[]; compact?: boolean }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: compact ? 6 : 0 }}>
      {chips.map((chip, i) => (
        <span key={chip.key} style={{ display: "block" }}>
          {!compact && i > 0 && (
            <span style={{ display: "block", height: 1, background: "var(--fg-subtle)", margin: "6px 0" }} />
          )}
          <span style={{ display: "block", fontWeight: 550 }}>{chip.label}</span>
          <span style={{ display: "block", fontSize: 10, fontWeight: 400, opacity: 0.82, marginTop: 2, lineHeight: 1.4 }}>
            {chip.desc}
          </span>
        </span>
      ))}
    </span>
  );
}

export function TaskChipBadge({ chip }: { chip: TaskChip }) {
  const { label, Icon, color, bg } = chip;
  const { active, tipStyle, triggerProps } = useTooltip();

  const tooltipNode = active && tipStyle ? createPortal(
    <span
      role="tooltip"
      style={{
        ...tipStyle,
        width: "max-content", maxWidth: 260,
        borderRadius: 8, padding: "8px 11px",
        fontSize: 11, fontWeight: 500, lineHeight: 1.45,
        background: "var(--ink)", color: "var(--card)",
        boxShadow: "var(--shadow-pop)",
        pointerEvents: "none", textAlign: "left",
      }}
    >
      <ChipTooltipBody chips={[chip]} />
    </span>,
    document.body,
  ) : null;

  return (
    <>
      <span
        {...triggerProps}
        title={chipTipTitle(chip)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          fontSize: 11, fontWeight: 500,
          padding: "3px 8px", borderRadius: 6,
          background: bg, color,
          whiteSpace: "nowrap", flexShrink: 0,
        }}
      >
        <Icon style={{ width: 10, height: 10, flexShrink: 0 }} />
        {label}
      </span>
      {tooltipNode}
    </>
  );
}

export function OverflowChipBadge({ chips }: { chips: TaskChip[] }) {
  const text = chips.map(chipTipTitle).join("\n");
  const { active, tipStyle, triggerProps } = useTooltip();

  const tooltipNode = active && tipStyle ? createPortal(
    <span
      role="tooltip"
      style={{
        ...tipStyle,
        width: "max-content", maxWidth: 260,
        borderRadius: 8, padding: "8px 11px",
        fontSize: 11, fontWeight: 500, lineHeight: 1.45,
        background: "var(--ink)", color: "var(--card)",
        boxShadow: "var(--shadow-pop)",
        pointerEvents: "none", textAlign: "left",
      }}
    >
      <ChipTooltipBody chips={chips} compact />
    </span>,
    document.body,
  ) : null;

  return (
    <>
      <span
        {...triggerProps}
        title={text}
        style={{
          fontSize: 11, fontWeight: 500,
          padding: "3px 8px", borderRadius: 6,
          background: "var(--bg-soft)", color: "var(--fg-muted)",
          cursor: "default", whiteSpace: "nowrap", flexShrink: 0,
        }}
      >
        +{chips.length}
      </span>
      {tooltipNode}
    </>
  );
}
