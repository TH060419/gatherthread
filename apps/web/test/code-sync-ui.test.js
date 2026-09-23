import test from "node:test";
import assert from "node:assert/strict";
import { mountCodeSync } from "../src/code-sync-view.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class Node {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this.isConnected = true;
    this.disabled = false;
    this.open = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  setAttribute() {}
  focus() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
}

function setup() {
  const nodes = new Map();
  const el = (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const doc = { getElementById: el, createElement: () => new Node(), activeElement: new Node() };
  const status = { repository: { enabled: true, main_commit: "a".repeat(40) }, own_branch_id: "b1", branches: [
    { id: "b1", name: "member", user_id: "u1", head_commit: "b".repeat(40), review_status: "requested" },
  ] };
  const mutations = [];
  let snapshotHead = status.branches[0].head_commit;
  const api = {
    getProjectCode: async () => structuredClone(status),
    getProjectCodeSnapshot: async (_project, branch) => ({ snapshot: {
      commit: branch === "main" ? status.repository.main_commit : snapshotHead,
      files: [{ path: "app.js", content_base64: btoa(branch === "main" ? "before" : "after"), executable: false }],
    } }),
    mutateProjectCode: async (...args) => { mutations.push(args); return { status }; },
  };
  let context = { project: { id: "p1", name: "Project", role: "owner" }, userId: "u1", sessionId: "s1", runtimes: [] };
  const ui = mountCodeSync({ document: doc, api, localizer: { t: (text) => text }, getContext: () => context });
  return { el, ui, status, mutations,
    changeContext: (next) => { context = next; ui.updateContext(); },
    setSnapshotHead: (value) => { snapshotHead = value; },
    viewChanges: () => el("code-branch-list").children[0].children[1].dispatch("click"),
  };
}

test("a refreshed preview cancels pending approval even for the same branch", async () => {
  const app = setup();
  app.el("project-code-button").dispatch("click");
  await tick();
  app.viewChanges();
  await tick();
  assert.equal(app.el("code-merge-button").disabled, false);
  const approval = app.el("code-merge-button").dispatch("click");
  assert.equal(app.el("code-confirmation").hidden, false);
  app.status.branches[0].head_commit = "c".repeat(40);
  app.setSnapshotHead("c".repeat(40));
  await app.el("code-refresh-button").dispatch("click");
  app.viewChanges();
  await tick();
  assert.equal(app.el("code-confirmation").hidden, true);
  app.el("code-confirm-accept").dispatch("click");
  await approval;
  assert.equal(app.mutations.length, 0);
  const freshApproval = app.el("code-merge-button").dispatch("click");
  app.el("code-confirm-accept").dispatch("click");
  await freshApproval;
  assert.equal(app.mutations.length, 1);
  assert.equal(app.mutations[0][2].expected_head_commit, "c".repeat(40));
  app.ui.close();
});

test("logout clears source previews and cancels a pending merge", async () => {
  const app = setup();
  app.el("project-code-button").dispatch("click");
  await tick();
  app.viewChanges();
  await tick();
  assert.ok(app.el("code-review-files").children.length > 0);
  const approval = app.el("code-merge-button").dispatch("click");
  app.changeContext({ project: null, userId: undefined, sessionId: undefined, runtimes: [] });
  app.el("code-confirm-accept").dispatch("click");
  await approval;
  assert.equal(app.mutations.length, 0);
  assert.equal(app.el("code-review-files").children.length, 0);
  assert.equal(app.el("code-review-preview").hidden, true);
  app.ui.close();
});

test("viewers can inspect member changes without exposing merge authority", async () => {
  const app = setup();
  app.changeContext({ project: { id: "p1", name: "Project", role: "viewer" }, userId: "viewer", runtimes: [] });
  app.el("project-code-button").dispatch("click");
  await tick();
  app.viewChanges();
  await tick();
  assert.ok(app.el("code-review-files").children.length > 0);
  assert.equal(app.el("code-merge-button").hidden, true);
  assert.equal(app.el("code-merge-button").disabled, true);
  assert.equal(app.el("code-upload-button").disabled, true);
  app.ui.close();
});
