/* Runs before the application bundle to avoid a light-theme/language flash. */
(function () {
  try {
    var mode = localStorage.getItem("apiplatform-theme");
    var isDark = mode === "dark" ||
      (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (isDark) document.documentElement.classList.add("dark");
    var lang = localStorage.getItem("apiplatform-lang");
    if (lang === "zh-CN" || lang === "zh-TW" || lang === "en") {
      document.documentElement.lang = lang;
    }
  } catch (_) {
    /* Storage can be unavailable in hardened/private browser contexts. */
  }
})();
