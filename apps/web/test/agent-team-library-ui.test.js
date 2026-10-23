import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { mountAgentTeams } from "../src/agent-team-library-view.js";

class Element {
  constructor(document, tag, namespaceURI) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.namespaceURI = namespaceURI;
    this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {}; this.style = {};
    this.listeners = new Map(); this.className = ""; this.value = ""; this.textContent = "";
    this.open = false; this.hidden = false; this.disabled = false; this.scrollLeft = 0; this.scrollTop = 0;
    this.clientWidth = 600; this.clientHeight = 400;
    this.classList = { add: (...values) => { this.className += ` ${values.join(" ")}`; } };
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  get isConnected() { let root = this; while (root.parentElement) root = root.parentElement; return root === this.ownerDocument.body; }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.style.display === "none" || node.style.visibility === "hidden" || node.tagName === "DIALOG" && !node.open) return [];
    }
    return [{ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }];
  }
  checkVisibility() { return Boolean(this.getClientRects().length); }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, callback, options = false) {
    const listeners = this.listeners.get(type) ?? []; listeners.push({ callback, capture: options === true || options?.capture === true }); this.listeners.set(type, listeners);
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const value = part.trim();
      if (value.startsWith("#")) return this.id === value.slice(1);
      if (value === "dialog:not([open])") return this.tagName === "DIALOG" && !this.open;
      if (value === "dialog[open]") return this.tagName === "DIALOG" && this.open;
      if (value === "[hidden]") return this.hidden;
      if (value.startsWith(".")) return this.className.split(/\s+/u).includes(value.slice(1));
      if (/^[a-z]+$/i.test(value)) return this.tagName === value.toUpperCase();
      const attribute = /^\[([a-z-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/.exec(value); if (!attribute) return false;
      const key = attribute[1].replace(/^data-/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const field = attribute[1].startsWith("data-") ? this.dataset[key] : this.attributes[attribute[1]];
      return attribute[2] === undefined ? field !== undefined : field === attribute[2];
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const found = []; for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
  querySelector(selector) {
    const split = selector.indexOf(" ");
    if (split !== -1 && !selector.includes("='") && !selector.includes('="')) return this.querySelectorAll(selector.slice(0, split)).flatMap(node => node.querySelectorAll(selector.slice(split + 1)))[0] ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  dispatch(type, fields = {}) {
    const event = { type, target: this, button: 0, pointerId: 1, ...fields, stopped: false, immediate: false,
      preventDefault() {}, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    const ancestors = []; for (let node = this; node; node = node.parentElement) ancestors.push(node);
    for (const capture of [true, false]) for (const node of capture ? [...ancestors].reverse() : ancestors) {
      for (const listener of node.listeners.get(type) ?? []) { if (listener.capture === capture) listener.callback(event); if (event.immediate) break; }
      if (event.stopped) return event;
      if (!capture && ["pointerenter", "pointerleave"].includes(type)) break;
    }
    return event;
  }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() { if (!this.disabled && this.getClientRects().length) this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  reportValidity() { return (!this.required || this.value !== "") && (this.type !== "number" || Number.isFinite(Number(this.value))
    && Number(this.value) >= Number(this.min) && Number(this.value) <= Number(this.max)); }
  showModal() { this.open = true; this.focus(); }
  close() {
    this.open = false;
    // WebKit may leave body active rather than restoring an opener inside a closed sheet.
    if (this.ownerDocument.activeElement?.closest("dialog") === this) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.dispatch("close");
  }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
}

const target = { kind: "local", runtime_id: "runtime-a", harness: "codex", provider: "fixture", model: "fixture-model", reasoning_effort: "high" };
const module = { label: "Planner", role: "Plan", prompt: "Be concise", target };
const team = (id = "team-a", overrides = {}) => ({ id, revision: 1,
  draft: { name: id, team_prompt: "", entry_node_id: "node-a", nodes: [{ ...structuredClone(module), id: "node-a", x: 40, y: 60 }], edges: [] },
  max_calls: 12, max_duration_minutes: 30, enabled: false, tested_revision: null, test_status: "not_tested", ...overrides });
const flush = async () => { for (let index = 0; index < 70; index++) await Promise.resolve(); };

function fixture({ initial = [], modules = [], initialRuns = [], overrides = {} } = {}) {
  const document = { documentElement: { lang: "en" }, activeElement: null,
    createElement(tag) { return new Element(this, tag); }, createElementNS(namespace, tag) { return new Element(this, tag, namespace); }, elementFromPoint() { return null; } };
  document.body = document.createElement("body");
  document.getElementById = id => document.body.querySelector(`#${id}`);
  document.querySelector = selector => document.body.querySelector(selector);
  document.defaultView = { getComputedStyle: node => ({ display: node.style.display ?? "block", visibility: node.style.visibility ?? "visible" }) };
  const hostButton = document.createElement("button"); document.body.append(hostButton);
  let teams = structuredClone(initial), favorites = structuredClone(modules), runs = structuredClone(initialRuns), nextId = 0;
  let context = { scope: "alice:project-a:session-a", userId: "alice", projectId: "project-a", sessionId: "session-a", sessionMode: "multi", writable: true,
    runtimes: [{ id: "runtime-a", userId: "alice", deviceId: "device-a", purpose: "execution", harness: "codex", status: "online",
      provider: "fixture", model: "fixture-model", executionProfiles: [{ provider: "fixture", model: "fixture-model", reasoningEfforts: ["high"] }] }],
    devices: [{ id: "device-a", name: "Alice Mac" }] };
  const calls = [], api = {
    listAgentTeams: async () => ({ teams: structuredClone(teams), modules: structuredClone(favorites), team_limit: 5, module_limit: 5 }),
    listTeamRuns: async () => ({ runs: structuredClone(runs) }),
    controlTeamRun: async (session, id, input) => {
      calls.push(["run-control", session, id, structuredClone(input)]);
      const run = runs.find(item => item.id === id); run.status = input.action === "stop" ? "stopped" : input.action === "pause" ? "paused" : "running";
      run.error_code = null; return { run: structuredClone(run), replayed: false };
    },
    saveAgentTeam: async (id, input) => {
      calls.push(["save", id, structuredClone(input)]);
      const saved = team(id, { draft: structuredClone(input.draft), revision: (input.expected_revision ?? 0) + 1,
        max_calls: input.max_calls, max_duration_minutes: input.max_duration_minutes });
      teams = [...teams.filter(item => item.id !== id), saved]; return { team: structuredClone(saved), replayed: false };
    },
    controlAgentTeam: async (session, id, input) => {
      calls.push(["control", session, id, structuredClone(input)]);
      const saved = teams.find(item => item.id === id); saved.enabled = input.enabled; saved.revision++;
      if (saved.test_status === "passed") saved.tested_revision = saved.revision;
      return { team: structuredClone(saved), replayed: false };
    },
    executeAgentTeam: async (session, id, input, test) => {
      calls.push(["execute", session, id, structuredClone(input), test]);
      const saved = teams.find(item => item.id === id);
      if (test) { saved.test_status = "passed"; saved.tested_revision = saved.revision; }
      return { run: { id: "run-a", definition_id: id, purpose: test ? "test" : "task", status: test ? "completed" : "running", calls_used: 1, max_calls: 12 }, replayed: false };
    },
    saveTeamModule: async (id, input) => { calls.push(["favorite", id, structuredClone(input)]);
      const favorite = { id, module: structuredClone(input.module) }; favorites.push(favorite); return { favorite, replayed: false }; },
    deleteTeamItem: async (kind, id, input) => { calls.push(["delete", kind, id, structuredClone(input)]);
      if (kind === "module") favorites = favorites.filter(item => item.id !== id); else teams = teams.filter(item => item.id !== id);
      return { deleted: true, replayed: false }; },
    ...overrides,
  };
  const ui = mountAgentTeams({ document, api, hostButton, getContext: () => context, makeKey: prefix => `${prefix}-fixture-${++nextId}`, confirm: () => true });
  const byId = id => {
    const search = node => node.id === id ? node : node.children.map(search).find(Boolean);
    return search(document.body);
  };
  ui.updateContext();
  return { document, api, ui, calls, el: byId, hostButton, get teams() { return teams; }, set teams(value) { teams = value; },
    get runs() { return runs; }, set runs(value) { runs = value; },
    get favorites() { return favorites; }, set favorites(value) { favorites = value; }, update(value) { context = { ...context, ...value }; ui.updateContext(); },
    button(text, root = document.body) { return root.querySelectorAll("button").find(node => node.textContent === text); } };
}

async function open(f, index = 0) { await flush(); f.hostButton.click(); await flush(); f.document.body.querySelector(".team-library-list").children[index].children[0].click(); }

test("a closed Team dialog remains reachable for Pause and Stop during replay without enabling new work", async () => {
  const run = { id: "running-team", status: "running", purpose: "task", calls_used: 1, max_calls: 12 };
  const f = fixture({ initial: [team()], initialRuns: [run] });
  await flush();
  assert.equal(f.document.body.querySelector("dialog").open, false);
  f.update({ writable: false, controlWritable: true });
  assert.equal(f.hostButton.disabled, false);
  f.hostButton.click(); await flush();
  assert.equal(f.document.body.querySelector("dialog").open, true);
  const pause = f.button("Pause"), stop = f.button("Stop");
  assert.equal(pause.disabled, false); assert.equal(stop.disabled, false);
  pause.click(); await flush();
  assert.equal(f.calls.filter(call => call[0] === "run-control")[0][3].action, "pause");
  assert.equal(f.button("Resume").disabled, true, "replay must still block new native work");
  f.document.body.querySelector(".team-row-edit").click();
  assert.equal(f.el("team-save").disabled, true);
  assert.equal(f.el("team-add-blank").disabled, true);
  assert.equal(f.el("team-name").disabled, true);
  await assert.rejects(f.ui.controlRun(f.runs[0], "resume"), /current writable history/u);
  assert.equal(f.calls.filter(call => call[0] === "run-control").length, 1, "only Pause reaches the API during replay");
  f.update({ controlWritable: false });
  assert.equal(f.hostButton.disabled, true); assert.equal(f.button("Stop").disabled, true);
});

for (const [locale, identityHint, promptHint] of [
  ["en", "Responsibilities and boundaries of this role.", "How to work within this role and format the response."],
  ["zh-CN", "负责什么、职责边界是什么。", "在职责范围内如何工作、怎样输出。"],
]) {
  test(`identity and prompt hints are localized placeholders, never saved default content (${locale})`, async () => {
    const empty = team(); empty.draft.nodes[0].role = ""; delete empty.draft.nodes[0].prompt;
    const f = fixture({ initial: [empty] }); f.document.documentElement.lang = locale; await open(f);
    f.document.body.querySelector("[data-node-id='node-a']").dispatch("click");
    const identity = f.el("team-identity-node-a"), prompt = f.document.body.querySelector(".team-inspector").querySelector("textarea");
    assert.equal(identity.placeholder, identityHint); assert.equal(prompt.placeholder, promptHint);
    assert.equal(identity.value, ""); assert.equal(prompt.value, "");
    assert.equal(f.el("team-save").disabled, true, "showing hints must not change or dirty the saved configuration");
    f.el("team-name").value = "Renamed without filling hints"; f.el("team-name").dispatch("input");
    f.el("team-save").click(); await flush();
    const savedNode = f.calls.find(call => call[0] === "save")[2].draft.nodes[0];
    assert.equal(savedNode.role, ""); assert.equal("prompt" in savedNode, false);
    assert.ok(!JSON.stringify(savedNode).includes(identityHint) && !JSON.stringify(savedNode).includes(promptHint), "placeholder guidance must never become model instructions");
  });
}

test("identity and prompt placeholders preserve existing module instructions", async () => {
  const f = fixture({ initial: [team()] }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").dispatch("click");
  assert.equal(f.el("team-identity-node-a").value, module.role);
  assert.equal(f.document.body.querySelector(".team-inspector").querySelector("textarea").value, module.prompt);
  f.el("team-name").value = "Renamed with existing instructions"; f.el("team-name").dispatch("input"); f.el("team-save").click(); await flush();
  const savedNode = f.calls.find(call => call[0] === "save")[2].draft.nodes[0];
  assert.equal(savedNode.role, module.role); assert.equal(savedNode.prompt, module.prompt);
});

test("Save follows dirty state and untested Teams cannot be enabled", async () => {
  const f = fixture({ initial: [team()] }); await open(f);
  assert.equal(f.el("team-save").disabled, true);
  assert.equal(f.el("team-enable").disabled, true);
  f.el("team-name").value = "Changed Team"; f.el("team-name").dispatch("input");
  assert.equal(f.el("team-save").disabled, false);
  f.el("team-save").click(); await flush();
  assert.equal(f.calls[0][2].draft.name, "Changed Team");
  assert.equal(f.calls[0][2].expected_revision, 1);
  assert.equal(f.el("team-save").disabled, true); assert.equal(f.el("team-save").textContent, "Saved");
  assert.equal(f.el("team-enable").disabled, true);
});

const editInput = (input, value) => { input.value = value; input.dispatch("input"); };

test("a delayed old probe acknowledgement cannot mark a newly saved configuration as testing", async () => {
  let releaseProbe, hangReads = false;
  const f = fixture({ initial: [team()], overrides: {
    listAgentTeams: async () => hangReads ? new Promise(() => {}) : { teams: structuredClone(f.teams), modules: [] },
    executeAgentTeam: async () => new Promise(resolve => { releaseProbe = () => resolve({ run: {
      id: "old-probe", definition_id: "team-a", purpose: "test", status: "running", calls_used: 1, max_calls: 1,
    }, replayed: false }); }),
  } });
  await open(f); f.el("team-test").click(); await flush();
  editInput(f.el("team-name"), "A configuration saved after the old probe");
  hangReads = true; f.el("team-save").click(); await flush();
  assert.equal(f.teams[0].revision, 2); assert.equal(f.el("team-save").disabled, true);
  releaseProbe(); await flush();
  assert.equal(f.el("team-test").disabled, false, "an old test ACK must not block testing the replacement draft");
  assert.equal(f.el("team-test").textContent, "Test"); assert.equal(f.el("team-enable").disabled, true);
});

test("a Save acknowledgement delayed past a confirmed Delete cannot resurrect that Team in the local library", async () => {
  let releaseSave, hangReads = false;
  const f = fixture({ initial: [team()], overrides: {
    listAgentTeams: async () => hangReads ? new Promise(() => {}) : { teams: structuredClone(f.teams), modules: [] },
    saveAgentTeam: async (id, input) => {
      const accepted = team(id, { revision: 2, draft: structuredClone(input.draft) }); f.teams = [accepted];
      return new Promise(resolve => { releaseSave = () => resolve({ team: accepted, replayed: false }); });
    },
  } });
  await open(f); editInput(f.el("team-name"), "Accepted before Delete"); f.el("team-save").click(); await flush();
  f.button("Back to Teams").click(); f.button("Delete").click(); await flush();
  assert.deepEqual(f.teams, []); hangReads = true;
  releaseSave(); await flush();
  assert.equal(f.document.body.querySelectorAll(".team-row-edit").length, 0, "a superseded response cannot reintroduce deleted private configuration");
  assert.equal(f.ui.pendingStart(), false);
});

test("a currently unavailable cloud model remains visibly unavailable when another cloud model is online", async () => {
  const original = team(); original.draft.nodes[0].target = { kind: "cloud", profile_id: "cloud-a", provider: "fixture", model: "model-a", include_code: false };
  const f = fixture({ initial: [original] });
  f.update({ cloudProfiles: [{ id: "cloud-a", provider: "fixture", model: "model-a", available: false },
    { id: "cloud-b", provider: "fixture", model: "model-b", available: true }] });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
  assert.ok(f.document.body.querySelector(".team-notice"), "one available cloud model must not mask another model's unavailable status");
  assert.equal(f.el("team-selection-model").value, JSON.stringify(["fixture", "model-a", "cloud-a"]));
});

test("a delayed Enable acknowledgement cannot resurrect a Team deleted on another device", async () => {
  let releaseEnable, hangReads = false;
  const initial = team("team-a", { test_status: "passed", tested_revision: 1 });
  const f = fixture({ initial: [initial], overrides: {
    listAgentTeams: async () => hangReads ? new Promise(() => {}) : { teams: structuredClone(f.teams), modules: [] },
    controlAgentTeam: async () => {
      const accepted = { ...initial, enabled: true, revision: 2, tested_revision: 2 }; f.teams = [accepted];
      return new Promise(resolve => { releaseEnable = () => resolve({ team: accepted, replayed: false }); });
    },
  } });
  await open(f); f.el("team-enable").click(); await flush();
  f.teams = []; await f.ui.refresh(); hangReads = true;
  releaseEnable(); await flush();
  assert.deepEqual(f.ui.choices(), []); assert.equal(f.document.body.querySelectorAll(".team-row-edit").length, 0);
});

test("losing current write permission immediately disables task controls and execution without discarding private draft edits", async () => {
  const f = fixture({ initial: [team("team-a", { test_status: "passed", tested_revision: 1 })],
    initialRuns: [{ id: "active", status: "running", calls_used: 1, max_calls: 12 }] });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
  editInput(f.el("team-identity-node-a"), "Keep these private edits");
  f.update({ writable: false });
  assert.equal(f.button("Stop").disabled, true); assert.equal(f.button("Pause").disabled, true);
  assert.equal(f.el("team-test").disabled, true); assert.equal(f.el("team-identity-node-a").value, "Keep these private edits");
  f.update({ writable: true }); assert.equal(f.button("Stop").disabled, false); assert.equal(f.el("team-test").disabled, false);
});

for (const [label, select, changedValue] of [
  ["Team name", f => f.el("team-name"), "Changed name"],
  ["call limit", f => f.el("team-max-calls"), "13"],
  ["duration limit", f => f.el("team-max-minutes"), "31"],
  ["Team rules", f => f.document.body.querySelector("[aria-label='Team rules']"), "Changed rules"],
  ["module identity", f => f.el("team-identity-node-a"), "Changed role"],
  ["module prompt", f => f.document.body.querySelector(".team-inspector").querySelector("textarea"), "Changed method"],
]) {
  test(`restoring the saved ${label} disables Save without invalidating its successful test`, async () => {
    const f = fixture({ initial: [team("team-a", { test_status: "passed", tested_revision: 1 })] }); await open(f);
    f.document.body.querySelector("[data-node-id='node-a']").click();
    const input = select(f), original = input.value;
    editInput(input, changedValue); assert.equal(f.el("team-save").disabled, false);
    assert.equal(f.el("team-enable").disabled, true, "a genuinely changed draft must not be enabled using an older test");
    editInput(input, original);
    assert.equal(f.el("team-save").disabled, true); assert.equal(f.el("team-save").textContent, "Saved");
    assert.equal(f.el("team-test").textContent, "Successfully connected"); assert.equal(f.el("team-test").disabled, true);
    assert.equal(f.el("team-enable").disabled, false, "the unchanged saved configuration retains its valid test");
    f.el("team-save").click(); f.el("team-test").click(); await flush();
    assert.deepEqual(f.calls, [], "reverting a draft must not send a repeat save or connectivity call");
    assert.equal(f.teams[0].revision, 1); assert.equal(f.teams[0].test_status, "passed");
  });
}

test("saving, testing, then restoring a name edit does not repeat Save or clear the new test stamp", async () => {
  const f = fixture({ initial: [team()] }); await open(f);
  editInput(f.el("team-name"), "Saved Team"); f.el("team-save").click(); await flush();
  f.el("team-test").click(); await flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["save", "execute"]);
  const revision = f.teams[0].revision;
  editInput(f.el("team-name"), "Temporary edit"); editInput(f.el("team-name"), "Saved Team");
  assert.equal(f.el("team-save").disabled, true); f.el("team-save").click(); await flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["save", "execute"]);
  assert.equal(f.teams[0].revision, revision); assert.equal(f.teams[0].test_status, "passed");
  assert.equal(f.el("team-test").textContent, "Successfully connected"); assert.equal(f.el("team-enable").disabled, false);
});

test("an absent optional module prompt and empty input represent the same saved configuration", async () => {
  const original = team(); delete original.draft.nodes[0].prompt;
  const f = fixture({ initial: [original] }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").click();
  const prompt = f.document.body.querySelector(".team-inspector").querySelector("textarea");
  editInput(prompt, "Temporary method"); assert.equal(f.el("team-save").disabled, false);
  editInput(prompt, ""); assert.equal(f.el("team-save").disabled, true);
  editInput(f.el("team-max-calls"), "012"); assert.equal(f.el("team-save").disabled, true, "numeric spelling does not change the call limit");
  assert.deepEqual(f.calls, []);
});

test("restoring module geometry, routes and module additions compares the actual graph content", async () => {
  const original = team("team-a", { test_status: "passed", tested_revision: 1 });
  original.draft.nodes.push({ ...structuredClone(original.draft.nodes[0]), id: "node-b", label: "Worker", x: 400, y: 60 });
  original.draft.edges.push({ id: "edge-a", source: "node-a", target: "node-b", direction: "one_way" });
  const f = fixture({ initial: [original] }); await open(f);
  const drag = () => f.document.body.querySelector("[data-node-id='node-a']").querySelector(".team-node-drag");
  drag().dispatch("keydown", { key: "ArrowRight" }); assert.equal(f.el("team-save").disabled, false);
  drag().dispatch("keydown", { key: "ArrowLeft" }); assert.equal(f.el("team-save").disabled, true);
  f.document.body.querySelector("[data-edge-id='edge-a']").click();
  f.button("Bidirectional").click(); assert.equal(f.el("team-save").disabled, false);
  f.button("One-way").click(); assert.equal(f.el("team-save").disabled, true);
  f.el("team-add-blank").click(); assert.equal(f.el("team-save").disabled, false);
  f.button("Delete module").click(); assert.equal(f.el("team-save").disabled, true);
  assert.equal(f.el("team-test").textContent, "Successfully connected"); assert.deepEqual(f.calls, []);
});

for (const restored of [false, true]) {
  test(`a delayed Save acknowledgement ${restored ? "recognizes restored accepted content" : "preserves newer local edits"}`, async () => {
    let releaseSave;
    const f = fixture({ initial: [team()], overrides: { saveAgentTeam: async (id, input) => {
      f.calls.push(["save", id, structuredClone(input)]);
      return new Promise(resolve => { releaseSave = () => {
        const accepted = team(id, { draft: structuredClone(input.draft), revision: 2, max_calls: input.max_calls, max_duration_minutes: input.max_duration_minutes });
        f.teams = [accepted]; resolve({ team: structuredClone(accepted), replayed: false });
      }; });
    } } });
    await open(f); editInput(f.el("team-name"), "Accepted content"); f.el("team-save").click(); await flush();
    editInput(f.el("team-name"), "Newer local content"); if (restored) editInput(f.el("team-name"), "Accepted content");
    releaseSave(); await flush();
    assert.equal(f.el("team-name").value, restored ? "Accepted content" : "Newer local content");
    assert.equal(f.el("team-save").disabled, restored);
    if (!restored) {
      f.el("team-save").click(); await flush();
      assert.equal(f.calls[1][2].draft.name, "Newer local content"); assert.equal(f.calls[1][2].expected_revision, 2);
    }
  });
}

test("reverting local changes after a remote edit cannot advance CAS while retaining the old configuration", async () => {
  const f = fixture({ initial: [team()] }); await open(f);
  editInput(f.el("team-name"), "Local temporary edit");
  const remote = team("team-a", { revision: 2 }); remote.draft.team_prompt = "New remote rule";
  f.teams = [remote]; await f.ui.refresh();
  editInput(f.el("team-name"), "team-a");
  editInput(f.el("team-name"), "New local edit"); f.el("team-save").click(); await flush();
  const input = f.calls.find(call => call[0] === "save")[2];
  assert.ok(input.expected_revision === 1 || input.draft.team_prompt === "New remote rule",
    "restoring an old baseline must not allow an unrelated remote change to be overwritten under a newer revision");
});

test("reverting to an old editor baseline cannot enable an unseen remotely tested configuration", async () => {
  const f = fixture({ initial: [team("team-a", { test_status: "passed", tested_revision: 1 })] }); await open(f);
  editInput(f.el("team-name"), "Local temporary edit");
  const remote = team("team-a", { revision: 2, test_status: "passed", tested_revision: 2 });
  remote.draft.name = "Remote tested Team"; remote.draft.team_prompt = "New remote rule";
  f.teams = [remote]; await f.ui.refresh();
  editInput(f.el("team-name"), "team-a");
  const showsRemote = f.el("team-name").value === remote.draft.name
    && f.document.body.querySelector("[aria-label='Team rules']").value === remote.draft.team_prompt;
  assert.ok(showsRemote || !f.el("team-save").disabled,
    "a stale editor must either display the new saved configuration or remain visibly unsaved");
  assert.ok(showsRemote || f.el("team-enable").disabled,
    "the remotely passed test does not validate a different stale editor configuration");
});

function mobileFocusFixture() {
  const f = fixture({ initial: [team()] }), tools = f.document.createElement("dialog"), trigger = f.document.createElement("button"), compose = f.document.createElement("button");
  tools.id = "mobile-tools-dialog"; trigger.id = "mobile-tools-button"; compose.id = "mobile-compose-tools-button";
  f.document.body.append(trigger, compose, tools); tools.append(f.hostButton);
  tools.addEventListener("click", () => tools.close(), true);
  return { ...f, tools, trigger, compose };
}

async function launchFromTools(f) {
  await flush(); f.trigger.focus(); f.tools.showModal(); f.hostButton.focus(); f.hostButton.click(); await flush();
  assert.equal(f.tools.open, false); assert.equal(f.el("agent-team-dialog").open, true);
}

test("keyboard closing a desktop Team dialog restores its visible original trigger", async () => {
  const f = fixture(); await flush(); f.hostButton.focus(); f.hostButton.click(); await flush();
  f.el("agent-team-dialog").dispatch("cancel", { key: "Escape" });
  assert.equal(f.el("agent-team-dialog").open, false); assert.equal(f.document.activeElement, f.hostButton);
});

test("keyboard closing a Team opened from mobile tools falls back to the visible tools trigger", async () => {
  const f = mobileFocusFixture(); await launchFromTools(f);
  f.el("agent-team-dialog").dispatch("cancel", { key: "Escape" });
  assert.equal(f.document.activeElement, f.trigger, "the Team button inside the closed tools dialog cannot regain focus in WebKit");
});

test("a removed original Team trigger is never selected for focus restoration", async () => {
  const f = mobileFocusFixture(); await launchFromTools(f); f.hostButton.remove();
  f.button("Close", f.el("agent-team-dialog")).click();
  assert.equal(f.document.activeElement, f.trigger); assert.equal(f.hostButton.isConnected, false);
});

test("mobile focus restoration skips hidden tools and uses the visible compose tools trigger", async () => {
  const f = mobileFocusFixture(); await launchFromTools(f); f.trigger.hidden = true;
  f.el("agent-team-dialog").dispatch("cancel");
  assert.equal(f.document.activeElement, f.compose);
});

test("switching from desktop to mobile while Team is open restores only a visible mobile control", async () => {
  const f = mobileFocusFixture(); f.document.body.append(f.hostButton); await flush();
  f.hostButton.focus(); f.hostButton.click(); await flush();
  f.tools.append(f.hostButton); f.el("agent-team-dialog").dispatch("cancel");
  assert.equal(f.document.activeElement, f.trigger); assert.equal(f.tools.open, false);
});

test("switching from mobile to desktop while Team is open restores the original desktop control", async () => {
  const f = mobileFocusFixture(); await launchFromTools(f); f.document.body.append(f.hostButton);
  f.trigger.hidden = true; f.compose.hidden = true; f.el("agent-team-dialog").dispatch("cancel");
  assert.equal(f.document.activeElement, f.hostButton);
});

for (const state of ["disabled", "css-hidden", "css-collapsed"]) {
  test(`focus restoration skips a ${state} mobile tools trigger`, async () => {
    const f = mobileFocusFixture(); await launchFromTools(f);
    if (state === "disabled") f.trigger.disabled = true;
    else f.trigger.style.visibility = state === "css-hidden" ? "hidden" : "collapse";
    f.el("agent-team-dialog").dispatch("cancel");
    assert.equal(f.document.activeElement, f.compose);
  });
}

test("a delayed native close event cannot steal focus from a newly opened dialog", async () => {
  const f = mobileFocusFixture(); await launchFromTools(f);
  const dialog = f.el("agent-team-dialog"), next = f.document.createElement("dialog"); f.document.body.append(next);
  // Native close events are queued; this first models only the immediate closing steps.
  dialog.close = () => { dialog.open = false; f.document.activeElement = f.document.body; };
  dialog.dispatch("cancel"); assert.equal(f.document.activeElement, f.trigger);
  next.showModal(); assert.equal(f.document.activeElement, next);
  dialog.dispatch("close");
  assert.equal(f.document.activeElement, next, "another open dialog owns focus even after an older Team close event arrives");
});

test("Test saves the current draft first and successful connectivity unlocks Enable", async () => {
  const f = fixture(); await flush(); f.hostButton.click(); await flush(); f.el("team-add").click();
  f.el("team-add-blank").click();
  const agent = f.document.body.querySelector("[aria-label='Agent']"); agent.value = "local:runtime-a"; agent.dispatch("change");
  f.el("team-test").click(); await flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["save", "execute"]);
  assert.equal(f.calls[0][2].draft.nodes[0].target.runtime_id, "runtime-a");
  assert.equal(f.calls[1][3].expected_revision, 1); assert.equal(f.calls[1][4], true);
  assert.equal(f.el("team-test").textContent, "Successfully connected"); assert.equal(f.el("team-test").disabled, true);
  assert.equal(f.el("team-enable").disabled, false);
  f.el("team-enable").click(); await flush();
  assert.equal(f.calls[2][0], "control"); assert.equal(f.calls[2][3].enabled, true);
  assert.equal(f.el("team-enable").textContent, "Disable");
});

test("five saved Teams prevent creation while preserving editing and deletion", async () => {
  const f = fixture({ initial: Array.from({ length: 5 }, (_, index) => team(`team-${index}`)) }); await open(f);
  assert.equal(f.el("team-add").disabled, true);
  f.el("team-name").value = "Edit at capacity"; f.el("team-name").dispatch("input"); f.el("team-save").click(); await flush();
  assert.equal(f.calls[0][0], "save");
  f.button("Back to Teams").click();
  f.document.body.querySelector(".team-library-list").children[0].children[2].click(); await flush();
  assert.equal(f.el("team-add").disabled, false); assert.equal(f.teams.length, 4);
});

test("favorite insertion creates independent module copies with fresh identities", async () => {
  const favorite = { id: "favorite-a", module: structuredClone(module) };
  const f = fixture({ initial: [team()], modules: [favorite] }); await open(f);
  for (let index = 0; index < 2; index++) { f.el("team-add-favorite").click(); f.button("Planner", f.document.body.querySelector(".team-secondary-dialog")).click(); }
  f.el("team-save").click(); await flush();
  const nodes = f.calls.find(call => call[0] === "save")[2].draft.nodes;
  assert.equal(nodes.length, 3); assert.equal(new Set(nodes.map(node => node.id)).size, 3);
  assert.deepEqual(nodes[1].target, favorite.module.target); assert.deepEqual(nodes[2].target, favorite.module.target);
  assert.notEqual(nodes[1].target, nodes[2].target);
  assert.deepEqual(f.favorites[0].module, favorite.module);
});

test("the five-favorite cap blocks a new snapshot while permitting removal of an existing favorite", async () => {
  const favorites = Array.from({ length: 5 }, (_, index) => ({ id: `favorite-${index}`, module: { ...structuredClone(module), label: `Saved ${index}` } }));
  const f = fixture({ initial: [team()], modules: favorites }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").dispatch("click");
  assert.equal(f.button("Favorite").disabled, true);
  f.el("team-add-favorite").click();
  const secondary = f.document.body.querySelector(".team-secondary-dialog");
  secondary.querySelector(".team-library-list").children[0].children[1].click(); await flush();
  assert.equal(f.favorites.length, 4); assert.equal(f.button("Favorite").disabled, false);
  f.button("Favorite").click(); await flush();
  assert.equal(f.favorites.length, 5);
  assert.equal(f.calls.find(call => call[0] === "favorite")[2].module.label, "Planner");
});

test("editing an enabled Team first disables it, then saves the draft against the acknowledged stop revision", async () => {
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })] }); await open(f);
  f.el("team-name").value = "Updated Team"; f.el("team-name").dispatch("input");
  f.el("team-save").click(); await flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["control", "save"]);
  assert.equal(f.calls[0][3].enabled, false);
  assert.equal(f.calls[1][2].expected_revision, 2);
  assert.equal(f.calls[1][2].draft.name, "Updated Team");
  assert.equal(f.el("team-enable").disabled, true, "edited configuration requires a new connectivity test");
  assert.equal(f.ui.choices().length, 0);
});

test("a pending Disable receipt with newer remote content cannot advance the stale editor CAS", async () => {
  let releaseStop;
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    controlAgentTeam: async (session, id, input) => {
      f.calls.push(["control", session, id, structuredClone(input)]);
      return new Promise(resolve => { releaseStop = () => {
        const remote = team(id, { revision: 3, test_status: "passed", tested_revision: 3 });
        remote.draft.team_prompt = "New rule from another device"; f.teams = [remote];
        resolve({ team: structuredClone(remote), replayed: false });
      }; });
    },
    saveAgentTeam: async (id, input) => {
      f.calls.push(["save", id, structuredClone(input)]);
      const remote = f.teams.find(item => item.id === id);
      if (input.expected_revision !== remote.revision) throw Object.assign(new Error("Fixture CAS conflict"), { status: 409, code: "conflict" });
      const stored = team(id, { revision: remote.revision + 1, draft: structuredClone(input.draft),
        max_calls: input.max_calls, max_duration_minutes: input.max_duration_minutes });
      f.teams = [stored]; return { team: structuredClone(stored), replayed: false };
    },
  } });
  await open(f); editInput(f.el("team-name"), "Unsaved local rename");
  f.el("team-save").click(); await flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["control"], "Save waits for the independent Disable acknowledgement");
  releaseStop(); await flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["control", "save"]);
  assert.equal(f.calls[1][2].expected_revision, 1, "a control receipt may not acknowledge unseen configuration changes for this editor");
  assert.equal(f.teams[0].revision, 3); assert.equal(f.teams[0].draft.team_prompt, "New rule from another device");
  assert.equal(f.el("team-name").value, "Unsaved local rename"); assert.equal(f.el("team-save").disabled, false);
  assert.equal(f.el("team-enable").disabled, true);
  assert.match(f.document.body.querySelector(".form-error").textContent, /configuration changed elsewhere/u);
});

