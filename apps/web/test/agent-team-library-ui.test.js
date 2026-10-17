import assert from "node:assert/strict";
import test from "node:test";
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
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, callback, options = false) {
    const listeners = this.listeners.get(type) ?? []; listeners.push({ callback, capture: options === true || options?.capture === true }); this.listeners.set(type, listeners);
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const value = part.trim();
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
  focus() { this.ownerDocument.activeElement = this; }
  reportValidity() { return (!this.required || this.value !== "") && (this.type !== "number" || Number.isFinite(Number(this.value))
    && Number(this.value) >= Number(this.min) && Number(this.value) <= Number(this.max)); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
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
    get favorites() { return favorites; }, update(value) { context = { ...context, ...value }; ui.updateContext(); },
    button(text, root = document.body) { return root.querySelectorAll("button").find(node => node.textContent === text); } };
}

async function open(f, index = 0) { await flush(); f.hostButton.click(); await flush(); f.document.body.querySelector(".team-library-list").children[index].children[0].click(); }

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
const clarificationHint = "请先在当前会话发送 chat 说明如何处理，再点击“澄清后继续”。如需修改身份、提示词或连线，请停止后修改、重测并启动新任务。";

test("an instruction conflict shows a Chinese clarification state and resumes only through the explicit resume action", async () => {
  const f = fixture({ initial: [team()], initialRuns: [pausedRun("agent_team_instruction_conflict")] });
  f.document.documentElement.lang = "zh-CN"; await flush(); f.hostButton.click(); await flush();
  const row = f.document.body.querySelector(".team-run-row");
  assert.match(row.children[0].textContent, /等待澄清/u); assert.equal(row.children[1].textContent, clarificationHint);
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
    const row = f.document.body.querySelector(".team-run-row"); assert.equal(row.children.length, 2);
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
