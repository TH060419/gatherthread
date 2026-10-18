import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/page-recovery.js", import.meta.url), "utf8");

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) { const handlers = this.listeners.get(type) ?? []; handlers.push(handler); this.listeners.set(type, handlers); }
  dispatch(type, properties = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    Object.defineProperties(event, Object.getOwnPropertyDescriptors(properties));
    for (const handler of this.listeners.get(type) ?? []) handler(event);
    return event;
  }
}

class Element extends Events {
  constructor(doc, tag) { super(); this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.open = false; this.disabled = false; this.textContent = ""; this.parentElement = null; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "open") this.open = true; }
  removeAttribute(name) { delete this.attributes[name]; if (name === "open") this.open = false; }
  get isConnected() { let root = this; while (root.parentElement) root = root.parentElement; return root === this.ownerDocument.body; }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let node = this; node; node = node.parentElement) if (node.hidden || node.tagName === "DIALOG" && !node.open) return [];
    return [{}];
  }
  focus() { if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.showCount = (this.showCount ?? 0) + 1; this.focus(); }
  close() { this.open = false; this.dispatch("close"); }
  click() { if (!this.disabled) this.dispatch("click"); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.includes("#page-recovery-help") && node.id === "page-recovery-help"
        || selector.includes("[data-page-recovery-help]") && "data-page-recovery-help" in node.attributes) return node;
    }
    return null;
  }
}

