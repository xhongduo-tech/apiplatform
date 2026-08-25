/**
 * 首屏前同步执行的浏览器守卫（IE / 360 兼容模式等 Trident 内核）。
 * EdgeHTML（旧 Edge）由 @vitejs/plugin-legacy 的 nomodule 包承接，不在此拦截。
 * 必须在 React 加载前运行；由 index.html / admin.html 通过同步 <script src> 引入。
 */
(function () {
  var ua = navigator.userAgent;
  var isIE = /MSIE |Trident\//.test(ua);
  if (!isIE) return;

  var hint =
    "本开放平台需要 Chrome 60+、Edge 18+、Firefox 60+ 或 Safari 11+。";
  var domestic =
    "若使用统信或麒麟系统，请用 360 安全浏览器、奇虎浏览器或奇安信浏览器的「极速 / Chromium 内核」模式访问；" +
    "IE 用户可在 Edge 中使用「IE 模式」打开旧系统，再切换到 Chromium 内核访问本平台。";

  // 闭合标签斜杠必须转义为 <\/...>，避免 HTML 解析器提前结束本 <script>
  document.documentElement.innerHTML =
    '<body style="font-family:system-ui,-apple-system,sans-serif;padding:48px 24px;text-align:center;color:#1a1d24;max-width:560px;margin:0 auto;line-height:1.6">' +
    '<h2 style="margin:0 0 16px;font-size:20px">浏览器版本过低<\/h2>' +
    '<p style="margin:0 0 12px;font-size:15px">' + hint + '<\/p>' +
    '<p style="margin:0;font-size:14px;color:#555">' + domestic + '<\/p>' +
    '<\/body>';
})();
