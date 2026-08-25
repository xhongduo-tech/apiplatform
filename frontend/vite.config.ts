import path from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** 内网旧版 Chromium 若 modern chunk 仍残留 __VITE_PRELOAD__ 引用，避免整页白屏 */
function vitePreloadShim(): Plugin {
  return {
    name: "vite-preload-shim",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        '<head>\n    <script src="/vite-preload-shim.js"></script>',
      );
    },
  };
}

/** 修补 Vite 动态 import 预载 helper，避免 deps 为非数组时 t.map 白屏。 */
function patchPreloadHelperCode(code: string): string {
  let out = code;

  // sp=function(e,t,n){...if(t&&t.length>0)...Promise.allSettled(t.map(...))}
  out = out.replace(
    /(sp=function\(\w+,\w+,\w+\)\{let \w+=Promise\.resolve\(\);if\()(\w+)&&\2\.length>0/,
    "$1Array.isArray($2)&&$2.length>0",
  );

  // 部分版本/压缩结果不含 sp= 名称，用 CSS 预载特征匹配同一逻辑
  out = out.replace(
    /if\((\w+)&&\1\.length>0\)\{([^{}]*?)Promise\.allSettled\(\1\.map\(/g,
    (match, depVar, middle) =>
      middle.includes("Unable to preload CSS") || middle.includes('rel="stylesheet"')
        ? `if(Array.isArray(${depVar})&&${depVar}.length>0){${middle}Promise.allSettled(${depVar}.map(`
        : match,
  );

  // __vite__mapDeps=(i,...)=>i.map(i=>d[i]) — 参数列表含嵌套括号，只匹配箭头后半段
  out = out.replace(
    /(__vite__mapDeps=[^;]+=>)(\w+)\.map\(/g,
    "$1(Array.isArray($2)?$2:[]).map(",
  );

  return out;
}

/**
 * Vite 生成的 module preload helper 对 deps 仅做 t&&t.length>0 判断。
 * 字符串等非数组 deps 会触发 `TypeError: t.map is not a function`（lazy route 白屏）。
 */
function safeModulePreload(): Plugin {
  let outDir = "dist";

  const patchBundle = (bundle: Record<string, unknown>) => {
    for (const [, chunk] of Object.entries(bundle)) {
      if (!chunk || typeof chunk !== "object" || (chunk as { type?: string }).type !== "chunk") continue;
      const c = chunk as { code?: string };
      if (!c.code || (!c.code.includes("sp=function") && !c.code.includes("__vite__mapDeps"))) continue;
      c.code = patchPreloadHelperCode(c.code);
    }
  };

  const patchJsAssetsOnDisk = () => {
    const assetsDir = path.join(outDir, "assets");
    try {
      for (const file of readdirSync(assetsDir)) {
        if (!file.endsWith(".js")) continue;
        const fp = path.join(assetsDir, file);
        const code = readFileSync(fp, "utf8");
        if (!code.includes("sp=function") && !code.includes("__vite__mapDeps")) continue;
        const patched = patchPreloadHelperCode(code);
        if (patched !== code) writeFileSync(fp, patched);
      }
    } catch {
      /* dist/assets 不存在时忽略 */
    }
  };

  return {
    name: "safe-module-preload",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    renderChunk(code) {
      if (!code.includes("sp=function") && !code.includes("__vite__mapDeps")) return null;
      return patchPreloadHelperCode(code);
    },
    generateBundle(_opts, bundle) {
      patchBundle(bundle);
    },
    closeBundle() {
      // Vite 可能在 write 阶段才注入 __vite__mapDeps，落盘后再补一刀
      patchJsAssetsOnDisk();
    },
  };
}

// 为静态资源生成 .gz 兄弟文件，配合 nginx gzip_static
function preGzip(): Plugin {
  let outDir = "dist";

  return {
    name: "pre-gzip",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const assetsDir = path.join(outDir, "assets");
      try {
        for (const file of readdirSync(assetsDir)) {
          if (!/\.(js|css|svg|json)$/.test(file)) continue;
          const fp = path.join(assetsDir, file);
          const buf = readFileSync(fp);
          if (buf.length < 1024) continue;
          writeFileSync(`${fp}.gz`, gzipSync(buf));
        }
      } catch {
        /* ignore */
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // 读取仓库根 .env 的 BACKEND_PORT，避免 Vite 仍代理到被占用的 8000
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, ".."), "");
  const apiPort =
    process.env.VITE_DEV_API_PORT || rootEnv.BACKEND_PORT || process.env.BACKEND_PORT || "8010";
  const apiOrigin = `http://localhost:${apiPort}`;

  return {
    plugins: [
      react(),
      legacy({
        targets: ["chrome >= 60", "firefox >= 60", "safari >= 11", "edge >= 18"],
        additionalLegacyPolyfills: ["regenerator-runtime/runtime"],
        modernPolyfills: true,
        renderLegacyChunks: true,
        polyfills: [
          "es.promise.finally",
          "es/map",
          "es/set",
          "es.array.flat",
          "es.array.flat-map",
          "es.object.from-entries",
          "es.string.match-all",
        ],
      }),
      vitePreloadShim(),
      safeModulePreload(),
      preGzip(),
    ],
    build: {
      cssTarget: "chrome61",
      // manualChunks 会把 react 拆到独立包，部分 Vite 版本下 lazy import 的
      // __VITE_PRELOAD__ 替换会漏进 vendor chunk → 控制台 ReferenceError 白屏
      modulePreload: false,
      minify: "terser",
      terserOptions: { compress: { drop_debugger: true } },
      rolldownOptions: {
        input: {
          main: path.resolve(import.meta.dirname, "index.html"),
          admin: path.resolve(import.meta.dirname, "admin.html"),
        },
      },
    },
    server: {
      port: Number(process.env.VITE_DEV_UI_PORT || rootEnv.VITE_DEV_UI_PORT || 5173),
      strictPort: true,
      proxy: {
        "/api": apiOrigin,
        "/v1": apiOrigin,
        "/health": apiOrigin,
      },
    },
  };
});