function fixture({ body = true, hidden = false, lang = "zh-CN", createThrows = false, bootState, readyState = "loading", styles = [], languageStorage, browserLanguage } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), window = new Events(), document = new Events(), confirms = [];
  window.localStorage = languageStorage; window.navigator = { language: browserLanguage };
  document.documentElement = { lang, dataset: { bootState } }; document.readyState = readyState; document.visibilityState = hidden ? "hidden" : "visible"; document.hidden = hidden;
  document.querySelectorAll = selector => selector === "link[data-page-required-style]" ? styles : [];
  document.createElement = tag => { if (createThrows) throw new Error("synthetic creation failure"); return new Element(document, tag); };
  document.body = body ? new Element(document, "body") : null; document.activeElement = document.body;
  window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + Math.max(0, delay) }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.location = { reload() { window.reloads++; } }; window.reloads = 0;
  window.confirm = text => { confirms.push(text); return window.confirmed; }; window.confirmed = false;
  const context = vm.createContext({ window, document, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(source, context);
  const find = (id, root = document.body) => root?.id === id ? root : root?.children?.map(child => find(id, child)).find(Boolean);
  return { window, document, confirms, api: window.__gtPageRecovery, find,
    tick(ms) {
      const end = now + ms; let iterations = 0;
      while (true) { const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break;
        assert.ok(++iterations < 1000, "recovery must not create a timer loop"); now = due[1].at; timers.delete(due[0]); due[1].callback(); }
      now = end;
    },
    visibility(value) { document.hidden = value; document.visibilityState = value ? "hidden" : "visible"; document.dispatch("visibilitychange"); },
    attachBody() { document.body = new Element(document, "body"); document.activeElement = document.body; document.dispatch("DOMContentLoaded"); },
    runAgain() { vm.runInContext(source, context); },
    get timerCount() { return timers.size; },
  };
}

test("the classic script is inert until bootstrap starts loading or an actual fixed failure is reported", () => {
  const f = fixture(); f.tick(180000);
  assert.equal(f.find("page-recovery-dialog"), undefined); assert.equal(f.timerCount, 0);
  assert.deepEqual(Object.keys(f.api).sort(), ["languageChanged", "loading", "ready", "report"]);
  assert.equal(Object.isFrozen(f.api), true);
});

test("startup uses 45 seconds of foreground-visible time and does not misreport time spent in a hidden tab", () => {
  const f = fixture(); f.api.loading(); f.tick(20000); f.visibility(true); f.tick(300000);
  assert.equal(f.find("page-recovery-dialog"), undefined);
  f.visibility(false); f.tick(24999); assert.equal(f.find("page-recovery-dialog"), undefined);
  f.tick(1); assert.equal(f.find("page-recovery-dialog").open, true);
  assert.match(f.find("page-recovery-title").textContent, /启动时间较长/u);
});

test("a hidden initial page and ordinary background/resume without errors do not create a failure", () => {
  const f = fixture({ hidden: true }); f.api.loading(); f.tick(600000); assert.equal(f.find("page-recovery-dialog"), undefined);
  f.api.ready(); f.visibility(false); f.window.dispatch("pageshow", { persisted: true }); f.tick(100000);
  assert.equal(f.find("page-recovery-dialog"), undefined);
});

test("ready cancels startup detection without clearing an independently reported runtime failure", () => {
  const f = fixture(); f.api.loading(); f.tick(30000); f.api.report("runtime");
  f.api.ready(); f.tick(100000);
  assert.match(f.find("page-recovery-title").textContent, /页面出现异常/u); assert.equal(f.find("page-recovery-dialog").open, true);
  f.find("page-recovery-dismiss").click(); f.tick(100000); assert.equal(f.find("page-recovery-dialog").open, false);
});

test("a startup warning remains truthful after the page recovers, and a later loading cycle gets its own clock", () => {
  const f = fixture(); f.api.loading(); f.tick(45000); f.api.ready();
  assert.match(f.find("page-recovery-title").textContent, /已恢复响应/u);
  f.find("page-recovery-dismiss").click(); f.api.loading(); f.tick(44999); assert.equal(f.find("page-recovery-dialog").open, false);
  f.tick(1); assert.equal(f.find("page-recovery-dialog").open, true); assert.match(f.find("page-recovery-title").textContent, /启动时间较长/u);
});

test("sensitive exception fields, rejection reasons, URLs, application text and input values are never read", () => {
  const f = fixture(); let reads = 0;
  const secret = () => { reads++; throw new Error("private getter must not be accessed"); };
  const sensitive = {};
  for (const key of ["message", "error", "stack", "filename", "reason", "sourceURL"]) Object.defineProperty(sensitive, key, { get: secret });
  const errorEvent = { target: f.window };
  for (const key of Object.getOwnPropertyNames(sensitive)) Object.defineProperty(errorEvent, key, { get: secret });
  Object.defineProperty(f.document.body, "innerHTML", { get: secret });
  Object.defineProperty(f.document.body, "textContent", { get: secret, set: secret });
  const input = f.document.createElement("input"); Object.defineProperty(input, "value", { get: secret }); f.document.body.append(input); input.focus();
  f.window.dispatch("error", errorEvent); f.window.dispatch("unhandledrejection", sensitive);
  assert.equal(reads, 0); assert.equal(f.find("page-recovery-dialog").open, true);
  assert.match(f.find("page-recovery-description").textContent, /部分操作可能未完成/u);
});

test("only failed scripts and stylesheet links produce resource recovery; images and favicons do not", () => {
  for (const [tag, rel, expected] of [["img", "", false], ["link", "icon", false], ["link", "preload", false],
    ["script", "", true], ["link", "stylesheet", true], ["link", "alternate stylesheet", true]]) {
    const f = fixture(), target = f.document.createElement(tag); target.rel = rel;
    Object.defineProperty(target, "src", { get() { throw new Error("must not read resource URL"); } });
    Object.defineProperty(target, "href", { get() { throw new Error("must not read resource URL"); } });
    f.window.dispatch("error", { target });
    assert.equal(Boolean(f.find("page-recovery-dialog")?.open), expected);
    if (expected) assert.match(f.find("page-recovery-title").textContent, /资源未加载完整/u);
  }
});

test("errors reported before body exists wait for DOMContentLoaded without touching application views", () => {
  const f = fixture({ body: false }); f.api.report("resource"); f.api.report("runtime"); f.api.ready();
  assert.equal(f.find("page-recovery-dialog"), undefined);
  f.attachBody(); assert.equal(f.find("page-recovery-dialog").open, true); assert.equal(f.document.body.children.length, 1);
  assert.match(f.find("page-recovery-title").textContent, /资源未加载完整/u);
});

test("missing or failing DOM APIs do not recursively throw or trigger automatic reload", () => {
  const f = fixture({ createThrows: true });
  assert.doesNotThrow(() => { f.api.report("runtime"); f.window.dispatch("unhandledrejection"); f.api.languageChanged(); f.api.ready(); });
  assert.equal(f.window.reloads, 0); assert.equal(f.timerCount, 0);
});

test("error storms share one modal and repeated automatic errors cannot reopen it after dismissal", () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) { f.window.dispatch("error"); f.window.dispatch("unhandledrejection"); f.api.report("request_timeout"); }
  assert.equal(f.document.body.children.length, 1); assert.equal(f.find("page-recovery-dialog").showCount, 1);
  f.find("page-recovery-dismiss").click();
  for (let i = 0; i < 100; i++) { f.api.report("runtime"); f.api.report("request_timeout"); }
  assert.equal(f.find("page-recovery-dialog").open, false);
  f.api.report("manual"); assert.equal(f.find("page-recovery-dialog").open, true); assert.equal(f.find("page-recovery-dialog").showCount, 2);
});

