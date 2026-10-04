// Same preference contract as the home page and account/workspace settings.
const languageStorageKey = "gt-lang";
function preferredLanguage() {
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (saved === "zh") return "zh-CN";
    if (saved === "en") return "en";
    const settings = JSON.parse(localStorage.getItem("gatherthread.settings.v1") || "null");
    if (settings?.general?.locale === "zh-CN" || settings?.general?.locale === "en") return settings.general.locale;
  } catch { /* Restricted storage keeps the gate usable with the browser language. */ }
  return navigator.language.startsWith("zh") ? "zh-CN" : "en";
}
function persistLanguage() {
  try { localStorage.setItem(languageStorageKey, language === "zh-CN" ? "zh" : "en"); }
  catch { /* The current page still switches language when persistence is unavailable. */ }
}
let language = preferredLanguage();
persistLanguage();
const form = document.querySelector("#gate-form"), input = document.querySelector("#admission-code"), enter = document.querySelector("#enter"), feedback = document.querySelector("#feedback");
function render() {
  document.documentElement.lang = language;
  document.querySelectorAll("[data-en]").forEach(element => { element.textContent = language === "zh-CN" ? element.dataset.zh : element.dataset.en; });
  document.querySelector("#language").textContent = language === "zh-CN" ? "English" : "中文";
  document.title = language === "zh-CN" ? "测试环境 · GatherThread" : "Test environment · GatherThread";
}
document.querySelector("#language").addEventListener("click", () => { language = language === "zh-CN" ? "en" : "zh-CN"; persistLanguage(); render(); });
window.addEventListener("storage", event => {
  if (event.key !== languageStorageKey && event.key !== null) return;
  language = preferredLanguage(); render();
});
form.addEventListener("submit", async event => {
  event.preventDefault(); enter.disabled = true; feedback.textContent = "";
  const code = input.value.trim(); input.value = "";
  try {
    const response = await fetch("/v1/test-gate", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ admission_code: code }) });
    if (!response.ok) {
      feedback.textContent = response.status === 429
        ? (language === "zh-CN" ? "尝试过于频繁，请稍后再试。" : "Too many attempts. Try again later.")
        : (language === "zh-CN" ? "代码不可用，请向负责人确认。" : "Code unavailable. Check with your test coordinator.");
      input.focus(); return;
    }
    if (location.pathname === "/app/" && !location.search) location.reload();
    else location.replace(`/app/${location.hash}`);
  } catch { feedback.textContent = language === "zh-CN" ? "连接失败，请重试。" : "Connection failed. Try again."; input.focus(); }
  finally { enter.disabled = false; }
});
render();
