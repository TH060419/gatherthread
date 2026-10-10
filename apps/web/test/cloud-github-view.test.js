import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { translateUiText } from "../src/i18n.js";
import { fillRepositoryFields, bindRepositoryFields } from "../src/github-setup.js";

const source = (await readFile(new URL("../src/cloud-github-view.js", import.meta.url), "utf8")).replace(/^import .*\n/gmu, "");
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
  const attributes = new Map();
  return { value: "", textContent: "", hidden: false, disabled: false, open: false, children: [], options: [],
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatchEvent(event) { return listeners.get(event.type)?.(event); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    replaceChildren(...children) { this.children = children; },
    removeAttribute(name) { delete this[name]; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; } };
}

function fixture(overrides = {}, { agentEnabled = true, locale = "en" } = {}) {
  const nodes = new Map();
  const el = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  let context = { userId: "u1", projectId: "p1", sessionId: "s1" };
  const api = { getHostedGithubStatus: async () => ({ enabled: true, connected: true, login: "owner",
      installation_url: "https://github.com/apps/fixture/installations/new",
      binding: { repository: "owner/private", base_branch: "main" } }),
    listHostedGithubTasks: async () => ({ tasks: [task()] }), getHostedGithubTask: async () => task(), ...overrides };
  const sandbox = vm.createContext({ Event, URL, URLSearchParams, TextDecoder, Uint8Array, atob, fillRepositoryFields, bindRepositoryFields,
    document: { getElementById: el, createElement: element, createTextNode: (textContent) => ({ textContent }) },
    window: { addEventListener() {} }, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(source.replace("export function mountCloudGithub", "function mountCloudGithub"), sandbox);
  const view = sandbox.mountCloudGithub({ api: () => api, context: () => context, t: (value) => translateUiText(value, locale),
    agentEnabled, openSurface: () => el("project-code-dialog").showModal() });
  view.updateContext();
  return { view, el, setContext: (next) => { context = next; view.updateContext(); } };
}

test("raw answers, source and paths are excluded from automatic UI translation", async () => {
  const detail = { ...task(), answer: "failed", changes: [{ path: "Ready", before_base64: btoa("Settings"),
    after_base64: btoa("Ready"), before_executable: false, after_executable: true }] };
  const ui = fixture({ getHostedGithubTask: async () => detail }, { locale: "zh-CN" });
  await ui.view.openTask(detail.id);
  assert.equal(ui.el("cloud-github-answer").getAttribute("data-i18n-skip"), "");
  assert.equal(ui.el("cloud-github-answer").textContent, "failed");
  const [summary, beforeLabel, before, afterLabel, after] = ui.el("cloud-github-changes").children[0].children;
  assert.equal(summary.children[0].getAttribute("data-i18n-skip"), "");
  assert.equal(summary.children[0].textContent, "Ready");
  assert.equal(before.getAttribute("data-i18n-skip"), ""); assert.equal(before.textContent, "Settings");
  assert.equal(after.getAttribute("data-i18n-skip"), ""); assert.equal(after.textContent, "Ready");
  assert.equal(beforeLabel.textContent, "更改前"); assert.equal(afterLabel.textContent, "更改后");
});

test("setup shows one page at a time and splits the GitHub account from repository name", async () => {
  let status = { enabled: true, connected: false, installation_url: "https://github.com/apps/fixture/installations/new" };
  const ui = fixture({ getHostedGithubStatus: async () => status, listHostedGithubTasks: async () => ({ tasks: [] }) });
  await ui.view.refresh();
  assert.equal(ui.el("github-cloud-account").hidden, false);
  assert.equal(ui.el("cloud-github-repository-form").hidden, true);
  assert.equal(ui.el("github-cloud-home").hidden, true);
  status = { ...status, connected: true, login: "owner" }; await ui.view.refresh();
  assert.equal(ui.el("github-cloud-account").hidden, true);
  assert.equal(ui.el("cloud-github-repository-form").hidden, false);
  assert.equal(ui.el("cloud-github-owner").value, "owner");
  status = { ...status, binding: { repository: "owner/project", base_branch: "main" } }; await ui.view.refresh();
  assert.equal(ui.el("github-cloud-home").hidden, false);
  assert.equal(ui.el("cloud-github-repository-form").hidden, true);
  ui.el("cloud-github-edit").dispatchEvent({ type: "click" });
  assert.equal(ui.el("cloud-github-owner").value, "owner");
  assert.equal(ui.el("cloud-github-name").value, "project");
  assert.equal(ui.el("github-cloud-home").hidden, true);
});

test("public GitHub failures are localized immediately without translating user content", async () => {
  const message = "GitHub access is unavailable. Reconnect and check repository permissions.";
  for (const [locale, expected] of [["en", message], ["zh-CN", "GitHub 访问不可用，请重新连接并检查仓库权限。"]]) {
    const ui = fixture({ getHostedGithubStatus: async () => { throw new Error(message); } }, { locale });
    await ui.view.refresh(); assert.equal(ui.el("cloud-github-error").textContent, expected);
  }
});

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
  assert.equal(ui.el("project-code-dialog").open, false);
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
  assert.equal(ui.el("project-code-dialog").open, false);
  assert.equal(ui.el("message-input").focused, true);
});

test("closed cloud Agent entry preserves GitHub binding and review but refuses new runs", async () => {
  let bindings = 0, runs = 0;
  const ui = fixture({ bindHostedGithub: async () => { bindings++; },
    startHostedGithubTask: async () => { runs++; return task(); } }, { agentEnabled: false });
  await ui.view.openTask("private-task");
  assert.equal(ui.el("project-code-dialog").open, true);
  assert.equal(ui.el("cloud-github-controls").hidden, false);
  assert.equal(ui.el("cloud-github-repository-form").hidden, true);
  ui.el("cloud-github-edit").dispatchEvent({ type: "click" });
  assert.equal(ui.el("cloud-github-repository-form").hidden, false);
  assert.equal(ui.el("cloud-github-pr-form").hidden, false);
  assert.equal(ui.el("cloud-github-new").disabled, true);
  assert.equal(ui.el("cloud-github-continue").disabled, true);
  ui.el("cloud-github-owner").value = "owner";
  ui.el("cloud-github-name").value = "another";
  ui.el("cloud-github-base").value = "main";
  ui.el("cloud-github-repository-form").dispatchEvent({ type: "submit", preventDefault() {} });
  await settle();
  assert.equal(bindings, 1);
  for (const id of ["cloud-github-new", "cloud-github-continue"]) ui.el(id).dispatchEvent({ type: "click" });
  assert.equal(ui.el("agent-harness-select").value, "");
  assert.equal(ui.el("cloud-github-error").textContent, "Cloud Agent · coming later");
  await assert.rejects(ui.view.start("s1", { content: "Edit", profileId: "coding", idempotencyKey: "request" }), /coming later/);
  assert.equal(runs, 0);
});
