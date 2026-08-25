(function () {
  var documentRef = document;
  var probe = documentRef.createElement("script");
  if (!("noModule" in probe) && "onbeforeload" in probe) {
    var seenProbe = false;
    documentRef.addEventListener("beforeload", function (event) {
      if (event.target === probe) seenProbe = true;
      else if (!event.target.hasAttribute("nomodule") || !seenProbe) return;
      event.preventDefault();
    }, true);
    probe.type = "module";
    probe.src = ".";
    documentRef.head.appendChild(probe);
    probe.remove();
  }
})();
