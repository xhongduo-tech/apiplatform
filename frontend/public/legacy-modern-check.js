if (!import.meta.resolve) throw new Error("import.meta.resolve not supported");
import.meta.url;
import("/legacy-modern-check.js").catch(function () {});
(async function* () {})().next();
window.__vite_is_modern_browser = true;
