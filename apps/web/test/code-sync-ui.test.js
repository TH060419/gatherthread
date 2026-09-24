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
  click() { return this.dispatch("click"); }
}

function setup({ seenNotice = true } = {}) {
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
  const storageValues = new Map(seenNotice ? [["gatherthread.code-notice.v2:d1", "seen"]] : []);
  const storage = { getItem: (key) => storageValues.get(key) ?? null, setItem: (key, value) => storageValues.set(key, value) };
  const ui = mountCodeSync({ document: doc, api, localizer: { t: (text) => text }, getContext: () => context, storage });
  return { el, ui, status, mutations,
    changeContext: (next) => { context = next; ui.updateContext(); },
    setSnapshotHead: (value) => { snapshotHead = value; },
    viewChanges: () => el("code-branch-list").children[0].children[1].dispatch("click"),
  };
}

test("the Git notice blocks first workspace entry per device until acknowledged", async () => {
  const app = setup({ seenNotice: false });
  app.ui.showFirstLoginNotice("d1");
  assert.equal(app.el("code-notice-dialog").open, true);
  assert.equal(app.el("project-code-dialog").open, false);
  let prevented = false;
  app.el("code-notice-dialog").listeners.get("cancel")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "Escape cannot dismiss the required notice");
  app.el("code-notice-continue").click();
  assert.equal(app.el("project-code-dialog").open, false);
  app.ui.close();
  app.ui.showFirstLoginNotice("d1");
  assert.equal(app.el("code-notice-dialog").open, false);
  app.ui.showFirstLoginNotice("d2");
  assert.equal(app.el("code-notice-dialog").open, true, "a second device must see the notice");
  app.el("code-notice-continue").click();
  app.el("project-code-button").click();
  assert.equal(app.el("code-notice-dialog").open, false);
  assert.equal(app.el("project-code-dialog").open, true);
  app.ui.close();
});

test("Git panel guides accounts without projects and owner can pause syncing", async () => {
  const app = setup();
  app.changeContext({ project: null, userId: "u1", canCreateProjects: true, runtimes: [] });
  app.el("project-code-button").click();
  assert.equal(app.el("project-code-dialog").open, true);
  assert.equal(app.el("code-no-project").hidden, false);
  assert.equal(app.el("code-create-project-button").hidden, false);
  app.ui.close();
  app.changeContext({ project: { id: "p1", name: "Project", role: "owner" }, userId: "u1", sessionId: "s1", runtimes: [] });
  app.el("project-code-button").click();
  await tick();
  const pending = app.el("code-disable-active-button").click();
  app.el("code-confirm-accept").click();
  await pending;
  assert.equal(app.mutations[0][1], "disable");
  app.ui.close();
});

test("paused Git keeps local automatic-upload stop control reachable", async () => {
  const app = setup();
  app.status.repository.enabled = false;
  app.el("project-code-button").click();
  await tick();
  assert.equal(app.el("code-enabled-content").hidden, false);
  assert.equal(app.el("code-paused-note").hidden, false);
  assert.equal(app.el("code-disable-active-button").disabled, true);
  app.ui.close();
});

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
