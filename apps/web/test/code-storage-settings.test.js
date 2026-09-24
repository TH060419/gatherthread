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
  focus() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  dispatch(type) { this.listeners.get(type)?.({ target: this }); }
}

function fixture({ owner = true, detached = false } = {}) {
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
  let storageLoader = null;
  const api = {
    async getCodeStorage() {
      if (storageLoader) return storageLoader();
      return { limit_bytes: 128 * 1024 * 1024, used_bytes: hasData ? 4096 : 0,
      detached_branches: hasData && detached ? [{ project_id: "old", project_title: "Old project",
        own_branch_head_commit: "d".repeat(40), own_branch_bytes: 4096 }] : [],
      projects: hasData ? [{ project_id: "p1", project_title: "Project", repository_enabled: true,
        main_commit: code.repository.main_commit, main_bytes: 2048, own_branch_id: "branch-1",
        own_branch_head_commit: code.branches[0].head_commit, own_branch_bytes: 2048,
        branch_count: 2, can_clear_project: owner }] : [] };
    },
    async getProjectCode() { return structuredClone(code); },
    async clearProjectCode(...args) { calls.push(["project", ...args]); hasData = false; },
    async clearOwnCodeBranch(...args) { calls.push(["own", ...args]); hasData = false; },
    async clearDetachedCodeBranch(...args) { calls.push(["detached", ...args]); hasData = false; },
  };
  let userId = "u1";
  const ui = mountCodeStorageSettings({ document: { getElementById: el, createElement: () => new Node() },
    api, localizer: { t: (value) => value }, getUserId: () => userId });
  return {
    ui, el, calls,
    changeUser(value) { userId = value; },
    setStorageLoader(loader) { storageLoader = loader; },
  };
}

async function openCleanup(app) {
  app.el("code-storage-open").dispatch("click");
  await tick();
}

test("cleanup subview announces loading, clears stale rows, and shows quota after refresh", async () => {
  const app = fixture();
  await app.ui.load();
  assert.equal(app.el("code-storage-projects").children.length, 1);
  let resolveStorage;
  const pendingStorage = new Promise((resolve) => { resolveStorage = resolve; });
  app.setStorageLoader(() => pendingStorage);

  app.el("code-storage-open").dispatch("click");
  await tick();
  assert.equal(app.el("code-storage-manage").hidden, false);
  assert.equal(app.el("code-storage-manage-status").textContent, "Loading cloud Git storage…");
  assert.equal(app.el("code-storage-projects").children.length, 0, "do not leave a stale list visible while refreshing");

  resolveStorage({ limit_bytes: 128 * 1024 * 1024, used_bytes: 8192, projects: [{
    project_id: "p1", project_title: "Project", repository_enabled: true,
    main_commit: "a".repeat(40), main_bytes: 4096, own_branch_id: "branch-1",
    own_branch_head_commit: "b".repeat(40), own_branch_bytes: 4096,
    branch_count: 2, can_clear_project: true,
  }] });
  await tick();
  assert.equal(app.el("code-storage-manage-status").textContent, "My logical cloud Git quota: 8.0 KiB / 128.0 MiB");
  assert.equal(app.el("code-storage-projects").children.length, 1);
});

test("cleanup subview visibly reports storage-load errors", async () => {
  const app = fixture();
  app.setStorageLoader(async () => { throw new Error("temporary network failure"); });
  app.el("code-storage-open").dispatch("click");
  await tick();
  assert.equal(app.el("code-storage-manage-status").textContent, "Unable to load cloud Git storage.");
  assert.equal(app.el("code-storage-error").textContent, "temporary network failure");
});

test("owner explicitly reviews whole-project cleanup with all branch heads before deletion", async () => {
  const app = fixture();
  await app.ui.load();
  assert.equal(app.el("code-storage-manage").hidden, true);
  await openCleanup(app);
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
  await openCleanup(app);
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

test("former member can explicitly review and clear only their own detached branch", async () => {
  const app = fixture({ detached: true });
  await app.ui.load();
  await openCleanup(app);
  const row = app.el("code-storage-projects").children[1];
  const checkbox = row.children[0].children[0];
  checkbox.checked = true;
  checkbox.dispatch("change");
  app.el("code-storage-review").dispatch("click");
  await tick();
  assert.equal(app.calls.length, 0);
  app.el("code-storage-confirm").dispatch("click");
  await tick();
  assert.equal(app.calls[0][0], "detached");
  assert.equal(app.calls[0][1], "old");
  assert.equal(app.calls[0][2].expected_head_commit, "d".repeat(40));
});
