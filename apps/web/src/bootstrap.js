// Never show login before the server has checked its HttpOnly session.
// No identity, credential or authentication decision is cached on the client.
(async () => {
  // This script may finish loading before or after the independent async script.
  const recovery = () => globalThis.__gtPageRecovery;
  const root = document.documentElement;
  const helpLabel = () => root.lang?.startsWith("zh") ? "页面无响应？" : "Page stuck?";
  const confirmReload = () => {
    const text = root.lang?.startsWith("zh")
      ? "恢复界面未能加载。请先手动复制未发送草稿和未保存配置；重新加载可能丢失这些内容，且不会取消已提交任务。重载后请先核对记录，避免重复提交。现在重新加载？"
      : "The recovery screen could not load. Copy unsent drafts and unsaved settings first; reloading may lose them and does not cancel submitted tasks. Check records before submitting again. Reload now?";
    if (typeof globalThis.confirm === "function" && globalThis.confirm(text)) location.reload();
  };
  const translateHelp = () => {
    for (const button of document.querySelectorAll("[data-page-recovery-help]")) button.textContent = helpLabel();
    recovery()?.languageChanged?.();
  };
  const bootChanged = () => {
    const state = root.dataset.bootState;
    if (state === "loading") recovery()?.loading?.();
    else if (state === "failed") recovery()?.report?.("startup");
    else recovery()?.ready?.();
  };
  // These controls do not depend on any workspace event handler. In a modal,
  // a body-level help button would be inert, so give that dialog its own entry.
  const addDialogHelp = dialog => {
    if (dialog.id === "page-recovery-dialog" || dialog.hasAttribute("data-page-recovery-surface") || dialog.querySelector("[data-page-recovery-help]")) return;
    const button = document.createElement("button");
    button.type = "button"; button.className = "page-recovery-help";
    button.setAttribute("data-page-recovery-help", ""); button.setAttribute("data-i18n-skip", "");
    button.textContent = helpLabel();
    const footer = dialog.querySelector("footer");
    if (footer) footer.append(button);
    else {
      const row = document.createElement("div"); row.className = "page-recovery-help-row";
      row.append(button); dialog.append(row);
    }
  };
  if (typeof MutationObserver === "function") {
    new MutationObserver(records => {
      for (const record of records) {
        if (record.attributeName === "data-boot-state") bootChanged();
        if (record.attributeName === "lang") translateHelp();
      }
    }).observe(root, { attributes: true, attributeFilter: ["data-boot-state", "lang"] });
    new MutationObserver(records => {
      for (const record of records) if (record.target.tagName === "DIALOG" && record.target.open) addDialogHelp(record.target);
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["open"] });
  }
  translateHelp(); bootChanged();
  for (const dialog of document.querySelectorAll("dialog[open]")) addDialogHelp(dialog);
  document.addEventListener("click", event => {
    if (recovery()) return;
    if (!event.target.closest?.("[data-page-recovery-help]")) return;
    confirmReload();
  }, true);
  try {
    await import("./main.js?v=20261018-tabs-2");
  } catch {
    root.dataset.bootState = "failed";
    if (recovery()?.report) recovery().report("startup");
    else {
      const screen = document.getElementById("boot-screen");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button button-secondary";
      retry.textContent = /^zh/i.test(navigator.language) ? "重新加载" : "Reload";
      retry.addEventListener("click", confirmReload);
      // Retain the static bilingual instructions if even the recovery script failed.
      screen?.append(retry);
    }
  }
})();
