import assert from "node:assert/strict";
import test from "node:test";
import { mountTeamCanvas } from "../src/agent-team-canvas.js";

class Element {
  constructor(document, tagName, namespaceURI) {
    this.ownerDocument = document; this.tagName = tagName; this.namespaceURI = namespaceURI;
    this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = {}; this.style = {};
    this.className = ""; this.listeners = new Map(); this.scrollLeft = 100; this.scrollTop = 40;
    this.clientWidth = 600; this.clientHeight = 400;
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(" ").trim(); } };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler, options = false) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ handler, capture: options === true || options?.capture === true }); this.listeners.set(type, listeners);
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const value = part.trim();
      if (value.startsWith(".")) return this.className.split(/\s+/).includes(value.slice(1));
      const attribute = /^\[data-([a-z-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/.exec(value);
      if (!attribute) return false;
      const key = attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return attribute[2] === undefined ? key in this.dataset : this.dataset[key] === attribute[2];
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const values = []; for (const child of this.children) { if (child.matches(selector)) values.push(child); values.push(...child.querySelectorAll(selector)); }
    return values;
  }
  querySelector(selector) {
    const split = selector.indexOf(" ");
    if (split !== -1) return this.querySelectorAll(selector.slice(0, split)).flatMap(node => node.querySelectorAll(selector.slice(split + 1)))[0] ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture(id) { this.ownerDocument.captured.set(id, this); }
  hasPointerCapture(id) { return this.ownerDocument.captured.get(id) === this; }
  releasePointerCapture(id) { if (this.hasPointerCapture(id)) this.ownerDocument.captured.delete(id); }
  dispatch(type, fields = {}) {
    const event = { type, target: this, button: 0, pointerId: 1, clientX: 0, clientY: 0,
      ...fields, prevented: false, stopped: false, immediate: false, preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    const ancestors = []; for (let node = this; node; node = node.parentElement) ancestors.push(node);
    for (const node of [...ancestors].reverse()) {
      for (const listener of node.listeners.get(type) ?? []) {
        if (listener.capture) listener.handler(event);
        if (event.immediate) break;
      }
      if (event.stopped) return event;
    }
    for (const node of ancestors) {
      for (const listener of node.listeners.get(type) ?? []) {
        if (!listener.capture) listener.handler(event);
        if (event.immediate) break;
      }
      if (event.stopped || ["pointerenter", "pointerleave"].includes(type)) break;
    }
    return event;
  }
}

function fixture({ t = text => text } = {}) {
  const document = { captured: new Map(), pointElement: null, activeElement: null,
    createElement(tag) { return new Element(this, tag); },
    createElementNS(namespace, tag) { return new Element(this, tag, namespace); },
    elementFromPoint() { return this.pointElement; } };
  const host = document.createElement("div");
  const draft = { name: "Fixture Team", entry_node_id: "a", nodes: [
    { id: "a", label: "Planner", role: "Plan", target: null, x: 40, y: 60 },
    { id: "b", label: "Worker", role: "Execute", target: null, x: 500, y: 80 },
  ], edges: [{ id: "existing", source: "a", target: "b", direction: "one_way" }] };
  let changes = 0, nextId = 0; const selections = [];
  const canvas = mountTeamCanvas({ document, host, getDraft: () => draft, onChange: () => changes++,
    onSelection: (selection, pinned) => selections.push({ selection, pinned }), t, makeId: prefix => `${prefix}-${++nextId}` });
  canvas.render();
  const card = id => host.querySelector(`[data-node-id="${id}"]`);
  const title = id => card(id).querySelector(".team-node-drag");
  const port = (id, direction) => card(id).querySelector(`[data-port='${direction}']`);
  return { document, host, draft, canvas, selections, card, title, port, changes: () => changes,
    viewport: host.querySelector(".team-canvas-viewport"), hud: host.querySelector(".team-canvas-tools") };
}

test("hover highlights restore on leave, pinned selection ignores hover, and blank canvas clears the pin", () => {
  const f = fixture();
  f.card("a").dispatch("pointerenter");
  assert.deepEqual(f.canvas.selection(), { kind: "node", id: "a" });
  assert.equal(f.card("a").dataset.highlighted, "true");
  f.card("a").dispatch("pointerleave");
  assert.equal(f.canvas.selection(), null);
  f.card("a").dispatch("click");
  f.card("b").dispatch("pointerenter");
  assert.deepEqual(f.canvas.pinned(), { kind: "node", id: "a" });
  assert.equal(f.card("b").dataset.highlighted, "false");
  f.viewport.dispatch("click");
  assert.equal(f.canvas.pinned(), null);
  f.card("b").dispatch("pointerenter");
  assert.deepEqual(f.canvas.selection(), { kind: "node", id: "b" });
});

test("a selected data flow keeps highlight across node hover and supports keyboard selection", () => {
  const f = fixture(), edge = f.host.querySelector("[data-edge-id='existing']");
  edge.dispatch("pointerenter");
  assert.equal(edge.dataset.highlighted, "true");
  edge.dispatch("pointerleave");
  assert.equal(edge.dataset.highlighted, "false");
  const event = edge.dispatch("keydown", { key: "Enter" });
  assert.equal(event.prevented, true);
  f.card("a").dispatch("pointerenter");
  assert.deepEqual(f.canvas.pinned(), { kind: "edge", id: "existing" });
  assert.equal(edge.dataset.highlighted, "true");
});

test("keyboard-compatible output/input clicks create and select a new route without duplicate routes", () => {
  const f = fixture();
  f.port("b", "out").dispatch("click");
  assert.equal(f.viewport.dataset.linking, "true");
  f.port("a", "in").dispatch("click");
  assert.equal(f.changes(), 1);
  assert.deepEqual(f.draft.edges[1], { id: "edge-1", source: "b", target: "a", direction: "one_way" });
  assert.deepEqual(f.canvas.pinned(), { kind: "edge", id: "edge-1" });
  assert.equal(f.viewport.dataset.linking, "false");
  f.port("b", "out").dispatch("click"); f.port("a", "in").dispatch("click");
  assert.equal(f.draft.edges.length, 2);
  assert.equal(f.changes(), 1);
});

test("a captured port drag connects the exact input hit by elementFromPoint", () => {
  const f = fixture();
  f.document.pointElement = f.port("a", "in");
  f.port("b", "out").dispatch("pointerdown", { clientX: 730, clientY: 140 });
  assert.equal(f.viewport.hasPointerCapture(1), true);
  f.viewport.dispatch("pointerup", { clientX: 40, clientY: 120 });
  assert.equal(f.draft.edges.length, 2);
  assert.equal(f.viewport.hasPointerCapture(1), false);
  assert.deepEqual(f.canvas.pinned(), { kind: "edge", id: "edge-1" });
  assert.equal(f.viewport.dataset.linking, "false");
});

test("the compatibility click on the capture target must not immediately clear a pointer-selected node", () => {
  const f = fixture();
  f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointerup", { clientX: 70, clientY: 80 });
  // Pointer Events dispatches the following click at the pointerup capture target.
  f.viewport.dispatch("click", { clientX: 70, clientY: 80 });
  assert.deepEqual(f.canvas.pinned(), { kind: "node", id: "a" });
});

test("the compatibility click after a captured wire drag must preserve the newly selected flow", () => {
  const f = fixture();
  f.document.pointElement = f.port("a", "in");
  f.port("b", "out").dispatch("pointerdown", { clientX: 730, clientY: 140 });
  f.viewport.dispatch("pointerup", { clientX: 40, clientY: 120 });
  f.viewport.dispatch("click", { clientX: 40, clientY: 120 });
  assert.deepEqual(f.canvas.pinned(), { kind: "edge", id: "edge-1" });
});

test("pointer users can click an output then an input, and cancel a pending connection by clicking blank canvas", () => {
  const f = fixture();
  f.document.pointElement = f.port("b", "out");
  f.port("b", "out").dispatch("pointerdown", { clientX: 730, clientY: 140 });
  f.viewport.dispatch("pointerup", { clientX: 730, clientY: 140 });
  f.viewport.dispatch("click", { clientX: 730, clientY: 140 });
  assert.equal(f.viewport.dataset.linking, "true");
  f.document.pointElement = f.port("a", "in");
  f.port("a", "in").dispatch("pointerdown", { clientX: 40, clientY: 120 });
  f.port("a", "in").dispatch("pointerup", { clientX: 40, clientY: 120 });
  // The second tap has no capture: its click targets the input port normally.
  f.port("a", "in").dispatch("click", { clientX: 40, clientY: 120 });
  assert.equal(f.draft.edges.length, 2);
  assert.deepEqual(f.canvas.pinned(), { kind: "edge", id: "edge-1" });
  f.port("a", "out").dispatch("click");
  f.viewport.dispatch("click");
  assert.equal(f.viewport.dataset.linking, "false");
  assert.equal(f.canvas.pinned(), null);
});

test("a minor pointer tremor cannot silently change a saved node position without a dirty notification", () => {
  const f = fixture(), before = { x: f.draft.nodes[0].x, y: f.draft.nodes[0].y };
  f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { clientX: 71, clientY: 80 });
  f.viewport.dispatch("pointerup", { clientX: 71, clientY: 80 });
  const changed = f.draft.nodes[0].x !== before.x || f.draft.nodes[0].y !== before.y;
  assert.ok(!changed || f.changes() > 0, "changed geometry must mark the configuration dirty even below the visual drag threshold");
});

test("secondary mouse buttons do not start a data-flow gesture", () => {
  const f = fixture();
  f.port("b", "out").dispatch("pointerdown", { button: 2 });
  assert.notEqual(f.viewport.dataset.linking, "true");
  assert.equal(f.viewport.hasPointerCapture(1), false);
});

test("dragging uses graph coordinates at the current zoom and ignores unrelated pointer ids", () => {
  const f = fixture();
  f.hud.children[2].dispatch("click"); f.hud.children[2].dispatch("click"); // 120%.
  f.title("a").dispatch("pointerdown", { clientX: 100, clientY: 100 });
  f.viewport.dispatch("pointermove", { pointerId: 8, clientX: 600, clientY: 600 });
  assert.equal(f.draft.nodes[0].x, 40);
  f.viewport.dispatch("pointermove", { clientX: 124, clientY: 112 });
  f.viewport.dispatch("pointerup", { clientX: 124, clientY: 112 });
  assert.equal(f.draft.nodes[0].x, 60);
  assert.equal(f.draft.nodes[0].y, 70);
  assert.equal(f.changes(), 1);
});

test("arrow keys move the selected module, clamp to the graph boundary and restore keyboard focus", () => {
  const f = fixture(); f.draft.nodes[0].x = 0;
  const left = f.title("a").dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(left.prevented, true); assert.equal(f.draft.nodes[0].x, 0);
  f.title("a").dispatch("keydown", { key: "ArrowRight", shiftKey: true });
  f.title("a").dispatch("keydown", { key: "ArrowDown" });
  assert.equal(f.draft.nodes[0].x, 40); assert.equal(f.draft.nodes[0].y, 70);
  assert.equal(f.document.activeElement, f.title("a"));
  assert.deepEqual(f.canvas.pinned(), { kind: "node", id: "a" });
});

test("zoom keeps the viewport center stable, clamps its range and leaves ordinary wheel scrolling alone", () => {
  const f = fixture(), [minus, reset, plus] = f.hud.children;
  plus.dispatch("click");
  assert.ok(Math.abs(f.viewport.scrollLeft - 140) < .00001);
  assert.ok(Math.abs(f.viewport.scrollTop - 64) < .00001);
  assert.equal(reset.textContent, "110%");
  for (let index = 0; index < 20; index++) plus.dispatch("click");
  assert.equal(reset.textContent, "180%");
  for (let index = 0; index < 30; index++) minus.dispatch("click");
  assert.equal(reset.textContent, "40%");
  reset.dispatch("click");
  assert.equal(reset.textContent, "100%");
  const ordinary = f.viewport.dispatch("wheel", { deltaY: 10 });
  assert.equal(ordinary.prevented, false); assert.equal(reset.textContent, "100%");
  const pinch = f.viewport.dispatch("wheel", { ctrlKey: true, deltaY: -10 });
  assert.equal(pinch.prevented, true); assert.equal(reset.textContent, "108%");
});


test("a pending wire cannot introduce an endpoint deleted before connection completes", () => {
  const f = fixture();
  // Use keyboard-compatible port selection, then remove its source externally.
  f.port("b", "out").dispatch("click"); f.draft.nodes = f.draft.nodes.filter(node => node.id !== "b"); f.draft.edges = [];
  f.canvas.render(); f.port("a", "in").dispatch("click");
  assert.deepEqual(f.draft.edges, []); assert.equal(f.changes(), 0);
});

test("clearing the fixed selection cancels wiring and a captured drag", () => {
  const f = fixture(); f.port("b", "out").dispatch("click"); f.canvas.select(null);
  assert.equal(f.viewport.dataset.linking, "false");
  f.port("a", "in").dispatch("click"); assert.equal(f.draft.edges.length, 1);
  f.title("a").dispatch("pointerdown", { clientX: 50, clientY: 60 }); f.canvas.select(null);
  f.viewport.dispatch("pointermove", { clientX: 200, clientY: 250 }); f.viewport.dispatch("pointerup", { clientX: 200, clientY: 250 });
  assert.equal(f.draft.nodes[0].x, 40); assert.equal(f.draft.nodes[0].y, 60); assert.equal(f.changes(), 0);
});


test("changing language refreshes persistent canvas and zoom accessible names", () => {
  let chinese = false;
  const labels = { "Team workflow canvas": "团队流程画布", "Zoom out": "缩小", "Zoom in": "放大", "Reset zoom": "重置缩放" };
  const f = fixture({ t: text => chinese ? labels[text] ?? text : text });
  chinese = true; f.canvas.render();
  assert.equal(f.viewport.attributes["aria-label"], "团队流程画布");
  assert.deepEqual(f.hud.children.map(node => node.attributes["aria-label"]), ["缩小", "重置缩放", "放大"]);
});

test("a touch drag without a compatibility click cannot swallow the next independent blank tap", () => {
  const f = fixture();
  f.title("a").dispatch("pointerdown", { pointerType: "touch", clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { pointerType: "touch", clientX: 120, clientY: 80 });
  f.viewport.dispatch("pointerup", { pointerType: "touch", clientX: 120, clientY: 80 });
  assert.equal(f.draft.nodes[0].x, 90);
  assert.deepEqual(f.canvas.pinned(), { kind: "node", id: "a" });
  f.viewport.dispatch("pointerdown", { pointerType: "touch", clientX: 300, clientY: 400 });
  f.viewport.dispatch("pointerup", { pointerType: "touch", clientX: 300, clientY: 400 });
  const tap = f.viewport.dispatch("click", { pointerType: "touch", clientX: 300, clientY: 400 });
  assert.equal(tap.prevented, false); assert.equal(f.canvas.pinned(), null);
});

test("a cancelled wire gesture leaves the next blank tap and keyboard click available", () => {
  const f = fixture(); f.canvas.select({ kind: "node", id: "a" });
  f.port("a", "out").dispatch("pointerdown");
  f.viewport.dispatch("pointercancel");
  assert.equal(f.viewport.dataset.linking, "false");
  f.viewport.dispatch("pointerdown"); f.viewport.dispatch("pointerup"); f.viewport.dispatch("click");
  assert.equal(f.canvas.pinned(), null);
  f.title("a").dispatch("pointerdown"); f.viewport.dispatch("pointerup");
  f.port("b", "out").dispatch("click", { detail: 0, pointerId: -1 });
  assert.equal(f.viewport.dataset.linking, "true");
});

test("remote canvas redraw preserves module keyboard focus and subsequent arrow editing", () => {
  const f = fixture(); f.title("a").focus();
  f.draft.nodes[0] = { ...f.draft.nodes[0], label: "Updated remotely", x: 100 };
  f.canvas.render();
  assert.equal(f.document.activeElement, f.title("a"));
  assert.equal(f.document.activeElement.textContent, "Updated remotely");
  f.document.activeElement.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(f.draft.nodes[0].x, 110); assert.equal(f.changes(), 1);
});

test("remote redraw preserves exact port and edge focus without stealing inspector focus", () => {
  const f = fixture(); f.port("a", "out").focus(); f.canvas.render();
  assert.equal(f.document.activeElement, f.port("a", "out"));
  f.host.querySelector("[data-edge-id='existing']").focus();
  f.draft.edges[0].direction = "bidirectional"; f.canvas.render();
  assert.equal(f.document.activeElement, f.host.querySelector("[data-edge-id='existing']"));
  const input = f.document.createElement("input"); input.focus(); f.canvas.render();
  assert.equal(f.document.activeElement, input);
});

test("removing a focused remote module or flow falls back to the visible canvas", () => {
  const f = fixture(); f.canvas.select({ kind: "node", id: "b" }); f.title("b").focus();
  f.draft.nodes = f.draft.nodes.filter(node => node.id !== "b"); f.draft.edges = []; f.canvas.render();
  assert.equal(f.document.activeElement, f.viewport);
  assert.equal(f.canvas.pinned(), null);
  f.card("a").dispatch("pointerenter");
  assert.deepEqual(f.canvas.selection(), { kind: "node", id: "a" });
  f.draft.nodes.push({ id: "b", label: "Worker", role: "Execute", target: null, x: 500, y: 80 });
  f.draft.edges.push({ id: "replacement", source: "a", target: "b", direction: "one_way" }); f.canvas.render();
  f.host.querySelector("[data-edge-id='replacement']").focus(); f.draft.edges = []; f.canvas.render();
  assert.equal(f.document.activeElement, f.viewport);
});

test("losing pointer capture settles the partial drag once and fences later movement", () => {
  const f = fixture(); f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { clientX: 100, clientY: 90 });
  const position = { x: f.draft.nodes[0].x, y: f.draft.nodes[0].y };
  f.viewport.releasePointerCapture(1); f.viewport.dispatch("lostpointercapture");
  f.viewport.dispatch("pointermove", { clientX: 200, clientY: 190 }); f.viewport.dispatch("pointerup", { clientX: 200, clientY: 190 });
  assert.deepEqual({ x: f.draft.nodes[0].x, y: f.draft.nodes[0].y }, position);
  assert.equal(f.changes(), 1); assert.equal(f.viewport.dataset.linking, "false");
});

test("an unrelated touch cancellation cannot cancel the pointer that owns the drag", () => {
  const f = fixture(); f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { clientX: 100, clientY: 80 }); f.viewport.dispatch("pointercancel", { pointerId: 2 });
  f.viewport.dispatch("pointermove", { clientX: 120, clientY: 80 }); f.viewport.dispatch("pointerup", { clientX: 120, clientY: 80 });
  assert.equal(f.draft.nodes[0].x, 90); assert.equal(f.changes(), 1); assert.equal(f.viewport.hasPointerCapture(1), false);
});

test("a remote replacement of the dragged node cannot be overwritten by the old gesture", () => {
  const f = fixture(); f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { clientX: 100, clientY: 80 });
  f.draft.nodes[0] = { ...f.draft.nodes[0], x: 800, y: 300, label: "Updated remotely" }; f.canvas.render();
  f.viewport.dispatch("pointermove", { clientX: 170, clientY: 180 }); f.viewport.dispatch("pointerup", { clientX: 170, clientY: 180 });
  assert.equal(f.draft.nodes[0].x, 800); assert.equal(f.draft.nodes[0].y, 300);
  assert.equal(f.viewport.hasPointerCapture(1), false); assert.equal(f.changes(), 0);
});