test("recovering an old Save cannot acknowledge unseen remote changes for a newer local draft", async () => {
  let attempts = 0;
  const f = fixture({ initial: [team()], overrides: { saveAgentTeam: async (id, input) => {
    f.calls.push(["save", id, structuredClone(input)]); attempts++;
    if (attempts === 1) {
      f.teams = [team(id, { revision: 2, draft: structuredClone(input.draft) })];
      throw Object.assign(new Error("Lost Save acknowledgement"), { status: 0 });
    }
    if (input.idempotency_key === f.calls[0][2].idempotency_key) return { team: structuredClone(f.teams[0]), replayed: true };
    if (input.expected_revision !== f.teams[0].revision) throw Object.assign(new Error("Fixture CAS conflict"), { status: 409, code: "conflict" });
    f.teams = [team(id, { revision: f.teams[0].revision + 1, draft: structuredClone(input.draft) })];
    return { team: structuredClone(f.teams[0]), replayed: false };
  } } });
  await open(f); editInput(f.el("team-name"), "Accepted rename"); f.el("team-save").click(); await flush();
  editInput(f.document.body.querySelector("[aria-label='Team rules']"), "Newer local rule");
  const remote = structuredClone(f.teams[0]); remote.revision = 3; remote.draft.nodes[0].role = "Unrelated remote identity";
  f.teams = [remote]; await f.ui.refresh(); await f.ui.recover();
  assert.equal(f.el("team-save").disabled, false); assert.equal(f.el("team-enable").disabled, true);
  assert.match(f.document.body.querySelector(".form-error").textContent, /configuration changed elsewhere/u);
  assert.equal(f.document.body.querySelector("[aria-label='Team rules']").value, "Newer local rule");
  assert.equal(f.button("Check the previous action").hidden, true, "the original mutation is known accepted; the remaining issue is a configuration conflict");
  f.el("team-save").click(); await flush();
  const last = f.calls.at(-1)[2];
  assert.equal(last.expected_revision, 1, "a current-library replay may not lend the stale draft a newer CAS revision");
  assert.equal(f.teams[0].draft.nodes[0].role, "Unrelated remote identity"); assert.equal(f.teams[0].revision, 3);
});

