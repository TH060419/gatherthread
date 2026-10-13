import test from "node:test";
import assert from "node:assert/strict";
import { mountAgentTeams } from "../src/agent-team-view.js";

class Element {
  constructor(doc, tag = "div") {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
    this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ""; this.textContent = "";
    this.className = ""; this.isConnected = true; this.open = false; this.hidden = false; this.disabled = false;
  }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners); }
  dispatch(type, fields = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this, button: 0, pointerId: 1, preventDefault() {}, ...fields }); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.fragment) this.append(...node.children);
      else { node.parentElement = this; this.children.push(node); }
    }
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.isConnected = false; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  focus() { this.doc.activeElement = this; }
  closest(selector) { if (selector === "[data-node-id]") return this.dataset.nodeId ? this : this.parentElement?.closest(selector); return null; }
  querySelector(selector) {
    const id = /data-node-id="([^"]+)"/u.exec(selector)?.[1];
    const cards = this.children.filter(child => child.dataset.nodeId === id);
    return cards[0]?.children.find(child => child.className === "team-node-header") ?? null;
  }
  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (selector.startsWith(".") ? child.className.split(/\s+/u).includes(selector.slice(1)) : child.tagName.toLowerCase() === selector) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  setPointerCapture() {}
}
const target = { kind: "local", runtime_id: "runtime-fixture", harness: "codex", provider: "openai", model: "fixture-model" };
const plan = { name: "Private team A", team_prompt: "Private role A", nodes: [{ id: "lead", label: "Director", role: "Direct accurately", x: 20, y: 40, target }], edges: [] };
const run = { id: "team-fixture", session_id: "session-a", status: "running", plan, content: "Task", calls_used: 1, max_calls: 12,
  max_duration_minutes: 30, created_at: "2026-10-13T00:00:00.000Z", deadline_at: "2026-10-13T00:30:00.000Z", finished_at: null,
  current_node_id: "lead", current_step_id: "step-fixture", error_code: null,
  steps: [{ id: "step-fixture", node_id: "lead", node_label: "Director", status: "running", request_event_id: "request-fixture", response_event_id: null }] };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fixture({ active = false, overrides = {} } = {}) {
  const registry = new Map(), calls = []; let counter = 0;
  const doc = { activeElement: null, listeners: new Map(),
    getElementById(id) { if (!registry.has(id)) registry.set(id, new Element(doc)); return registry.get(id); },
    createElement: tag => new Element(doc, tag), createElementNS: (_namespace, tag) => new Element(doc, tag),
    createDocumentFragment: () => Object.assign(new Element(doc), { fragment: true }),
    createTextNode: text => Object.assign(new Element(doc, "text"), { textContent: text }),
    addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners); },
    dispatch(type, fields) { for (const listener of this.listeners.get(type) ?? []) listener(fields); }, elementFromPoint: () => null,
  };
  const el = id => doc.getElementById(`agent-team-${id}`);
  el("max-calls").value = "12"; el("max-minutes").value = "30"; el("edge-direction").value = "one_way";
  let context = { scope: "owner-a:session-a:0", userId: "owner-a", sessionId: "session-a", contentRevision: 0, writable: true,
    runtimes: [{ id: "runtime-fixture", deviceId: "device-fixture", harness: "codex", status: "online", provider: "openai", model: "fixture-model" }],
    devices: [], cloudStatus: { enabled: false }, refreshAgents: async () => {},
  };
  let serverRun = active ? structuredClone(run) : null;
  const api = {
    getAgentTeamPlan: async () => ({ plan: structuredClone(plan), revision: 1 }),
    listAgentTeamRuns: async () => ({ runs: serverRun ? [structuredClone(serverRun)] : [] }),
    getAgentTeamRun: async () => ({ run: structuredClone(serverRun) }),
    saveAgentTeamPlan: async (_id, input) => ({ plan: structuredClone(input.plan), revision: 2 }),
    startAgentTeamRun: async (id, input) => { calls.push(["start", id, structuredClone(input)]); serverRun = { ...structuredClone(run), session_id: id, plan: structuredClone(input.plan) }; return { run: structuredClone(serverRun), replayed: false }; },
    controlAgentTeamRun: async (session, id, input) => { calls.push(["control", session, id, structuredClone(input)]); serverRun.status = input.action === "pause" ? "paused" : input.action === "stop" ? "stopped" : "running"; return { run: structuredClone(serverRun) }; },
    ...overrides,
  };
  const ui = mountAgentTeams({ document: doc, api, localizer: { t: value => value, setText: (node, value) => { node.textContent = value; } },
    getContext: () => context, makeKey: prefix => `${prefix}-fixture-key-${++counter}` });
  ui.updateContext();
  return { ui, el, doc, api, calls, get context() { return context; }, update(patch) { context = { ...context, ...patch }; ui.updateContext(); },
    get serverRun() { return serverRun; }, close: () => el("dialog").close() };
}

