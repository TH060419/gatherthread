import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGithubCodeSyncController, githubPermissions, githubLinks, githubBaseBranchAllowed, GITHUB_CODE_JOB_KINDS } from "../src/github-code-sync.js";
import { HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { ExampleCollaborationApi } from "../src/example-api.js";
import { normalizeSnapshotRequest } from "../src/domain.js";
import { translateUiText } from "../src/i18n.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const status = { connection: { repository: "team/project", base_branch: "main", enabled: true, revision: "v1" },
  branch: "gatherthread/p/u", can_write: true, can_configure: true };
const context = (overrides = {}) => ({ project: { id: "p", role: "owner" }, userId: "u", sessionId: "s", sessionWritable: true,
  runtimes: [{ id: "codex", userId: "u", harness: "codex", status: "online" }, { id: "dsh", userId: "u", harness: "deepseek-harness", status: "online" }], ...overrides });
const result = (overrides = {}) => ({ provider: "github", repository: "team/project", base_branch: "main", branch: status.branch, enabled: true, automatic_upload: false, ...overrides });

test("GitHub permissions require owner configuration, exact own online runtime, local consent and independent enablement", () => {
  const state = { github: status, runtimeId: "codex", local: result() };
  assert.equal(githubPermissions(context(), state).transfer, true);
  assert.equal(githubPermissions(context({ runtimes: [{ id: "codex", harness: "codex", status: "online" }] }), state).local, true, "the authenticated own-runtime endpoint omits user_id");
  for (const runtimes of [[{ id: "codex", userId: "other", harness: "codex", status: "online" }], [{ id: "codex", userId: "u", harness: "codex", status: "offline" }]]) {
    assert.equal(githubPermissions(context({ runtimes }), state).local, false);
  }
  assert.equal(githubPermissions(context({ project: { id: "p", role: "viewer" } }), state).transfer, false);
  assert.equal(githubPermissions(context({ project: { id: "p", role: "participant" } }), state).configure, false);
  assert.equal(githubPermissions(context({ sessionWritable: false }), state).transfer, false);
  assert.equal(githubPermissions(context(), { ...state, local: null }).transfer, false);
  assert.equal(githubPermissions(context(), { ...state, job: { status: "claimed" } }).configure, false);
});

test("GitHub config API uses cookies, encoded IDs and exact revision CAS", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ data: status }); };
  try {
    const api = new HttpCollaborationApi();
    await api.getProjectGithub("project/a");
    const input = { repository: "team/project", base_branch: "main", enabled: true, expected_revision: null };
    await api.putProjectGithub("project/a", input);
    assert.equal(calls[0].url, "/v1/projects/project%2Fa/github");
    assert.equal(calls[1].options.method, "PUT");
    assert.equal(calls[1].options.credentials, "include");
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[1].options.body), input);
  } finally { globalThis.fetch = original; }
});

test("GitHub controls route only to selected runtime and paused connections allow stopping auto-upload", async () => {
  const github = structuredClone(status), calls = [];
  const api = { getProjectGithub: async () => structuredClone(github), listSnapshotRequests: async () => [],
    createSnapshotRequest: async (sessionId, kind, targetRuntimeId) => { calls.push({ sessionId, kind, targetRuntimeId }); return { id: kind, kind, status: "queued" }; },
    getSnapshotRequest: async (id) => ({ id, kind: id, status: "completed", result: result({ automatic_upload: id !== "github_code_auto_upload_disable" }) }),
  };
  const controller = createGithubCodeSyncController({ api }); controller.setContext(context()); controller.open(); await tick();
  assert.equal(await controller.queue("github_code_upload"), false);
  await controller.selectRuntime("dsh"); await tick();
  await controller.queue("github_code_upload"); await tick();
  assert.equal(calls.at(-1).targetRuntimeId, "dsh");
  assert.equal(calls.at(-1).sessionId, "s");
  assert.equal(await controller.queue("code_upload"), false);
  github.connection.enabled = false;
  await controller.refresh();
  assert.equal(await controller.queue("github_code_upload"), false);
  assert.equal(await controller.queue("github_code_auto_upload_enable"), false);
  assert.equal(await controller.queue("github_code_auto_upload_disable"), true); await tick();
  assert.equal(controller.getState().local.automatic_upload, false);
  controller.setContext(context({ runtimes: [context().runtimes[0]] }));
  assert.equal(controller.getState().runtimeId, "dsh");
  assert.equal(await controller.queue("github_code_sync_status"), false);
  controller.close();
});

