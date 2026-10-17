import test from "node:test";
import assert from "node:assert/strict";
import { INTERFACE_MODE_STORAGE_KEY, normalizeInterfacePreference, isMobileCandidate,
  resolveInterfaceMode, createInterfacePreferenceStore, mountInterfaceMode } from "../src/interface-mode.js";

test("only an explicit mobile preference switches presentation", () => {
  for (const value of [undefined, null, "", "automatic", "MOBILE", {}, 1]) {
    assert.equal(normalizeInterfacePreference(value), "auto");
    assert.equal(resolveInterfaceMode(value), "desktop");
  }
  assert.equal(resolveInterfaceMode("auto"), "desktop");
  assert.equal(resolveInterfaceMode("desktop"), "desktop");
  assert.equal(resolveInterfaceMode("mobile"), "mobile");
});

test("detection combines mobile platforms, iPad touch and coarse compact viewports", () => {
  assert.equal(isMobileCandidate({ userAgent: "iPhone" }, 390), true);
  assert.equal(isMobileCandidate({ userAgent: "Android" }, 1366), true);
  assert.equal(isMobileCandidate({ platform: "MacIntel", maxTouchPoints: 5 }, 1024), true);
  assert.equal(isMobileCandidate({ userAgentData: { mobile: true } }, 980), true);
  const touch = { platform: "Win32", maxTouchPoints: 10 };
  assert.equal(isMobileCandidate(touch, 820, true), true);
  assert.equal(isMobileCandidate(touch, 1367, true), false);
  assert.equal(isMobileCandidate(touch, NaN, true), false);
  assert.equal(isMobileCandidate(touch, 0, true), false);
  assert.equal(isMobileCandidate(touch, 390, false), false);
  assert.equal(isMobileCandidate({ platform: "MacIntel", maxTouchPoints: 0 }, 390, true), false);
  assert.equal(isMobileCandidate({}, 390, false), false);
});

test("preference storage keeps only a non-sensitive interface value", () => {
  const values = new Map([[INTERFACE_MODE_STORAGE_KEY, "mobile"]]);
  const store = createInterfacePreferenceStore({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) });
  assert.equal(store.get(), "mobile");
  assert.equal(store.set("desktop"), "desktop");
  assert.deepEqual([...values], [[INTERFACE_MODE_STORAGE_KEY, "desktop"]]);
  assert.equal(store.set("auto"), "auto");
  assert.throws(() => store.set("phone"), RangeError);
  assert.equal(store.get(), "auto");
});

test("unavailable, malformed and throwing storage degrade to in-memory preferences", () => {
  for (const storage of [undefined, {}, { getItem: () => '{"mode":"mobile"}' },
    { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } }]) {
    const store = createInterfacePreferenceStore(storage);
    assert.equal(store.get(), "auto");
    assert.equal(store.set("mobile"), "mobile");
    assert.equal(store.get(), "mobile");
    assert.equal(store.set("desktop"), "desktop");
  }
});

function fixture({ stored = null, mobile = true, storageDenied = false, promptEnabled = true } = {}) {
  const all = [], changes = [], queued = [], listeners = new Map();
  const values = new Map(stored == null ? [] : [[INTERFACE_MODE_STORAGE_KEY, stored]]);
  const doc = { visibilityState: "visible", activeElement: null,
    addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) ?? [], fn]); },
    emit(name, target) { for (const fn of listeners.get(name) ?? []) fn({ target }); },
    querySelectorAll: () => all.filter(node => node.tagName === "DIALOG" && node.open) };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.dataset = {}; this.events = new Map(); this.isConnected = true; all.push(this); }
    setAttribute(name, value) { this[name] = value; }
    append() {}
    addEventListener(name, fn) { this.events.set(name, [...this.events.get(name) ?? [], fn]); }
    emit(name) { for (const fn of this.events.get(name) ?? []) fn({ target: this }); }
    focus() { doc.activeElement = this; }
    getClientRects() { return [{}]; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit("close"); doc.emit("close", this); }
  }
  doc.createElement = name => new Element(name);
  doc.documentElement = new Element("html");
  doc.documentElement.lang = "en";
  doc.body = new Element("body");
  const originalFocus = new Element("button");
  doc.activeElement = originalFocus;
  const win = { navigator: mobile ? { userAgent: "iPhone", maxTouchPoints: 5 } : { platform: "MacIntel" },
    innerWidth: 390, matchMedia: () => ({ matches: mobile, addEventListener() {} }),
    queueMicrotask: fn => queued.push(fn), addEventListener(name, fn) { this[name] = fn; },
    MutationObserver: class { constructor(fn) { win.observer = fn; } observe() {} } };
  Object.defineProperty(win, "localStorage", { get() {
    if (storageDenied) throw new Error("access denied");
    return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  } });
  const controller = mountInterfaceMode({ document: doc, window: win, promptEnabled,
    onChange: (...args) => changes.push(args) });
  return { doc, win, controller, values, changes, originalFocus,
    node: id => all.find(node => node.id === id), flush() { while (queued.length) queued.shift()(); } };
}

