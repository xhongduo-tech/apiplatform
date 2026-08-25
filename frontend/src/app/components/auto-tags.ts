/**
 * auto-tags.ts — Rule-based auto-tagging for LLM models.
 *
 * Applied transparently in model-context.tsx so every model
 * gets appropriate tags without manual maintenance.
 *
 * Rules: name/id pattern matching + property-based logic.
 * Existing manual tags are always preserved; auto tags are added only
 * if not already present.
 */

import type { Model } from "./model-data";

function add(set: Set<string>, tag: string) { set.add(tag); }

/** Parse a contextWindow string like "128K", "1M", "64K" → tokens */
function ctxToTokens(ctx: string | undefined): number {
  if (!ctx) return 0;
  const m = ctx.match(/^([\d.]+)\s*(K|M|B)?/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  if (unit === "M") return v * 1_000_000;
  if (unit === "K") return v * 1_000;
  return v;
}

/** Parse param string like "671B", "32B", "7B" → billions */
function paramsToBillions(p: string | undefined): number {
  if (!p) return 0;
  const m = p.match(/^([\d.]+)\s*B/i);
  return m ? parseFloat(m[1]) : 0;
}

export function autoTagModel(model: Model): string[] {
  const existing = new Set(model.tags ?? []);
  const auto = new Set<string>();

  const name = (model.name || "").toLowerCase();
  const id   = (model.id   || "").toLowerCase();
  const text = `${name} ${id}`;

  // ── Architecture ──────────────────────────────────────────────────────
  if (model.arch === "MoE")     add(auto, "MoE");
  if (model.arch === "Dense")   add(auto, "稠密模型");
  if (model.arch === "Encoder") add(auto, "编码器");

  // ── Category ──────────────────────────────────────────────────────────
  if (model.category === "embedding") add(auto, "向量化");
  if (model.category === "reranker")  add(auto, "重排序");
  if (model.category === "vision")    add(auto, "多模态");
  if (model.category === "image_generation") add(auto, "图像生成");
  if (model.category === "ocr")       add(auto, "文字识别");

  // ── Name / ID pattern matching ────────────────────────────────────────
  if (/code|coder|coding/.test(text))                  add(auto, "代码");
  if (/r1|think|reason|qwq|qvq/.test(text))           add(auto, "思维链");
  if (/reason|infer/.test(text))                       add(auto, "推理");
  if (/math/.test(text))                               add(auto, "数学");
  if (/vision|vl-|vl\b|visual|图文|多模态/.test(text)) add(auto, "多模态");
  if (/embed|embedding/.test(text))                    add(auto, "向量化");
  if (/rerank/.test(text))                             add(auto, "重排序");
  if (/instruct|chat/.test(text))                      add(auto, "指令跟随");
  if (/long|128k|256k|1m/.test(text))                  add(auto, "长上下文");
  if (/multilingual|多语言/.test(text))                add(auto, "多语言");
  if (/distill|蒸馏/.test(text))                       add(auto, "蒸馏");
  if (/pro|plus|ultra/.test(text))                     add(auto, "旗舰");
  if (/3\.5|3\.6|3\.7/.test(text))                     add(auto, "Qwen3");
  if (/v3|v4/.test(text) && /deepseek/.test(text))     add(auto, "DeepSeek");
  if (/fim|fill.?in.?middle/.test(text))               add(auto, "代码补全");
  if (/agent|tool/.test(text))                         add(auto, "工具调用");

  // ── Context window ────────────────────────────────────────────────────
  const ctx = ctxToTokens(model.contextWindow);
  if (ctx >= 500_000) add(auto, "超长上下文");
  else if (ctx >= 128_000) add(auto, "128K");
  else if (ctx >= 32_000)  add(auto, "长上下文");

  // ── Model size ────────────────────────────────────────────────────────
  const pb = paramsToBillions(model.params);
  if (pb >= 200)      add(auto, "大参数");
  else if (pb >= 70)  add(auto, "70B+");
  else if (pb <= 14 && pb > 0) add(auto, "轻量级");

  // ── Scene ─────────────────────────────────────────────────────────────
  const scenes = model.scenes ?? (model.scene ? [model.scene] : []);
  if (scenes.includes("high"))    add(auto, "高并发");

  // ── Speed ─────────────────────────────────────────────────────────────
  if (model.speed === "slow")   add(auto, "深度思考");

  // ── Provider shortcuts ────────────────────────────────────────────────
  if (/deepseek/.test(text) || model.provider === "DeepSeek") add(auto, "DeepSeek");
  if (/qwen/.test(id))                                         add(auto, "Qwen");
  if (/llama/.test(id))                                        add(auto, "Llama");
  if (/mistral/.test(id))                                      add(auto, "Mistral");
  if (/gemma/.test(id))                                        add(auto, "Gemma");
  if (/bge/.test(id))                                          add(auto, "BGE");

  // Merge: keep all existing, add auto ones not yet present
  for (const t of auto) existing.add(t);

  return [...existing];
}
