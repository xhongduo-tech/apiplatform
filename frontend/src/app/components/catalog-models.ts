import type { ModelInfo } from "../api/gateway";

/**
 * API 暂不可用时展示的虚构目录，与 backend/app/catalog_seed.py 对齐。
 * 这些条目不代表真实部署；管理员需在后台配置上游端点后才能用于推理。
 */
export const PRESET_CATALOG: ModelInfo[] = [
  {
    id: "platform-sota", name: "platform-sota", provider: "Platform",
    category: "lts", status: "online", is_virtual: true,
    resolve_to_model_id: "demo-reasoning-model", context_window: "动态", speed: "medium",
    short_desc: "可配置的高能力稳定别名",
    description: "虚构演示条目；管理员可将其指向当前首选模型。",
  },
  {
    id: "platform-flash", name: "platform-flash", provider: "Platform",
    category: "lts", status: "online", is_virtual: true,
    resolve_to_model_id: "demo-chat-model", context_window: "动态", speed: "fast",
    short_desc: "可配置的低延迟稳定别名",
    description: "虚构演示条目；管理员可将其指向当前低延迟模型。",
  },
  {
    id: "demo-chat-model", name: "Demo Chat Model", provider: "Example Provider",
    category: "chat", status: "online", is_virtual: false,
    context_window: "32K", speed: "fast", params: "—",
    short_desc: "通用对话模型占位条目",
    description: "虚构演示条目，不连接真实上游；使用前请由管理员配置端点。",
  },
  {
    id: "demo-reasoning-model", name: "Demo Reasoning Model", provider: "Example Provider",
    category: "flagship", status: "online", is_virtual: false,
    context_window: "64K", speed: "medium", params: "—",
    short_desc: "复杂推理模型占位条目",
    description: "虚构演示条目，不连接真实上游；使用前请由管理员配置端点。",
  },
  {
    id: "demo-vision-model", name: "Demo Vision Model", provider: "Example Provider",
    category: "vision", status: "online", is_virtual: false,
    context_window: "16K", speed: "medium", params: "—",
    short_desc: "图文理解模型占位条目",
    description: "虚构演示条目，不连接真实上游；使用前请由管理员配置端点。",
  },
  {
    id: "demo-embedding-model", name: "Demo Embedding Model", provider: "Example Provider",
    category: "embedding", status: "online", is_virtual: false,
    context_window: "8K", speed: "fast", params: "—",
    short_desc: "文本向量模型占位条目",
    description: "虚构演示条目，不连接真实上游；使用前请由管理员配置端点。",
  },
  {
    id: "demo-reranker-model", name: "Demo Reranker Model", provider: "Example Provider",
    category: "reranker", status: "online", is_virtual: false,
    context_window: "8K", speed: "fast", params: "—",
    short_desc: "检索重排序模型占位条目",
    description: "虚构演示条目，不连接真实上游；使用前请由管理员配置端点。",
  },
  {
    id: "demo-ocr-model", name: "Demo OCR Model", provider: "Example Provider",
    category: "ocr", status: "online", is_virtual: false,
    context_window: "—", speed: "fast", params: "—",
    short_desc: "文档识别模型占位条目",
    description: "虚构演示条目，不连接真实上游；使用前请由管理员配置端点。",
  },
];

const PRESET_BY_ID = new Map(PRESET_CATALOG.map((model) => [model.id.toLowerCase(), model]));

/** 查找预置目录条目（id 大小写不敏感）。 */
export function findCatalogPreset(id: string): ModelInfo | undefined {
  return PRESET_BY_ID.get(id.toLowerCase());
}

/** 预置目录优先，管理员新增模型回退到数据库中的类别。 */
export function displayCategoryForModel(id: string, backendCategory?: string | null): string {
  const preset = findCatalogPreset(id);
  if (preset?.category) return preset.category;
  const category = (backendCategory || "chat").toLowerCase();
  if (category === "image_gen" || category === "image_generation") return "image_generation";
  return category || "chat";
}
