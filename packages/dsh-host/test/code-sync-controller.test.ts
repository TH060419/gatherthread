import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectCodeSyncStatus, SnapshotRequestSummary } from "@gatherthread/bridge";
import { DshCodeSyncController, GITHUB_CODE_ACTIONS, type DshCodeSyncEngine } from "../src/code-sync-controller.js";
import { DshGitHubCodeSyncController, type DshGitHubMetadata } from "../src/github-code-sync-controller.js";

const initialStatus = (): ProjectCodeSyncStatus => ({
  enabled: true, automatic_upload: false, local_changes: 1, file_count: 2, excluded_count: 3,
  base_commit: null, cloud_commit: null, branch_id: null, needs_download: false,
});

async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "gatherthread-dsh-code-"));
  const calls: string[] = [];
  const operations: Array<string | undefined> = [];
  let busy = false;
  let status = initialStatus();
  const jobs: SnapshotRequestSummary[] = [];
  const completed: string[] = [];
  const failed: Array<{ id: string; code: string }> = [];
  const engine: DshCodeSyncEngine = {
    async initialize() { calls.push("initialize"); },
    async status() { return { ...status }; },
    async execute(kind, options) {
      calls.push(kind);
      operations.push(options?.operationId);
      if (kind === "code_auto_upload_enable") status.automatic_upload = true;
      return { ...status };
    },
    async tick({ busy: active }) { if (!active && status.automatic_upload) calls.push("tick"); return undefined; },
  };
  const options = {
    permissionPath: path.join(directory, "consent.json"), binding: "bound-project-and-user",
    createEngine: () => { calls.push("create"); return engine; },
    api: {
      async listSnapshotRequests(status?: string) { return jobs.filter((job) => job.status === status); },
      async claimSnapshotRequest(id: string) {
        const job = jobs.find((entry) => entry.id === id)!;
        return { ...job, status: "claimed" as const };
      },
      async completeSnapshotRequest(id: string) {
        completed.push(id);
        return { ...jobs.find((entry) => entry.id === id)!, status: "completed" as const };
      },
      async failSnapshotRequest(id: string, _runtime: string, error: { code: string }) {
        failed.push({ id, code: error.code });
        return { ...jobs.find((entry) => entry.id === id)!, status: "failed" as const };
      },
    },
    runtimes: () => new Map([["session-own", "runtime-dsh"]]),
    isBusy: () => busy,
  };
  return {
    directory, calls, jobs, completed, failed, options, operations,
    create: () => new DshCodeSyncController(options),
    setBusy(value: boolean) { busy = value; },
    resetStatus() { status = initialStatus(); },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}

test("DSH code synchronization requires separate local permission and retains it across restart", async () => {
  const f = await fixture();
  try {
    const controller = f.create();
    await controller.start();
    assert.deepEqual(f.calls, []);
    assert.equal((await controller.execute("code_upload")).error, "code_sync_disabled");
    assert.deepEqual(f.calls, []);
    await controller.authorize(true);
    assert.equal(controller.view().authorized, true);
    assert.equal(controller.view().status?.automatic_upload, false);
    await controller.execute("code_upload");
    await controller.stop();
    const restarted = f.create();
    await restarted.start();
    assert.equal(restarted.view().authorized, true);
    await restarted.authorize(false);
    const disabled = f.create();
    await disabled.start();
    assert.equal(disabled.view().authorized, false);
    await Promise.all([restarted.stop(), disabled.stop()]);
    const differentUser = new DshCodeSyncController({ ...f.options, binding: "another-user" });
    await differentUser.start();
    assert.equal(differentUser.view().authorized, false);
    await differentUser.stop();
  } finally { await f.cleanup(); }
});