test("a Save replay may load the whole latest remote configuration when no newer local draft exists", async () => {
  let attempts = 0;
  const f = fixture({ initial: [team()], overrides: { saveAgentTeam: async (id, input) => {
    f.calls.push(["save", id, structuredClone(input)]); attempts++;
    if (attempts === 1) {
      f.teams = [team(id, { revision: 2, draft: structuredClone(input.draft) })];
      throw Object.assign(new Error("Lost Save acknowledgement"), { status: 0 });
    }
    return { team: structuredClone(f.teams[0]), replayed: true };
  } } });
  await open(f); editInput(f.el("team-name"), "Accepted rename"); f.el("team-save").click(); await flush();
  const remote = structuredClone(f.teams[0]); remote.revision = 3; remote.draft.team_prompt = "A remote rule to load in full";
  f.teams = [remote]; await f.ui.refresh(); await f.ui.recover();
  assert.equal(f.document.body.querySelector("[aria-label='Team rules']").value, remote.draft.team_prompt);
  assert.equal(f.el("team-save").disabled, true); assert.equal(f.button("Check the previous action").hidden, true);
});

test("a normalized Save acknowledgement may advance CAS for newer local edits without treating literal Team rules as trimmed", async () => {
  let completeSave;
  const f = fixture({ initial: [team()], overrides: { saveAgentTeam: async (id, input) => {
    f.calls.push(["save", id, structuredClone(input)]);
    const draft = structuredClone(input.draft); draft.name = draft.name.trim();
    draft.nodes = draft.nodes.map(node => ({ ...node, label: node.label.trim(), role: node.role.trim(), prompt: node.prompt?.trim() }));
    const stored = team(id, { revision: (input.expected_revision ?? 0) + 1, draft,
      max_calls: input.max_calls, max_duration_minutes: input.max_duration_minutes });
    if (f.calls.length === 1) return new Promise(resolve => { completeSave = () => {
      f.teams = [stored]; resolve({ team: structuredClone(stored), replayed: false });
    }; });
    assert.equal(input.expected_revision, f.teams[0].revision); f.teams = [stored];
    return { team: structuredClone(stored), replayed: false };
  } } });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
  editInput(f.el("team-name"), "  Accepted name  "); editInput(f.el("team-node-name-node-a"), "  Accepted module  ");
  editInput(f.el("team-identity-node-a"), "  Accepted role  "); editInput(f.el("team-prompt-node-a"), "  Accepted method  ");
  editInput(f.document.body.querySelector("[aria-label='Team rules']"), "\nLiteral Team rule\n");
  f.el("team-save").click(); await flush(); editInput(f.el("team-max-calls"), "2"); completeSave(); await flush();
  assert.equal(f.document.body.querySelector(".form-error").textContent, ""); assert.equal(f.el("team-save").disabled, false);
  f.el("team-save").click(); await flush();
  assert.equal(f.calls[1][2].expected_revision, 2); assert.equal(f.teams[0].max_calls, 2);
  assert.equal(f.teams[0].draft.team_prompt, "\nLiteral Team rule\n"); assert.equal(f.teams[0].draft.nodes[0].role, "Accepted role");
});

test("editing a clean Team after a newer remote revision preserves unrelated remote changes or raises a conflict", async () => {
  const f = fixture({ initial: [team()] }); await open(f);
  const remote = team("team-a", { revision: 2 }); remote.draft.team_prompt = "New remote rule";
  f.teams = [remote]; await f.ui.refresh();
  f.el("team-name").value = "Local rename"; f.el("team-name").dispatch("input"); f.el("team-save").click(); await flush();
  const input = f.calls.find(call => call[0] === "save")[2];
  assert.ok(input.expected_revision === 1 || input.draft.team_prompt === "New remote rule",
    "do not advance CAS to the remote revision while retaining an older draft that drops remote edits");
});

test("editing a favorited module changes the toggle to Favorite without deleting its saved template", async () => {
  const f = fixture({ initial: [team()], modules: [{ id: "favorite-a", module: structuredClone(module) }] }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").dispatch("click");
  assert.ok(f.button("Unfavorite"));
  f.el("team-node-name-node-a").value = "Edited planner"; f.el("team-node-name-node-a").dispatch("input");
  assert.ok(f.button("Favorite"), "a changed module is an independent snapshot and must no longer target the original favorite for deletion");
  assert.equal(f.button("Unfavorite"), undefined);
});

test("an Unfavorite acknowledgement keeps its original favorite identity after the module changes", async t => {
  for (const next of ["unmatched", "favorite-b"]) await t.test(next, async () => {
    let completeDelete, releaseRefresh;
    const favoriteB = { id: "favorite-b", module: { ...structuredClone(module), role: "Different saved role" } };
    const f = fixture({ initial: [team()], modules: [{ id: "favorite-a", module: structuredClone(module) }, favoriteB], overrides: {
      deleteTeamItem: async (kind, id, input) => {
        f.calls.push(["delete", kind, id, structuredClone(input)]);
        return new Promise(resolve => { completeDelete = () => {
          f.favorites = f.favorites.filter(favorite => favorite.id !== id); resolve({ deleted: true, replayed: false });
        }; });
      },
    } });
    await open(f); f.document.body.querySelector("[data-node-id='node-a']").click(); f.button("Unfavorite").click(); await flush();
    const identity = f.el("team-identity-node-a"); identity.value = next === "favorite-b" ? favoriteB.module.role : "A new unsaved role";
    identity.dispatch("input");
    // Keep the post-ack refresh pending so it cannot hide a wrong local deletion.
    f.api.listAgentTeams = () => new Promise(resolve => { releaseRefresh = () => resolve({ teams: structuredClone(f.teams),
      modules: structuredClone(f.favorites), team_limit: 5, module_limit: 5 }); });
    completeDelete(); await flush();
    assert.equal(f.button("Check the previous action").hidden, true, "An accepted deletion must not become an uncertain retry after the selection changed");
    assert.equal(f.el("team-module-favorite").textContent, next === "favorite-b" ? "Unfavorite" : "Favorite");
    f.el("team-add-favorite").click();
    const secondary = f.document.body.querySelector(".team-secondary-dialog");
    const remaining = secondary.querySelectorAll(".team-row-edit");
    assert.equal(remaining.length, 1); assert.equal(remaining[0].textContent, favoriteB.module.label);
    assert.equal(f.calls.filter(call => call[0] === "delete").length, 1); assert.equal(f.calls.find(call => call[0] === "delete")[2], "favorite-a");
    assert.deepEqual(f.favorites.map(favorite => favorite.id), ["favorite-b"]);
    releaseRefresh(); await flush();
  });
});

test("opening another Team resets the previous pan and zoom and brings its entry module into view", async t => {
  for (const distantEntry of [false, true]) await t.test(distantEntry ? "distant explicit entry" : "first module near the origin", async () => {
    const other = team("team-b");
    if (distantEntry) {
      other.draft.nodes.push({ ...structuredClone(module), id: "node-b", x: 4200, y: 2500 }); other.draft.entry_node_id = "node-b";
    }
    const f = fixture({ initial: [team(), other] }); await open(f);
    const viewport = f.document.body.querySelector(".team-canvas-viewport"), hud = f.document.body.querySelector(".team-canvas-tools");
    viewport.scrollLeft = 900; viewport.scrollTop = 500; hud.children[2].click(); hud.children[2].click();
    assert.equal(hud.children[1].textContent, "120%");
    f.button("Back to Teams").click(); f.document.body.querySelector(".team-library-list").children[1].children[0].click();
    assert.equal(hud.children[1].textContent, "100%", "each opened Team starts with a readable independent viewport");
    const entry = other.draft.nodes.find(node => node.id === other.draft.entry_node_id);
    assert.ok(entry.x >= viewport.scrollLeft && entry.x + 228 <= viewport.scrollLeft + viewport.clientWidth, "the entry module is horizontally visible");
    assert.ok(entry.y >= viewport.scrollTop && entry.y + 114 <= viewport.scrollTop + viewport.clientHeight, "the entry module is vertically visible");
    f.document.body.querySelector(`[data-node-id='${entry.id}']`).click(); hud.children[2].click();
    const pan = [viewport.scrollLeft, viewport.scrollTop];
    editInput(f.el(`team-identity-${entry.id}`), "An ordinary inspector edit must preserve the working view");
    assert.equal(hud.children[1].textContent, "110%"); assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], pan);
  });
});

test("an unknown enable acknowledgement keeps an independent Disable action available", async () => {
  let resolveEnable; const f = fixture({ initial: [team("team-a", { test_status: "passed", tested_revision: 1 })], overrides: {
    controlAgentTeam: async (session, id, input) => {
      f.calls.push(["control", session, id, structuredClone(input)]);
      if (input.enabled) return new Promise(resolve => { resolveEnable = resolve; });
      const stopped = team(id, { revision: 3, test_status: "passed", tested_revision: 3 }); f.teams = [stopped]; return { team: stopped, replayed: false };
    },
  } });
  await open(f); f.el("team-enable").click(); await flush();
  assert.equal(f.el("team-enable").textContent, "Disable"); assert.equal(f.el("team-enable").disabled, false);
  f.el("team-enable").click(); await flush();
  assert.equal(f.calls[1][3].enabled, false);
  resolveEnable({ team: team("team-a", { revision: 2, enabled: true, test_status: "passed", tested_revision: 2 }) }); await flush();
  assert.equal(f.el("team-enable").textContent, "Enable");
  assert.equal(f.ui.choices().length, 0, "a late older enable receipt must not resurrect a stopped Team");
});

test("a save waiting for Disable cannot write another Team after the editor selection changes", async () => {
  let releaseStop; const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 }), team("team-b")], overrides: {
    controlAgentTeam: async (session, id, input) => {
      f.calls.push(["control", session, id, structuredClone(input)]);
      return new Promise(resolve => { releaseStop = () => resolve({ team: team(id, { revision: 2 }), replayed: false }); });
    },
  } });
  await open(f); f.el("team-name").value = "Unsaved A"; f.el("team-name").dispatch("input");
  f.el("team-save").click(); await flush();
  f.button("Back to Teams").click();
  f.document.body.querySelector(".team-library-list").children[1].children[0].click();
  f.el("team-name").value = "Unsaved B"; f.el("team-name").dispatch("input");
  releaseStop(); await flush();
  assert.equal(f.calls.filter(call => call[0] === "save").length, 0, "the suspended A action must not capture B's draft or revision");
  assert.equal(f.el("team-name").value, "Unsaved B");
  f.el("team-save").click(); await flush();
  const saved = f.calls.find(call => call[0] === "save");
  assert.equal(saved[1], "team-b"); assert.equal(saved[2].draft.name, "Unsaved B");
});

test("recovering multiple uncertain actions stops dispatching the old account's actions after a scope change", async () => {
  let releaseRecovery; const attempts = new Map();
  const f = fixture({ initial: [team("team-a", { enabled: true }), team("team-b", { enabled: true })], overrides: {
    controlAgentTeam: async (session, id, input) => {
      f.calls.push(["control", session, id, structuredClone(input)]); const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
      if (count === 1) throw Object.assign(new Error("Fixture dropped receipt"), { status: 503 });
      if (id === "team-a") return new Promise(resolve => { releaseRecovery = () => resolve({ team: team(id, { revision: 2 }), replayed: true }); });
      return { team: team(id, { revision: 2 }), replayed: true };
    },
  } });
  await flush(); f.hostButton.click(); await flush();
  f.document.body.querySelector(".team-library-list").children[0].children[1].click(); await flush();
  f.document.body.querySelector(".team-library-list").children[1].children[1].click(); await flush();
  const recovering = f.ui.recover(); await flush();
  assert.equal(attempts.get("team-a"), 2);
  f.teams = []; f.update({ scope: "bob:project-b:session-b", userId: "bob", projectId: "project-b", sessionId: "session-b" });
  releaseRecovery(); await recovering; await flush();
  assert.equal(attempts.get("team-b"), 1, "do not send the next frozen Alice intent using Bob's current browser session");
});

test("a probe POST acknowledgement immediately prevents repeated probes while its follow-up GET is hanging", async () => {
  let hangReads = false;
  const f = fixture({ initial: [team()], overrides: {
    listAgentTeams: async () => hangReads ? new Promise(() => {}) : { teams: structuredClone(f.teams), modules: [], team_limit: 5, module_limit: 5 },
    executeAgentTeam: async (session, id, input, probe) => {
      f.calls.push(["execute", session, id, structuredClone(input), probe]); hangReads = true;
      return { run: { id: "probe-a", definition_id: id, purpose: "test", status: "running", calls_used: 0, max_calls: 1 }, replayed: false };
    },
  } });
  await open(f); f.el("team-test").click(); await flush();
  assert.equal(f.el("team-test").disabled, true); assert.equal(f.el("team-test").textContent, "Test running…");
  f.el("team-test").click(); await flush();
  assert.equal(f.calls.filter(call => call[0] === "execute").length, 1, "an accepted probe must not rely on a later GET to prevent duplicate calls");
  assert.equal(f.el("team-enable").disabled, true);
});

test("repeated Favorite clicks during a pending acknowledgement reuse one snapshot identity", async () => {
  let releaseFavorite;
  const f = fixture({ initial: [team()], overrides: {
    saveTeamModule: async (id, input) => {
      f.calls.push(["favorite", id, structuredClone(input)]);
      return new Promise(resolve => { releaseFavorite = () => resolve({ favorite: { id, module: structuredClone(input.module) }, replayed: false }); });
    },
  } });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").dispatch("click");
  f.button("Favorite").click(); await flush();
  assert.equal(f.button("Favorite").disabled, true);
  // Re-selecting renders a fresh inspector; it must retain the pending snapshot fence.
  f.document.body.querySelector("[data-node-id='node-a']").dispatch("click");
  assert.equal(f.button("Favorite").disabled, true); f.button("Favorite").click(); await flush();
  assert.equal(f.calls.filter(call => call[0] === "favorite").length, 1);
  releaseFavorite(); await flush();
});

const pausedRun = error_code => ({ id: "run-a", definition_id: "team-a", purpose: "task", status: "paused", error_code,
  calls_used: 2, max_calls: 12 });

test("terminal task records can be cleared with an explicit action while active records cannot", async () => {
  const f = fixture({ initial: [team()], initialRuns: [
    { ...pausedRun(null), id: "finished", status: "completed" }, { ...pausedRun(null), id: "active", status: "running" },
  ], overrides: { forgetTeamRun: async (session, id) => {
    f.calls.push(["forget", session, id]); f.runs = f.runs.filter(run => run.id !== id); return { deleted: true };
  } } });
  await flush(); f.hostButton.click(); await flush();
  const clear = f.button("Clear private record"); assert.ok(clear, "the documented terminal-record recovery must be reachable from the Web UI");
  clear.click(); await flush();
  assert.deepEqual(f.calls, [["forget", "session-a", "finished"]]); assert.equal(f.runs.length, 1);
  assert.equal(f.button("Clear private record"), undefined); assert.ok(f.button("Stop"));
});

