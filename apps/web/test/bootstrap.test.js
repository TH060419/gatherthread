import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8"))
  .replace(/await import\("\.\/main\.js\?[^"\n]+"\);/u, "await loadMain();");

class Element {
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.handlers = new Map(); this.open = false; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, callback) { this.handlers.set(type, callback); }
  querySelector(selector) {
    return this.children.find(child => selector === "footer" ? child.tagName === "FOOTER" : child.hasAttribute("data-page-recovery-help"))
      ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null;
  }
}

function fixture({ language = "en", recovery, rejectMain = false, openDialogs = [] } = {}) {
  const root = { lang: language, dataset: { bootState: "loading" } }, body = new Element("body"), screen = new Element();
  const hint = new Element("p"); hint.textContent = "Static bilingual recovery instructions"; screen.append(hint);
  const help = new Element("button"); help.setAttribute("data-page-recovery-help", "");
  const observers = [], listeners = new Map(), confirmations = []; let reloads = 0, accepts = false;
  const document = { documentElement: root, body,
    getElementById(id) { return id === "boot-screen" ? screen : null; }, createElement: tag => new Element(tag),
    querySelectorAll(selector) {
      if (selector === "dialog[open]") return openDialogs.filter(dialog => dialog.open);
      return [help, ...openDialogs.flatMap(dialog => dialog.querySelector("[data-page-recovery-help]") ?? [])];
    }, addEventListener(type, callback) { listeners.set(type, callback); }
  };
  const context = vm.createContext({ document, __gtPageRecovery: recovery, navigator: { language }, location: { reload() { reloads++; } },
    confirm(text) { confirmations.push(text); return accepts; },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } },
    async loadMain() { if (rejectMain) throw Object.defineProperty({}, "message", { get() { throw new Error("Do not inspect private error"); } }); }
  });
  return { root, body, screen, hint, help, observers, listeners, confirmations,
    installRecovery(value) { context.__gtPageRecovery = value; },
    setAccept(value) { accepts = value; }, reloads: () => reloads,
    run: () => vm.runInContext(source, context) };
}

for (const [language, label] of [["en", "Reload"], ["zh-CN", "重新加载"]]) {
  test(`module failure retains static ${language} instructions when the independent recovery script is missing`, async () => {
    const f = fixture({ language, rejectMain: true }); await f.run();
    assert.equal(f.root.dataset.bootState, "failed"); assert.equal(f.screen.children[0], f.hint);
    const retry = f.screen.children[1]; assert.equal(retry.textContent, label);
    retry.handlers.get("click")(); assert.equal(f.reloads(), 0, "cancel leaves the page untouched");
    f.setAccept(true); retry.handlers.get("click")(); assert.equal(f.reloads(), 1);
    assert.match(f.confirmations[0], language === "en" ? /unsent drafts.*does not cancel submitted tasks/ : /未发送草稿.*不会取消已提交任务/u);
    assert.doesNotMatch(f.confirmations.join(" "), /private error/i);
  });
}

test("import failure uses the independent recovery layer without revealing authentication or duplicating controls", async () => {
  const calls = [], recovery = { loading: () => calls.push("loading"), ready: () => calls.push("ready"),
    languageChanged() {}, report: kind => calls.push(kind) };
  const f = fixture({ recovery, rejectMain: true }); await f.run();
  assert.deepEqual(calls, ["loading", "startup"]); assert.equal(f.root.dataset.bootState, "failed");
  assert.equal(f.screen.children.length, 1); assert.equal(f.reloads(), 0);
});

test("import success does not prematurely finish startup before asynchronous authentication restoration", async () => {
  const calls = [], recovery = { loading: () => calls.push("loading"), ready: () => calls.push("ready") };
  const f = fixture({ recovery }); await f.run();
  assert.deepEqual(calls, ["loading"]); assert.equal(f.root.dataset.bootState, "loading");
  delete f.root.dataset.bootState; f.observers[0].callback([{ target: f.root, attributeName: "data-boot-state" }]);
  assert.deepEqual(calls, ["loading", "ready"]);
  f.root.dataset.bootState = "loading"; f.observers[0].callback([{ target: f.root, attributeName: "data-boot-state" }]);
  assert.deepEqual(calls, ["loading", "ready", "loading"], "BFCache restoration gets another startup watchdog");
});

test("opened modal dialogs gain one local recovery entry without closing or altering their original content", async () => {
  const dialog = new Element("dialog"), footer = new Element("footer"), original = new Element("button");
  original.textContent = "Keep unsaved changes"; footer.append(original); dialog.append(footer); dialog.open = true;
  const f = fixture({ openDialogs: [dialog], recovery: {} }); await f.run();
  const help = dialog.querySelector("[data-page-recovery-help]"); assert.ok(help); assert.equal(help.textContent, "Page stuck?");
  assert.equal(footer.children[0], original); assert.equal(dialog.open, true);
  f.observers[1].callback([{ target: dialog, attributeName: "open" }]);
  assert.equal(footer.children.length, 2, "reopening does not duplicate the recovery entry");
  f.root.lang = "zh-CN"; f.observers[0].callback([{ target: f.root, attributeName: "lang" }]);
  assert.equal(help.textContent, "页面无响应？"); assert.equal(f.help.textContent, "页面无响应？");
  const overlay = new Element("dialog"); overlay.id = "page-recovery-dialog"; overlay.open = true;
  f.observers[1].callback([{ target: overlay, attributeName: "open" }]); assert.equal(overlay.children.length, 0);
});

test("a dynamically opened footerless dialog also has an independent accessible help entry", async () => {
  const f = fixture({ recovery: {} }); await f.run(); const dialog = new Element("dialog"); dialog.open = true;
  const content = new Element("form"); dialog.append(content);
  f.observers[1].callback([{ target: dialog, attributeName: "open" }]);
  assert.equal(dialog.children[0], content); assert.equal(dialog.children[1].className, "page-recovery-help-row");
  const help = dialog.querySelector("[data-page-recovery-help]"); assert.equal(help.tagName, "BUTTON"); assert.equal(help.type, "button");
});

test("manual help still offers explicit safe reload when the recovery script did not load", async () => {
  const f = fixture(); await f.run();
  const click = f.listeners.get("click"); assert.ok(click);
  click({ target: { closest: () => f.help } }); assert.equal(f.reloads(), 0);
  f.setAccept(true); click({ target: { closest: () => f.help } }); assert.equal(f.reloads(), 1);
  assert.match(f.confirmations[0], /Copy unsent drafts.*does not cancel submitted tasks.*Check records/s);
});

test("late asynchronous recovery installation receives readiness without a duplicate manual reload prompt", async () => {
  const f = fixture(); await f.run(); const calls = [];
  f.installRecovery({ ready: () => calls.push("ready"), loading: () => calls.push("loading"), languageChanged() {} });
  delete f.root.dataset.bootState;
  f.observers[0].callback([{ target: f.root, attributeName: "data-boot-state" }]);
  assert.deepEqual(calls, ["ready"]);
  f.listeners.get("click")({ target: { closest: () => f.help } });
  assert.equal(f.confirmations.length, 0, "the classic layer owns manual help once it arrives");
  f.root.dataset.bootState = "loading";
  f.observers[0].callback([{ target: f.root, attributeName: "data-boot-state" }]);
  assert.deepEqual(calls, ["ready", "loading"]);
});
