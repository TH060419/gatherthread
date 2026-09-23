import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { codePermissions, codeRuntimeChoices, createCodeSyncController, codeErrorText, CODE_JOB_KINDS } from "../src/code-sync.js";
import { compareCodeSnapshots, codeFilePreview, codeBranchAuthor } from "../src/code-sync-view.js";
import { normalizeSnapshotRequest } from "../src/domain.js";
import { translateUiText } from "../src/i18n.js";

const context = (overrides = {}) => ({ project: { id: "p1", role: "owner" }, userId: "u1", sessionId: "s1", sessionWritable: true,
  runtimes: [{ id: "r1", harness: "codex", deviceId: "d1", status: "online" }], ...overrides });
const repository = { repository: { enabled: true, main_commit: "a".repeat(40) }, own_branch_id: "b1", branches: [
  { id: "b1", user_id: "u1", name: "gt/u1", head_commit: "b".repeat(40), review_status: "draft" },
] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("code review branches identify collaborators by project member name with a stable fallback", () => {
  const branch = repository.branches[0];
  assert.equal(codeBranchAuthor(branch, [{ userId: "u1", username: "Alice" }]), "Alice");
  assert.equal(codeBranchAuthor(branch, []), "gt/u1");
  assert.equal(codeBranchAuthor(branch, [{ userId: "u2", username: "Someone else" }]), "gt/u1");
});

test("code runtime selection excludes offline, snapshots, other users and disabled harnesses", () => {
  const contexts = context({ enabledHarnesses: ["codex"], runtimes: [
    { id: "ok", harness: "codex", status: "online", userId: "u1", purpose: "execution" },
    { id: "offline", harness: "codex", status: "offline" },
    { id: "snapshot", harness: "codex", status: "online", purpose: "snapshot_connector" },
    { id: "foreign", harness: "codex", status: "online", userId: "u2" },
    { id: "dsh", harness: "deepseek-harness", status: "online" },
  ] });
  assert.deepEqual(codeRuntimeChoices(contexts).map((runtime) => runtime.id), ["ok"]);
});

test("code permissions distinguish project owner, participant, viewer and read-only sessions", () => {
  const state = { repository, runtimeId: "r1", local: { enabled: true } };
  assert.equal(codePermissions(context(), state).merge, true);
  assert.equal(codePermissions(context({ project: { id: "p1", role: "participant" } }), state).merge, false);
  assert.equal(codePermissions(context({ project: { id: "p1", role: "participant" } }), state).transfer, true);
  const viewer = codePermissions(context({ project: { id: "p1", role: "viewer" } }), state);
  assert.equal(viewer.local, false);
  assert.equal(viewer.review, false);
  assert.equal(codePermissions(context({ sessionWritable: false }), state).transfer, false);
  assert.equal(codePermissions(context(), { ...state, local: { enabled: false } }).transfer, false);
  assert.equal(codePermissions(context(), { ...state, job: { status: "queued" } }).transfer, false);
});

test("controller discards stale project loads and never silently chooses an Agent", async () => {
  let finishOld;
  const api = { getProjectCode: (id) => id === "p1" ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve({ ...repository, own_branch_id: "p2-only" }) };
  const controller = createCodeSyncController({ api });
  controller.setContext(context());
  controller.open();
  controller.setContext(context({ project: { id: "p2", role: "owner" }, sessionId: "s2" }));
  await tick();
  finishOld(repository);
  await tick();
  assert.equal(controller.getState().repository.own_branch_id, "p2-only");
  assert.equal(controller.getState().runtimeId, "");
  assert.equal(await controller.queue("code_upload"), false);
  controller.close();
  assert.equal(await controller.queue("code_auto_upload_disable"), false);
  assert.equal(await controller.mutate("review"), false);
});

test("local operations target the selected runtime and stay separate from conversation controls", async () => {
  const commands = [];
  const api = {
    getProjectCode: async () => repository, listSnapshotRequests: async () => [],
    createSnapshotRequest: async (sessionId, kind, targetRuntimeId) => {
      commands.push({ sessionId, kind, targetRuntimeId });
      return { id: kind, kind, sessionId, targetRuntimeId, status: "queued" };
    },
    getSnapshotRequest: async (id) => ({ id, kind: id, status: "completed", result: { enabled: true, automatic_upload: id === "code_auto_upload_enable" } }),
  };
  const controller = createCodeSyncController({ api });
  controller.setContext(context());
  controller.open(); await tick();
  await controller.selectRuntime("r1"); await tick();
  assert.equal(controller.getState().local.automatic_upload, false);
  await controller.queue("code_auto_upload_enable"); await tick();
  assert.deepEqual(commands, [
    { sessionId: "s1", kind: "code_sync_status", targetRuntimeId: "r1" },
    { sessionId: "s1", kind: "code_auto_upload_enable", targetRuntimeId: "r1" },
  ]);
  controller.setContext(context({ runtimes: [{ id: "r2", harness: "codex", status: "online" }] }));
  assert.equal(controller.getState().runtimeId, "r1");
  assert.equal(await controller.queue("code_upload"), false);
  controller.close();
});

test("paused Git still permits switching off an existing local automatic-upload preference", async () => {
  const paused = structuredClone(repository);
  paused.repository.enabled = false;
  const commands = [];
  const api = {
    getProjectCode: async () => paused,
    listSnapshotRequests: async () => [],
    createSnapshotRequest: async (sessionId, kind, targetRuntimeId) => {
      commands.push({ sessionId, kind, targetRuntimeId });
      return { id: kind, kind, status: "queued" };
    },
    getSnapshotRequest: async (id) => ({ id, kind: id, status: "completed", result: { enabled: true, automatic_upload: id !== "code_auto_upload_disable" } }),
  };
  const controller = createCodeSyncController({ api });
  controller.setContext(context()); controller.open(); await tick();
  await controller.selectRuntime("r1"); await tick();
  assert.equal(controller.getState().permissions.transfer, false);
  assert.equal(controller.getState().permissions.stopAutomaticUpload, true);
  assert.equal(await controller.queue("code_upload"), false);
  assert.equal(await controller.queue("code_auto_upload_enable"), false);
  assert.equal(await controller.queue("code_auto_upload_disable"), true);
  await tick();
  assert.equal(controller.getState().local.automatic_upload, false);
  assert.deepEqual(commands.map(({ kind }) => kind), ["code_sync_status", "code_auto_upload_disable"]);
  controller.close();
});

test("stale code job cannot update a switched session, and pending jobs resume without duplicate writes", async () => {
  let resolveJob;
  let writes = 0;
  const api = {
    getProjectCode: async () => repository,
    listSnapshotRequests: async () => [{ id: "existing", targetRuntimeId: "r1", kind: "code_upload", status: "queued" }],
    createSnapshotRequest: async () => { writes += 1; },
    getSnapshotRequest: () => new Promise((resolve) => { resolveJob = resolve; }),
  };
  const controller = createCodeSyncController({ api });
  controller.setContext(context()); controller.open(); await tick();
  await controller.selectRuntime("r1");
  controller.setContext(context({ sessionId: "s2" }));
  resolveJob({ id: "existing", status: "completed", result: { enabled: true, automatic_upload: true } });
  await tick();
  assert.equal(controller.getState().local, null);
  assert.equal(writes, 0);
  controller.close();
});

test("device selection cannot invalidate an in-flight status load or strand the panel", async () => {
  let resolveLoad;
  const controller = createCodeSyncController({ api: { getProjectCode: () => new Promise((resolve) => { resolveLoad = resolve; }) } });
  controller.setContext(context()); controller.open();
  await controller.selectRuntime("r1");
  assert.equal(controller.getState().runtimeId, "");
  resolveLoad(repository); await tick();
  assert.equal(controller.getState().loading, false);
  assert.equal(controller.getState().repository.own_branch_id, "b1");
  controller.close();
});

test("review and merge freeze expected heads and require a requested review", async () => {
  const writes = [];
  const status = structuredClone(repository);
  const api = { getProjectCode: async () => status, mutateProjectCode: async (...args) => { writes.push(args); return { status }; } };
  const controller = createCodeSyncController({ api });
  controller.setContext(context()); controller.open(); await tick();
  assert.equal(await controller.mutate("merge", "b1"), false);
  await controller.mutate("review");
  assert.equal(writes[0][2].head_commit, "b".repeat(40));
  status.branches[0].review_status = "requested";
  await controller.mutate("merge", "b1");
  assert.equal(writes[1][2].expected_main_commit, "a".repeat(40));
  assert.equal(writes[1][2].expected_head_commit, "b".repeat(40));
  assert.ok(writes[1][2].idempotency_key);
  controller.close();
});

test("Git API uses encoded project IDs, cookie-authenticated requests and exact snake_case payloads", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return Response.json({ data: repository }); };
  try {
    const api = new HttpCollaborationApi();
    await api.getProjectCode("project/a");
    await api.mutateProjectCode("project/a", "merge", { branch_id: "b1", expected_main_commit: "main", expected_head_commit: "head", idempotency_key: "once" });
    await api.getProjectCodeSnapshot("project/a", "branch/name");
    assert.equal(calls[0][0], "/v1/projects/project%2Fa/code");
    assert.equal(calls[1][0], "/v1/projects/project%2Fa/code/merge");
    assert.equal(calls[1][1].credentials, "include");
    assert.equal(calls[1][1].headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[1][1].body), { branch_id: "b1", expected_main_commit: "main", expected_head_commit: "head", idempotency_key: "once" });
    assert.equal(calls[2][0], "/v1/projects/project%2Fa/code/snapshot?branch_id=branch%2Fname");
    await assert.rejects(api.mutateProjectCode("p", "delete", {}), /Unknown code operation/);
  } finally { globalThis.fetch = originalFetch; }
});