test("a control acknowledgement delayed past clearing its ended run cannot restore an active task", async () => {
  let releaseControl;
  const f = fixture({ initial: [team()], initialRuns: [{ ...pausedRun(null), status: "running" }], overrides: {
    controlTeamRun: async () => new Promise(resolve => { releaseControl = () => resolve({ run: { ...pausedRun(null), status: "paused" } }); }),
    forgetTeamRun: async () => { f.runs = []; return { deleted: true }; },
  } });
  await flush(); f.hostButton.click(); await flush(); f.button("Pause").click(); await flush();
  f.runs = [{ ...pausedRun(null), status: "completed" }]; await f.ui.refresh();
  f.button("Clear private record").click(); await flush();
  let blockReads = true;
  f.api.listTeamRuns = async () => blockReads ? new Promise(() => {}) : { runs: [] };
  releaseControl(); await flush();
  assert.equal(f.ui.activeRun(), undefined, "a cleared cache cannot become a phantom paused task through an old reply");
  blockReads = false;
});
const clarificationHint = "请先在当前会话发送 chat 说明如何处理，再点击“澄清后继续”。如需修改身份、提示词或连线，请停止后修改、重测并启动新任务。";

test("an instruction conflict shows a Chinese clarification state and resumes only through the explicit resume action", async () => {
  const f = fixture({ initial: [team()], initialRuns: [pausedRun("agent_team_instruction_conflict")] });
  f.document.documentElement.lang = "zh-CN"; await flush(); f.hostButton.click(); await flush();
  const row = f.document.body.querySelector(".team-run-row");
  assert.match(row.children[0].textContent, /等待澄清/u); assert.equal(row.querySelector(".team-run-advice").textContent, clarificationHint);
  assert.match(row.querySelector(".team-run-reason").textContent, /指令冲突/u);
  assert.ok(f.button("澄清后继续", row)); assert.ok(f.button("停止", row));
  assert.equal(f.button("继续", row), undefined); assert.equal(f.button("恢复", row), undefined);
  f.button("澄清后继续", row).click(); await flush();
  assert.equal(f.calls[0][0], "run-control"); assert.equal(f.calls[0][1], "session-a");
  assert.equal(f.calls[0][2], "run-a"); assert.equal(f.calls[0][3].action, "resume");
});

for (const [locale, label, expected] of [["en", "Continue after clarification", "Send a chat message in this session explaining how to proceed"],
  ["zh-CN", "澄清后继续", clarificationHint]]) {
  test(`missing owner clarification reports a localized recovery instruction without exposing the API error (${locale})`, async () => {
    const f = fixture({ initial: [team()], initialRuns: [pausedRun("agent_team_instruction_conflict")], overrides: {
      controlTeamRun: async (session, id, input) => {
        f.calls.push(["run-control", session, id, structuredClone(input)]);
        throw Object.assign(new Error("private fixture backend error"), { status: 409, code: "agent_team_clarification_required" });
      },
    } });
    f.document.documentElement.lang = locale; await flush(); f.hostButton.click(); await flush();
    f.button(label).click(); await flush();
    const message = f.document.body.querySelector(".form-error").textContent;
    assert.ok(message.startsWith(expected)); assert.doesNotMatch(message, /private fixture/u);
    assert.equal(f.calls[0][3].action, "resume");
    assert.equal(f.button(label).disabled, false, "the owner can retry explicitly after sending a chat clarification");
  });
}

for (const [errorCode, label, action] of [[null, "Resume", "resume"], ["agent_timeout", "Continue", "continue"]]) {
  test(`ordinary ${errorCode ?? "manual pause"} retains its original ${action} control`, async () => {
    const f = fixture({ initial: [team()], initialRuns: [pausedRun(errorCode)] }); await flush(); f.hostButton.click(); await flush();
    const row = f.document.body.querySelector(".team-run-row"); assert.ok(row.querySelector(".team-run-reason")); assert.ok(row.querySelector(".team-run-advice"));
    assert.equal(f.button("Continue after clarification", row), undefined);
    f.button(label, row).click(); await flush(); assert.equal(f.calls[0][3].action, action);
  });
}

const startedRun = (id, status = "running") => ({ id, definition_id: "team-a", session_id: "session-a", purpose: "task", status,
  calls_used: 1, max_calls: 12 });

test("a Team task sends its selected quote and member identities while ordinary starts omit empty metadata", async () => {
  const enabled = team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 });
  for (const withMetadata of [false, true]) {
    const f = fixture({ initial: [enabled] }); await flush(); f.ui.select("team:team-a");
    let accepted = 0;
    const mentions = [{ user_id: "bob", start: 3, end: 7 }];
    await f.ui.startTask("😀 @Bob please review", { replyTo: withMetadata ? "quoted-message" : null,
      mentions: withMetadata ? mentions : [], onAccepted: () => accepted++ });
    const body = f.calls.find(call => call[0] === "execute")[3];
    assert.equal(accepted, 1); assert.equal(body.content, "😀 @Bob please review");
    if (withMetadata) {
      assert.equal(body.reply_to_event_id, "quoted-message"); assert.deepEqual(body.mentions, mentions);
    } else {
      assert.equal(Object.hasOwn(body, "reply_to_event_id"), false); assert.equal(Object.hasOwn(body, "mentions"), false);
    }
  }
});

test("unknown Team acceptance retries the frozen quote and mentions even after the caller changes its selection", async () => {
  let firstAccepted = 0, replacementAccepted = 0;
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    executeAgentTeam: async (session, id, body) => {
      f.calls.push(["execute", session, id, structuredClone(body)]);
      if (f.calls.length === 1) throw Object.assign(new Error("Unknown acknowledgement"), { status: 0, code: "request_timeout" });
      return { run: startedRun("accepted-run"), replayed: true };
    },
  } });
  await flush(); f.ui.select("team:team-a");
  const mentions = [{ user_id: "bob", start: 0, end: 4 }];
  await assert.rejects(f.ui.startTask("@Bob review", { replyTo: "original-quote", mentions,
    onAccepted: () => firstAccepted++ }), /Unknown acknowledgement/);
  assert.equal(f.ui.pendingStart(), true); assert.equal(firstAccepted, 0);
  mentions[0].user_id = "charlie";
  await f.ui.startTask("@Charlie a different task", { replyTo: "new-quote", mentions: [{ user_id: "charlie", start: 0, end: 8 }],
    onAccepted: () => replacementAccepted++ });
  assert.deepEqual(f.calls[0][3], f.calls[1][3], "retry must preserve all metadata and the original idempotency key");
  assert.equal(f.calls[1][3].reply_to_event_id, "original-quote"); assert.equal(f.calls[1][3].mentions[0].user_id, "bob");
  assert.equal(firstAccepted, 1); assert.equal(replacementAccepted, 0); assert.equal(f.ui.pendingStart(), false);
});

test("an unknown Team start recovered through the explicit recovery action retains its metadata", async () => {
  let accepted = 0;
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    executeAgentTeam: async (session, id, body) => {
      f.calls.push(["execute", session, id, structuredClone(body)]);
      if (f.calls.length === 1) throw Object.assign(new Error("Lost response"), { status: 0 });
      return { run: startedRun("recovered-run"), replayed: true };
    },
  } });
  await flush(); f.ui.select("team:team-a");
  await assert.rejects(f.ui.startTask("@Bob review", { replyTo: "original-quote", mentions: [{ user_id: "bob", start: 0, end: 4 }],
    onAccepted: () => accepted++ }), /Lost response/);
  await f.ui.recover();
  assert.deepEqual(f.calls[1][3], f.calls[0][3]); assert.equal(accepted, 1); assert.equal(f.ui.pendingStart(), false);
});

test("a definitive deleted-source rejection preserves the caller's draft metadata and does not acknowledge acceptance", async () => {
  let accepted = 0;
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    executeAgentTeam: async () => { throw Object.assign(new Error("Original message deleted"), { status: 410 }); },
  } });
  await flush(); f.ui.select("team:team-a");
  const metadata = { replyTo: "deleted-quote", mentions: [{ user_id: "bob", start: 0, end: 4 }], onAccepted: () => accepted++ };
  await assert.rejects(f.ui.startTask("@Bob review", metadata), /Original message deleted/);
  assert.equal(accepted, 0); assert.equal(f.ui.pendingStart(), false); assert.equal(metadata.replyTo, "deleted-quote");
  assert.deepEqual(metadata.mentions, [{ user_id: "bob", start: 0, end: 4 }]);
});

const startedEvent = (id, runId, key, content = "Same task") => ({ id, type: "agent_request", actor: { id: "alice" }, sessionId: "session-a",
  payload: { agent_team: { run_id: runId, node_id: "node-a", step_id: `${runId}-step`, node_label: "Planner", task_content: content,
    ...(key === undefined ? {} : { start_idempotency_key: key }) } } });

async function startWithUnknownReceipt(overrides = {}) {
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    executeAgentTeam: async (session, id, input) => {
      f.calls.push(["execute", session, id, structuredClone(input)]); return new Promise(() => {});
    }, ...overrides,
  } });
  await flush(); f.ui.select("team:team-a"); void f.ui.startTask("Same task"); await flush();
  return { f, input: f.calls.find(call => call[0] === "execute")[3] };
}

test("same-account devices submitting identical tasks keep Stop bound to the exact pending start key", async () => {
  const { f, input } = await startWithUnknownReceipt();
  f.runs = [startedRun("other-device-run"), startedRun("this-device-run", "paused")]; await f.ui.refresh();
  f.update({ events: [startedEvent("other-device-request", "other-device-run", "other-device-key"),
    startedEvent("this-device-request", "this-device-run", input.idempotency_key)] });
  assert.equal(f.ui.pendingStart(), true); assert.equal(f.ui.activeRun().id, "this-device-run");
  assert.equal(f.ui.activeRun().status, "paused", "the exact known run's state must take precedence over a synthesized running state");
  await f.ui.stopActive(); await flush();
  const stop = f.calls.find(call => call[0] === "run-control");
  assert.equal(stop[2], "this-device-run"); assert.equal(stop[3].action, "stop");
  assert.equal(f.ui.activeRun(), undefined, "a terminal exact run must not fall through to the other device's active run");
});

test("an unknown start receipt cannot infer ownership from another run or an identical canonical task without the exact key", async () => {
  const { f, input } = await startWithUnknownReceipt();
  f.runs = [startedRun("foreign-first")]; await f.ui.refresh();
  const otherSession = startedEvent("other-session", "foreign-session-run", input.idempotency_key); otherSession.sessionId = "session-b";
  const otherUser = startedEvent("other-user", "foreign-user-run", input.idempotency_key); otherUser.actor.id = "bob";
  const probe = startedEvent("probe-request", "probe-run", input.idempotency_key); probe.payload.agent_team.purpose = "test";
  f.update({ events: [startedEvent("legacy-no-key", "legacy-run", undefined), startedEvent("other-device", "foreign-first", "other-key"),
    otherSession, otherUser, probe, startedEvent("wrong-content", "wrong-content-run", input.idempotency_key, "Different task")] });
  assert.equal(f.ui.activeRun(), undefined);
  await f.ui.stopActive();
  assert.equal(f.calls.some(call => call[0] === "run-control"), false, "uncertain receipt recovery must not stop an unrelated run");
});

test("an exact canonical start key enables independent Stop even while the receipt and run-list GET are hanging", async () => {
  const { f, input } = await startWithUnknownReceipt();
  f.api.listTeamRuns = () => new Promise(() => {});
  void f.ui.refresh(); await flush();
  f.update({ events: [startedEvent("own-request", "exact-run", input.idempotency_key)] });
  assert.equal(f.ui.activeRun().id, "exact-run");
  f.api.controlTeamRun = async (session, id, value) => {
    f.calls.push(["run-control", session, id, structuredClone(value)]);
    return { run: startedRun(id, "stopped"), replayed: false };
  };
  await f.ui.stopActive(); await flush();
  assert.equal(f.calls.find(call => call[0] === "run-control")[2], "exact-run");
  assert.equal(f.ui.activeRun(), undefined); assert.equal(f.ui.pendingStart(), true);
});

for (const state of ["completed", "failed", "stopped", "timed_out", "call_limit"]) {
  test(`a ${state} exact run cannot be synthesized as active while its original start acknowledgement is missing`, async () => {
    const { f, input } = await startWithUnknownReceipt();
    f.runs = [startedRun("other-run"), startedRun("exact-run", state)]; await f.ui.refresh();
    f.update({ events: [startedEvent("own-request", "exact-run", input.idempotency_key)] });
    assert.equal(f.ui.activeRun(), undefined); await f.ui.stopActive();
    assert.equal(f.calls.some(call => call[0] === "run-control"), false);
  });
}

test("without a pending start the session's known active task remains stoppable", async () => {
  const f = fixture({ initial: [team()], initialRuns: [startedRun("known-run")] }); await flush();
  assert.equal(f.ui.activeRun().id, "known-run"); await f.ui.stopActive();
  assert.equal(f.calls.find(call => call[0] === "run-control")[2], "known-run");
});


test("adding a module preserves the existing implicit start module", async () => {
  const saved = team(); delete saved.draft.entry_node_id;
  const f = fixture({ initial: [saved] }); await open(f);
  f.el("team-add-blank").click(); f.el("team-save").click(); await flush();
  const plan = f.calls.find(call => call[0] === "save")[2].draft;
  assert.equal(plan.entry_node_id ?? plan.nodes[0].id, "node-a", "adding a later module must not silently replace the saved default start");
});

test("switching Teams cancels an unfinished wire instead of saving an invisible foreign-node route", async () => {
  const other = team("team-b"); other.draft.nodes[0].id = "other-node"; other.draft.entry_node_id = "other-node";
  const f = fixture({ initial: [team(), other] }); await open(f);
  f.document.body.querySelector("[data-port='out']").click();
  assert.equal(f.document.body.querySelector(".team-canvas-viewport").dataset.linking, "true");
  f.button("Back to Teams").click(); f.document.body.querySelector(".team-library-list").children[1].children[0].click();
  assert.equal(f.document.body.querySelector(".team-canvas-viewport").dataset.linking, "false");
  f.document.body.querySelector("[data-port='in']").click();
  editInput(f.el("team-name"), "Other Team updated"); f.el("team-save").click(); await flush();
  assert.deepEqual(f.calls.find(call => call[0] === "save")[2].draft.edges, [], "the new Team must not gain a route from the previous Team's node");
});

for (const changed of ["disabled", "deleted", "different selection"]) {
  test(`a lost start acknowledgement remains exactly recoverable after its Team is ${changed}`, async () => {
    const enabled = team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 });
    const f = fixture({ initial: [enabled], overrides: { executeAgentTeam: async (session, id, input) => {
      f.calls.push(["execute", session, id, structuredClone(input)]);
      if (f.calls.length === 1) throw Object.assign(new Error("Lost start acknowledgement"), { status: 0 });
      return { run: startedRun("accepted-before-disable"), replayed: true };
    } } });
    await flush(); f.ui.select("team:team-a"); await assert.rejects(f.ui.startTask("Original task"), /Lost start acknowledgement/u);
    if (changed === "deleted") f.teams = [];
    else if (changed === "disabled") f.teams = [{ ...enabled, enabled: false, revision: 2, tested_revision: 2 }];
    else f.ui.select("local:other-runtime");
    await f.ui.refresh(); await f.ui.startTask("A newer draft must not replace the accepted task");
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1], f.calls[0]);
    assert.equal(f.ui.pendingStart(), false);
  });
}

test("language refresh does not keep updating discarded library controls", async () => {
  const f = fixture({ initial: [team()] }); await open(f);
  const oldDelete = f.document.body.querySelector(".team-library-list").children[0].children[2];
  assert.equal(oldDelete.textContent, "Delete"); await f.ui.refresh(); assert.equal(oldDelete.isConnected, false);
  f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
  assert.equal(f.document.body.querySelector(".team-library-list").children[0].children[2].textContent, "删除");
  assert.equal(oldDelete.textContent, "Delete", "translation work must refer only to live controls, not retain every replaced 2-second poll row");
});