test("GitHub browser sign-in can be requested before local file authorization", async () => {
  const calls = [];
  let currentStatus = structuredClone(status);
  const controller = createGithubCodeSyncController({ api: {
    getProjectGithub: async () => structuredClone(currentStatus), listSnapshotRequests: async () => [],
    createSnapshotRequest: async (sessionId, kind, runtimeId) => { calls.push({ sessionId, kind, runtimeId }); return { id: kind, kind, status: "queued" }; },
    getSnapshotRequest: async (id) => ({ kind: id, status: "completed", result: id === "github_auth_connect"
      ? { provider: "github", connected: true } : result({ enabled: false }) }),
  } });
  controller.setContext(context()); controller.open(); await tick();
  await controller.selectRuntime("codex"); await tick();
  assert.equal(controller.getState().permissions.transfer, false);
  assert.equal(await controller.queue("github_auth_connect"), true); await tick();
  assert.equal(calls.at(-1).runtimeId, "codex");
  assert.equal(controller.getState().authConnected, true);
  assert.equal(controller.getState().local?.enabled, false);
  currentStatus = { ...currentStatus, connection: { ...currentStatus.connection, revision: "v2" } };
  await controller.refresh();
  assert.equal(controller.getState().authConnected, false, "a new GitHub target cannot inherit the old browser-sign-in status");
  controller.close();
});

test("GitHub binding change, failed refresh and stale scope cannot authorize transfers", async () => {
  let currentStatus = structuredClone(status), resolveJob, fail = false;
  const controller = createGithubCodeSyncController({ api: {
    getProjectGithub: async () => { if (fail) throw Error("/private/token"); return structuredClone(currentStatus); },
    listSnapshotRequests: async () => [],
    createSnapshotRequest: async () => ({ id: "j", status: "queued" }),
    getSnapshotRequest: () => new Promise((resolve) => { resolveJob = resolve; }),
  } });
  controller.setContext(context()); controller.open(); await tick(); await controller.selectRuntime("codex");
  currentStatus.connection = { ...currentStatus.connection, repository: "team/changed", revision: "v2" };
  await controller.refresh(); resolveJob({ status: "completed", result: result() }); await tick();
  assert.equal(controller.getState().local, null);
  assert.match(controller.getState().error, /configuration changed/);
  await controller.queue("github_code_sync_status");
  controller.setContext(context({ sessionId: "s2" }));
  resolveJob({ status: "completed", result: result() }); await tick();
  assert.equal(controller.getState().local, null);
  fail = true; await controller.refresh();
  assert.equal(controller.getState().github, null);
  assert.doesNotMatch(controller.getState().error, /private|token/);
  controller.close();
});

test("GitHub pending jobs resume without duplicate writes; reconfiguration freezes expected revision", async () => {
  let writes = 0, configured;
  const controller = createGithubCodeSyncController({ api: {
    getProjectGithub: async () => structuredClone(status),
    listSnapshotRequests: async () => [{ id: "pending", targetRuntimeId: "codex", kind: "github_code_upload", status: "queued" }],
    getSnapshotRequest: async () => ({ status: "completed", result: result() }),
    createSnapshotRequest: async () => { writes += 1; },
    putProjectGithub: async (_id, input) => { configured = input; return { ...status, connection: { ...input, revision: "v2" } }; },
  } });
  controller.setContext(context()); controller.open(); await tick(); await controller.selectRuntime("codex"); await tick();
  assert.equal(writes, 0); assert.equal(controller.getState().local.provider, "github");
  assert.equal(await controller.configure({ repository: "https://user:secret@example.invalid/repo", base_branch: "main", enabled: true }), false);
  assert.equal(configured, undefined, "credential-bearing URLs never leave the browser");
  assert.equal(await controller.configure({ repository: "team/next", base_branch: "gatherthread/reserved", enabled: true }), false);
  assert.equal(configured, undefined);
  await controller.configure({ repository: "team/next", base_branch: "develop", enabled: true });
  assert.equal(configured.expected_revision, "v1");
  assert.equal(controller.getState().local, null);
  controller.close(); assert.equal(await controller.configure({}), false);
});