test("a delayed save cannot show another account's team or target in the new scope", async () => {
  const deferred = Promise.withResolvers();
  const f = fixture({ overrides: { saveAgentTeamPlan: () => deferred.promise } });
  try {
    await f.ui.open();
    f.el("max-calls").value = "48"; f.el("max-minutes").value = "120";
    f.el("name").value = "Unsaved private team A"; f.el("name").dispatch("input"); f.el("save").dispatch("click"); await flush();
    f.update({ scope: "owner-b:session-b:0", userId: "owner-b", sessionId: "session-b", runtimes: [] });
    assert.equal(f.el("dialog").open, false); assert.equal(f.el("node-inspector").hidden, true);
    assert.equal(f.el("max-calls").value, "12"); assert.equal(f.el("max-minutes").value, "30");
    assert.equal(f.el("node-target").children.length, 0); assert.equal(f.el("name").value, ""); assert.equal(f.el("add-target").children.length, 1);
    f.api.getAgentTeamPlan = async () => ({ plan: { ...structuredClone(plan), name: "Private team B", team_prompt: "Private role B" }, revision: 1 });
    await f.ui.open();
    deferred.resolve({ plan: { ...plan, name: "Old acknowledgement A" }, revision: 2 }); await flush();
    assert.equal(f.el("name").value, "Private team B"); assert.equal(f.el("prompt").value, "Private role B");
  } finally { f.close(); }
});

test("uncertain team start retries the frozen key and history pin, then deletion clears the retained attempt", async () => {
  const f = fixture(); let first = true;
  const original = f.api.startAgentTeamRun;
  f.api.startAgentTeamRun = async (id, input) => {
    if (first) { first = false; f.calls.push(["start", id, structuredClone(input)]); throw Object.assign(new Error("Uncertain fixture response"), { status: 0 }); }
    return original(id, input);
  };
  try {
    await f.ui.open(); f.el("task").value = "Human task"; f.el("start-form").dispatch("submit"); await flush();
    assert.equal(f.el("start").textContent, "Retry the same team start"); assert.equal(f.el("task").disabled, true);
    f.el("start-form").dispatch("submit"); await flush();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0][2].idempotency_key, f.calls[1][2].idempotency_key);
    assert.equal(f.calls[1][2].content_revision, 0);
    f.update({ scope: "owner-a:session-a:1", contentRevision: 1 });
    assert.equal(f.el("task").value, ""); assert.equal(f.el("dialog").open, false);
    assert.equal(f.el("control-retry").hidden, true);
  } finally { f.close(); }
});

test("uncertain pause is acknowledged with its original key before a new resume or pause is allowed", async () => {
  const f = fixture({ active: true }); let first = true;
  const original = f.api.controlAgentTeamRun;
  f.api.controlAgentTeamRun = async (...args) => {
    const result = await original(...args);
    if (first) { first = false; throw Object.assign(new Error("Uncertain fixture pause"), { status: 0 }); }
    return result;
  };
  try {
    await f.ui.open(); f.el("pause").dispatch("click"); await flush();
    assert.equal(f.el("control-retry").hidden, false); assert.equal(f.el("resume").disabled, true); assert.equal(f.el("start").disabled, true);
    f.el("refresh").dispatch("click"); await flush();
    assert.equal(f.el("run-status").textContent, "Team paused"); assert.equal(f.el("resume").disabled, true);
    f.el("control-retry").dispatch("click"); await flush();
    assert.equal(f.calls[0][3].idempotency_key, f.calls[1][3].idempotency_key); assert.equal(f.el("control-retry").hidden, true);
    assert.equal(f.el("resume").disabled, false);
    f.el("resume").dispatch("click"); await flush(); f.el("pause").dispatch("click"); await flush();
    assert.equal(f.calls.length, 4); assert.notEqual(f.calls[3][3].idempotency_key, f.calls[0][3].idempotency_key);
  } finally { f.close(); }
});

test("revoking write permission during a drag prevents further node movement", async () => {
  const f = fixture();
  try {
    await f.ui.open(); const card = f.el("nodes").children[0], header = card.children[0];
    header.dispatch("pointerdown", { clientX: 100, clientY: 100, pointerId: 42 });
    f.doc.dispatch("pointermove", { clientX: 200, clientY: 220, pointerId: 42 });
    assert.equal(card.style.left, "120px"); assert.equal(card.style.top, "160px");
    f.update({ writable: false }); f.doc.dispatch("pointermove", { clientX: 300, clientY: 400, pointerId: 42 });
    assert.equal(card.style.left, "120px"); assert.equal(card.style.top, "160px"); assert.equal(f.el("save").disabled, true);
  } finally { f.close(); }
});