test("restoring an empty optional prompt keeps the matching favorite instead of offering a duplicate", async () => {
  const saved = team(); delete saved.draft.nodes[0].prompt;
  const favorite = { id: "favorite-a", module: structuredClone(module) }; delete favorite.module.prompt;
  const f = fixture({ initial: [saved], modules: [favorite] }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").click(); assert.ok(f.button("Unfavorite"));
  const prompt = f.document.body.querySelector(".team-inspector").querySelector("textarea");
  editInput(prompt, "Temporary prompt"); assert.ok(f.button("Favorite")); editInput(prompt, "");
  assert.equal(f.el("team-save").disabled, true); assert.ok(f.button("Unfavorite"));
  assert.equal(f.button("Favorite"), undefined);
});


for (const [label, field, changedValue, readSaved] of [
  ["identity", f => f.el("team-identity-node-a"), "Updated after save", draft => draft.nodes[0].role],
  ["module name", f => f.el("team-node-name-node-a"), "Renamed after save", draft => draft.nodes[0].label],
  ["prompt", f => f.document.body.querySelector(".team-inspector").querySelector("textarea"), "Method after save", draft => draft.nodes[0].prompt],
]) {
  test(`editing the selected module ${label} after saving updates the accepted draft instead of a detached node`, async () => {
    const f = fixture({ initial: [team()] }); await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
    editInput(f.el("team-name"), "Save with a selected module"); f.el("team-save").click(); await flush();
    editInput(field(f), changedValue);
    assert.equal(f.el("team-save").disabled, false, "the newly visible edit must belong to the current saved draft object");
    f.el("team-save").click(); await flush();
    assert.equal(readSaved(f.calls.filter(call => call[0] === "save")[1][2].draft), changedValue);
  });
}

test("save acknowledgement normalizes visible fields and preserves a newly focused inspector caret", async () => {
  let finishSave;
  const f = fixture({ initial: [team()], overrides: { saveAgentTeam: async (id, input) => {
    f.calls.push(["save", id, structuredClone(input)]);
    return new Promise(resolve => { finishSave = () => {
      const draft = structuredClone(input.draft); draft.name = draft.name.trim();
      const accepted = team(id, { revision: 2, draft }); f.teams = [accepted]; resolve({ team: accepted, replayed: false });
    }; });
  } } });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
  editInput(f.el("team-name"), "  Normalized Team  "); f.el("team-save").click(); await flush();
  const role = f.el("team-identity-node-a"); role.focus(); role.selectionStart = 1; role.selectionEnd = 3;
  finishSave(); await flush();
  assert.equal(f.el("team-name").value, "Normalized Team");
  assert.equal(f.document.activeElement, f.el("team-identity-node-a"));
  assert.equal(f.document.activeElement.selectionStart, 1); assert.equal(f.document.activeElement.selectionEnd, 3);
});

test("library polling preserves the focused row action without retaining the replaced row", async () => {
  const f = fixture({ initial: [team(), team("team-b")] }); await flush(); f.hostButton.click(); await flush();
  const first = f.document.body.querySelector(".team-library-list").children[1].children[2]; first.focus();
  await f.ui.refresh();
  const replacement = f.document.body.querySelector(".team-library-list").children[1].children[2];
  assert.equal(first.isConnected, false); assert.ok(f.document.activeElement === replacement, "focus must move to the replacement for the same Team action");
});

test("run polling preserves the focused exact task control", async () => {
  const f = fixture({ initial: [team()], initialRuns: [startedRun("focused-run")] }); await flush(); f.hostButton.click(); await flush();
  const first = f.button("Stop", f.document.body.querySelector(".team-run-row")); first.focus();
  await f.ui.refresh();
  assert.equal(first.isConnected, false); assert.ok(f.document.activeElement === f.button("Stop", f.document.body.querySelector(".team-run-row")), "focus must remain on the exact task control after polling");
});


test("switching language refreshes persistent rules and an open favorite dialog", async () => {
  const f = fixture({ initial: [team()], modules: [{ id: "favorite-a", module: structuredClone(module) }] }); await open(f);
  f.el("team-add-favorite").click(); f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
  assert.equal(f.document.body.querySelector(".team-rules").querySelector("textarea").attributes["aria-label"], "全队提示词");
  assert.equal(f.el("team-secondary-title").textContent, "已收藏模块 (1/5)");
  const remove = f.document.body.querySelector(".team-secondary-dialog").querySelector(".team-library-list").children[0].children[1];
  assert.equal(remove.attributes["aria-label"], "删除: Planner");
});

test("a delayed favorite deletion cannot reopen a dialog the user has closed", async () => {
  let completeDelete;
  const f = fixture({ initial: [team()], modules: [{ id: "favorite-a", module: structuredClone(module) }], overrides: {
    deleteTeamItem: async (kind, id, input) => {
      f.calls.push(["delete", kind, id, structuredClone(input)]);
      return new Promise(resolve => { completeDelete = () => { f.favorites = []; resolve({ deleted: true, replayed: false }); }; });
    },
  } });
  await open(f); f.el("team-add-favorite").click();
  const secondary = f.document.body.querySelector(".team-secondary-dialog");
  secondary.querySelector(".team-library-list").children[0].children[1].click(); await flush();
  f.button("Close", secondary).click(); f.button("Close", f.el("agent-team-dialog")).click();
  completeDelete(); await flush();
  assert.equal(f.el("agent-team-dialog").open, false); assert.equal(secondary.open, false, "late acknowledgements must not summon a closed modal");
});


test("account/scope changes clear the previous private editor, graph, favorites and run DOM", async () => {
  const privateTeam = team(); privateTeam.draft.name = "Private Alice Team"; privateTeam.draft.team_prompt = "Private Alice rules";
  privateTeam.draft.nodes[0].label = "Private Alice module"; privateTeam.draft.nodes[0].role = "Private Alice responsibility";
  const f = fixture({ initial: [privateTeam], modules: [{ id: "favorite-a", module: { ...structuredClone(module), label: "Private Alice favorite" } }], initialRuns: [startedRun("private-alice-run")] });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").click(); f.el("team-add-favorite").click();
  f.teams = []; f.favorites = []; f.runs = [];
  f.update({ scope: "bob:project-b:session-b", userId: "bob", projectId: "project-b", sessionId: "session-b" });
  const nodes = [f.el("agent-team-dialog"), f.document.body.querySelector(".team-secondary-dialog")]
    .flatMap(surface => [surface, ...surface.querySelectorAll("input,textarea,strong,small,span,p,h2,li,button")]);
  assert.ok(nodes.every(node => !String(node.value || node.textContent).includes("Private Alice")),
    "closing a modal alone must not leave the former account's private configuration in the new account's DOM");
  assert.equal(f.document.body.querySelectorAll("[data-node-id]").length, 0); assert.equal(f.el("agent-team-dialog").open, false);
});

test("favorite status follows another device's library refresh without requiring module reselection", async () => {
  const f = fixture({ initial: [team()], modules: [{ id: "favorite-a", module: structuredClone(module) }] }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").click(); assert.ok(f.button("Unfavorite"));
  f.favorites = []; await f.ui.refresh(); assert.ok(f.button("Favorite"));
  f.favorites = [{ id: "favorite-b", module: structuredClone(module) }]; await f.ui.refresh(); assert.ok(f.button("Unfavorite"));
});


test("model and reasoning selectors remain bound to the accepted module after repeated saves", async () => {
  const f = fixture({ initial: [team()] });
  f.update({ runtimes: [{ id: "runtime-a", userId: "alice", deviceId: "device-a", purpose: "execution", harness: "codex", status: "online",
    provider: "fixture", model: "fixture-model", executionProfiles: [
      { provider: "fixture", model: "fixture-model", reasoningEfforts: ["high"] },
      { provider: "fixture", model: "second-model", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
    ] }] });
  await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
  editInput(f.el("team-name"), "Saved before changing model"); f.el("team-save").click(); await flush();
  const model = f.document.body.querySelector("[aria-label='Model']"); model.value = JSON.stringify(["fixture", "second-model", ""]); model.dispatch("change");
  assert.equal(f.el("team-save").disabled, false); f.el("team-save").click(); await flush();
  const effort = f.document.body.querySelector("[aria-label='Reasoning effort']"); effort.value = "high"; effort.dispatch("change");
  assert.equal(f.el("team-save").disabled, false); f.el("team-save").click(); await flush();
  const saves = f.calls.filter(call => call[0] === "save");
  assert.equal(saves[1][2].draft.nodes[0].target.model, "second-model"); assert.equal(saves[1][2].draft.nodes[0].target.reasoning_effort, "medium");
  assert.equal(saves[2][2].draft.nodes[0].target.model, "second-model"); assert.equal(saves[2][2].draft.nodes[0].target.reasoning_effort, "high");
});


test("a late favorite deletion cannot replace a newer relationships dialog", async () => {
  let completeDelete;
  const f = fixture({ initial: [team()], modules: [{ id: "favorite-a", module: structuredClone(module) }], overrides: {
    deleteTeamItem: async () => new Promise(resolve => { completeDelete = () => { f.favorites = []; resolve({ deleted: true, replayed: false }); }; }),
  } });
  await open(f); f.el("team-add-favorite").click(); const secondary = f.document.body.querySelector(".team-secondary-dialog");
  secondary.querySelector(".team-library-list").children[0].children[1].click(); await flush();
  f.button("Close", secondary).click(); f.button("View configuration").click(); completeDelete(); await flush();
  assert.equal(secondary.open, true); assert.equal(f.el("team-secondary-title").textContent, "Configuration relationships");
});

test("polling removal of a focused Team at library capacity still restores a visible enabled control", async () => {
  const f = fixture({ initial: Array.from({ length: 5 }, (_, index) => team(`team-${index}`)) }); await flush(); f.hostButton.click(); await flush();
  const action = f.document.body.querySelector(".team-library-list").children[0].children[2]; action.focus();
  f.teams = [...f.teams.slice(1), team("team-new")]; await f.ui.refresh();
  assert.equal(action.isConnected, false);
  assert.ok(f.document.activeElement !== action && f.document.activeElement !== f.document.body && !f.document.activeElement.disabled
    && f.document.activeElement.getClientRects().length > 0, "a disappearing row must not leave keyboard focus on BODY or a disabled Add button");
});


for (const waitingSave of [false, true]) {
  test(`a stale ${waitingSave ? "save waiting for Disable" : "Disable failure"} cannot write an error into another account`, async () => {
    let rejectStop;
    const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
      controlAgentTeam: async () => new Promise((_resolve, reject) => { rejectStop = reject; }),
    } });
    await open(f);
    if (waitingSave) { editInput(f.el("team-name"), "Alice local edit"); f.el("team-save").click(); }
    else f.el("team-enable").click();
    await flush();
    f.teams = []; f.update({ scope: "bob:project-b:session-b", userId: "bob", projectId: "project-b", sessionId: "session-b" });
    f.hostButton.click(); await flush(); rejectStop(Object.assign(new Error("Old account failure"), { status: 409, code: "conflict" })); await flush();
    assert.equal(f.document.body.querySelector(".form-error").textContent, "", "old async failures must not replace another account's current view");
  });
}

for (const action of ["pause", "resume"]) {
  test(`a delayed ${action} ACK cannot roll back a newer state observed from another device after reconnect`, async () => {
    let releaseControl, readsFail = false;
    const original = startedRun("shared-device-run", action === "pause" ? "running" : "paused");
    let authoritative = structuredClone(original);
    const reads = async () => {
      if (readsFail) throw Object.assign(new Error("Reconnect read interrupted"), { status: 0 });
      return { runs: [structuredClone(authoritative)] };
    };
    const a = fixture({ initial: [team()], overrides: { listTeamRuns: reads,
      controlTeamRun: async (_session, _id, input) => {
        authoritative.status = input.action === "pause" ? "paused" : "running";
        const accepted = structuredClone(authoritative);
        return new Promise(resolve => { releaseControl = () => resolve({ run: accepted }); });
      },
    } });
    const b = fixture({ initial: [team()], overrides: { listTeamRuns: reads,
      controlTeamRun: async (_session, _id, input) => {
        authoritative.status = input.action === "pause" ? "paused" : "running";
        return { run: structuredClone(authoritative) };
      },
    } });
    await flush(); const pending = a.ui.controlRun(original, action); await flush();
    await b.ui.refresh(); await b.ui.controlRun(b.ui.activeRun(), action === "pause" ? "resume" : "pause"); await flush();
    await a.ui.refresh(); const observed = a.ui.activeRun().status; readsFail = true;
    releaseControl(); await pending; await flush();
    assert.equal(a.ui.activeRun().status, observed, "the delayed ACK must not overwrite a newer authoritative observation while the next refresh is offline");
    assert.equal(a.button("Check the previous action").hidden, true, "the accepted control receipt must still settle");
  });
}

test("a delayed control ACK cannot roll back a newer independent control ACK when polling is unavailable", async () => {
  let releasePause;
  const original = startedRun("local-control-order"); let authoritative = structuredClone(original);
  const f = fixture({ initial: [team()], initialRuns: [original], overrides: {
    controlTeamRun: async (_session, _id, input) => {
      authoritative.status = input.action === "pause" ? "paused" : "running";
      const accepted = structuredClone(authoritative);
      if (input.action === "pause") return new Promise(resolve => { releasePause = () => resolve({ run: accepted }); });
      return { run: accepted };
    },
  } });
  await flush(); f.api.listTeamRuns = async () => { throw Object.assign(new Error("Offline list"), { status: 0 }); };
  const pause = f.ui.controlRun(original, "pause"); await flush();
  await f.ui.controlRun({ ...original, status: "paused" }, "resume"); await flush();
  assert.equal(f.ui.activeRun().status, "running"); releasePause(); await pause; await flush();
  assert.equal(f.ui.activeRun().status, "running", "control receipts settle independently without restoring an earlier run status");
});

test("a delayed Start ACK settles the composer without replacing a newer remotely paused run", async () => {
  let releaseStart, readsFail = false; let authoritative = [];
  const enabled = team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 });
  const f = fixture({ initial: [enabled], overrides: {
    listTeamRuns: async () => {
      if (readsFail) throw Object.assign(new Error("Offline list"), { status: 0 });
      return { runs: structuredClone(authoritative) };
    },
    executeAgentTeam: async () => {
      authoritative = [startedRun("accepted-before-reconnect")]; const accepted = structuredClone(authoritative[0]);
      return new Promise(resolve => { releaseStart = () => resolve({ run: accepted, replayed: false }); });
    },
  } });
  await flush(); f.ui.select("team:team-a"); let acceptedCount = 0;
  const pending = f.ui.startTask("Task accepted before reconnect", { onAccepted: () => acceptedCount++ }); await flush();
  authoritative[0].status = "paused"; await f.ui.refresh(); readsFail = true;
  releaseStart(); await pending; await flush();
  assert.equal(acceptedCount, 1); assert.equal(f.ui.pendingStart(), false);
  assert.equal(f.ui.activeRun().status, "paused", "the original Start ACK is an acceptance receipt, not a later status observation");
});

test("a control ACK still updates immediately if no later observation exists and the follow-up read is offline", async () => {
  const original = startedRun("accepted-pause");
  const f = fixture({ initial: [team()], initialRuns: [original] }); await flush();
  f.api.listTeamRuns = async () => { throw Object.assign(new Error("Offline list"), { status: 0 }); };
  await f.ui.controlRun(original, "pause"); await flush();
  assert.equal(f.ui.activeRun().status, "paused"); assert.equal(f.button("Check the previous action").hidden, true);
});

test("a recovered control receipt is a fresh observation unless another response arrives during that retry", async () => {
  let tries = 0; const original = startedRun("retried-control");
  const f = fixture({ initial: [team()], initialRuns: [original], overrides: {
    controlTeamRun: async () => {
      if (++tries === 1) throw Object.assign(new Error("Lost Pause ACK"), { status: 0 });
      return { run: { ...original, status: "paused" } };
    },
  } });
  await flush(); await assert.rejects(f.ui.controlRun(original, "pause"), /Lost Pause ACK/u); await flush();
  assert.equal(f.ui.activeRun().status, "running");
  f.api.listTeamRuns = async () => { throw Object.assign(new Error("Offline list"), { status: 0 }); };
  await f.ui.recover(); await flush();
  assert.equal(tries, 2); assert.equal(f.ui.activeRun().status, "paused", "observations preceding a new transport attempt cannot suppress that attempt's later receipt");
});

test("a missing Start ACK cannot revive a completed run after another device clears it and the browser reconnects", async () => {
  const { f, input } = await startWithUnknownReceipt();
  f.update({ events: [startedEvent("completed-own-request", "finished-on-another-device", input.idempotency_key)] });
  f.runs = [startedRun("finished-on-another-device", "completed")]; await f.ui.refresh();
  assert.equal(f.ui.activeRun(), undefined);
  f.runs = []; await f.ui.refresh();
  assert.equal(f.ui.activeRun(), undefined, "an already observed terminal run must not be synthesized as running after its private record is cleared");
  await f.ui.stopActive(); assert.equal(f.calls.some(call => call[0] === "run-control"), false);
  assert.equal(f.ui.pendingStart(), true, "the unknown Start receipt remains separately recoverable");
});

test("an empty reconnect list fences a canonical pending run that finished and was cleared before this browser ever listed it", async () => {
  const { f, input } = await startWithUnknownReceipt();
  f.update({ events: [startedEvent("unlisted-own-request", "completed-before-first-list", input.idempotency_key)] });
  assert.equal(f.ui.activeRun().id, "completed-before-first-list");
  await f.ui.refresh();
  assert.equal(f.ui.activeRun(), undefined, "an exact canonical run missing from a later successful list must not stay active forever");
  await f.ui.stopActive(); assert.equal(f.calls.some(call => call[0] === "run-control"), false);
  assert.equal(f.ui.pendingStart(), true, "clearing private run state cannot acknowledge an unresolved Start transport");
});

test("an empty list sent before a canonical Start marker arrived cannot fence that newly accepted run", async () => {
  const { f, input } = await startWithUnknownReceipt(); let releaseList;
  f.api.listTeamRuns = () => new Promise(resolve => { releaseList = () => resolve({ runs: [] }); });
  const reading = f.ui.refresh(); await flush();
  f.update({ events: [startedEvent("newer-own-request", "accepted-after-old-list", input.idempotency_key)] });
  releaseList(); await reading; await flush();
  assert.equal(f.ui.activeRun().id, "accepted-after-old-list", "the old empty snapshot predates acceptance evidence");
  f.api.listTeamRuns = async () => ({ runs: [] }); await f.ui.refresh();
  assert.equal(f.ui.activeRun(), undefined, "the next successful list can fence the marker known when it was sent");
});

