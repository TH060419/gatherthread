let language = navigator.language.startsWith("zh") ? "zh-CN" : "en";
const form = document.querySelector("#gate-form"), input = document.querySelector("#admission-code"), enter = document.querySelector("#enter"), feedback = document.querySelector("#feedback");
function render() {
  document.documentElement.lang = language;
  document.querySelectorAll("[data-en]").forEach(element => { element.textContent = language === "zh-CN" ? element.dataset.zh : element.dataset.en; });
  document.querySelector("#language").textContent = language === "zh-CN" ? "English" : "中文";
  document.title = language === "zh-CN" ? "测试环境 · GatherThread" : "Test environment · GatherThread";
}
document.querySelector("#language").addEventListener("click", () => { language = language === "zh-CN" ? "en" : "zh-CN"; render(); });
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
