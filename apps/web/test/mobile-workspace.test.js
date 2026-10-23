import test from "node:test";
import assert from "node:assert/strict";
import { isMobileDevice, usesMobileWorkspace, MOBILE_WORKSPACE_MAX_WIDTH, mobileAgentLabel, mobileControlLabel, isDialogBackdropPointer,
  mountMobileWorkspace, mobileWorkspaceModeActive } from "../src/mobile-workspace.js";

test("local connection availability follows the platform, not a narrow desktop window", () => {
  assert.equal(isMobileDevice({ userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(isMobileDevice({ userAgent: "Windows Chrome", platform: "Win32", maxTouchPoints: 10 }), false);
  assert.equal(isMobileDevice({ userAgent: "Mozilla/5.0 (iPhone)" }), true);
  assert.equal(isMobileDevice({ userAgent: "Mozilla/5.0 (Linux; Android 16)" }), true);
  assert.equal(isMobileDevice({ userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 }), true);
});

test("mobile presentation includes tablet portrait/landscape without replacing a narrow desktop", () => {
  const ipad = { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 };
  const android = { userAgent: "Mozilla/5.0 (Linux; Android 16)", maxTouchPoints: 5 };
  const desktop = { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 0 };
  const touchLaptop = { userAgent: "Windows Chrome", platform: "Win32", maxTouchPoints: 10 };
  for (const width of [320, 390, 768, 820, 844, 1024, 1180, 1366]) {
    assert.equal(usesMobileWorkspace(ipad, width), true);
    assert.equal(usesMobileWorkspace(android, width), true);
    assert.equal(usesMobileWorkspace(desktop, width), false);
    assert.equal(usesMobileWorkspace(touchLaptop, width), false);
  }
  assert.equal(usesMobileWorkspace(ipad, MOBILE_WORKSPACE_MAX_WIDTH + 1), false);
});

test("an explicit interface choice overrides viewport detection without changing device identity", () => {
  const phone = { userAgent: "iPhone" }, desktop = { userAgent: "Macintosh", maxTouchPoints: 0 };
  assert.equal(mobileWorkspaceModeActive("mobile", desktop, 1920), true);
  assert.equal(mobileWorkspaceModeActive("desktop", phone, 390), false);
  assert.equal(mobileWorkspaceModeActive(null, phone, 390), true);
  assert.equal(mobileWorkspaceModeActive(null, desktop, 390), false);
  assert.equal(isMobileDevice(phone), true);
  assert.equal(isMobileDevice(desktop), false);
});

test("small mobile labels preserve harness identity and request/pause/resume distinctions", () => {
  const translate = text => ({ low: "低", Cloud: "云端" })[text] ?? text;
  assert.equal(mobileAgentLabel("codex", "low", translate), "Codex · 低");
  assert.equal(mobileAgentLabel("deepseek-harness", "high"), "DSH · high");
  assert.equal(mobileAgentLabel("cloud", "", translate), "云端");
  assert.equal(mobileControlLabel("Request my agent"), "Ask AI");
  assert.equal(mobileControlLabel("Pause Agent"), "Pause");
  assert.equal(mobileControlLabel("Resume Agent"), "Resume");
  assert.equal(mobileControlLabel("Pausing…"), "Pausing…");
  assert.equal(mobileControlLabel("Pauses your current request; your draft stays here."), "Pauses your current request; your draft stays here.");
});

test("dialog backdrop hit testing excludes the sheet's border, padding and child controls", () => {
  const dialog = { getBoundingClientRect: () => ({ left: 100, right: 620, top: 120, bottom: 700 }) };
  const pointer = (x, y, target = dialog) => ({ target, clientX: x, clientY: y });
  for (const [x, y] of [[100, 120], [112, 200], [620, 700], [360, 420]]) {
    assert.equal(isDialogBackdropPointer(dialog, pointer(x, y)), false);
  }
  for (const [x, y] of [[99, 200], [621, 200], [360, 119], [360, 701]]) {
    assert.equal(isDialogBackdropPointer(dialog, pointer(x, y)), true);
  }
  assert.equal(isDialogBackdropPointer(dialog, pointer(4, 4, {})), false);
  assert.equal(isDialogBackdropPointer(dialog, { target: dialog }), false);
});

test("selecting a Team on mobile shows its saved name without leaking the previous Codex reasoning choice", () => {
  const nodes = new Map();
  const create = () => ({ children: [], dataset: {}, attributes: {}, hidden: false, open: false, value: "", textContent: "",
    tagName: "DIV", classList: { contains: () => false }, style: { setProperty() {} },
    append(...items) { this.children.push(...items); }, before() {}, after() {}, addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; }, closest: () => null,
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector() { return create(); }, querySelectorAll: () => [], getClientRects: () => [{}], focus() {},
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  const el = id => { if (!nodes.has(id)) nodes.set(id, create()); return nodes.get(id); };
  const dialogs = ["mobile-sessions-dialog", "mobile-agent-dialog", "mobile-tools-dialog", "mobile-members-dialog"].map(el);
  const document = { body: create(), documentElement: create(), getElementById: el, createComment: create,
    createElement: create, querySelectorAll: selector => selector === "dialog" ? dialogs : [], querySelector: () => null };
  const window = { navigator: { userAgent: "iPhone", maxTouchPoints: 5 },
    matchMedia: () => ({ matches: true, addEventListener() {} }), MutationObserver: class { observe() {} }, queueMicrotask };
  const harness = el("agent-harness-select"); harness.value = "codex"; harness.selectedOptions = [{ textContent: "Codex" }];
  el("agent-effort-select").value = "high"; el("agent-effort-select").selectedOptions = [{ textContent: "高" }];
  el("agent-request-profile").querySelectorAll = () => [harness];
  const translate = text => ({ high: "高", "Agent, model and reasoning": "Agent、模型和推理强度" })[text] ?? text;
  const mobile = mountMobileWorkspace({ document, window, t: translate });
  assert.equal(mobile.isActive(), true); assert.equal(el("mobile-agent-label").textContent, "Codex · 高");
  harness.value = "team:team-a"; harness.selectedOptions = [{ textContent: "我的审查团队" }]; mobile.update();
  assert.equal(el("mobile-agent-label").textContent, "我的审查团队");
  assert.doesNotMatch(el("mobile-agent-label").textContent, /Codex|high|高/);
  assert.equal(el("mobile-agent-button").attributes["aria-label"], "Agent、模型和推理强度 · 我的审查团队");
  assert.equal(harness.value, "team:team-a", "presentation must not change the selected Team or its request route");
});