test("mount and refresh do not prompt; a confirmed choice persists without reload", () => {
  const f = fixture();
  assert.equal(f.doc.documentElement.dataset.interfaceMode, "desktop");
  assert.equal(f.doc.documentElement.dataset.interfacePreference, "auto");
  f.controller.refresh(); f.flush();
  assert.equal(f.node("interface-mode-dialog").open, undefined);
  assert.deepEqual(f.changes, []);
  assert.equal(f.controller.maybePrompt(), true);
  assert.equal(f.doc.activeElement.id, "interface-mode-title");
  f.node("interface-mode-use-mobile").emit("click");
  assert.equal(f.controller.getPreference(), "mobile");
  assert.equal(f.controller.getMode(), "mobile");
  assert.equal(f.doc.documentElement.dataset.interfacePreference, "mobile");
  assert.equal(f.values.get(INTERFACE_MODE_STORAGE_KEY), "mobile");
  assert.deepEqual(f.changes, [["mobile", "mobile"]]);
  assert.equal(f.doc.activeElement, f.originalFocus);
  f.controller.refresh();
  assert.equal(f.changes.length, 1);
});

test("saved desktop wins on touch phones and saved mobile wins on wide desktops", () => {
  const phone = fixture({ stored: "desktop" });
  assert.equal(phone.controller.isMobileCandidate(), true);
  assert.equal(phone.controller.maybePrompt(), false);
  assert.equal(phone.controller.getMode(), "desktop");
  const desktop = fixture({ stored: "mobile", mobile: false });
  desktop.win.innerWidth = 1800;
  desktop.controller.refresh();
  assert.equal(desktop.controller.getMode(), "mobile");
  assert.equal(desktop.controller.isMobileCandidate(), false);
});

test("an explicit desktop choice notifies both preference controls without a layout change", () => {
  const f = fixture();
  assert.deepEqual(f.changes, []);
  f.controller.setPreference("desktop");
  assert.equal(f.doc.documentElement.dataset.interfacePreference, "desktop");
  assert.deepEqual(f.changes, [["desktop", "desktop"]]);
  f.controller.refresh();
  f.controller.setPreference("desktop");
  assert.equal(f.changes.length, 1);
  f.controller.setPreference("auto");
  assert.equal(f.doc.documentElement.dataset.interfacePreference, "auto");
  assert.deepEqual(f.changes.at(-1), ["desktop", "auto"]);
  f.controller.refresh();
  assert.equal(f.changes.length, 2);
});

test("confirmation waits for boot and existing dialogs, without stealing their focus", () => {
  const f = fixture();
  f.doc.documentElement.dataset.bootState = "loading";
  assert.equal(f.controller.maybePrompt(), false);
  const other = f.doc.createElement("dialog");
  other.showModal(); other.focus();
  delete f.doc.documentElement.dataset.bootState;
  f.win.observer(); f.flush();
  assert.equal(f.node("interface-mode-dialog").open, undefined);
  assert.equal(f.doc.activeElement, other);
  other.close(); f.flush();
  assert.equal(f.node("interface-mode-dialog").open, true);
  other.showModal(); other.focus();
  f.controller.setPreference("desktop");
  assert.equal(f.doc.activeElement, other);
});

test("Escape postpones only this page; explicit auto can ask again", () => {
  const f = fixture();
  f.controller.maybePrompt();
  f.node("interface-mode-dialog").emit("cancel");
  f.node("interface-mode-dialog").close();
  f.controller.refresh(); f.flush();
  assert.equal(f.controller.maybePrompt(), false);
  assert.equal(f.controller.getPreference(), "auto");
  f.controller.setPreference("auto"); f.flush();
  assert.equal(f.node("interface-mode-dialog").open, true);
});

test("storage-denied browsers and examples can choose without authentication or a prompt", () => {
  const f = fixture({ storageDenied: true, promptEnabled: false });
  assert.equal(f.controller.maybePrompt(), false);
  f.controller.setPreference("mobile");
  assert.equal(f.controller.getMode(), "mobile");
  f.controller.setPreference("auto"); f.flush();
  assert.equal(f.node("interface-mode-dialog").open, undefined);
});

test("dialog text follows Chinese and live language changes", () => {
  const f = fixture();
  f.doc.documentElement.lang = "zh-CN";
  f.controller.maybePrompt();
  assert.equal(f.node("interface-mode-title").textContent, "选择界面");
  assert.equal(f.node("interface-mode-use-mobile").textContent, "使用移动端");
  f.doc.documentElement.lang = "en";
  f.controller.refresh();
  assert.equal(f.node("interface-mode-title").textContent, "Choose your interface");
});

test("cross-tab updates change only presentation and never echo storage writes", () => {
  const f = fixture({ stored: "desktop" });
  f.win.storage({ key: "unrelated", newValue: "mobile" });
  assert.equal(f.controller.getMode(), "desktop");
  f.win.storage({ key: INTERFACE_MODE_STORAGE_KEY, newValue: "mobile" });
  assert.equal(f.controller.getMode(), "mobile");
  assert.equal(f.values.get(INTERFACE_MODE_STORAGE_KEY), "desktop");
  assert.deepEqual(f.changes, [["mobile", "mobile"]]);
});
