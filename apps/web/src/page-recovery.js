/* Independent recovery surface: no imports, error payloads, diagnostic storage or network. */
(function (win, doc) {
  "use strict";
  if (!win || !doc || win.__gtPageRecovery) return;
  // Before main can localize the page, read only the existing public language
  // choice. Never inspect workspace settings, credentials, drafts or error data.
  if (doc.documentElement && doc.documentElement.dataset && doc.documentElement.dataset.bootState) {
    var preferredLanguage;
    try {
      var savedLanguage = win.localStorage && win.localStorage.getItem("gt-lang");
      if (savedLanguage === "zh" || savedLanguage === "zh-CN") preferredLanguage = "zh-CN";
      else if (savedLanguage === "en") preferredLanguage = "en";
    } catch (_) { /* Private/opaque-origin storage must not prevent recovery. */ }
    if (!preferredLanguage && win.navigator && /^zh/i.test(win.navigator.language || "")) preferredLanguage = "zh-CN";
    if (preferredLanguage) doc.documentElement.lang = preferredLanguage;
  }
  var kinds = ["resource", "runtime", "startup", "request_timeout", "manual"];
  var seen = new Map(), pending = new Set(), activeKind = null, building = false;
  var dialog, heading, description, instructions, caution, reloadButton, dismissButton, previousFocus;
  var isReady = false, loading = false, remaining = 45000, visibleSince = null, startupTimer, presentationTimer;
  var deferUntil = 0;
  var messages = {
    zh: {
      startup: ["页面启动时间较长", "页面尚未完成启动，可能有资源加载或连接问题。"],
      runtime: ["页面出现异常", "页面发生异常，部分操作可能未完成。"],
      resource: ["页面资源未加载完整", "部分界面或功能可能不可用。"],
      request_timeout: ["操作结果尚未确认", "请求等待超时；这不代表操作失败或 Agent 已停止。"],
      manual: ["页面没有响应？", "可先检查网络并稍候；如果仍无法操作，请先保留草稿和配置，再重新加载。"],
      recovered: ["页面已恢复响应", "启动曾出现延迟；请先核对之前的操作与任务记录。"],
      instructions: "如需保留内容，请先点“稍后处理”回到原页面，手动复制未发送的草稿和未保存的配置；重新加载可能丢失这些内容。",
      caution: "已有 Agent 任务可能仍在执行，请勿重复提交。重新加载后，请先核对聊天及运行记录，再决定下一步。",
      reload: "重新加载", dismiss: "稍后处理",
      confirm: "重新加载可能丢失未发送的草稿和未保存的配置，请先手动复制。已有 Agent 可能继续执行；重新加载后请先核对记录，避免重复提交。确认重新加载？"
    },
    en: {
      startup: ["The page is taking longer to start", "The page has not finished starting. A resource or connection may be unavailable."],
      runtime: ["The page encountered an error", "Some page actions may not have completed."],
      resource: ["Some page resources did not load", "Part of the interface or its features may be unavailable."],
      request_timeout: ["The action's result is unconfirmed", "Waiting for the request timed out. This does not mean the action failed or the Agent stopped."],
      manual: ["Is the page unresponsive?", "Check your connection and wait briefly. If it still does not respond, preserve your drafts and settings before reloading."],
      recovered: ["The page is responding again", "Startup was delayed. Check your earlier actions and task records first."],
      instructions: "To preserve your work, choose ‘Deal with this later’ to return to the page first. Manually copy any unsent drafts and unsaved configuration; reloading may lose them.",
      caution: "Existing Agent tasks may still be running. Do not submit duplicates. After reloading, check the conversation and run records before deciding what to do next.",
      reload: "Reload page", dismiss: "Deal with this later",
      confirm: "Reloading may lose unsent drafts and unsaved configuration. Manually copy them first. Agents may keep running; check the records after reloading to avoid duplicate work. Reload now?"
    }
  };
  function visible() { return doc.visibilityState !== "hidden" && doc.hidden !== true; }
  function now() { return Date.now(); }
  function copy() { return messages[(doc.documentElement && doc.documentElement.lang || "zh").toLowerCase().indexOf("en") === 0 ? "en" : "zh"]; }
  function updateCopy() {
    if (!dialog || !activeKind) return;
    var words = copy(), content = words[activeKind === "startup" && isReady ? "recovered" : activeKind];
    heading.textContent = content[0]; description.textContent = content[1];
    instructions.textContent = words.instructions; caution.textContent = words.caution;
    reloadButton.textContent = words.reload; dismissButton.textContent = words.dismiss;
    dialog.setAttribute("lang", words === messages.en ? "en" : "zh-CN");
  }
  function restoreFocus() {
    var previous = previousFocus; previousFocus = null;
    try {
      if (previous && previous.isConnected !== false && !previous.disabled && typeof previous.focus === "function"
        && (!previous.getClientRects || previous.getClientRects().length)) previous.focus({ preventScroll: true });
    } catch (_) { /* A removed or closing application surface cannot block recovery. */ }
  }
  function dismiss() {
    pending.clear(); activeKind = null;
    if (!dialog) return;
    try { if (dialog.open && typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); }
    catch (_) { try { dialog.removeAttribute("open"); } catch (_) { /* No recursive recovery. */ } }
    restoreFocus();
  }
  function build() {
    if (dialog && dialog.isConnected === false) dialog = null;
    if (dialog) return true;
    if (building || !doc.body || typeof doc.createElement !== "function") return false;
    building = true;
    try {
      var created = doc.createElement("dialog"); created.id = "page-recovery-dialog"; created.className = "page-recovery-dialog";
      created.setAttribute("role", "alertdialog"); created.setAttribute("aria-modal", "true");
      created.setAttribute("aria-labelledby", "page-recovery-title"); created.setAttribute("aria-describedby", "page-recovery-description page-recovery-instructions page-recovery-caution");
      created.setAttribute("data-i18n-skip", "");
      heading = doc.createElement("h2"); heading.id = "page-recovery-title";
      description = doc.createElement("p"); description.id = "page-recovery-description";
      instructions = doc.createElement("p"); instructions.id = "page-recovery-instructions"; instructions.className = "page-recovery-instructions";
      caution = doc.createElement("p"); caution.id = "page-recovery-caution";
      var actions = doc.createElement("div"); actions.className = "page-recovery-actions";
      dismissButton = doc.createElement("button"); dismissButton.type = "button"; dismissButton.id = "page-recovery-dismiss";
      reloadButton = doc.createElement("button"); reloadButton.type = "button"; reloadButton.id = "page-recovery-reload"; reloadButton.className = "page-recovery-reload";
      dismissButton.addEventListener("click", dismiss);
      reloadButton.addEventListener("click", function () {
        try { if (typeof win.confirm === "function" && win.confirm(copy().confirm)) win.location.reload(); }
        catch (_) { /* Reload is always explicit; failed recovery never loops. */ }
      });
      created.addEventListener("cancel", function (event) { event.preventDefault(); dismiss(); });
      created.addEventListener("close", function () { if (created.open) return; pending.clear(); activeKind = null; restoreFocus(); });
      actions.append(dismissButton, reloadButton); created.append(heading, description, instructions, caution, actions);
      doc.body.append(created); dialog = created; return true;
    } catch (_) { return false; }
    finally { building = false; }
  }
  function present() {
    win.clearTimeout(presentationTimer); presentationTimer = undefined;
    if (!pending.size && !activeKind || !visible()) return;
    if (now() < deferUntil) { presentationTimer = win.setTimeout(present, deferUntil - now()); return; }
    if (!build()) return;
    for (var index = 0; index < kinds.length; index++) if (pending.has(kinds[index]) || activeKind === kinds[index]) { activeKind = kinds[index]; break; }
    updateCopy();
    if (dialog.open) return;
    previousFocus = doc.activeElement;
    try {
      if (typeof dialog.showModal !== "function") return;
      dialog.showModal(); dismissButton.focus({ preventScroll: true });
    } catch (_) { /* Keep the pending fixed cause for a later safe presentation. */ }
  }
  function report(kind) {
    if (kinds.indexOf(kind) === -1) return;
    // Suppress a burst without silencing a later incident for the whole visit.
    if (kind !== "manual" && seen.has(kind) && (dialog && dialog.open || now() - seen.get(kind) < 60000)) return;
    seen.set(kind, now()); pending.add(kind); present();
  }
  function accountVisibleTime() {
    if (visibleSince !== null) { remaining = Math.max(0, remaining - Math.max(0, now() - visibleSince)); visibleSince = null; }
    win.clearTimeout(startupTimer); startupTimer = undefined;
  }
  function armStartup() {
    accountVisibleTime();
    if (!loading || !visible()) return;
    if (remaining <= 0) { report("startup"); return; }
    visibleSince = now(); startupTimer = win.setTimeout(function () {
      accountVisibleTime(); if (loading && visible()) armStartup();
    }, remaining);
  }
  win.__gtPageRecovery = Object.freeze({
    report: report,
    loading: function () {
      if (loading) return;
      accountVisibleTime(); loading = true; isReady = false; remaining = 45000; seen.delete("startup"); armStartup();
    },
    ready: function () {
      loading = false; isReady = true; accountVisibleTime();
      if (activeKind !== "startup") pending.delete("startup");
      updateCopy();
    },
    languageChanged: updateCopy
  });
  win.addEventListener("error", function (event) {
    // Inspect only the element type, never message/error/stack/source URL.
    var target = event.target;
    if (target && target !== win) {
      if (target.tagName === "SCRIPT" || target.tagName === "LINK" && String(target.rel || "").toLowerCase().split(/\s+/).indexOf("stylesheet") !== -1) report("resource");
      return;
    }
    report("runtime");
  }, true);
  win.addEventListener("unhandledrejection", function () { report("runtime"); });
  function checkRequiredStyles() {
    try {
      if (typeof doc.querySelectorAll !== "function") return;
      var links = doc.querySelectorAll("link[data-page-required-style]");
      for (var index = 0; index < links.length; index++) if (!links[index].disabled && links[index].sheet === null) { report("resource"); return; }
    } catch (_) { /* Do not inspect stylesheet rules or resource addresses. */ }
  }
  win.addEventListener("load", checkRequiredStyles);
  doc.addEventListener("DOMContentLoaded", present);
  doc.addEventListener("click", function (event) {
    var button;
    try { button = event.target && event.target.closest && event.target.closest("#page-recovery-help, [data-page-recovery-help]"); } catch (_) { return; }
    if (!button) return;
    event.preventDefault(); event.stopPropagation(); report("manual");
  }, true);
  doc.addEventListener("visibilitychange", function () {
    if (!visible()) { accountVisibleTime(); win.clearTimeout(presentationTimer); presentationTimer = undefined; return; }
    deferUntil = now() + 2000; armStartup(); present();
  });
  win.addEventListener("pageshow", function () { if (visible()) { deferUntil = now() + 2000; armStartup(); present(); } });
  var initialBootState = doc.documentElement && doc.documentElement.dataset && doc.documentElement.dataset.bootState;
  if (initialBootState === "loading") win.__gtPageRecovery.loading();
  else if (initialBootState === "failed") report("startup");
  else win.__gtPageRecovery.ready();
  if (doc.readyState === "complete") checkRequiredStyles();
})(window, document);