test("DSH busy workspace blocks source writes and remote jobs cannot authorize code sync", async () => {
  const f = await fixture();
  const controller = f.create();
  try {
    await controller.start();
    f.jobs.push({ id: "job-own", sessionId: "session-own", kind: "code_upload", throughSequence: 0, status: "pending", targetRuntimeId: "runtime-dsh" });
    await controller.poll();
    assert.deepEqual(f.failed, [{ id: "job-own", code: "code_sync_disabled" }]);
    assert.equal(f.calls.includes("create"), false);
    await controller.authorize(true);
    f.setBusy(true);
    assert.equal((await controller.execute("code_download")).error, "code_sync_busy");
    assert.equal(f.calls.includes("code_download"), false);
    assert.equal((await controller.execute("code_sync_status")).error, undefined);
    assert.equal((await controller.execute("code_auto_upload_disable")).error, undefined);
    f.setBusy(false);
    await controller.execute("code_auto_upload_enable");
    assert.equal(controller.view().status?.automatic_upload, true);
  } finally { await controller.stop(); await f.cleanup(); }
});

test("DSH code jobs claim only the exact managed session/runtime and preserve unrelated jobs", async () => {
  const f = await fixture();
  const controller = f.create();
  try {
    await controller.start();
    await controller.authorize(true);
    const base = { kind: "code_upload" as const, throughSequence: 0, status: "pending" as const };
    f.jobs.push(
      { ...base, id: "other-device", sessionId: "session-own", targetRuntimeId: "runtime-other" },
      { ...base, id: "other-project", sessionId: "session-other", targetRuntimeId: "runtime-dsh" },
      { ...base, id: "untargeted", sessionId: "session-own" },
      { ...base, id: "conversation", kind: "local_turn_upload", sessionId: "session-own", targetRuntimeId: "runtime-dsh" },
      { ...base, id: "own", sessionId: "session-own", targetRuntimeId: "runtime-dsh" },
    );
    await controller.poll();
    assert.deepEqual(f.completed, ["own"]);
    assert.deepEqual(f.failed, []);
    assert.equal(f.calls.filter((call) => call === "code_upload").length, 1);
    assert.deepEqual(f.operations, ["own"]);
  } finally { await controller.stop(); await f.cleanup(); }
});

test("DSH resumes exact-runtime claimed code jobs with the stable operation receipt", async () => {
  const f = await fixture();
  const controller = f.create();
  try {
    await controller.start();
    await controller.authorize(true);
    f.jobs.push({ id: "recovery-retry", sessionId: "session-own", targetRuntimeId: "runtime-dsh",
      kind: "code_recover", throughSequence: 0, status: "claimed" });
    await controller.poll();
    assert.deepEqual(f.completed, ["recovery-retry"]);
    assert.deepEqual(f.operations, ["recovery-retry"]);
  } finally { await controller.stop(); await f.cleanup(); }
});

test("a lost DSH completion acknowledgement retries the same operation instead of failing finished local work", async () => {
  const f = await fixture();
  let attempts = 0;
  const complete = f.options.api.completeSnapshotRequest;
  f.options.api.completeSnapshotRequest = async (id) => {
    if (++attempts === 1) throw new Error("network disconnected while acknowledging");
    return complete(id);
  };
  const controller = f.create();
  try {
    await controller.start();
    await controller.authorize(true);
    f.jobs.push({ id: "lost-ack", sessionId: "session-own", targetRuntimeId: "runtime-dsh",
      kind: "code_recover", throughSequence: 0, status: "claimed" });
    await controller.poll();
    assert.deepEqual(f.failed, [], "completed local work must stay retryable after a lost acknowledgement");
    assert.deepEqual(f.completed, []);
    await controller.poll();
    assert.deepEqual(f.completed, ["lost-ack"]);
    assert.deepEqual(f.operations, ["lost-ack", "lost-ack"], "recovery retries use the durable receipt key");
    assert.equal(controller.view().error, undefined);
  } finally { await controller.stop(); await f.cleanup(); }
});

test("DSH public code errors never expose native filesystem or credential text", async () => {
  const f = await fixture();
  const controller = new DshCodeSyncController({ ...f.options, createEngine: () => ({
    async initialize() { throw new Error("secret credential at /private/sensitive/source"); },
    async status() { return initialStatus(); },
    async execute() { throw new Error("raw local exception"); },
    async tick() { return undefined; },
  }) });
  try {
    await controller.start();
    const result = await controller.authorize(true);
    assert.equal(result.error, "code_sync_failed");
    assert.doesNotMatch(JSON.stringify(result), /secret|private|sensitive/u);
  } finally { await controller.stop(); await f.cleanup(); }
});