test("code snapshot kinds and structured failure codes survive Web normalization", () => {
  for (const kind of CODE_JOB_KINDS) assert.equal(normalizeSnapshotRequest({ id: "j", status: "queued", kind }).kind, kind);
  const failed = normalizeSnapshotRequest({ id: "j", kind: "code_download", status: "failed", failure: { code: "code_sync_dirty", message: "safe" } });
  assert.equal(failed.failureCode, "code_sync_dirty");
  assert.match(codeErrorText(failed.failureCode), /nothing was overwritten/);
  assert.doesNotMatch(codeErrorText({ message: "/private/user/token" }), /private/);
  for (const code of ["code_stale_head", "code_merge_conflict", "code_review_required", "code_secret_detected", "code_storage_quota_exceeded", "code_git_unavailable"]) {
    const message = codeErrorText(code);
    assert.doesNotMatch(message, /^Code operation failed/);
    assert.notEqual(translateUiText(message, "zh-CN"), message, `${code} must be translated`);
  }
});

test("change preview identifies additions, removals, modes and bounds text without evaluating HTML", () => {
  const file = (path, text, executable = false) => ({ path, content_base64: btoa(text), executable });
  const changes = compareCodeSnapshots({ files: [file("old", "x"), file("same", "s"), file("mode", "m")] }, { files: [file("new", "<script>alert(1)</script>"), file("same", "s"), file("mode", "m", true)] });
  assert.deepEqual(changes.map(({ path, type }) => [path, type]), [["mode", "Modified"], ["new", "Added"], ["old", "Deleted"]]);
  assert.equal(codeFilePreview(file("new", "<script>alert(1)</script>")), "<script>alert(1)</script>");
  assert.equal(codeFilePreview(file("binary", "x\0y")), null);
  assert.equal(codeFilePreview(file("large", "a".repeat(50000))).length, 12000);
});

