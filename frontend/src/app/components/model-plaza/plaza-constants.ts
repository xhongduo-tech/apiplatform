/**
 * plaza-constants.ts — 模型广场共享常量（热度表、场景推荐、排序默认值）
 */
import type { Model } from "../model-types";

/** 虚构演示模型的展示权重；未知模型使用统一默认值。 */
const HEAT: Record<string, number> = {
  "platform-sota": 10,
  "platform-flash": 10,
  "demo-reasoning-model": 9,
  "demo-chat-model": 8,
  "demo-vision-model": 7,
  "demo-embedding-model": 6,
  "demo-reranker-model": 5,
  "demo-ocr-model": 4,
};

// upgrading = 升级中，降权到末尾（减去 100）；upcoming（抢先体验）是真实可调用模型，不降权。
const heatOf = (m: Model) => (m.status === "upgrading" ? (HEAT[m.id] ?? 4) - 100 : (HEAT[m.id] ?? 4));

/** 表头状态筛选的默认选中项（在线 + 抢先体验计划）。 */
export const DEFAULT_STATUS_FILTER = ["online", "upcoming"] as const;

/** LTS 别名默认指向的真实模型 id（后端未配置时的兜底） */
export const LTS_RESOLVE_DEFAULTS = { sota: "demo-reasoning-model", flash: "demo-chat-model" } as const;

/** 模型助手场景 key —— 用联合类型而非 string，编译期保证与 i18n 字典一一对应 */
export type ScenarioKey = "chat" | "reason" | "best" | "fast" | "vision" | "rag" | "ocr";
export interface Scenario {
  key: ScenarioKey;
  pick: (models: Model[]) => Model[];
}

const byHeat = (a: Model, b: Model) => heatOf(b) - heatOf(a);
const online = (m: Model) => m.status === "online";

export const SCENARIOS: Scenario[] = [
  {
    key: "chat",
    pick: ms => {
      const chat = ms.filter(m => m.category === "chat" && online(m)).sort(byHeat);
      const flash = ms.filter(m => online(m) && m.id === "demo-chat-model");
      const rest = chat.filter(m => m.id !== "demo-chat-model");
      return [...flash, ...rest].slice(0, 3);
    },
  },
  {
    key: "reason",
    pick: ms => {
      const reason = ms.filter(m => online(m) && ((m.tags ?? []).some(t => ["推理", "思维链"].includes(t)) || m.id.includes("r1"))).sort(byHeat);
      const targeted = ms.filter(m => online(m) && m.id === "demo-reasoning-model");
      const rest = reason.filter(m => m.id !== "demo-reasoning-model");
      return [...targeted, ...rest].slice(0, 3);
    },
  },
  {
    key: "best",
    pick: ms => ms.filter(m => m.id.toLowerCase() === "platform-sota"),
  },
  {
    key: "fast",
    pick: ms => ms.filter(m => m.id.toLowerCase() === "platform-flash"),
  },
  {
    key: "vision",
    pick: ms => ms.filter(m => m.category === "vision" && online(m)).sort(byHeat).slice(0, 2),
  },
  {
    key: "rag",
    pick: ms => {
      const emb = ms.filter(m => m.category === "embedding" && online(m)).sort(byHeat)[0];
      const rr  = ms.filter(m => m.category === "reranker"  && online(m)).sort(byHeat)[0];
      return [emb, rr].filter(Boolean) as Model[];
    },
  },
  {
    key: "ocr",
    pick: ms => ms.filter(m => m.category === "ocr" && online(m)).sort(byHeat).slice(0, 2),
  },
];