test("a delayed close event from the previous presentation cannot clear a newly reopened recovery modal", () => {
  const f = fixture(); f.api.report("runtime"); f.find("page-recovery-dismiss").click(); f.api.report("manual");
  f.find("page-recovery-dialog").dispatch("close"); f.document.documentElement.lang = "en"; f.api.languageChanged();
  assert.equal(f.find("page-recovery-dialog").open, true); assert.match(f.find("page-recovery-title").textContent, /unresponsive/u);
});

test("the recovery modal can sit above an existing modal and Escape restores the original focused control", () => {
  const f = fixture(), original = f.document.createElement("dialog"), input = f.document.createElement("input");
  original.append(input); f.document.body.append(original); original.showModal(); input.focus();
  f.api.report("runtime"); assert.equal(original.open, true); assert.equal(f.find("page-recovery-dialog").open, true);
  assert.equal(f.document.activeElement, f.find("page-recovery-dismiss"));
  const cancel = f.find("page-recovery-dialog").dispatch("cancel");
  assert.equal(cancel.defaultPrevented, true); assert.equal(f.document.activeElement, input); assert.equal(original.open, true);
});

test("dismissing does not focus a removed or hidden original input", () => {
  const f = fixture(), input = f.document.createElement("input"); f.document.body.append(input); input.focus(); f.api.report("runtime");
  input.hidden = true; f.find("page-recovery-dismiss").click(); assert.notEqual(f.document.activeElement, input);
});

test("dismissing never returns focus into an application modal that closed while recovery was open", () => {
  const f = fixture(), original = f.document.createElement("dialog"), input = f.document.createElement("input");
  original.append(input); f.document.body.append(original); original.showModal(); input.focus();
  f.api.report("runtime"); original.close(); f.find("page-recovery-dismiss").click();
  assert.notEqual(f.document.activeElement, input);
});

test("reload requires explicit confirmation with a draft-copy warning and warns that Agent work may continue", () => {
  const f = fixture(); f.api.report("request_timeout");
  assert.match(f.find("page-recovery-title").textContent, /结果尚未确认/u);
  assert.match(f.find("page-recovery-description").textContent, /不代表操作失败或 Agent 已停止/u);
  assert.match(f.find("page-recovery-instructions").textContent, /手动复制.*未保存的配置/u);
  assert.match(f.find("page-recovery-instructions").textContent, /先点“稍后处理”回到原页面/u);
  assert.match(f.find("page-recovery-caution").textContent, /可能仍在执行.*请勿重复提交.*核对聊天及运行记录/u);
  f.find("page-recovery-reload").click(); assert.equal(f.window.reloads, 0);
  assert.match(f.confirms[0], /请先手动复制.*避免重复提交/u);
  f.window.confirmed = true; f.find("page-recovery-reload").click(); assert.equal(f.window.reloads, 1);
});

test("all recovery copy switches language without reading or embedding exception details", () => {
  const f = fixture({ lang: "en" }); f.api.report("runtime");
  assert.match(f.find("page-recovery-title").textContent, /page encountered an error/u);
  assert.match(f.find("page-recovery-instructions").textContent, /Manually copy.*unsent drafts/u);
  assert.match(f.find("page-recovery-instructions").textContent, /Deal with this later.*return to the page/u);
  f.document.documentElement.lang = "zh-CN"; f.api.languageChanged();
  assert.match(f.find("page-recovery-title").textContent, /页面出现异常/u);
  assert.equal(f.find("page-recovery-reload").textContent, "重新加载");
});

test("a background fault is deferred until two seconds after the page becomes visible", () => {
  const f = fixture({ hidden: true }); f.api.report("runtime"); f.tick(60000); assert.equal(f.find("page-recovery-dialog"), undefined);
  f.visibility(false); f.tick(1999); assert.equal(f.find("page-recovery-dialog"), undefined);
  f.tick(1); assert.equal(f.find("page-recovery-dialog").open, true);
});

test("pending startup timeout is cancelled if the page recovers during its foreground resumption delay", () => {
  const f = fixture(); f.api.loading(); f.tick(44000); f.visibility(true); f.tick(60000); f.visibility(false);
  f.tick(1000); assert.equal(f.find("page-recovery-dialog"), undefined); f.api.ready(); f.tick(10000);
  assert.equal(f.find("page-recovery-dialog"), undefined);
});

test("the independent help trigger works inside application dialogs without depending on main event handlers", () => {
  const f = fixture(), host = f.document.createElement("dialog"), button = f.document.createElement("button"), icon = f.document.createElement("span");
  button.setAttribute("data-page-recovery-help", ""); button.append(icon); host.append(button); f.document.body.append(host); host.showModal();
  const click = f.document.dispatch("click", { target: icon });
  assert.equal(click.defaultPrevented, true); assert.equal(click.stopped, true); assert.equal(host.open, true);
  assert.match(f.find("page-recovery-title").textContent, /页面没有响应/u);
});

