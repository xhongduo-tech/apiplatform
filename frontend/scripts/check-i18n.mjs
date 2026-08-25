/**
 * 三语字典键一致性自检。
 *
 * zh-CN 是唯一权威键集（TranslationKey 由它推导）。缺键会静默回落简体——
 * 页面看起来"没做完"却不报任何错，只有人工逐页对比才发现；多余键则连
 * tsc 都过不去。CI 里跑这一步，把两类问题都挡在提交前。
 *
 * 用 node 直接读 TS 源码：字典是纯字面量对象，剥掉 TS 语法即可当 JS 求值，
 * 不必为一个自检引入 ts-node / tsx 依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const i18nDir = path.join(here, "..", "src", "app", "i18n");

async function loadKeys(file) {
  const src = fs
    .readFileSync(path.join(i18nDir, file), "utf8")
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/^const\s+\w+(\s*:\s*[^=]*?)?\s*=\s*/m, "export default ")
    .replace(/\}\s*as const;?/m, "}")
    .replace(/^export default \w+;?\s*$/m, "");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "i18n-")), "dict.mjs");
  fs.writeFileSync(tmp, src);
  const mod = await import(pathToFileURL(tmp).href);
  return Object.keys(mod.default);
}

/**
 * 重复键要单独扫源码：求值成对象后 Object.keys 只会留下最后一个，
 * 重复定义在这一步是看不见的（tsc 会报 TS1117，但那是构建才发现）。
 */
function findDuplicates(file) {
  const seen = new Map();
  const dups = [];
  fs.readFileSync(path.join(i18nDir, file), "utf8").split("\n").forEach((line, i) => {
    const m = line.match(/^\s*"([^"]+)"\s*:/);
    if (!m) return;
    if (seen.has(m[1])) dups.push(`${m[1]}（行 ${seen.get(m[1])} 与 ${i + 1}）`);
    else seen.set(m[1], i + 1);
  });
  return dups;
}

const base = await loadKeys("zh-CN.ts");
const baseSet = new Set(base);
let failed = false;

for (const [lang, file] of [["zh-CN", "zh-CN.ts"], ["en", "en.ts"], ["zh-TW", "zh-TW.ts"]]) {
  const dups = findDuplicates(file);
  if (dups.length) {
    failed = true;
    console.error(`✗ ${lang} 有 ${dups.length} 个重复键：`);
    for (const d of dups) console.error(`    ${d}`);
  }
}

for (const [lang, file] of [["en", "en.ts"], ["zh-TW", "zh-TW.ts"]]) {
  const keys = await loadKeys(file);
  const set = new Set(keys);
  const missing = base.filter((k) => !set.has(k));
  const extra = keys.filter((k) => !baseSet.has(k));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ ${lang}: ${keys.length} 键，与 zh-CN 完全一致`);
    continue;
  }
  failed = true;
  if (missing.length) {
    console.error(`✗ ${lang} 缺少 ${missing.length} 个键（会静默回落简体）：`);
    for (const k of missing.slice(0, 40)) console.error(`    ${k}`);
    if (missing.length > 40) console.error(`    …还有 ${missing.length - 40} 个`);
  }
  if (extra.length) {
    console.error(`✗ ${lang} 多出 ${extra.length} 个 zh-CN 没有的键（tsc 会报 TS2353）：`);
    for (const k of extra.slice(0, 40)) console.error(`    ${k}`);
    if (extra.length > 40) console.error(`    …还有 ${extra.length - 40} 个`);
  }
}

if (failed) {
  console.error("\n三语字典不一致：以 zh-CN 为准补齐/删除后再提交。");
  process.exit(1);
}
console.log(`✓ 三语字典一致（zh-CN 基准 ${base.length} 键）`);