for (const deletion of ["another device", "this device"]) {
  test(`a delayed Favorite ACK cannot restore a snapshot deleted on ${deletion}`, async () => {
    let releaseFavorite, readsFail = false;
    const f = fixture({ initial: [team()], overrides: {
      listAgentTeams: async () => {
        if (readsFail) throw Object.assign(new Error("Offline library"), { status: 0 });
        return { teams: structuredClone(f.teams), modules: structuredClone(f.favorites) };
      },
      saveTeamModule: async (id, input) => {
        const accepted = { id, module: structuredClone(input.module) }; f.favorites = [accepted];
        return new Promise(resolve => { releaseFavorite = () => resolve({ favorite: accepted, replayed: false }); });
      },
    } });
    await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
    f.button("Favorite").click(); await flush(); await f.ui.refresh();
    if (deletion === "another device") { f.favorites = []; await f.ui.refresh(); }
    else { f.el("team-add-favorite").click(); f.button("Delete", f.document.body.querySelector(".team-secondary-dialog")).click(); await flush(); }
    readsFail = true; releaseFavorite(); await flush();
    assert.equal(f.el("team-module-favorite").textContent, "Favorite", "an accepted but superseded snapshot must not reappear from a delayed creation ACK");
    assert.equal(f.el("team-add-favorite").disabled, true); assert.equal(f.button("Check the previous action").hidden, true);
  });
}

test("a quota-stopped run identifies its frozen module and specific recovery in the row and main notice", async () => {
  const f = fixture({ initial: [team()], initialRuns: [{ ...pausedRun("agent_share_daily_limit"), status: "failed",
    issue: { code: "agent_share_daily_limit", node_id: "node-a", node_label: "原共享研究模块", target_kind: "shared", retry_at: null } }] });
  f.document.documentElement.lang = "zh-CN"; await flush(); f.hostButton.click(); await flush();
  const row = f.document.body.querySelector(".team-run-row");
  assert.match(row.querySelector(".team-run-reason").textContent, /原共享研究模块.*额度已用尽/u);
  assert.match(row.querySelector(".team-run-advice").textContent, /北京时间 08:00/u);
  assert.match(f.ui.runNotice().text, /原共享研究模块/u); assert.equal(f.ui.runNotice().runId, "run-a");
  assert.equal(f.button("Continue", row), undefined); assert.equal(f.button("Resume", row), undefined);
  f.runs = [{ ...pausedRun(null), id: "newer-task", status: "running" }, ...f.runs]; await f.ui.refresh();
  assert.equal(f.ui.runNotice(), null, "a healthy current task must hide an old failed task's notice");
  f.runs = [{ ...pausedRun(null), id: "newer-task", status: "completed" }, ...f.runs]; await f.ui.refresh();
  assert.equal(f.ui.runNotice(), null, "a new successful result must also hide old failure notices");
});

test("running offline diagnostics distinguish missing heartbeat from preflight failure and retain Stop", async () => {
  const f = fixture({ initialRuns: [{ ...pausedRun(null), status: "running", issue: {
    code: "agent_team_runtime_offline", node_id: "node-a", node_label: "执行模块", target_kind: "local", retry_at: null,
  } }] }); f.document.documentElement.lang = "zh-CN"; await flush(); f.hostButton.click(); await flush();
  assert.match(f.ui.runNotice().text, /心跳已中断.*尚无最终结果/u);
  assert.match(f.ui.runNotice().advice, /请勿重复提交.*消耗次数/u);
  assert.doesNotMatch(f.ui.runNotice().text, /执行前|失败/u); assert.ok(f.button("停止")); assert.ok(f.button("暂停"));
});

test("unknown run diagnostics and module names render as literal text without raw provider data", async () => {
  const label = "<img src=x onerror=alert(1)>";
  const f = fixture({ initialRuns: [{ ...pausedRun("private_fixture_code"), status: "failed", issue: {
    code: "private_fixture_code", node_id: "node-a", node_label: label, target_kind: "local", retry_at: null, message: "private provider fixture",
  } }] }); await flush(); f.hostButton.click(); await flush();
  const reason = f.document.body.querySelector(".team-run-reason");
  assert.match(reason.textContent, /<img/u); assert.equal(reason.children.length, 0);
  assert.equal(f.ui.runNotice().code, "unknown"); assert.doesNotMatch(JSON.stringify(f.ui.runNotice()), /private_fixture|private provider/u);
});

test("a connectivity failure exposes its own test module and cause even when task-first listing omitted its cache", async () => {
  const f = fixture({ initial: [team("team-a", { test_status: "failed", test_run_id: "probe-a", test_session_id: "session-probe" })], overrides: {
    getTeamRun: async (session, id) => { f.calls.push(["get-run", session, id]); return { run: {
      ...pausedRun("provider_auth_failed"), id, purpose: "test", status: "failed", issue: {
        code: "provider_auth_failed", node_id: "node-a", node_label: "云端检查模块", target_kind: "cloud", retry_at: null,
      },
    } }; },
  } }); f.document.documentElement.lang = "zh-CN"; await open(f); await flush();
  assert.deepEqual(f.calls.filter(call => call[0] === "get-run"), [["get-run", "session-probe", "probe-a"]]);
  const text = f.document.body.querySelector(".team-execution-actions").querySelector("p").textContent;
  assert.match(text, /云端检查模块.*授权无效/u); assert.match(text, /管理员/u);
  assert.equal(f.ui.runNotice(), null, "hidden test records must not pretend a task failed in the main composer");
});

test("a late failed-test detail cannot write the previous account's module into the new scope", async () => {
  let release;
  const f = fixture({ initial: [team("team-a", { test_status: "failed", test_run_id: "probe-a", test_session_id: "session-a" })], overrides: {
    getTeamRun: () => new Promise(resolve => { release = () => resolve({ run: { ...pausedRun("agent_share_revoked"), id: "probe-a", purpose: "test",
      issue: { code: "agent_share_revoked", node_label: "private former account fixture" } } }); }),
  } }); await open(f); await flush();
  f.teams = []; f.runs = []; f.update({ scope: "bob:project-b:session-b", userId: "bob", projectId: "project-b", sessionId: "session-b" });
  release(); await flush();
  assert.doesNotMatch(f.document.body.querySelector(".team-execution-actions").querySelector("p").textContent, /private former/u);
  assert.equal(f.ui.runNotice(), null);
});

test("a missing connectivity record says diagnostics are unavailable instead of inventing a failure cause", async () => {
  const f = fixture({ initial: [team("team-a", { test_status: "failed", test_run_id: "probe-a", test_session_id: "session-a" })], overrides: {
    getTeamRun: async () => { throw Object.assign(new Error("private fixture detail"), { status: 404 }); },
  } }); f.document.documentElement.lang = "zh-CN"; await open(f); await flush();
  const text = f.document.body.querySelector(".team-execution-actions").querySelector("p").textContent;
  assert.match(text, /详细记录当前不可用.*测试会使用模型和共享额度/u); assert.doesNotMatch(text, /fixture/u);
});

test("run-control conflicts describe task state changes instead of a configuration edit conflict", async () => {
  const f = fixture({ initialRuns: [pausedRun(null)], overrides: { controlTeamRun: async () => {
    throw Object.assign(new Error("private conflicting fixture"), { status: 409, code: "conflict" });
  } } }); f.document.documentElement.lang = "zh-CN"; await flush(); f.hostButton.click(); await flush(); f.button("恢复").click(); await flush();
  const text = f.document.body.querySelector(".form-error").textContent;
  assert.match(text, /任务状态.*刷新运行记录/u); assert.doesNotMatch(text, /配置已|fixture/u);
  assert.equal(f.button("Check the previous action").hidden, true, "a definite rejection is not an unknown acceptance");
});

test("an uncertain mutation says the action is unconfirmed and keeps its exact recovery button", async () => {
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    executeAgentTeam: async () => { throw Object.assign(new Error("raw provider fixture"), { status: 0 }); },
  } }); f.document.documentElement.lang = "zh-CN"; await flush(); f.ui.select("team:team-a");
  await assert.rejects(f.ui.startTask("最小任务")); await flush();
  assert.match(f.document.body.querySelector(".form-error").textContent, /结果尚未确认.*不代表.*执行失败/u);
  assert.equal(f.ui.pendingStart(), true); assert.equal(f.button("Check the previous action").hidden, false);
});

test("an explicitly disabled sharing service reports its module and discards a definitely rejected start", async () => {
  const f = fixture({ initial: [team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 })], overrides: {
    executeAgentTeam: async () => { throw Object.assign(new Error("raw service fixture"), { status: 503, code: "agent_sharing_disabled",
      details: { node_label: "借用模块", raw: "private fixture" } }); },
  } }); f.document.documentElement.lang = "zh-CN"; await flush(); f.ui.select("team:team-a");
  await assert.rejects(f.ui.startTask("最小任务")); await flush();
  const text = f.document.body.querySelector(".form-error").textContent;
  assert.match(text, /借用模块.*未被接受/u); assert.doesNotMatch(text, /fixture|结果尚未确认/u);
  assert.equal(f.ui.pendingStart(), false); assert.equal(f.button("Check the previous action").hidden, true);
});

test("failed status reads show uncertainty without hiding a known active task's controls, then clear after reconnect", async () => {
  const f = fixture({ initialRuns: [{ ...pausedRun(null), status: "running" }] }); f.document.documentElement.lang = "zh-CN"; await flush();
  f.api.listTeamRuns = async () => { throw Object.assign(new Error("private socket fixture"), { status: 0 }); };
  await f.ui.refresh(); f.hostButton.click(); await flush();
  assert.equal(f.ui.runNotice().code, "unconfirmed"); assert.match(f.ui.runNotice().text, /无法确认/u);
  assert.match(f.ui.runNotice().advice, /重连后.*请勿重复提交/u); assert.ok(f.button("停止"));
  f.api.listTeamRuns = async () => ({ runs: [{ ...pausedRun(null), status: "completed" }] }); await f.ui.refresh();
  assert.equal(f.ui.runNotice(), null); assert.equal(f.document.body.querySelector(".team-run-refresh-error"), null);
});

test("a status-read authorization loss clears old private run labels but preserves a nonidentifying notice", async () => {
  const f = fixture({ initialRuns: [{ ...pausedRun("agent_share_revoked"), status: "failed", issue: {
    code: "agent_share_revoked", node_label: "private former access fixture",
  } }] }); await flush(); f.hostButton.click(); await flush();
  f.api.listTeamRuns = async () => { throw Object.assign(new Error("private forbidden fixture"), { status: 403 }); };
  await f.ui.refresh(); assert.equal(f.document.body.querySelector(".team-run-row"), null);
  assert.equal(f.ui.runNotice().code, "unconfirmed"); assert.doesNotMatch(JSON.stringify(f.ui.runNotice()), /fixture/u);
});

test("a user who never started or listed a Team task sees no unsolicited Team failure on a network outage", async () => {
  const f = fixture({ overrides: { listTeamRuns: async () => { throw Object.assign(new Error("offline fixture"), { status: 0 }); } } });
  await flush(); assert.equal(f.ui.runNotice(), null); f.hostButton.click(); await flush();
  assert.equal(f.document.body.querySelector(".team-run-refresh-error"), null);
});

test("run-record navigation preserves dirty editor content and diagnostic copy follows locale changes", async () => {
  const f = fixture({ initial: [team()], initialRuns: [{ ...pausedRun("server_restart") }] }); await open(f);
  editInput(f.el("team-name"), "Unsaved exact name"); f.ui.openRunRecords();
  assert.equal(f.document.body.querySelector(".team-run-records").open, true);
  assert.equal(f.document.body.querySelector(".team-editor").hidden, false); assert.equal(f.el("team-name").value, "Unsaved exact name");
  assert.match(f.ui.runNotice().text, /server restarted/u);
  f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
  assert.match(f.ui.runNotice().text, /服务器已重启/u);
  assert.match(f.document.body.querySelector(".team-run-reason").textContent, /服务器已重启/u);
  assert.equal(f.el("team-name").value, "Unsaved exact name"); assert.equal(f.el("team-save").disabled, false);
});

test("a healthy task on a second device cannot hide another still-active task needing recovery", async () => {
  const f = fixture({ initialRuns: [{ ...pausedRun(null), id: "newer-running", status: "running" },
    { ...pausedRun("server_restart"), id: "older-paused", status: "paused" }] }); await flush();
  assert.equal(f.ui.runNotice().runId, "older-paused");
  f.runs = [{ ...pausedRun(null), id: "newer-running", status: "running" }, { ...pausedRun(null), id: "older-completed", status: "completed" }];
  await f.ui.refresh(); assert.equal(f.ui.runNotice(), null);
  f.runs = [{ ...pausedRun(null), id: "newer-running", status: "running" }, { ...pausedRun(null), id: "older-waiting", status: "running",
    issue: { code: "hosted_user_rate_limit", node_label: "云端模块" } }];
  await f.ui.refresh(); assert.equal(f.ui.runNotice().runId, "older-waiting");
});

for (const change of ["access denied", "content erased"]) {
  for (const action of ["start", "pause"]) {
    test(`a delayed ${action} receipt cannot restore private runs after ${change}, even before first observation`, async () => {
      let release, blocked = false, accepted = 0;
      const original = startedRun("private-pre-fence");
      const enabled = team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 });
      const f = fixture({ initial: [enabled], initialRuns: action === "pause" ? [original] : [], overrides: {
        listTeamRuns: async () => {
          if (blocked) throw Object.assign(new Error("Fixture private read rejected"), { status: change === "access denied" ? 403 : 0 });
          return { runs: structuredClone(f.runs) };
        },
        executeAgentTeam: () => new Promise(resolve => { release = () => resolve({ run: original }); }),
        controlTeamRun: () => new Promise(resolve => { release = () => resolve({ run: { ...original, status: "paused" } }); }),
      } });
      await flush(); f.ui.select("team:team-a");
      const pending = action === "start" ? f.ui.startTask("private fixture task", { onAccepted: () => accepted++ }) : f.ui.controlRun(original, "pause");
      await flush(); blocked = true;
      if (change === "access denied") await f.ui.refresh();
      else f.update({ contentRevision: 1, events: [] });
      release(); await pending; await flush();
      assert.equal(f.ui.activeRun(), undefined, "an accepted old reply cannot restore fenced private data");
      assert.equal(f.document.body.querySelectorAll(".team-run-row").length, 0);
      if (action === "start") { assert.equal(accepted, 1); assert.equal(f.ui.pendingStart(), false); }
      blocked = false; f.runs = [{ ...original, status: "stopped" }]; await f.ui.refresh();
      assert.equal(f.document.body.querySelectorAll(".team-run-row").length, 1, "a later authorized read may expose current safe records again");
    });
  }
}

test("an exact retry alone cannot lift a preceding authoritative access refusal", async () => {
  let tries = 0, denied = false;
  const original = startedRun("old-private-record");
  const f = fixture({ initialRuns: [original], overrides: {
    listTeamRuns: async () => { if (denied) throw Object.assign(Error("denied"), { status: 403 }); return { runs: [original] }; },
    controlTeamRun: async () => { if (++tries === 1) throw Error("lost ACK"); return { run: { ...original, status: "paused" } }; },
  } }); await flush(); await assert.rejects(f.ui.controlRun(original, "pause")); await flush();
  denied = true; await f.ui.refresh(); await f.ui.recover(); await flush();
  assert.equal(tries, 2); assert.equal(f.ui.activeRun(), undefined);
  assert.equal(f.document.body.querySelectorAll(".team-run-row").length, 0);
  denied = false; await f.ui.refresh(); assert.equal(f.ui.activeRun().id, original.id);
});

for (const action of ["Test", "Save"]) {
  test(`a delayed ${action} ACK cannot replace a same-revision passed stamp observed by GET while the next GET is offline`, async () => {
    let release, offline = false;
    const f = fixture({ initial: [team()], overrides: {
      listAgentTeams: async () => { if (offline) throw Error("offline library"); return { teams: structuredClone(f.teams), modules: [] }; },
      executeAgentTeam: () => new Promise(resolve => { release = () => resolve({ run: { ...startedRun("probe-before-pass"), purpose: "test" } }); }),
      saveAgentTeam: async (id, body) => {
        const accepted = team(id, { revision: 2, draft: structuredClone(body.draft) }); f.teams = [accepted];
        return new Promise(resolve => { release = () => resolve({ team: accepted }); });
      },
    } }); await open(f);
    if (action === "Save") editInput(f.el("team-name"), "Saved before a successful remote test");
    f.el(action === "Test" ? "team-test" : "team-save").click(); await flush();
    f.teams = f.teams.map(saved => ({ ...saved, test_status: "passed", tested_revision: saved.revision, test_run_id: "probe-before-pass" }));
    await f.ui.refresh(); offline = true; release(); await flush();
    assert.equal(f.el("team-test").textContent, "Successfully connected"); assert.equal(f.el("team-test").disabled, true);
    assert.equal(f.el("team-enable").disabled, false, "passed metadata survives the delayed receipt even without a successful follow-up GET");
    offline = false; await f.ui.refresh(); assert.equal(f.el("team-test").textContent, "Successfully connected");
  });
}

for (const missing of ["connection", "model", "effort", "cloud revision"]) {
  test(`a missing saved ${missing} remains visibly selected and unavailable without changing the exact target`, async () => {
    const original = team();
    if (missing === "cloud revision") original.draft.nodes[0].target = { kind: "cloud", provider: "fixture", model: "fixture-model", profile_id: "api-a", api_config_revision: "old", include_code: false };
    const f = fixture({ initial: [original] }); await open(f);
    f.document.body.querySelector("[data-node-id='node-a']").click();
    if (missing === "connection") f.update({ runtimes: [] });
    else if (missing === "cloud revision") f.update({ cloudProfiles: [{ id: "api-a", provider: "fixture", model: "fixture-model", api_config_revision: "new", available: true }] });
    else f.update({ runtimes: [{ id: "runtime-a", userId: "alice", deviceId: "device-a", purpose: "execution", harness: "codex", status: "online",
      executionProfiles: [{ provider: "fixture", model: missing === "model" ? "different-model" : "fixture-model", reasoningEfforts: missing === "effort" ? ["low"] : ["high"] }] }] });
    for (const id of missing === "connection" ? ["agent", "model", "reasoning-effort"] : missing === "effort" ? ["reasoning-effort"] : ["model"]) {
      const select = f.el(`team-selection-${id}`), option = select.children.find(item => item.value === select.value);
      assert.ok(option, `${id} keeps its exact saved selection`); assert.equal(option.disabled, true); assert.match(option.textContent, /Unavailable/u);
    }
    assert.equal(f.el("team-save").disabled, true, "catalog changes cannot edit the saved target");
  });
}

