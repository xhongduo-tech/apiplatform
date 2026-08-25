(function () {
  if (window.__vite_is_modern_browser) return;
  console.warn("vite: loading legacy chunks; an earlier syntax error can be ignored");
  var polyfill = document.getElementById("vite-legacy-polyfill");
  var script = document.createElement("script");
  script.src = polyfill.src;
  script.onload = function () {
    System.import(document.getElementById("vite-legacy-entry").getAttribute("data-src"));
  };
  document.body.appendChild(script);
})();
