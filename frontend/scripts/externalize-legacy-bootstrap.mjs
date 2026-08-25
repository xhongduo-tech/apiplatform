import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

console.log("✓ legacy bootstrap scripts externalized; strict CSP compatible");
