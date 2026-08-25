/**
 * 生成 model-readme-zh-tw.ts —— 由 model-readme-zh.ts 做简→繁字符级转换得到。
 *
 * 只做字符级转换（OpenCC s2t：字/词形转换），不做地区词汇替换
 * （不会把「软件」换成台湾用词「軟體」），符合项目对繁体内容的选型：
 * 保留大陆用词习惯，只转字形。
 *
 * 用法：node scripts/gen-model-readme-zh-tw.mjs
 * 内容改了 model-readme-zh.ts 之后要重新跑一遍这个脚本同步繁体版本，
 * 不是运行时转换（避免给浏览器端引入几百 KB 的转换词典）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import * as esbuild from "esbuild";
import * as OpenCC from "opencc-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src", "app", "components");
const entry = path.join(srcDir, "model-readme-zh.ts");
const outFile = path.join(srcDir, "model-readme-zh-tw.ts");

const bundled = (await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
})).outputFiles[0].text;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-tw-gen-"));
const tmpFile = path.join(tmpDir, "bundle.mjs");
fs.writeFileSync(tmpFile, bundled);
const { ARTICLES_ZH } = await import(pathToFileURL(tmpFile).href);

// s2t：简体 -> OpenCC 标准繁体（字符/字形转换），不套用 tw/twp 的台湾地区词汇替换
const convert = OpenCC.Converter({ from: "cn", to: "t" });

function convertDeep(value) {
  if (typeof value === "string") return convert(value);
  if (Array.isArray(value)) return value.map(convertDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertDeep(v);
    return out;
  }
  return value;
}

const articlesZhTw = convertDeep(ARTICLES_ZH);

const header = `/**
 * model-readme-zh-tw.ts
 *
 * 由 model-readme-zh.ts 通过 scripts/gen-model-readme-zh-tw.mjs 自动生成，
 * 简→繁字符级转换（OpenCC s2t），不做地区词汇替换。
 *
 * 不要手改此文件 —— 改 model-readme-zh.ts 后重新跑生成脚本同步。
 */
import type { ModelArticle } from "./model-readme-data";

export const ARTICLES_ZH_TW: Record<string, ModelArticle> = `;

const body = JSON.stringify(articlesZhTw, null, 2);
fs.writeFileSync(outFile, header + body + ";\n");

console.log(`✓ 已生成 ${path.relative(process.cwd(), outFile)}（${Object.keys(articlesZhTw).length} 篇）`);
