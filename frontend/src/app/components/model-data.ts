export interface Model {
  id: string;
  name: string;
  provider: string;
  shortDescription: string;
  description: string;
  contextWindow: string;
  pricing: string;
  status: "online" | "offline" | "maintenance" | "exclusive" | "unstable" | "pilot" | "upcoming" | "upgrading" | "sunsetting";
  offlineReason?: string;
  category: "flagship" | "chat" | "embedding" | "vision" | "reranker" | "image_generation" | "ocr" | "lts";
  speed: "fast" | "medium" | "slow";
  scene?: "high" | "auto";
  scenes?: ("high" | "auto")[];
  autoApprove?: boolean;
  arch?: "MoE" | "Dense" | "Encoder" | "Demo";
  params?: string;
  activatedParams?: string;
  dimension?: string;
  addedAt: string;
  releaseDate?: string;
  tags?: string[];
  badge?: "推荐" | "热门" | "新上线" | "蒸馏" | "大参数" | "MoE" | "演示";
  baseUrl?: string;
  apiKey?: string;
  modelApiName?: string;
  callNames?: string[];
  resolveToModelId?: string | null;
  importFormat?: "openai" | "custom" | "anthropic";
  customHeaders?: Record<string, string>;
  endpoints?: ModelEndpoint[];
  endpointCount?: number;
  docZh?: string;
  docEn?: string;
}

export interface ModelEndpoint {
  label: string;
  baseUrl: string;
  apiKey?: string;
  modelApiName?: string;
  importFormat?: "openai" | "custom" | "anthropic";
  upstreamPath?: string;
  customHeaders?: Record<string, string>;
  weight?: number;
}

export const categoryLabels: Record<Model["category"], string> = {
  lts: "LTS 稳定接口",
  flagship: "全能旗舰",
  chat: "文本生成",
  vision: "视觉理解",
  embedding: "向量嵌入",
  reranker: "重排序",
  image_generation: "图像生成",
  ocr: "OCR识别",
};

export const statusLabels: Record<Model["status"], string> = {
  online: "在线",
  offline: "下线",
  maintenance: "维护中",
  exclusive: "临时独占",
  unstable: "非稳定",
  pilot: "试点",
  upcoming: "抢先体验计划",
  upgrading: "升级中",
  sunsetting: "即将下线",
};

type ModelMeta = Pick<Model,
  | "shortDescription" | "description" | "contextWindow" | "speed"
  | "arch" | "params" | "activatedParams" | "dimension"
  | "addedAt" | "releaseDate" | "tags" | "badge" | "scene" | "scenes" | "autoApprove"
>;

const DEMO_DESCRIPTION = "虚构演示条目，不连接真实上游；使用前请由管理员配置模型与端点。";

/** 仅对应开源演示目录，不包含任何真实模型部署或接入日期。 */
export const MODEL_METADATA: Record<string, ModelMeta> = {
  "platform-sota": {
    shortDescription: "可配置的高能力稳定别名",
    description: `管理员可将该别名指向当前首选模型。${DEMO_DESCRIPTION}`,
    contextWindow: "动态", speed: "medium", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["稳定别名", "推理", "工具调用"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "platform-flash": {
    shortDescription: "可配置的低延迟稳定别名",
    description: `管理员可将该别名指向当前低延迟模型。${DEMO_DESCRIPTION}`,
    contextWindow: "动态", speed: "fast", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["稳定别名", "高速", "工具调用"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "demo-chat-model": {
    shortDescription: "通用对话模型占位条目", description: DEMO_DESCRIPTION,
    contextWindow: "32K", speed: "fast", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["对话", "文本生成", "工具调用"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "demo-reasoning-model": {
    shortDescription: "复杂推理模型占位条目", description: DEMO_DESCRIPTION,
    contextWindow: "64K", speed: "medium", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["推理", "代码", "长上下文"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "demo-vision-model": {
    shortDescription: "图文理解模型占位条目", description: DEMO_DESCRIPTION,
    contextWindow: "16K", speed: "medium", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["图文理解", "多模态", "文本生成"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "demo-embedding-model": {
    shortDescription: "文本向量模型占位条目", description: DEMO_DESCRIPTION,
    contextWindow: "8K", speed: "fast", arch: "Demo", params: "—", dimension: "1024",
    addedAt: "2026-01-01", tags: ["向量", "语义搜索", "RAG"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "demo-reranker-model": {
    shortDescription: "检索重排序模型占位条目", description: DEMO_DESCRIPTION,
    contextWindow: "8K", speed: "fast", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["重排序", "语义搜索", "RAG"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
  "demo-ocr-model": {
    shortDescription: "文档识别模型占位条目", description: DEMO_DESCRIPTION,
    contextWindow: "—", speed: "fast", arch: "Demo", params: "—",
    addedAt: "2026-01-01", tags: ["文字识别", "文档理解", "结构化"],
    badge: "演示", scene: "auto", autoApprove: true,
  },
};

export interface NotificationItem {
  id: string;
  type: "online" | "offline" | "maintenance" | "info";
  title: string;
  description: string;
  date: string;
  isNew?: boolean;
  details?: string[];
}
