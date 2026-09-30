import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/cloud-github-view.js", import.meta.url), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const task = (id = "private-task") => ({ id, session_id: "s1", profile_id: "coding", resumable: true,
  repository: "owner/private", state: "completed", revision: "reviewed", answer: "Private answer",
  pull_request_url: null, changes: [{ path: "index.ts", before_base64: "MQ==", after_base64: "Mg==",
    before_executable: false, after_executable: false }] });

function element() {
  const listeners = new Map();
  return { value: "", textContent: "", hidden: false, disabled: false, open: false, children: [], options: [],
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatchEvent(event) { return listeners.get(event.type)?.(event); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    removeAttribute(name) { delete this[name]; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; } };
}

function fixture(overrides = {}) {
  const nodes = new Map();
  const el = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  let context = { userId: "u1", projectId: "p1", sessionId: "s1" };
  const api = { getHostedGithubStatus: async () => ({ enabled: true, connected: true, login: "owner",
      installation_url: "https://github.com/apps/fixture/installations/new",
      binding: { repository: "owner/private", base_branch: "main" } }),
    listHostedGithubTasks: async () => ({ tasks: [task()] }), getHostedGithubTask: async () => task(), ...overrides };
  const sandbox = vm.createContext({ Event, URL, URLSearchParams, TextDecoder, Uint8Array, atob,
    document: { getElementById: el, createElement: element },
    window: { addEventListener() {} }, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(source.replace("export function mountCloudGithub", "function mountCloudGithub"), sandbox);
  const view = sandbox.mountCloudGithub({ api: () => api, context: () => context, t: (value) => value });
  view.updateContext();
  return { view, el, setContext: (next) => { context = next; view.updateContext(); } };
}

test("switching accounts clears private task previews and ignores an old PR response", async () => {
  const response = deferred();
  const ui = fixture({ publishHostedGithub: () => response.promise });
  await ui.view.openTask("private-task");
  assert.equal(ui.el("cloud-github-answer").textContent, "Private answer");
  ui.el("cloud-github-pr-form").dispatchEvent({ type: "submit", preventDefault() {} });
  ui.setContext({ userId: "u2", projectId: "p2", sessionId: "s2" });
  response.resolve({ ...task(), pull_request_url: "https://github.com/owner/private/pull/1" });
  await settle();
  for (const id of ["cloud-github-status", "cloud-github-task-status", "cloud-github-answer"])
    assert.equal(ui.el(id).textContent, "");
  assert.equal(ui.el("cloud-github-changes").children.length, 0);
  assert.equal(ui.el("cloud-github-pr-link").href, undefined);
  assert.equal(ui.el("cloud-github-pr-link").hidden, true);
  assert.equal(ui.el("cloud-github-pr-body").value, "");
  assert.equal(ui.el("cloud-github-repository").value, "");
  assert.equal(ui.el("cloud-github-dialog").open, false);
});

test("a request finishing in an old session cannot replace a newer continuation draft", async () => {
  const response = deferred();
  const ui = fixture({ startHostedGithubTask: () => response.promise });
  const pending = ui.view.start("s1", { content: "Edit", profileId: "coding", idempotencyKey: "request" });
  ui.setContext({ userId: "u1", projectId: "p1", sessionId: "s2" });
  ui.el("cloud-github-parent").value = "new-task";
  ui.el("cloud-github-selected").textContent = "New draft";
  response.resolve(task()); await pending;
  assert.equal(ui.el("cloud-github-parent").value, "new-task");
  assert.equal(ui.el("cloud-github-selected").textContent, "New draft");
});

test("refresh preserves repository and PR edits; task buttons select the cloud repository route", async () => {
  const ui = fixture();
  await ui.view.openTask("private-task");
  ui.el("cloud-github-repository").value = "owner/new-draft";
  ui.el("cloud-github-pr-title").value = "My reviewed title";
  ui.el("cloud-github-pr-body").value = "My reviewed description";
  ui.el("cloud-github-refresh").dispatchEvent({ type: "click" }); await settle();
  assert.equal(ui.el("cloud-github-repository").value, "owner/new-draft");
  assert.equal(ui.el("cloud-github-pr-title").value, "My reviewed title");
  assert.equal(ui.el("cloud-github-pr-body").value, "My reviewed description");
  ui.el("agent-cloud-model-select").options = [{ value: "coding" }];
  let routeChanges = 0;
  ui.el("cloud-agent-source").addEventListener("change", () => routeChanges++);
  ui.el("cloud-github-continue").dispatchEvent({ type: "click" });
  assert.equal(ui.el("agent-harness-select").value, "cloud");
  assert.equal(ui.el("agent-cloud-model-select").value, "coding");
  assert.equal(ui.el("cloud-agent-source").value, "github");
  assert.equal(ui.el("cloud-github-parent").value, "private-task");
  assert.equal(routeChanges, 1);
  ui.el("cloud-github-new").dispatchEvent({ type: "click" });
  assert.equal(ui.el("cloud-github-parent").value, "");
  assert.equal(routeChanges, 2);
  assert.equal(ui.el("cloud-github-dialog").open, false);
  assert.equal(ui.el("message-input").focused, true);
});