test("Team Stop remains available during realtime replay and checks current control authorization", async () => {
  const f = fixture({ initialRuns: [startedRun("http-stoppable")] }); await flush(); f.hostButton.click(); await flush();
  f.update({ writable: false, controlWritable: true });
  assert.equal(f.button("Stop").disabled, false); assert.equal(f.button("Pause").disabled, false);
  f.button("Stop").click(); await flush(); assert.equal(f.calls[0][3].action, "stop");
  f.runs = [startedRun("no-longer-authorized")]; await f.ui.refresh(); f.update({ controlWritable: false });
  assert.equal(f.button("Stop").disabled, true, "current authorization remains distinct from transport replay");
});

test("Pause uses current HTTP control authority while replaying, deduplicates itself and never blocks independent Stop", async () => {
  let releasePause;
  const run = startedRun("replay-pause-stop");
  const f = fixture({ initialRuns: [run], overrides: {
    controlTeamRun: async (session, id, input) => {
      f.calls.push(["run-control", session, id, structuredClone(input)]);
      if (input.action === "pause") return new Promise(resolve => { releasePause = () => resolve({ run: { ...run, status: "paused" } }); });
      f.runs = [{ ...run, status: "stopped" }]; return { run: structuredClone(f.runs[0]) };
    },
  } }); await flush(); f.hostButton.click(); await flush(); f.update({ writable: false, controlWritable: true });
  const pause = f.button("Pause"); assert.equal(pause.disabled, false); pause.click(); pause.click(); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.button("Pause").disabled, true); assert.equal(f.button("Stop").disabled, false);
  f.button("Stop").click(); await flush(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1][3].action, "stop");
  releasePause(); await flush(); assert.equal(f.ui.activeRun(), undefined, "the old Pause receipt cannot undo confirmed Stop");
  f.runs = [{ ...run, status: "paused", error_code: null }]; await f.ui.refresh();
  assert.equal(f.button("Resume").disabled, true, "replay does not authorize a new execution");
  f.update({ controlWritable: false }); assert.equal(f.button("Stop").disabled, true);
  f.runs = [run]; await f.ui.refresh(); assert.equal(f.button("Pause").disabled, true);
});

test("successful exact recovery clears only that dialog error and language changes cannot revive it", async () => {
  let tries = 0;
  const f = fixture({ initialRuns: [startedRun("recover-error")], overrides: {
    controlTeamRun: async () => { if (++tries === 1) throw Error("lost receipt"); return { run: startedRun("recover-error", "paused") }; },
  } }); await flush(); await assert.rejects(f.ui.controlRun(f.ui.activeRun(), "pause")); await flush();
  assert.match(f.document.body.querySelector(".form-error").textContent, /unconfirmed/u);
  await f.ui.recover(); await flush(); assert.equal(f.document.body.querySelector(".form-error").textContent, "");
  f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
  assert.equal(f.document.body.querySelector(".form-error").textContent, "");
});

test("a recovered earlier intent cannot clear a newer unrelated dialog error", async () => {
  let release;
  const f = fixture({ initialRuns: [startedRun("older-control"), startedRun("newer-control")], overrides: {
    controlTeamRun: async (_session, id) => {
      if (id === "older-control") return new Promise(resolve => { release = () => resolve({ run: startedRun(id, "paused") }); });
      throw Object.assign(Error("denied newer action"), { status: 409, code: "agent_team_clarification_required" });
    },
  } }); await flush(); const older = f.ui.controlRun(startedRun("older-control"), "pause"); await flush();
  await assert.rejects(f.ui.controlRun(startedRun("newer-control"), "resume")); const before = f.document.body.querySelector(".form-error").textContent;
  release(); await older; await flush(); assert.equal(f.document.body.querySelector(".form-error").textContent, before);
});

for (const exhausted of ["calls", "time"]) {
  test(`a timed-out task with exhausted ${exhausted} hides Continue, retains Stop and explains starting anew`, async () => {
    const run = { ...pausedRun("agent_timeout"), ...(exhausted === "calls" ? { calls_used: 12 } : { deadline_at: "2020-01-01T00:00:00Z" }) };
    const f = fixture({ initialRuns: [run] }); await flush(); f.hostButton.click(); await flush();
    assert.equal(f.button("Continue"), undefined); assert.ok(f.button("Stop"));
    assert.match(f.document.body.querySelector(".team-run-advice").textContent, /start a new task/u);
    f.runs = [{ ...run, error_code: "user_paused" }]; await f.ui.refresh();
    assert.ok(f.button("Resume"), "ordinary Resume can settle an already completed retained result without a further Agent call");
  });
}

for (const initialStatus of ["not_tested", "failed"]) {
  test(`an unchanged ${initialStatus} GET predating Test acceptance cannot unlock duplicate probes when the next GET fails`, async () => {
    let release, offline = false;
    const f = fixture({ initial: [team("team-a", { test_status: initialStatus, test_run_id: initialStatus === "failed" ? "previous-failed" : undefined })], overrides: {
      listAgentTeams: async () => { if (offline) throw Error("offline"); return { teams: structuredClone(f.teams), modules: [] }; },
      executeAgentTeam: () => new Promise(resolve => { release = () => resolve({ run: { ...startedRun("accepted-new-probe"), purpose: "test" } }); }),
    } }); await open(f); f.el("team-test").click(); await flush(); await f.ui.refresh();
    offline = true; release(); await flush();
    assert.equal(f.el("team-test").disabled, true); assert.equal(f.el("team-test").textContent, "Test running…");
  });
}

for (const action of ["Test", "Save"]) {
  test(`an exact ${action} retry cannot downgrade a passed stamp observed before that retry when GET stays offline`, async () => {
    let tries = 0, offline = false, accepted;
    const f = fixture({ initial: [team()], overrides: {
      listAgentTeams: async () => { if (offline) throw Error("offline"); return { teams: structuredClone(f.teams), modules: [] }; },
      executeAgentTeam: async () => { if (++tries === 1) throw Error("lost ACK"); return { run: { ...startedRun("verified-probe"), purpose: "test", status: "completed" }, replayed: true }; },
      saveAgentTeam: async (id, body) => {
        if (++tries === 1) { accepted = team(id, { revision: 2, draft: structuredClone(body.draft) }); f.teams = [accepted]; throw Error("lost ACK"); }
        return { team: accepted, replayed: true };
      },
    } }); await open(f);
    if (action === "Save") editInput(f.el("team-name"), "Accepted before verified stamp");
    f.el(action === "Test" ? "team-test" : "team-save").click(); await flush();
    f.teams = f.teams.map(saved => ({ ...saved, test_status: "passed", tested_revision: saved.revision, test_run_id: "verified-probe" }));
    await f.ui.refresh(); offline = true; await f.ui.recover(); await flush();
    assert.equal(tries, 2); assert.equal(f.el("team-test").textContent, "Successfully connected"); assert.equal(f.el("team-enable").disabled, false);
    assert.equal(f.el("team-save").disabled, true);
  });
}

function twoNodeTeam() {
  const saved = team(); saved.draft.nodes.push({ ...structuredClone(module), id: "node-b", label: "Researcher", x: 350, y: 60 });
  saved.draft.edges = [{ id: "edge-a-b", source: "node-a", target: "node-b", direction: "one_way" }]; return saved;
}
const graphControl = (f, kind) => kind === "edge" ? f.document.body.querySelector("[data-edge-id='edge-a-b']")
  : f.document.body.querySelector("[data-node-id='node-a']").querySelector(kind === "module" ? ".team-node-drag" : "[data-port='out']");

for (const kind of ["module", "port", "edge"]) {
  test(`a real library revision refresh preserves the focused canvas ${kind} by stable graph identity`, async () => {
    const f = fixture({ initial: [twoNodeTeam()] }); await open(f); const oldControl = graphControl(f, kind); oldControl.focus();
    const remote = structuredClone(f.teams[0]); remote.revision = 2; remote.draft.nodes[0].label = "Renamed remotely";
    f.teams = [remote]; await f.ui.refresh(); const replacement = graphControl(f, kind);
    assert.notEqual(replacement, oldControl, "the production library path really rebuilt the canvas");
    assert.equal(f.document.activeElement, replacement); assert.equal(replacement.isConnected, true);
    assert.equal(f.el("team-save").disabled, true, "loading the remote revision cannot create a local edit");
  });
  test(`remote deletion of a focused canvas ${kind} recovers focus to the viewport through the library refresh`, async () => {
    const f = fixture({ initial: [twoNodeTeam()] }); await open(f); graphControl(f, kind).focus();
    const remote = structuredClone(f.teams[0]); remote.revision = 2;
    if (kind === "edge") remote.draft.edges = [];
    else { remote.draft.nodes = remote.draft.nodes.filter(node => node.id !== "node-a"); remote.draft.entry_node_id = "node-b"; remote.draft.edges = []; }
    f.teams = [remote]; await f.ui.refresh();
    assert.equal(f.document.activeElement, f.document.body.querySelector(".team-canvas-viewport"));
    assert.equal(f.document.activeElement.isConnected, true);
  });
}

test("a remote library revision does not rebuild a dirty graph or overwrite its local inspector or CAS base", async () => {
  const f = fixture({ initial: [twoNodeTeam()] }); await open(f);
  f.document.body.querySelector("[data-node-id='node-a']").click();
  editInput(f.el("team-identity-node-a"), "Unsaved local responsibility");
  const control = graphControl(f, "module"); control.focus();
  const remote = structuredClone(f.teams[0]); remote.revision = 2; remote.draft.nodes[0].role = "Remote responsibility";
  f.teams = [remote]; await f.ui.refresh();
  assert.equal(graphControl(f, "module"), control); assert.equal(f.document.activeElement, control);
  assert.equal(f.el("team-identity-node-a").value, "Unsaved local responsibility");
  f.api.saveAgentTeam = async (_id, body) => {
    assert.equal(body.expected_revision, 1, "a dirty editor cannot adopt a revision it never loaded");
    throw Object.assign(Error("conflict"), { status: 409, code: "conflict" });
  };
  f.el("team-save").click(); await flush();
  assert.equal(f.el("team-identity-node-a").value, "Unsaved local responsibility");
  assert.match(f.document.body.querySelector(".form-error").textContent, /configuration changed/u);
});

test("a delayed Delete ACK cannot remove a recreated higher revision or supersede its newer pending Save", async () => {
  let releaseDelete, releaseSave, offline = false;
  const f = fixture({ initial: [team()], overrides: {
    listAgentTeams: async () => { if (offline) throw Error("offline library"); return { teams: structuredClone(f.teams), modules: [] }; },
    deleteTeamItem: () => new Promise(resolve => { releaseDelete = () => resolve({ deleted: true, replayed: false }); }),
    saveAgentTeam: async (id, body) => {
      const accepted = team(id, { revision: 4, draft: structuredClone(body.draft) }); f.teams = [accepted];
      return new Promise(resolve => { releaseSave = () => resolve({ team: accepted, replayed: false }); });
    },
  } }); await open(f); f.button("Back to Teams").click(); f.button("Delete").click(); await flush();
  f.teams = [team("team-a", { revision: 3, draft: { ...team().draft, name: "Recreated on another device" } })];
  await f.ui.refresh(); f.document.body.querySelector(".team-library-list").children[0].children[0].click();
  editInput(f.el("team-name"), "Edit of the recreated Team"); f.el("team-save").click(); await flush();
  offline = true; releaseDelete(); await flush();
  assert.equal(f.ui.selected(), undefined, "the test has not selected a composer Team");
  assert.ok(f.document.body.querySelector(".team-library-list").children.some(row => row.querySelector("strong")?.textContent === "Recreated on another device"),
    "an old deletion receipt cannot discard a later observed incarnation while refresh is offline");
  releaseSave(); await flush();
  assert.equal(f.el("team-name").value, "Edit of the recreated Team");
  assert.equal(f.el("team-save").disabled, true, "the old deletion cannot supersede the newer Save receipt");
});

test("a newer graph validation error survives localization and recovery of an older uncertain operation", async () => {
  let attempts = 0;
  const f = fixture({ initial: [twoNodeTeam()], initialRuns: [startedRun("validation-order")], overrides: {
    controlTeamRun: async () => { if (++attempts === 1) throw Error("lost ACK"); return { run: startedRun("validation-order", "paused") }; },
  } }); await open(f); await assert.rejects(f.ui.controlRun(f.ui.activeRun(), "pause")); await flush();
  f.document.body.querySelector("[data-edge-id='edge-a-b']").click();
  const source = f.el("team-selection-source"); source.value = "node-b"; source.dispatch("change");
  assert.match(f.document.body.querySelector(".form-error").textContent, /route already exists/u);
  f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
  assert.match(f.document.body.querySelector(".form-error").textContent, /连线|起点|终点|线路/u);
  assert.doesNotMatch(f.document.body.querySelector(".form-error").textContent, /未确认/u);
  await f.ui.recover(); await flush();
  assert.notEqual(f.document.body.querySelector(".form-error").textContent, "", "an older recovery cannot clear the newer local validation");
});

for (const removal of ["Unfavorite", "Delete"]) for (const replacement of ["different snapshot", "identical snapshot"]) {
  test(`a delayed ${removal} receipt cannot remove a canonically observed recreated favorite with an ${replacement}`, async () => {
    let releaseDelete, offline = false;
    const original = { id: "favorite-recreated", created_at: "2026-10-20T00:00:00.000Z", module: structuredClone(module) };
    const f = fixture({ initial: [team()], modules: [original], overrides: {
      listAgentTeams: async () => { if (offline) throw Error("offline library"); return { teams: structuredClone(f.teams), modules: structuredClone(f.favorites) }; },
      deleteTeamItem: () => new Promise(resolve => { releaseDelete = () => resolve({ deleted: true, replayed: false }); }),
    } }); await open(f); f.document.body.querySelector("[data-node-id='node-a']").click();
    if (removal === "Delete") { f.el("team-add-favorite").click(); f.button("Delete", f.document.body.querySelector(".team-secondary-dialog")).click(); }
    else f.button("Unfavorite").click();
    await flush();
    const recreated = structuredClone(original);
    if (replacement === "different snapshot") recreated.module.label = "A recreated saved module";
    f.favorites = [recreated]; await f.ui.refresh();
    offline = true; releaseDelete(); await flush();
    if (removal !== "Delete") f.el("team-add-favorite").click();
    const labels = f.document.body.querySelector(".team-secondary-dialog").querySelectorAll(".team-row-edit").map(node => node.textContent);
    assert.deepEqual(labels, [recreated.module.label], "created_at can be identical within one clock tick; the next canonical GET must decide deletion");
    offline = false; f.favorites = []; await f.ui.refresh();
    assert.equal(f.el("team-add-favorite").disabled, true, "a later readable snapshot can confirm that no favorite remains");
  });
}

test("a delayed original favorite creation and deletion receipt cannot roll a recreated snapshot back to its old contents", async () => {
  let releaseCreation, releaseDelete, offline = false;
  const f = fixture({ initial: [team()], overrides: {
    listAgentTeams: async () => { if (offline) throw Error("offline library"); return { teams: structuredClone(f.teams), modules: structuredClone(f.favorites) }; },
    saveTeamModule: async (id, body) => {
      const accepted = { id, created_at: "2026-10-20T00:00:00.000Z", module: structuredClone(body.module) }; f.favorites = [accepted];
      return new Promise(resolve => { releaseCreation = () => resolve({ favorite: accepted, replayed: false }); });
    },
    deleteTeamItem: () => new Promise(resolve => { releaseDelete = () => resolve({ deleted: true, replayed: false }); }),
  } }); await open(f); f.document.body.querySelector("[data-node-id='node-a']").click(); f.button("Favorite").click(); await flush();
  await f.ui.refresh(); f.el("team-add-favorite").click(); f.button("Delete", f.document.body.querySelector(".team-secondary-dialog")).click(); await flush();
  const recreated = { ...f.favorites[0], module: { ...structuredClone(module), label: "The new canonical template" } };
  f.favorites = [recreated]; await f.ui.refresh(); offline = true;
  releaseDelete(); await flush(); releaseCreation(); await flush();
  const labels = f.document.body.querySelector(".team-secondary-dialog").querySelectorAll(".team-row-edit").map(node => node.textContent);
  assert.deepEqual(labels, [recreated.module.label]);
  assert.equal(f.button("Check the previous action").hidden, true, "both original receipts settle without dispatching replacement writes");
});