test("mock preview supports enable, exact code controls, review and merge without conversation changes", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const original = await api.replayEvents("session-orbit", { afterSequence: 0 });
  await api.mutateProjectCode("project-orbit", "enable", { idempotency_key: "enable" });
  const request = await api.createSnapshotRequest("session-orbit", "code_upload", "runtime-codex-session-orbit");
  await api.getSnapshotRequest(request.id);
  const completed = await api.getSnapshotRequest(request.id);
  assert.equal(completed.result.automatic_upload, false);
  const status = await api.getProjectCode("project-orbit");
  await api.mutateProjectCode("project-orbit", "review", { idempotency_key: "review", head_commit: status.branches[0].head_commit });
  const result = await api.mutateProjectCode("project-orbit", "merge", { idempotency_key: "merge", branch_id: status.own_branch_id, expected_main_commit: status.repository.main_commit, expected_head_commit: status.branches[0].head_commit });
  assert.equal(result.status.branches[0].review_status, "merged");
  assert.deepEqual(await api.replayEvents("session-orbit", { afterSequence: 0 }), original);
});

test("code dialog has named controls, a one-time notice, and a safe review surface", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const view = await readFile(new URL("../src/code-sync-view.js", import.meta.url), "utf8");
  assert.match(html, /id="project-code-button"[^>]*aria-label="Code collaboration"[^>]*aria-controls="project-code-dialog"/);
  assert.match(html, /id="project-code-dialog"[^>]*aria-labelledby="project-code-title"/);
  assert.match(html, /id="code-notice-dialog"[^>]*aria-labelledby="code-notice-title"[^>]*aria-describedby="code-notice-description"/);
  assert.match(html, /id="code-error"[^>]*role="alert"/);
  assert.match(html, /id="code-auto-upload-toggle"[^>]*disabled/);
  assert.match(html, /Off by default/);
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage/);
  assert.match(view, /selected\?\.head_commit === reviewed.head/);
  assert.match(view, /repository\.repository\.main_commit === reviewed.main/);
  for (const text of ["Code collaboration", "Automatically upload local code changes", "Restore to a new folder", "Approve and merge into main", "Selected device is offline"]) {
    assert.notEqual(translateUiText(text, "zh-CN"), text);
  }
});
