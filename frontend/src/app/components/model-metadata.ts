/** 开源演示目录的非敏感展示元数据。 */
export interface ModelMetadata {
  params?: string;
  releaseDate?: string;
  addedAt?: string;
  tags?: string[];
}

const MODEL_METADATA: Record<string, ModelMetadata> = {
  "platform-sota": { params: "—", tags: ["稳定别名", "推理", "工具调用"] },
  "platform-flash": { params: "—", tags: ["稳定别名", "高速", "工具调用"] },
  "demo-chat-model": { params: "—", tags: ["对话", "文本生成", "工具调用"] },
  "demo-reasoning-model": { params: "—", tags: ["推理", "代码", "长上下文"] },
  "demo-vision-model": { params: "—", tags: ["图文理解", "多模态", "文本生成"] },
  "demo-embedding-model": { params: "—", tags: ["向量", "语义搜索", "RAG"] },
  "demo-reranker-model": { params: "—", tags: ["重排序", "语义搜索", "RAG"] },
  "demo-ocr-model": { params: "—", tags: ["文字识别", "文档理解", "结构化"] },
};

export function getModelMetadata(id: string): ModelMetadata | undefined {
  return MODEL_METADATA[id] ?? MODEL_METADATA[id.toLowerCase()];
}