test("canonical favorite refresh updates an open picker and preserves a visible keyboard target", async () => {
  const first = { id: "favorite-a", module: structuredClone(module) }, second = { id: "favorite-b", module: { ...structuredClone(module), label: "Second template" } };
  const f = fixture({ initial: [team()], modules: [first, second] }); await open(f); f.el("team-add-favorite").click();
  const secondary = f.document.body.querySelector(".team-secondary-dialog");
  let remove = secondary.querySelectorAll("[data-team-favorite-control]").find(node => node.dataset.teamFavoriteControl === "delete:favorite-b"); remove.focus();
  f.favorites = [first, { ...second, module: { ...second.module, label: "Renamed saved template" } }]; await f.ui.refresh();
  const replacement = secondary.querySelectorAll("[data-team-favorite-control]").find(node => node.dataset.teamFavoriteControl === "delete:favorite-b");
  assert.notEqual(replacement, remove); assert.equal(f.document.activeElement, replacement);
  assert.match(secondary.textContent + secondary.querySelectorAll(".team-row-edit").map(node => node.textContent).join(" "), /Renamed saved template/u);
  remove = replacement; f.favorites = [first]; await f.ui.refresh();
  assert.equal(remove.isConnected, false); assert.equal(f.document.activeElement, secondary.querySelector("header").querySelector("button"));
});

test("an exact favorite-deletion retry retains its canonical observation fence when the library becomes unavailable", async () => {
  let attempts = 0, offline = false;
  const original = { id: "favorite-same-tick", created_at: "2026-10-20T00:00:00.000Z", module: structuredClone(module) };
  const f = fixture({ initial: [team()], modules: [original], overrides: {
    listAgentTeams: async () => { if (offline) throw Error("offline library"); return { teams: structuredClone(f.teams), modules: structuredClone(f.favorites) }; },
    deleteTeamItem: async () => { if (++attempts === 1) throw Error("lost deletion ACK"); return { deleted: true, replayed: true }; },
  } }); await open(f); f.document.body.querySelector("[data-node-id='node-a']").click(); f.button("Unfavorite").click(); await flush();
  f.favorites = [{ ...original, module: { ...original.module, label: "Recreated between retries" } }]; await f.ui.refresh();
  offline = true; await f.ui.recover(); await flush(); f.el("team-add-favorite").click();
  const labels = f.document.body.querySelector(".team-secondary-dialog").querySelectorAll(".team-row-edit").map(node => node.textContent);
  assert.deepEqual(labels, ["Recreated between retries"]); assert.equal(attempts, 2);
});

test("a picker opened while Unfavorite is pending cannot retain the deleted snapshot after the ACK", async () => {
  let releaseDelete;
  const f = fixture({ initial: [team()], modules: [{ id: "favorite-pending", module: structuredClone(module) }], overrides: {
    deleteTeamItem: () => new Promise(resolve => { releaseDelete = () => { f.favorites = []; resolve({ deleted: true, replayed: false }); }; }),
  } }); await open(f); f.document.body.querySelector("[data-node-id='node-a']").click(); f.button("Unfavorite").click(); await flush();
  f.el("team-add-favorite").click(); const secondary = f.document.body.querySelector(".team-secondary-dialog");
  assert.equal(secondary.querySelectorAll(".team-row-edit").length, 1); releaseDelete(); await flush();
  assert.equal(secondary.querySelectorAll(".team-row-edit").length, 0, "both the ACK and an equal later GET must not leave an insertable deleted module");
  assert.equal(secondary.open, true, "updating its content must not close or reopen the user's current dialog");
});

async function delayedDiagnosticAction(action) {
  let resolve, reject, response, reads = "allowed", attempts = 0, publicError, accepted = 0;
  const initial = twoNodeTeam();
  if (action !== "Test") Object.assign(initial, { test_status: "passed", tested_revision: initial.revision, enabled: action === "Start" });
  const run = startedRun("diagnostic-old-view"), hold = value => { response = value; return new Promise((yes, no) => { resolve = yes; reject = no; }); };
  const f = fixture({ initial: [initial], initialRuns: ["Control", "Recovery"].includes(action) ? [run] : [], overrides: {
    listTeamRuns: async () => {
      if (reads === "denied") throw Object.assign(Error("access denied"), { status: 403, code: "forbidden" });
      if (reads === "offline") throw Error("network offline");
      return { runs: structuredClone(f.runs) };
    },
    executeAgentTeam: async (_session, id, _input, testing) => hold({ run: { ...run, definition_id: id, purpose: testing ? "test" : "task" } }),
    saveAgentTeam: async (id, body) => hold({ team: team(id, { revision: 2, draft: structuredClone(body.draft) }) }),
    controlAgentTeam: async (_session, id, body) => hold({ team: { ...structuredClone(initial), id, revision: 2, enabled: body.enabled, tested_revision: 2 } }),
    controlTeamRun: async () => {
      if (action === "Recovery" && ++attempts === 1) throw Error("the first receipt was lost");
      return hold({ run: { ...run, status: "paused" } });
    },
  } }); await open(f);
  let pending;
  if (action === "Start") { f.ui.select("team:team-a"); pending = f.ui.startTask("The original task", { onAccepted: () => accepted++ }).catch(error => { publicError = error; }); }
  else if (action === "Control") pending = f.ui.controlRun(run, "pause").catch(error => { publicError = error; });
  else if (action === "Recovery") { await assert.rejects(f.ui.controlRun(run, "pause")); await flush(); pending = f.ui.recover(); }
  else {
    if (action === "Save") editInput(f.el("team-name"), "Saved in the original view");
    f.el(action === "Test" ? "team-test" : action === "Save" ? "team-save" : "team-enable").click();
  }
  await flush(); assert.ok(resolve, `${action} reached its actual API boundary`);
  return { f, get publicError() { return publicError; }, accepted: () => accepted,
    async invalidate(boundary) {
      if (boundary === "access denied") { reads = "denied"; await f.ui.refresh(); }
      else if (boundary === "history changed") { reads = "offline"; f.update({ contentRevision: 1, events: [] }); }
      else {
        f.teams = [twoNodeTeam()]; f.runs = [];
        f.update({ scope: "another-account:project-b:session-b", userId: "another-account", projectId: "project-b", sessionId: "session-b" });
        await open(f);
      }
      // This validation belongs to the current visible editor. An old outcome
      // must not replace it, even through an outer click-handler catch or locale refresh.
      f.document.body.querySelector("[data-edge-id='edge-a-b']").click();
      const source = f.el("team-selection-source"); source.value = "node-b"; source.dispatch("change");
      assert.match(f.document.body.querySelector(".form-error").textContent, /route already exists/u);
    },
    async settle(outcome) {
      if (outcome === "success") resolve(response);
      else reject(Object.assign(Error("SYNTHETIC_PRIVATE_EXCEPTION"), { status: 409, code: "agent_team_target_unavailable",
        details: { node_id: "node-a", node_label: "OLD_PRIVATE_MODULE_DIAGNOSTIC", target_kind: "local" } }));
      await pending; await flush();
    },
  };
}

for (const action of ["Start", "Test", "Save", "Enable", "Control", "Recovery"]) {
  for (const boundary of ["access denied", "history changed", "scope changed"]) for (const outcome of ["success", "failure"]) {
    test(`a delayed ${action} ${outcome} after ${boundary} cannot replace the current validation or disclose an old diagnostic`, async () => {
      const scenario = await delayedDiagnosticAction(action), { f } = scenario;
      await scenario.invalidate(boundary); await scenario.settle(outcome);
      const message = f.document.body.querySelector(".form-error");
      assert.match(message.textContent, /route already exists/u);
      assert.doesNotMatch(message.textContent, /OLD_PRIVATE_MODULE_DIAGNOSTIC|SYNTHETIC_PRIVATE_EXCEPTION/u);
      f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
      assert.match(message.textContent, /连线|起点|终点|线路/u);
      assert.doesNotMatch(message.textContent, /OLD_PRIVATE_MODULE_DIAGNOSTIC|SYNTHETIC_PRIVATE_EXCEPTION/u);
      if (outcome === "failure" && ["Start", "Control"].includes(action) && boundary !== "scope changed") {
        assert.ok(scenario.publicError, "the original caller receives a settled public failure");
        assert.equal(scenario.publicError.details, undefined);
        assert.equal(f.ui.isObsoleteError(scenario.publicError), true);
        assert.equal(scenario.publicError.code, boundary === "history changed" ? "context_changed" : "forbidden");
      }
      if (action === "Start") {
        assert.equal(f.ui.pendingStart(), false, "a definite original rejection or accepted receipt retires its intent");
        assert.equal(scenario.accepted(), outcome === "success" && boundary !== "scope changed" ? 1 : 0);
      }
    });
  }
}

test("invalidating history also clears a previously rendered private action diagnostic before language refresh", async () => {
  const f = fixture({ initialRuns: [startedRun("cached-private-error")], overrides: {
    controlTeamRun: async () => { throw Object.assign(Error("PRIVATE_EXCEPTION"), { status: 409, code: "agent_team_target_unavailable",
      details: { node_label: "PREVIOUS_PRIVATE_LABEL", node_id: "node-a", target_kind: "local" } }); },
  } }); await flush(); await assert.rejects(f.ui.controlRun(f.ui.activeRun(), "pause")); await flush();
  assert.match(f.document.body.querySelector(".form-error").textContent, /PREVIOUS_PRIVATE_LABEL/u);
  f.update({ contentRevision: 1, events: [] }); f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
  assert.doesNotMatch(f.document.body.querySelector(".form-error").textContent, /PREVIOUS_PRIVATE_LABEL/u);
});

for (const boundary of ["access denied", "history changed", "scope changed"]) {
  test(`a previously returned action problem becomes obsolete after ${boundary} and cannot be described again`, async () => {
    let denied = false, problem;
    const f = fixture({ initialRuns: [startedRun("returned-private-error")], overrides: {
      listTeamRuns: async () => { if (denied) throw Object.assign(Error("denied"), { status: 403, code: "forbidden" }); return { runs: structuredClone(f.runs) }; },
      controlTeamRun: async () => { throw Object.assign(Error("PRIVATE_PROVIDER_DETAIL"), { status: 409, code: "agent_team_target_unavailable",
        details: { node_id: "node-a", node_label: "RETURNED_PRIVATE_MODULE", target_kind: "local" } }); },
    } }); await flush();
    await assert.rejects(f.ui.controlRun(f.ui.activeRun(), "pause"), error => { problem = error; return true; });
    assert.equal(f.ui.isObsoleteError(problem), false); assert.match(f.ui.describeError(problem, "run"), /RETURNED_PRIVATE_MODULE/u);
    if (boundary === "access denied") { denied = true; await f.ui.refresh(); }
    else if (boundary === "history changed") f.update({ contentRevision: 1, events: [] });
    else f.update({ scope: "bob:project-b:session-b", userId: "bob", projectId: "project-b", sessionId: "session-b" });
    f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
    assert.equal(f.ui.isObsoleteError(problem), true, "the actual error already returned to main retains its original diagnostic fence");
    assert.equal(f.ui.describeError(problem, "run"), "");
    assert.doesNotMatch(f.document.body.querySelector(".form-error").textContent, /RETURNED_PRIVATE_MODULE|PRIVATE_PROVIDER_DETAIL/u);
  });
}

test("the current action's own permission rejection remains visible instead of being mistaken for an obsolete error", async () => {
  let problem;
  const f = fixture({ initialRuns: [startedRun("current-forbidden")], overrides: {
    controlTeamRun: async () => { throw Object.assign(Error("PRIVATE_FORBIDDEN_EXCEPTION"), { status: 403, code: "forbidden" }); },
  } }); await flush();
  await assert.rejects(f.ui.controlRun(f.ui.activeRun(), "pause"), error => { problem = error; return true; }); await flush();
  assert.equal(f.ui.isObsoleteError(problem), false);
  assert.match(f.ui.describeError(problem, "run"), /permissions/u);
  assert.match(f.document.body.querySelector(".form-error").textContent, /permissions/u);
  assert.doesNotMatch(f.document.body.querySelector(".form-error").textContent, /PRIVATE_FORBIDDEN_EXCEPTION/u);
});

test("a late unknown Start outcome keeps its frozen recovery key even when its diagnostic is obsolete", async () => {
  let reject, problem, accepted = 0;
  const initial = twoNodeTeam(); Object.assign(initial, { enabled: true, test_status: "passed", tested_revision: initial.revision });
  const f = fixture({ initial: [initial], overrides: {
    executeAgentTeam: async (session, id, input) => {
      f.calls.push(["execute", session, id, structuredClone(input)]);
      if (f.calls.length === 1) return new Promise((_resolve, no) => { reject = no; });
      throw Object.assign(Error("The old context no longer exists"), { status: 409, code: "context_changed" });
    },
  } }); await open(f); f.ui.select("team:team-a");
  const starting = f.ui.startTask("A frozen request", { onAccepted: () => accepted++ }).catch(error => { problem = error; }); await flush();
  f.update({ contentRevision: 1, events: [] });
  f.document.body.querySelector("[data-edge-id='edge-a-b']").click();
  const source = f.el("team-selection-source"); source.value = "node-b"; source.dispatch("change");
  reject(Object.assign(Error("PRIVATE_NETWORK_EXCEPTION"), { status: 0, code: "request_timeout" })); await starting; await flush();
  assert.equal(f.ui.isObsoleteError(problem), true); assert.equal(problem.details, undefined);
  assert.equal(f.ui.pendingStart(), true, "a neutral public 409 must not incorrectly settle the original unknown transport outcome");
  assert.match(f.document.body.querySelector(".form-error").textContent, /route already exists/u);
  await f.ui.recover(); await flush();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1], f.calls[0], "recovery sends only the original accepted-or-unknown intent and key");
  assert.equal(f.ui.pendingStart(), false, "the exact-key recovery's definite rejection settles the original intent"); assert.equal(accepted, 0);
  assert.match(f.document.body.querySelector(".form-error").textContent, /route already exists/u);
});

const composerMainSource = (await readFile(new URL("../src/main.js", import.meta.url), "utf8")).replace(/\r\n?/gu, "\n");
function composerFunctionSource(name) {
  const start = composerMainSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "m")); assert.notEqual(start, -1, name);
  const tail = composerMainSource.slice(start), end = tail.indexOf("\n}\n") + 2; assert.ok(end > 1, name); return tail.slice(0, end);
}

for (const boundary of ["access denied", "history changed"]) for (const foreground of ["original draft", "new validation"]) {
  test(`the real composer and mounted Team UI reject a delayed private failure after ${boundary} while preserving ${foreground}`, async () => {
    let reject, denied = false, sent = 0, executeCalls = 0;
    const initial = team("team-a", { enabled: true, test_status: "passed", tested_revision: 1 });
    const f = fixture({ initial: [initial], overrides: {
      listTeamRuns: async () => { if (denied) throw Object.assign(Error("access denied"), { status: 403, code: "forbidden" }); return { runs: [] }; },
      executeAgentTeam: async () => { executeCalls++; return new Promise((_resolve, no) => { reject = no; }); },
    } }); await open(f); f.ui.select("team:team-a");
    // Composer nodes are separate from the mounted Team dialog, as in main.
    const node = () => ({ value: "", textContent: "", disabled: false, childNodes: [], focus() {}, replaceChildren(...children) { this.childNodes = children; } });
    const raw = "An original Team request", app = vm.createContext({
      authenticationGeneration: 1, selectedSessionGeneration: 1,
      state: { currentUser: { id: "alice" }, project: { id: "project-a" }, session: { id: "session-a", mode: "multi" },
        settings: { composer: { confirmAgentRequest: false } }, sync: { contentRevision: 0 } },
      messageInput: { ...node(), value: raw }, sendAgentButton: node(), sendChatButton: node(), sendError: node(),
      pendingMessageSend: null, currentProjectHarness: () => "team", agentRequestControl: { action: () => "request" },
      createIdempotencyKey: () => "composer-key", renderComposerPermissions() {}, localizer: { t: value => value }, window: { confirm: () => true },
      api: { appendAgentRequest() { assert.fail("A Team task cannot bypass its service"); } },
      messageActions: { metadata: () => ({ replyTo: null, mentions: [] }), sent() { sent++; } }, teamsUi: f.ui,
    });
    vm.runInContext(["captureWorkspaceScope", "sendMessage"].map(composerFunctionSource).join("\n"), app);
    const sending = app.sendMessage("agent_request"); await flush(); assert.equal(executeCalls, 1); assert.equal(typeof reject, "function");
    if (boundary === "access denied") { denied = true; await f.ui.refresh(); }
    else { app.state.sync.contentRevision = 1; f.update({ contentRevision: 1, events: [] }); }
    let expected = "";
    if (foreground === "new validation") { app.messageInput.value = ""; await app.sendMessage("agent_request"); expected = "Write a message first."; app.messageInput.value = "A newer draft"; }
    const draft = app.messageInput.value;
    reject(Object.assign(Error("PRIVATE_PROVIDER_EXCEPTION"), { status: 409, code: "agent_team_target_unavailable",
      details: { node_id: "node-a", node_label: "LATE_COMPOSER_PRIVATE_LABEL", target_kind: "local" } }));
    await sending; await flush();
    assert.equal(app.sendError.textContent, expected); assert.equal(app.messageInput.value, draft); assert.equal(sent, 0);
    assert.equal(f.ui.pendingStart(), false, "the real rejected intent is settled despite suppressing its obsolete diagnostic");
    assert.equal(app.pendingMessageSend, null); assert.equal(executeCalls, 1);
    f.document.documentElement.lang = "zh-CN"; f.ui.refreshLanguage();
    assert.doesNotMatch(app.sendError.textContent + f.document.body.querySelector(".form-error").textContent, /LATE_COMPOSER_PRIVATE_LABEL|PRIVATE_PROVIDER_EXCEPTION/u);
  });
}