test("GitHub controller claims only its exact provider/runtime and permits idle-safe controls while busy", async () => {
  const f = await fixture();
  const controller = new DshCodeSyncController({ ...f.options, actionKinds: GITHUB_CODE_ACTIONS });
  try {
    await controller.start();
    await controller.authorize(true);
    const base = { sessionId: "session-own", targetRuntimeId: "runtime-dsh", throughSequence: 0, status: "pending" as const };
    f.jobs.push(
      { ...base, id: "cloud", kind: "code_upload" },
      { ...base, id: "github", kind: "github_code_upload" },
      { ...base, id: "foreign", kind: "github_code_download", targetRuntimeId: "runtime-other" },
    );
    await controller.poll();
    assert.deepEqual(f.completed, ["github"]);
    assert.equal((await controller.execute("code_upload")).error, "code_action_invalid");
    f.setBusy(true);
    assert.equal((await controller.execute("github_code_update")).error, "code_sync_busy");
    assert.equal((await controller.execute("github_code_sync_status")).error, undefined);
    assert.equal((await controller.execute("github_code_auto_upload_disable")).error, undefined);
  } finally { await controller.stop(); await f.cleanup(); }
});

test("GitHub consent is independent and exact-target/revision bound, including restart and A to B to A", async () => {
  const f = await fixture();
  const cloud = f.create();
  let metadata: DshGitHubMetadata = {
    connection: { repository: "owner/source", base_branch: "main", revision: "revision-a", enabled: true },
    branch: "gatherthread/project/user", can_configure: true, can_write: true,
  };
  let offline = false;
  const options = {
    ...f.options, permissionPath: path.join(f.directory, "github-consent.json"),
    readMetadata: async () => { if (offline) throw new Error("secret connection failure"); return metadata; },
  };
  let controller = new DshGitHubCodeSyncController(options);
  try {
    await cloud.start();
    await cloud.authorize(true);
    f.calls.length = 0;
    await controller.start();
    assert.equal(controller.view().authorized, false);
    assert.deepEqual(f.calls, []);
    await controller.authorize(true, metadata.connection!);
    assert.equal(controller.view().authorized, true);
    await controller.stop();
    controller = new DshGitHubCodeSyncController(options);
    await controller.start();
    assert.equal(controller.view().authorized, true);
    const stale = metadata.connection!;
    metadata = { ...metadata, connection: { ...stale, repository: "owner/other", revision: "revision-b" } };
    await assert.rejects(controller.authorize(true, stale), { code: "code_github_binding_changed" });
    assert.equal(controller.view().authorized, false);
    assert.equal(controller.view().connection?.repository, "owner/other");
    metadata = { ...metadata, connection: { ...stale, revision: "revision-c" } };
    await controller.poll();
    assert.equal(controller.view().authorized, false);
    await controller.authorize(true, metadata.connection!);
    offline = true;
    await assert.rejects(controller.execute("github_code_upload"));
    assert.doesNotMatch(JSON.stringify(controller.view()), /secret connection/u);
    await controller.authorize(false);
    assert.equal(controller.view().authorized, false);
    assert.equal(cloud.view().authorized, true);
  } finally { await controller.stop(); await cloud.stop(); await f.cleanup(); }
});

test("GitHub revoked write access invalidates local authorization before executing or ticking", async () => {
  const f = await fixture();
  let metadata: DshGitHubMetadata = {
    connection: { repository: "owner/source", base_branch: "main", revision: "a", enabled: true },
    branch: "gatherthread/project/user", can_configure: true, can_write: true,
  };
  const controller = new DshGitHubCodeSyncController({ ...f.options, readMetadata: async () => metadata });
  try {
    await controller.start();
    await controller.authorize(true, metadata.connection!);
    f.calls.length = 0;
    metadata = { ...metadata, can_write: false };
    await assert.rejects(controller.execute("github_code_upload"), { code: "code_github_not_configured" });
    await controller.poll();
    assert.equal(controller.view().authorized, false);
    assert.deepEqual(f.calls, []);
  } finally { await controller.stop(); await f.cleanup(); }
});
