
(function () {
  "use strict";
  var code = location.hash.slice(1).replace(/[^a-z0-9.\-]/gi, "").slice(0, 60);
  var button = document.getElementById("stop-button");
  if (!code || !button) return;
  var name = code.split(".")[0].replace(/-/g, " ").replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  var address = button.getAttribute("href").split("?")[0];
  button.setAttribute("href", address + "?subject=" + encodeURIComponent("Unsubscribe " + code) +
    "&body=" + encodeURIComponent("Please stop emailing me.\n\nReference: " + code + "\n"));
  if (name && code.indexOf(".") !== -1) {
    document.getElementById("stop-who").textContent = "Press the button and send the email it opens. We take " + name +
      " off our list promptly and will not write again.";
  }
})();