test("zooming during a drag settles its current position instead of applying an old anchor at a new scale", () => {
  const f = fixture(); f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { clientX: 100, clientY: 80 }); const position = f.draft.nodes[0].x;
  f.viewport.dispatch("wheel", { ctrlKey: true, deltaY: -10 });
  f.viewport.dispatch("pointermove", { clientX: 170, clientY: 80 }); f.viewport.dispatch("pointerup", { clientX: 170, clientY: 80 });
  assert.equal(f.draft.nodes[0].x, position); assert.equal(f.changes(), 1); assert.equal(f.viewport.hasPointerCapture(1), false);
});

test("intentional capture release keeps click-to-connect available across zoom", () => {
  const f = fixture(); f.document.pointElement = f.port("b", "out");
  f.port("b", "out").dispatch("pointerdown", { clientX: 700, clientY: 100 });
  f.viewport.dispatch("pointerup", { clientX: 700, clientY: 100 }); f.viewport.dispatch("lostpointercapture");
  f.viewport.dispatch("click", { detail: 1 });
  assert.equal(f.viewport.dataset.linking, "true"); f.hud.children[2].dispatch("click");
  assert.equal(f.viewport.dataset.linking, "true"); f.port("a", "in").dispatch("click", { detail: 0 });
  assert.equal(f.draft.edges.length, 2); assert.equal(f.changes(), 1);
});

