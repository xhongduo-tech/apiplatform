/** 模型广场 UI 共用的 Model 类型。 */

export interface Model {
  id: string;
  name: string;
  provider: string;
  shortDescription: string;
  description: string;
  contextWindow: string;
  status: "online" | "offline" | "maintenance" | "exclusive" | "unstable" | "pilot" | "upcoming" | "upgrading" | "sunsetting";
  category: "flagship" | "chat" | "embedding" | "vision" | "reranker" | "image_generation" | "ocr" | "lts";
  params?: string;
  addedAt: string;
  releaseDate?: string;
  tags?: string[];
  /** LTS 别名当前对齐的真实模型 id */
  resolveToModelId?: string | null;
  /** 推理引擎：vllm | llamacpp */
  engine_type?: string;
}
