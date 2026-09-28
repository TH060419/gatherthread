(() => {
  const button = document.getElementById("language-toggle");
  const zh = document.getElementById("privacy-zh");
  const en = document.getElementById("privacy-en");
  let language = "zh";
  try {
    const stored = localStorage.getItem("gt-lang");
    const settings = JSON.parse(localStorage.getItem("gatherthread.settings.v1") || "null");
    language = stored === "en" || (!stored && settings?.general?.locale === "en") ? "en" : "zh";
  } catch { /* Private browsing may block local storage. */ }
  function apply() {
    zh.hidden = language !== "zh";
    en.hidden = language !== "en";
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = language === "zh" ? "隐私说明 | GatherThread 共序" : "Privacy notice | GatherThread";
    button.textContent = language === "zh" ? "EN" : "中";
  }
  button.addEventListener("click", () => {
    language = language === "zh" ? "en" : "zh";
    try { localStorage.setItem("gt-lang", language); } catch { /* Keep this tab's selection. */ }
    apply();
  });
  apply();
})();
