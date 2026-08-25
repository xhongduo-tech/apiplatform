import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const entries = ["index.html", "admin.html"];
const replacements = [
  [
    /<script type="module">[\s\S]*?window\.__vite_is_modern_browser=true<\/script>/,
    '<script type="module" src="/legacy-modern-check.js"></script>',
    "modern browser detector",
  ],
  [
    /<script type="module">[\s\S]*?vite: loading legacy chunks[\s\S]*?<\/script>/,
    '<script type="module" src="/legacy-fallback.js"></script>',
    "legacy fallback loader",
  ],
  [
    /<script nomodule>[\s\S]*?onbeforeload[\s\S]*?<\/script>/,
    '<script nomodule src="/legacy-safari-nomodule.js"></script>',
    "Safari nomodule guard",
  ],
  [
    /<script nomodule crossorigin id="vite-legacy-entry" data-src="([^"]+)">[\s\S]*?<\/script>/,
    '<script nomodule crossorigin id="vite-legacy-entry" data-src="$1" src="/legacy-entry.js"></script>',
    "legacy entry loader",
  ],
];

for (const file of entries) {
  const target = path.join("dist", file);
  let html = readFileSync(target, "utf8");
  for (const [pattern, replacement, label] of replacements) {
    if (!pattern.test(html)) {
      throw new Error(`${file}: plugin-legacy ${label} template changed; refusing CSP-incompatible output`);
    }
    html = html.replace(pattern, replacement);
  }
  if (/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) {
    throw new Error(`${file}: inline script remains and violates the production CSP`);
  }
  writeFileSync(target, html);
}

// @vitejs/plugin-legacy also injects a data: module import into each modern
// entry and its polyfill chunk. A strict `script-src 'self'` correctly blocks
// that import, which previously left the production page blank. Point the
// feature guard at the same-origin external module used above instead.
let guardImports = 0;
for (const file of readdirSync(path.join("dist", "assets"))) {
  if (!file.endsWith(".js")) continue;
  const target = path.join("dist", "assets", file);
  const source = readFileSync(target, "utf8");
  const rewritten = source.replace(
    /import'data:text\/javascript,[^']+import\.meta\.resolve not supported[^']*';/g,
    () => {
      guardImports += 1;
      return 'import"/legacy-modern-check.js";';
    },
  );
  if (rewritten !== source) {
    writeFileSync(target, rewritten);
    // nginx `gzip_static on` serves the sibling verbatim, so it must be
    // regenerated after post-processing rather than retaining blocked code.
    writeFileSync(`${target}.gz`, gzipSync(rewritten, { level: 9 }));
  }
}
if (guardImports === 0) {
  throw new Error("plugin-legacy guard template changed; refusing CSP-incompatible output");
}

for (const file of readdirSync(path.join("dist", "assets"))) {
  if (!file.endsWith(".js")) continue;
  const source = readFileSync(path.join("dist", "assets", file), "utf8");
  if (source.includes("data:text/javascript")) {
    throw new Error(`${file}: data: module import remains and violates the production CSP`);
  }
}

console.log(`✓ legacy bootstrap externalized (${guardImports} guards); strict CSP compatible`);
