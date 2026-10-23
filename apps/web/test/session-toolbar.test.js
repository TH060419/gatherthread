import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mountSessionToolbar } from "../src/session-toolbar.js";
import { toolsActionLeavesPanel } from "../src/mobile-panels.js";

function fixture() {
  let document;
  class Element {
    constructor(tag = "div", id = "") { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.open = false; this.className = ""; }
    append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); this.children.push(node); node.parentNode = this; } }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) { return selector === "[hidden]" ? this.hidden : selector.startsWith("#") ? this.id === selector.slice(1) : selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : this.tagName.toLowerCase() === selector; }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node; return null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(", ").some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector)]); }
    getClientRects() { return this.closest("[hidden]") ? [] : [{}]; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = this.listeners[type].filter(value => value !== listener); }
    fire(type, event = {}) {
      const value = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...event };
      for (let node = this; node && !value.stopped; node = node.parentNode) for (const listener of node.listeners?.[type] ?? []) listener(value);
      return value;
    }
    focus() { document.activeElement = this; }
  }
  const body = new Element("body"), doc = new Element("document"); doc.append(body);
  document = Object.assign(doc, { body, activeElement: body, getElementById: id => body.querySelectorAll(`#${id}`)[0] ?? null });
  const add = (tag, id, parent = body) => { const node = new Element(tag, id); parent.append(node); return node; };
  const group = (id, triggerId, panelId) => {
    const root = add("div", id); root.className = "session-toolbar-menu";
    const trigger = add("button", triggerId, root); trigger.className = "session-toolbar-trigger";
    const panel = add("div", panelId, root); panel.hidden = true;
    trigger.setAttribute("aria-controls", panelId); trigger.setAttribute("aria-expanded", "false");
    return { root, trigger, panel };
  };
  const summaries = group("history-summary-menu", "history-summary-menu-button", "history-summary-menu-panel");
  const select = add("button", "history-summary-select-button", summaries.panel);
  const view = add("button", "history-summary-view-button", summaries.panel); view.hidden = true;
  const versions = add("button", "history-summary-versions-button", summaries.panel); versions.hidden = true;
  const options = group("session-options-menu", "session-options-button", "session-options-panel");
  const rename = add("button", "rename-session-button", options.panel); rename.hidden = true;
  const details = add("details", "session-context-details", options.panel), status = add("summary", "", details);
  const context = add("div", "session-context-panel", details), sync = add("button", "upload-local-turns-button", context);
  const outside = add("button", "outside");
  const toolbar = mountSessionToolbar({ document });
  return { document, toolbar, summaries, select, view, versions, options, rename, details, status, context, sync, outside };
}

test("one summary trigger preserves the existing action availability and never grants access", () => {
  const f = fixture();
  f.select.hidden = true; f.toolbar.refresh(); assert.equal(f.summaries.root.hidden, true);
  assert.equal(f.toolbar.open("history-summary-menu"), false);
  f.versions.hidden = false; f.view.hidden = false; f.view.disabled = true; f.toolbar.refresh();
  assert.equal(f.summaries.root.hidden, false); f.toolbar.open("history-summary-menu-button");
  assert.equal(f.select.hidden, true); assert.equal(f.view.disabled, true); assert.equal(f.rename.hidden, true);
});

test("keyboard opens on ArrowDown, skips disabled actions, and Escape restores trigger focus", () => {
  const f = fixture(); f.select.disabled = true; f.versions.hidden = false;
  const key = f.summaries.trigger.fire("keydown", { key: "ArrowDown" });
  assert.equal(key.prevented, true); assert.equal(f.summaries.panel.hidden, false);
  assert.equal(f.document.activeElement, f.versions);
  const escape = f.versions.fire("keydown", { key: "Escape" });
  assert.equal(escape.prevented, true); assert.equal(f.summaries.panel.hidden, true);
  assert.equal(f.summaries.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(f.document.activeElement, f.summaries.trigger);
});

test("outside pointer and focus dismiss disclosures; opening another keeps only one open", () => {
  const f = fixture(); f.summaries.trigger.fire("click"); f.options.trigger.fire("click");
  assert.equal(f.summaries.panel.hidden, true); assert.equal(f.options.panel.hidden, false);
  f.outside.fire("pointerdown"); assert.equal(f.options.panel.hidden, true);
  f.summaries.trigger.fire("click"); f.outside.focus(); f.outside.fire("focusin");
  assert.equal(f.summaries.panel.hidden, true); assert.equal(f.document.activeElement, f.outside);
});

test("actions close their menu without stealing focus already moved to the timeline or a dialog", () => {
  const f = fixture(); f.toolbar.open("history-summary-menu"); f.select.focus(); f.select.fire("click");
  assert.equal(f.summaries.panel.hidden, true); assert.equal(f.document.activeElement, f.summaries.trigger);
  f.select.addEventListener("click", () => f.outside.focus()); f.toolbar.open("history-summary-menu"); f.select.focus(); f.select.fire("click");
  assert.equal(f.document.activeElement, f.outside);
});

test("portalled status controls retain their disclosure and own the first Escape", () => {
  const f = fixture(); f.toolbar.open("session-options-menu"); f.details.open = true;
  f.document.body.append(f.context); f.sync.focus(); f.sync.fire("focusin"); f.sync.fire("pointerdown"); f.sync.fire("click");
  assert.equal(f.options.panel.hidden, false); assert.equal(f.details.open, true);
  const escape = f.sync.fire("keydown", { key: "Escape" });
  assert.notEqual(escape.prevented, true, "the existing session-context handler owns nested Escape");
  f.toolbar.reset(); assert.equal(f.options.panel.hidden, true); assert.equal(f.details.open, false);
});

test("mobile tools keep the two disclosures open for navigation but close for enabled actions", () => {
  const f = fixture();
  assert.equal(toolsActionLeavesPanel(f.summaries.trigger), false);
  assert.equal(toolsActionLeavesPanel(f.options.trigger), false);
  assert.equal(toolsActionLeavesPanel(f.sync), false);
  assert.equal(toolsActionLeavesPanel(f.select), true);
  f.select.disabled = true; assert.equal(toolsActionLeavesPanel(f.select), false);
});

test("header markup has only two purpose triggers and leaves mentions in the timeline", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const header = html.slice(html.indexOf('<header class="session-header">'), html.indexOf('</header>', html.indexOf('<header class="session-header">')));
  assert.equal((header.match(/class="[^\"]*session-toolbar-trigger/g) ?? []).length, 2);
  assert.ok(header.includes('id="history-summary-menu-panel"')); assert.ok(header.includes('id="session-options-panel"'));
  assert.equal(header.includes('id="mentions-button"'), false);
  assert.match(html, /id="event-timeline"[^>]*><\/ol>\s*<button id="mentions-button"[^>]*hidden>/);
});