test("a second touch cannot replace the owner of an active drag or retain an orphan capture", () => {
  const f = fixture(); f.title("a").dispatch("pointerdown", { clientX: 70, clientY: 80 });
  f.viewport.dispatch("pointermove", { clientX: 100, clientY: 80 });
  f.title("b").dispatch("pointerdown", { pointerId: 2, clientX: 500, clientY: 80 });
  assert.equal(f.viewport.hasPointerCapture(2), false);
  f.viewport.dispatch("pointermove", { clientX: 120, clientY: 80 }); f.viewport.dispatch("pointerup", { clientX: 120, clientY: 80 });
  assert.equal(f.draft.nodes[0].x, 90); assert.equal(f.draft.nodes[1].x, 500);
  assert.equal(f.changes(), 1); assert.equal(f.viewport.hasPointerCapture(1), false);
});

test("a programmatic port click cannot consume the pending compatibility click of the completed gesture", () => {
  const f = fixture(); f.document.pointElement = f.port("a", "in");
  f.port("b", "out").dispatch("pointerdown", { clientX: 700, clientY: 100 });
  f.viewport.dispatch("pointerup", { clientX: 40, clientY: 100 });
  f.port("a", "out").dispatch("click", { detail: 0, pointerId: -1 });
  assert.equal(f.viewport.dataset.linking, "true");
  const compatibility = f.viewport.dispatch("click", { detail: 1, pointerId: 1 });
  assert.equal(compatibility.prevented, true); assert.equal(f.viewport.dataset.linking, "true");
  f.viewport.dispatch("pointerdown", { pointerId: 1 }); f.viewport.dispatch("pointerup", { pointerId: 1 });
  const independent = f.viewport.dispatch("click", { detail: 1, pointerId: 1 });
  assert.equal(independent.prevented, false); assert.equal(f.viewport.dataset.linking, "false");
});