test("unknown report kinds cannot display arbitrary content, and repeated script installation adds no listeners", () => {
  const f = fixture(); f.api.report("private fixture exception"); assert.equal(f.find("page-recovery-dialog"), undefined);
  const handlers = f.window.listeners.get("error").length; f.runAgain();
  assert.equal(f.window.listeners.get("error").length, handlers); assert.equal(f.api, f.window.__gtPageRecovery);
});

test("dismissed error bursts do not reopen immediately, but a later real incident is not silenced forever", () => {
  const f = fixture(); f.api.report("runtime"); f.find("page-recovery-dismiss").click();
  for (let index = 0; index < 100; index++) f.api.report("runtime");
  assert.equal(f.find("page-recovery-dialog").open, false);
  f.tick(60000); assert.equal(f.find("page-recovery-dialog").open, false, "a timer alone must not reopen the warning");
  f.api.report("runtime"); assert.equal(f.find("page-recovery-dialog").open, true);
});

test("manual recovery can rebuild its own removed dialog without inspecting the app DOM", () => {
  const f = fixture(); f.api.report("runtime"); f.find("page-recovery-dismiss").click();
  f.find("page-recovery-dialog").parentElement = null; f.document.body.children = []; f.api.report("manual");
  assert.equal(f.find("page-recovery-dialog").open, true);
});

test("an asynchronous recovery script starts a clock only for an explicitly loading application", () => {
  const f = fixture({ bootState: "loading" }); f.tick(44999); assert.equal(f.find("page-recovery-dialog"), undefined);
  f.api.loading(); f.tick(1); assert.equal(f.find("page-recovery-dialog").open, true, "bootstrap loading must not reset the existing clock");
  for (const bootState of [undefined, "ready"]) {
    const inactive = fixture({ bootState }); inactive.tick(100000); assert.equal(inactive.find("page-recovery-dialog"), undefined);
  }
  const failed = fixture({ bootState: "failed" });
  assert.equal(failed.find("page-recovery-dialog").open, true, "a late recovery script reports an earlier import failure");
  assert.match(failed.find("page-recovery-title").textContent, /启动时间较长/u);
});

test("marked failed stylesheets are checked after load, never prematurely or through resource URL or CSS rules", () => {
  const style = { sheet: null }, f = fixture({ styles: [style] });
  Object.defineProperty(style, "href", { get() { throw new Error("must not inspect resource address"); } });
  assert.equal(f.find("page-recovery-dialog"), undefined);
  f.window.dispatch("load"); assert.match(f.find("page-recovery-title").textContent, /资源未加载完整/u);
  const loadedStyle = { sheet: {} }; Object.defineProperty(loadedStyle.sheet, "cssRules", { get() { throw new Error("must not inspect styles"); } });
  const healthy = fixture({ readyState: "complete", styles: [loadedStyle, { disabled: true, sheet: null }] });
  assert.equal(healthy.find("page-recovery-dialog"), undefined);
  const late = fixture({ readyState: "complete", styles: [{ sheet: null }] });
  assert.equal(late.find("page-recovery-dialog").open, true);
});

test("startup uses only the established public language preference before main can localize", () => {
  const keys = [];
  const f = fixture({ bootState: "loading", lang: "en", languageStorage: {
    getItem(key) { keys.push(key); return "zh"; }, setItem() { assert.fail("recovery must not write storage"); }
  } });
  f.tick(45000); assert.deepEqual(keys, ["gt-lang"]);
  assert.match(f.find("page-recovery-title").textContent, /启动时间较长/u);
  const english = fixture({ bootState: "failed", lang: "en", browserLanguage: "zh-CN", languageStorage: { getItem: () => "en" } });
  assert.match(english.find("page-recovery-title").textContent, /longer to start/u, "the explicit saved language wins over browser language");
});

test("unavailable language storage and invalid language values cannot block or inject recovery", () => {
  const denied = fixture({ bootState: "failed", lang: "en", browserLanguage: "zh-CN", languageStorage: { getItem() { throw new Error("synthetic storage denied"); } } });
  assert.match(denied.find("page-recovery-title").textContent, /启动时间较长/u);
  const invalid = fixture({ bootState: "failed", lang: "en", languageStorage: { getItem: () => "PRIVATE_INVALID_LANGUAGE" } });
  assert.doesNotMatch(invalid.find("page-recovery-title").textContent, /PRIVATE_INVALID/u);
  assert.match(invalid.find("page-recovery-title").textContent, /longer to start/u);
});
