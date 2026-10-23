import test from "node:test";
import assert from "node:assert/strict";
import { bindSessionContextPanel } from "../src/session-context-panel.js";

function fixture({ modal = false, controls = 0 } = {}) {
  const listeners = new Map();
  const doc = { body: { classList: { contains: () => false } },
    addEventListener: (name, listener) => listeners.set(name, listener) };
  const node = id => ({ id, tabIndex: 0, disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {},
    closest: () => null, getClientRects: () => [{}], focus() { doc.activeElement = this; } });
  const summary = node("status-summary"), following = node("next-visible-control"), hidden = node("hidden-control");
  hidden.closest = selector => selector === "[hidden]" ? {} : null;
  const children = Array.from({ length: controls }, (_, index) => node(`detail-${index}`));
  const panel = { contains: target => children.includes(target), querySelectorAll: () => children };
  const navigation = { querySelectorAll: () => [summary, hidden, following] };
  const details = { open: true, contains: target => target === summary,
    closest: () => modal ? navigation : null,
    querySelector: selector => selector === "summary" ? summary : panel };
  summary.compareDocumentPosition = () => 4;
  doc.querySelectorAll = navigation.querySelectorAll;
  doc.getElementById = () => details;
  const originalObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} };
  try { bindSessionContextPanel(doc); }
  finally { globalThis.MutationObserver = originalObserver; }
  const press = (target, shiftKey = false) => {
    doc.activeElement = target;
    const event = { key: "Tab", target, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    listeners.get("keydown")(event);
    return event;
  };
  return { doc, summary, following, children, press };
}

test("Tab exits an informational mobile status disclosure instead of remaining on its summary", () => {
  const f = fixture({ modal: true });
  assert.equal(f.press(f.summary).prevented, true);
  assert.equal(f.doc.activeElement, f.following);
  assert.equal(f.press(f.summary, true).prevented, false, "reverse traversal remains native within the modal");
});

test("actionable modal status controls keep native focus traversal", () => {
  const f = fixture({ modal: true, controls: 2 });
  assert.equal(f.press(f.summary).prevented, false);
  assert.equal(f.press(f.children[0]).prevented, false);
});

test("portalled desktop status controls follow logical order through the last header item", () => {
  const f = fixture({ controls: 2 });
  assert.equal(f.press(f.summary).prevented, true);
  assert.equal(f.doc.activeElement, f.children[0]);
  f.press(f.children[0]); assert.equal(f.doc.activeElement, f.children[1]);
  f.press(f.children[1]); assert.equal(f.doc.activeElement, f.following);
  f.press(f.following, true); assert.equal(f.doc.activeElement, f.children[1]);
});
