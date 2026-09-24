import test from "node:test";
import assert from "node:assert/strict";
import { mountCodeStorageSettings } from "../src/code-storage-settings.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class Node {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.checked = false;
    this.value = "";
    this.textContent = "";
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  dispatch(type) { this.listeners.get(type)?.({ target: this }); }
}

function fixture({ owner = true } = {}) {
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  };
  el("settings-dialog").open = true;
  const calls = [];
  let hasData = true;
  const code = {
    repository: { main_commit: "a".repeat(40) },
    own_branch_id: "branch-1",
    branches: [
      { id: "branch-1", head_commit: "b".repeat(40) },
      { id: "branch-2", head_commit: "c".repeat(40) },
    ],
  };
  const api = {
    async getCodeStorage() { return { limit_bytes: 128 * 1024 * 1024, used_bytes: hasData ? 4096 : 0,
      projects: hasData ? [{ project_id: "p1", project_title: "Project", repository_enabled: true,
        main_commit: code.repository.main_commit, main_bytes: 2048, own_branch_id: "branch-1",
        own_branch_head_commit: code.branches[0].head_commit, own_branch_bytes: 2048,
        branch_count: 2, can_clear_project: owner }] : [] }; },
    async getProjectCode() { return structuredClone(code); },
    async clearProjectCode(...args) { calls.push(["project", ...args]); hasData = false; },
    async clearOwnCodeBranch(...args) { calls.push(["own", ...args]); hasData = false; },
  };
  let userId = "u1";
  const ui = mountCodeStorageSettings({ document: { getElementById: el, createElement: () => new Node() },
    api, localizer: { t: (value) => value }, getUserId: () => userId });
  return { ui, el, calls, changeUser(value) { userId = value; } };
}

test("owner explicitly reviews whole-project cleanup with all branch heads before deletion", async () => {
  const app = fixture();
  await app.ui.load();
  const [row] = app.el("code-storage-projects").children;
  const checkbox = row.children[0].children[0];
  const action = row.children[1];
  assert.deepEqual(action.children.map((option) => option.value), ["own", "project"]);
  checkbox.checked = true;
  checkbox.dispatch("change");
  action.value = "project";
  action.dispatch("change");
  app.el("code-storage-review").dispatch("click");
  await tick();
  assert.equal(app.el("code-storage-confirmation").hidden, false);
  assert.equal(app.calls.length, 0, "review must not delete anything");
  app.el("code-storage-confirm").dispatch("click");
  await tick();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0][0], "project");
  assert.equal(app.calls[0][1], "p1");
  assert.deepEqual(app.calls[0][2].expected_branches, [
    { branch_id: "branch-1", head_commit: "b".repeat(40) },
    { branch_id: "branch-2", head_commit: "c".repeat(40) },
  ]);
});

test("ordinary member can select only their own cloud branch", async () => {
  const app = fixture({ owner: false });
  await app.ui.load();
  const [row] = app.el("code-storage-projects").children;
  const checkbox = row.children[0].children[0];
  const action = row.children[1];
  assert.deepEqual(action.children.map((option) => option.value), ["own"]);
  checkbox.checked = true;
  checkbox.dispatch("change");
  app.el("code-storage-review").dispatch("click");
  await tick();
  app.el("code-storage-confirm").dispatch("click");
  await tick();
  assert.equal(app.calls[0][0], "own");
  assert.equal(app.calls[0][2].expected_head_commit, "b".repeat(40));
});
