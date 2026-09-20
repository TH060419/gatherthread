// GatherThread product-page boot. Keep this external so the owner-host CSP can
// retain `script-src 'self'` without allowing inline scripts.
(function () {
  "use strict";

  var current = new URL(window.location.href);
  var fragment = current.hash.replace(/^#/, "");
  var hash = new URLSearchParams(fragment);
  var isOperationalEntry = current.searchParams.has("api")
    || current.searchParams.get("mock") === "1"
    || hash.has("project")
    || hash.has("session")
    || hash.has("dsh-pair")
    || fragment === "main-content"
    || fragment.indexOf("settings-") === 0;

  if (isOperationalEntry) {
    var application = new URL("./app/", current);
    application.search = current.search;
    application.hash = current.hash;
    window.location.replace(application.href);
    return;
  }

  var saved = null;
  try { saved = localStorage.getItem("gt-theme"); } catch (error) {}
  var requested = current.searchParams.get("theme");
  var theme = requested === "light" || requested === "dark"
    ? requested
    : saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", theme);

  var userAgent = navigator.userAgent;
  var isSafari = /^((?!chrome|chromium|android|edg).)*safari/i.test(userAgent);
  if (isSafari) document.documentElement.setAttribute("data-browser", "safari");
})();