test("GitHub base branch validation rejects reserved namespace and unsafe Git refs", () => {
  for (const branch of ["gatherthread/a/b", "main..backup", "HEAD", "-flag", ".hidden", "x.lock", "x//y", "main\n", "x/."]) assert.equal(githubBaseBranchAllowed(branch), false, branch);
  for (const branch of ["main", "release/v2", "feature/source-only"]) assert.equal(githubBaseBranchAllowed(branch), true, branch);
});

test("GitHub link targets remain on github.com and encode refs without HTML or arbitrary URLs", () => {
  const links = githubLinks(status);
  assert.equal(links.compare, "https://github.com/team/project/compare/main...gatherthread%2Fp%2Fu?expand=1");
  for (const repository of ["https://evil.test/x", "team/repo?redirect=evil", "team/repo#x", "team/..", "../repo", "team/repo/extra", "team/repo<script>"]) {
    assert.equal(githubLinks({ ...status, connection: { ...status.connection, repository } }), null);
  }
  const escaped = githubLinks({ ...status, connection: { ...status.connection, base_branch: "feature/a?b#c" } });
  assert.equal(new URL(escaped.files).origin, "https://github.com");
  assert.equal(new URL(escaped.files).hash, "");
});

test("all GitHub kinds survive normalization and mock/example operations stay independent of GT Cloud", async () => {
  for (const kind of GITHUB_CODE_JOB_KINDS) assert.equal(normalizeSnapshotRequest({ id: "j", kind, status: "completed" }).kind, kind);
  for (const api of [new MockCollaborationApi({ latency: 0 }), new ExampleCollaborationApi()]) {
    const cloud = await api.getProjectCode("project-orbit");
    const events = await api.replayEvents("session-orbit", { afterSequence: 0 });
    await api.putProjectGithub("project-orbit", { repository: "team/demo", base_branch: "main", enabled: true, expected_revision: null });
    const job = await api.createSnapshotRequest("session-orbit", "github_code_auto_upload_enable", "runtime-codex-session-orbit");
    await api.getSnapshotRequest(job.id);
    const completed = await api.getSnapshotRequest(job.id);
    assert.equal(completed.result.automatic_upload, true);
    assert.equal(completed.result.provider, "github");
    assert.equal(api.codeAutomaticUpload.size, 0); assert.equal(api.localAutomaticUpload.size, 0);
    assert.deepEqual(await api.getProjectCode("project-orbit"), cloud);
    assert.deepEqual(await api.replayEvents("session-orbit", { afterSequence: 0 }), events);
    await assert.rejects(api.putProjectGithub("project-orbit", { repository: "team/demo", base_branch: "main", enabled: false, expected_revision: null }), { code: "github_revision_conflict" });
  }
});

test("GitHub dialog has bilingual labelled controls, safe outbound links and separate consent guidance", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /label for="github-code-runtime"/);
  assert.match(html, /id="github-code-error"[^>]*role="alert"/);
  assert.match(html, /id="github-code-auth"/);
  assert.match(html, /--github-code-sync OWNER\/REPO --github-base-branch BRANCH/);
  for (const id of ["files", "branches", "compare"]) assert.match(html, new RegExp(`id="github-code-${id}" target="_blank" rel="noopener noreferrer"`));
  for (const text of ["GitHub · larger or long-term projects", "GT Cloud · small trials", "Existing GitHub repository", "Check GitHub status", "GitHub sync paused", "Set up GitHub on your device", "Automatically upload to GitHub while idle", "Compare / open pull request"]) {
    assert.notEqual(translateUiText(text, "zh-CN"), text);
  }
});
