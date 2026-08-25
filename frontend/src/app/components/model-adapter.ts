import type { ModelInfo } from "../api/gateway";
import { findCatalogPreset } from "./catalog-models";
import { getModelMetadata } from "./model-metadata";
import type { Model } from "./model-types";

/** 合并 API 运营字段与前端 catalog 展示字段（category / 虚拟模型标记等） */
function mergeCatalogDisplay(m: ModelInfo): ModelInfo {
  const preset = findCatalogPreset(m.id);
  if (!preset) return m;
  return {
    ...preset,
    ...m,
    category: preset.category,
    is_virtual: preset.is_virtual,
    status: m.status,
    resolve_to_model_id: m.resolve_to_model_id ?? preset.resolve_to_model_id,
  };
}

const ONLINE = new Set(["online", "exclusive", "unstable", "maintenance"]);

function mapCategory(m: ModelInfo): Model["category"] {
  if (m.category === "lts" || m.is_virtual) return "lts";
  if (m.category === "flagship") return "flagship";
  if (m.category === "image_gen") return "image_generation";
  const c = m.category as Model["category"];
  if (["chat", "embedding", "vision", "reranker", "ocr"].includes(c)) return c;
  return "chat";
}

function mapStatus(status: string): Model["status"] {
  if (status === "offline") return "offline";
  if (status === "sunsetting") return "sunsetting";
  if (status === "upcoming") return "upcoming";
  if (status === "upgrading") return "upgrading";
  if (status === "exclusive") return "exclusive";
  if (status === "maintenance") return "maintenance";
  if (status === "unstable") return "unstable";
  if (ONLINE.has(status)) return "online";
  return "online";
}

function inferParams(m: ModelInfo): string | undefined {
  const src = `${m.id} ${m.name}`;
  const hit = src.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  return hit ? `${hit[1]}B` : undefined;
}

function inferTags(m: ModelInfo): string[] {
  const tags: string[] = [];
  const text = `${m.id} ${m.name} ${m.short_desc || ""}`.toLowerCase();
  if (m.category === "chat" || m.category === "flagship" || m.category === "lts") {
    tags.push("工具调用", "文本生成");
    if (text.includes("r1") || text.includes("reason")) tags.push("推理", "思维链", "数学");
    if (text.includes("code")) tags.push("代码");
    if (text.includes("flash")) tags.push("高速");
    const ctx = m.context_window || "";
    if (/128[kK]/.test(ctx)) tags.push("长上下文");
  }
  if (m.category === "vision") tags.push("图文理解", "多模态", "文本生成");
  if (m.category === "embedding") tags.push("混合检索", "多语言检索");
  if (m.category === "reranker") tags.push("多语言检索");
  if (m.category === "ocr") tags.push("结构化");
  return tags;
}

export function toModel(m: ModelInfo): Model {
  const src = mergeCatalogDisplay(m);
  const category = mapCategory(src);
  const preset = findCatalogPreset(m.id);
  const meta = getModelMetadata(m.id);
  // 展示字段一律 API（admin 可编辑）优先，前端硬编码元数据仅作兜底——
  // 否则新上线模型的时间/参数量/标签永远无法通过后台写入
  return {
    id: src.id,
    name: src.name,
    provider: src.provider,
    shortDescription: src.short_desc || src.description || "",
    description: src.description || src.short_desc || "",
    contextWindow: src.context_window || "",
    status: mapStatus(src.status),
    category,
    params: src.params ?? meta?.params ?? inferParams(m),
    addedAt: src.addedAt ?? meta?.addedAt ?? "",
    // releaseDate 优先取 catalog 预设（模型固定发布时间），不随 API 覆写
    releaseDate: preset?.releaseDate ?? src.releaseDate ?? meta?.releaseDate,
    tags: (src.tags?.length ? src.tags : undefined) ?? meta?.tags ?? inferTags(src),
    resolveToModelId: src.resolve_to_model_id ?? null,
    engine_type: src.engine_type || "vllm",
  };
}

export function toModels(list: ModelInfo[]): Model[] {
  if (!Array.isArray(list)) return [];
  return list.map(toModel);
}