test("a delayed poll from before Pause cannot restore a stale running state after acknowledgement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ active: true }), deferred = Promise.withResolvers();
  try {
    await f.ui.open(); const old = structuredClone(f.serverRun);
    f.api.getAgentTeamRun = () => deferred.promise;
    t.mock.timers.tick(2000); await flush();
    f.el("pause").dispatch("click"); await flush();
    assert.equal(f.el("run-status").textContent, "Team paused");
    deferred.resolve({ run: old }); await flush();
    assert.equal(f.el("run-status").textContent, "Team paused");
    assert.equal(f.el("resume").hidden, false); assert.equal(f.el("pause").hidden, true);
  } finally { f.close(); }
});


test("viewing an accepted run preserves a different unsaved draft and restores its task after completion", async () => {
  const f = fixture();
  try {
    await f.ui.open();
    f.el("name").value = "Unsaved team draft"; f.el("name").dispatch("input");
    f.el("task").value = "Draft task";
    f.api.startAgentTeamRun = async () => ({ run: { ...structuredClone(run), plan: { ...structuredClone(plan), name: "Accepted team", nodes: [{ ...structuredClone(plan.nodes[0]), label: "Frozen director" }] }, content: "Accepted task" } });
    f.el("start-form").dispatch("submit"); await flush();
    assert.equal(f.el("name").value, "Accepted team"); assert.equal(f.el("task").value, "Accepted task");
    assert.equal(f.el("nodes").children[0].children[0].attributes["aria-label"], "Select and move Agent: Frozen director");
    assert.equal(f.el("edit").disabled, true); assert.equal(f.el("task").disabled, true);
    f.api.controlAgentTeamRun = async () => ({ run: { ...structuredClone(run), status: "stopped" } });
    f.el("stop").dispatch("click"); await flush(); f.el("edit").dispatch("click");
    assert.equal(f.el("name").value, "Unsaved team draft"); assert.equal(f.el("task").value, "Draft task");
    assert.equal(f.el("save").disabled, false);
  } finally { f.close(); }
});

test("a missing private record clears an uncertain control without discarding the editable draft", async () => {
  const f = fixture();
  try {
    await f.ui.open(); f.el("name").value = "Keep my draft"; f.el("name").dispatch("input");
    f.el("task").value = "Keep my task"; f.el("start-form").dispatch("submit"); await flush();
    const original = f.api.controlAgentTeamRun;
    f.api.controlAgentTeamRun = async (...args) => { await original(...args); throw Object.assign(new Error("Lost acknowledgement"), { status: 0 }); };
    f.el("pause").dispatch("click"); await flush(); assert.equal(f.el("control-retry").hidden, false);
    f.api.getAgentTeamRun = async () => { throw Object.assign(new Error("Private detail"), { status: 404 }); };
    f.el("refresh").dispatch("click"); await flush();
    assert.equal(f.el("control-retry").hidden, true); assert.equal(f.el("name").value, "Keep my draft");
    assert.equal(f.el("task").value, "Keep my task"); assert.equal(f.el("save").disabled, false);
    assert.equal(f.el("error").textContent, "This private team record is no longer available. Shared messages are kept.");
    assert.equal(f.el("run-status").textContent, "No team task yet");
  } finally { f.close(); }
});

test("the chosen first Agent belongs to the saved team and survives a fresh page load", async () => {
  const twoNodes = { ...structuredClone(plan), nodes: [...structuredClone(plan.nodes), { ...structuredClone(plan.nodes[0]), id: "worker", label: "Implementer" }] };
  let saved = twoNodes;
  const f = fixture({ overrides: { getAgentTeamPlan: async () => ({ plan: structuredClone(saved), revision: 1 }),
    saveAgentTeamPlan: async (_id, input) => { saved = structuredClone(input.plan); return { plan: structuredClone(saved), revision: 2 }; } } });
  try {
    await f.ui.open(); f.el("entry-node").value = "worker"; f.el("entry-node").dispatch("change");
    assert.equal(f.el("save").disabled, false); f.el("save").dispatch("click"); await flush();
    assert.equal(saved.entry_node_id, "worker");
    const restored = fixture({ overrides: { getAgentTeamPlan: async () => ({ plan: structuredClone(saved), revision: 2 }) } });
    try { await restored.ui.open(); assert.equal(restored.el("entry-node").value, "worker"); }
    finally { restored.close(); }
  } finally { f.close(); }
});
