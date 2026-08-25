(function () {
  if (typeof window.__VITE_PRELOAD__ === "function") return;
  window.__VITE_PRELOAD__ = function (load, dependencies) {
    return Promise.resolve().then(function () {
      return typeof load === "function" ? load() : load;
    });
  };
})();
