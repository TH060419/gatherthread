const banner = document.createElement("aside"); banner.id = "test-environment-banner"; banner.setAttribute("aria-label", "测试环境 / Test environment");
const label = document.createElement("span"), leave = document.createElement("button"); leave.type = "button";
const render = () => { const zh = document.documentElement.lang.startsWith("zh"); label.textContent = zh ? "测试环境 · 账号和数据独立" : "Test environment · Separate accounts and data"; leave.textContent = zh ? "退出测试环境" : "Leave test environment"; };
banner.append(label, leave); document.body.prepend(banner); render();
new ResizeObserver(() => document.documentElement.style.setProperty("--test-environment-height", `${Math.ceil(banner.getBoundingClientRect().height)}px`)).observe(banner);
new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
leave.addEventListener("click", async () => { leave.disabled = true; try { const response = await fetch("/v1/test-gate", { method: "DELETE", credentials: "same-origin" }); if (response.ok) location.replace("/"); } finally { leave.disabled = false; } });
// Revocation/expiry returns even an existing signed-in browser to admission.
setInterval(async () => { try { const response = await fetch("/v1/test-gate", { credentials: "same-origin" }); if (response.ok && !(await response.json()).data.admitted && !document.querySelector("#gate-form")) location.replace("/"); } catch { /* next poll retries */ } }, 30000);
