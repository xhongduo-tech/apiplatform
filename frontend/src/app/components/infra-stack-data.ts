import type { TranslationKey } from "../i18n";

/** 可点击展开图文详情的推理/运行时技术项 */
export type InfraTechId =
  | "vllm"
  | "embed-serving"
  | "container-runtime";

export type InfraTechDetail = {
  id: InfraTechId;
  labelKey: TranslationKey;
  tagKey: TranslationKey;
  titleKey: TranslationKey;
  summaryKey: TranslationKey;
  fitKey: TranslationKey;
  pointKeys: TranslationKey[];
};

export const INFRA_TECH_DETAILS: InfraTechDetail[] = [
  {
    id: "vllm",
    labelKey: "admin.infra.tech.vllm.label",
    tagKey: "admin.infra.tech.vllm.tag",
    titleKey: "admin.infra.tech.vllm.title",
    summaryKey: "admin.infra.tech.vllm.summary",
    fitKey: "admin.infra.tech.vllm.fit",
    pointKeys: [
      "admin.infra.tech.vllm.p1",
      "admin.infra.tech.vllm.p2",
      "admin.infra.tech.vllm.p3",
      "admin.infra.tech.vllm.p4",
    ],
  },
  {
    id: "embed-serving",
    labelKey: "admin.infra.tech.embed.label",
    tagKey: "admin.infra.tech.embed.tag",
    titleKey: "admin.infra.tech.embed.title",
    summaryKey: "admin.infra.tech.embed.summary",
    fitKey: "admin.infra.tech.embed.fit",
    pointKeys: [
      "admin.infra.tech.embed.p1",
      "admin.infra.tech.embed.p2",
      "admin.infra.tech.embed.p3",
    ],
  },
  {
    id: "container-runtime",
    labelKey: "admin.infra.tech.container.label",
    tagKey: "admin.infra.tech.container.tag",
    titleKey: "admin.infra.tech.container.title",
    summaryKey: "admin.infra.tech.container.summary",
    fitKey: "admin.infra.tech.container.fit",
    pointKeys: [
      "admin.infra.tech.container.p1",
      "admin.infra.tech.container.p2",
      "admin.infra.tech.container.p3",
    ],
  },
];

export const INFRA_TECH_BY_ID = Object.fromEntries(
  INFRA_TECH_DETAILS.map((d) => [d.id, d]),
) as Record<InfraTechId, InfraTechDetail>;

/** L1 synthetic 演示服务器；管理员登记后由实际资源视图取代。 */
export const HARDWARE_NODES = [
  { id: "hw-demo-a", specKey: "admin.infra.hw.demoA.spec" as TranslationKey, roleKey: "admin.infra.hw.demoA.role" as TranslationKey, accent: "#6366f1" },
  { id: "hw-demo-b", specKey: "admin.infra.hw.demoB.spec" as TranslationKey, roleKey: "admin.infra.hw.demoB.role" as TranslationKey, accent: "#5B8DEF" },
] as const;

/** L4 synthetic 模型部署单元，仅解释界面结构，不代表真实容量。 */
export type ModelDeployment = {
  id: string;
  modelKey: TranslationKey;
  quantKey: TranslationKey;
  engineId: InfraTechId;
  hardwareKey: TranslationKey;
  kvKey: TranslationKey;
  concurrencyKey: TranslationKey;
  contextKey: TranslationKey;
  scriptKey: TranslationKey;
};

export const MODEL_DEPLOYMENTS: ModelDeployment[] = [
  {
    id: "dep-demo-chat",
    modelKey: "admin.infra.dep.demoChat.model",
    quantKey: "admin.infra.dep.demoChat.quant",
    engineId: "vllm",
    hardwareKey: "admin.infra.dep.demoChat.hw",
    kvKey: "admin.infra.dep.demoChat.kv",
    concurrencyKey: "admin.infra.dep.demoChat.concurrency",
    contextKey: "admin.infra.dep.demoChat.context",
    scriptKey: "admin.infra.dep.demoChat.script",
  },
  {
    id: "dep-demo-embedding",
    modelKey: "admin.infra.dep.demoEmbedding.model",
    quantKey: "admin.infra.dep.demoEmbedding.quant",
    engineId: "embed-serving",
    hardwareKey: "admin.infra.dep.demoEmbedding.hw",
    kvKey: "admin.infra.dep.demoEmbedding.kv",
    concurrencyKey: "admin.infra.dep.demoEmbedding.concurrency",
    contextKey: "admin.infra.dep.demoEmbedding.context",
    scriptKey: "admin.infra.dep.demoEmbedding.script",
  },
];

export const INFERENCE_TECH_IDS: InfraTechId[] = [
  "vllm",
  "embed-serving",
];

export const RUNTIME_TECH_IDS: InfraTechId[] = ["container-runtime"];

/** L5 synthetic 应用示例；不映射任何组织内部场景分类。 */
export type ApplicationLayerItem = {
  id: string;
  sceneKey: TranslationKey;
  descKey: TranslationKey;
  accent: string;
};

export const APPLICATION_LAYER_ITEMS: ApplicationLayerItem[] = [
  { id: "demo-chat-app", sceneKey: "admin.infra.app.demoChat.title", descKey: "admin.infra.app.demoChat.desc", accent: "#8b5cf6" },
  { id: "demo-search-app", sceneKey: "admin.infra.app.demoSearch.title", descKey: "admin.infra.app.demoSearch.desc", accent: "#3b82f6" },
];
