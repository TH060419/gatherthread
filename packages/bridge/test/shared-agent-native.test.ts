import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentShare, AgentShareExecutionCapsule, SharedExecutionCapability } from "@gatherthread/protocol";
import { CodexSharedAgentExecutor, ProjectOnlyFileAccess, SHARED_CODEX_PERMISSION_PROFILE, SharedAgentJobController,
  buildSharedAgentPrompt, nativeSharedEnvironment,
  sharedCodexConfiguration, stableSharedContextJson, validateSharedProjectRoots,
  CodexAppServerClient, SharedExecutorCleanupUnconfirmedError, SharedStoppedReceiptOutbox,
  type SharedAgentControlApi, type SharedAgentExecutor } from "../src/index.js";

export function sharedCapsule(): AgentShareExecutionCapsule {
  const context = { view: "original" as const, through_sequence: 0, content_revision: 0, items: [] };
  return { version: 1, source_runtime_id: "runtime-a", owner_device_id: "device-a", content: "Public shared task", context,
    context_digest: createHash("sha256").update(stableSharedContextJson(context)).digest("hex"), content_revision: 0, through_sequence: 0,
    claim_attempt: 1, lease_expires_at: new Date(Date.now() + 15000).toISOString(), deadline_at: new Date(Date.now() + 720000).toISOString(),
    max_request_seconds: 720, sandbox_scope: "project_only", job: { id: "shared-job", project_id: "project", share_id: "share", share_revision: 1,
      session_id: "solo-b", request_event_id: "request-b", status: "running", requester_user_id: "b", requester_display_name: "B",
      execution_profile: { harness: "codex", provider: "openai", model: "test-model", reasoning_effort: "high" },
      created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 720000).toISOString(), finished_at: null, error_code: null, cleanup_pending: false } };
}

function stoppedAcknowledgment(capsule: AgentShareExecutionCapsule) {
  return { job: { ...capsule.job, status: "cancelled", cleanup_pending: false }, replayed: false };
}

test("shared context authenticates the canonical scope and digest without owner's native history", () => {
  const capsule = sharedCapsule(); assert.match(buildSharedAgentPrompt(capsule), /CURRENT AUTHORIZED TASK/);
  assert.throws(() => buildSharedAgentPrompt({ ...capsule, context_digest: "a".repeat(64) }), /digest/);
  assert.throws(() => buildSharedAgentPrompt({ ...capsule, content_revision: 1 }), /changed/);
  assert.throws(() => buildSharedAgentPrompt({ ...capsule, through_sequence: 2 }), /metadata/);
});

test("actual descriptor-scoped filesystem tools deny traversal, symlink and hardlink escapes", async t => {
  if (process.platform === "win32") { t.skip("Windows project file confinement remains unsupported"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "gt-shared-fs-")); t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"), outside = path.join(root, "outside.txt"); await mkdir(project); await writeFile(outside, "PRIVATE_OUTSIDE");
  await writeFile(path.join(project, "inside.txt"), "inside"); await symlink(outside, path.join(project, "escape")); await link(outside, path.join(project, "hardlink"));
  await symlink(root, path.join(project, "outside-dir"));
  const credentials = [".env", ".env.local", "auth.json", ".credentials.yaml", "credentials.json",
    "nested/.env.production", "nested/.ssh/id_rsa", "nested/.kube/config", "nested/.config/private.json"];
  for (const name of credentials) { await mkdir(path.dirname(path.join(project, name)), { recursive: true }); await writeFile(path.join(project, name), "FICTIONAL_PRIVATE_VALUE"); }
  await writeFile(path.join(project, ".env.example"), "EXAMPLE_ONLY=true");
  await writeFile(path.join(project, ".env.sample"), "SAMPLE_ONLY=true");
  const files = new ProjectOnlyFileAccess(project);
  if (!await files.preflight()) { t.skip("POSIX Python descriptor APIs unavailable; sharing fails closed"); return; }
  assert.equal((await files.execute({ action: "read", path: "inside.txt" })).content, "inside");
  await files.execute({ action: "write", path: "inside.txt", content: "updated" });
  assert.equal(await readFile(path.join(project, "inside.txt"), "utf8"), "updated");
  for (const target of ["../outside.txt", "escape", "hardlink", "outside-dir/outside.txt", ".git/config"]) {
    await assert.rejects(files.execute({ action: "read", path: target }));
    await assert.rejects(files.execute({ action: "write", path: target, content: "stolen" }));
  }
  assert.equal(await readFile(outside, "utf8"), "PRIVATE_OUTSIDE");
  for (const target of [...credentials, ".ENV", "nested/.ssh", "nested/.kube", "nested/.config"]) {
    for (const action of ["list", "read", "write"] as const) await assert.rejects(files.execute({ action, path: target, ...(action === "write" ? { content: "" } : {}) }));
  }
  for (const name of credentials) assert.equal(await readFile(path.join(project, name), "utf8"), "FICTIONAL_PRIVATE_VALUE");
  assert.equal((await files.execute({ action: "read", path: ".env.example" })).content, "EXAMPLE_ONLY=true");
  await files.execute({ action: "write", path: ".env.sample", content: "" });
  await files.execute({ action: "write", path: "ordinary-code.ts", content: "" });
  assert.equal((await files.execute({ action: "read", path: "ordinary-code.ts" })).content, "");
  const rootNames = (await files.execute({ action: "list", path: "." })).content.split("\n");
  assert.ok(rootNames.includes(".env.example")); assert.ok(rootNames.includes(".env.sample"));
  for (const name of credentials.filter(name => !name.includes("/"))) assert.equal(rootNames.includes(name), false);
  assert.equal((await files.execute({ action: "list", path: "nested" })).content, "");
  assert.doesNotMatch((await files.execute({ action: "list", path: "." })).content, /escape|outside-dir/u);
  await assert.rejects(validateSharedProjectRoots(project, path.join(project, "private")), /outside/);
});

test("shared Codex has a fresh private native home, exact permission profile and only public assistant output", async t => {
  if (process.platform === "win32") { t.skip("Windows project file confinement remains unsupported"); return; }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-shared-codex-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"), control = path.join(root, "private"), auth = path.join(root, "native-auth-fixture.json");
  await mkdir(project); await writeFile(auth, JSON.stringify({ fixture: true })); await writeFile(path.join(project, "inside.txt"), "INSIDE_FIXTURE");
  let nativeHome = "", starts = 0, closed = false, observedRoots: string[] = [];
  let call: NonNullable<ConstructorParameters<typeof CodexAppServerClient>[0]["dynamicToolCall"]>;
  const executor = new CodexSharedAgentExecutor({ command: process.execPath, workspacePath: project, privateStateRoot: control, authSourcePath: auth,
    env: { PATH: process.env.PATH, GATHERTHREAD_DEVICE_TOKEN: "excluded", PRIVATE_KEY: "excluded" }, sandboxProbe: async () => true,
    clientFactory: options => {
      nativeHome = options.env!.CODEX_HOME!;
      call = options.dynamicToolCall!;
      assert.equal(options.env!.GATHERTHREAD_DEVICE_TOKEN, undefined); assert.equal(options.env!.PRIVATE_KEY, undefined);
      assert.equal(options.env!.HOME, nativeHome); assert.equal(options.env!.USERPROFILE, nativeHome);
      assert.equal(options.env!.XDG_CONFIG_HOME, path.join(nativeHome, "xdg-config"));
      return { async start() { starts++; }, async request(method: string, input: Record<string, unknown>) {
        assert.equal(method, "thread/start"); assert.equal(input.permissions, SHARED_CODEX_PERMISSION_PROFILE);
        assert.equal(input.sandbox, undefined); assert.equal(input.allowProviderModelFallback, false);
        assert.equal((input.config as Record<string, unknown>)["features.shell_tool"], false);
        assert.equal((input.config as Record<string, unknown>)["features.goals"], false);
        assert.deepEqual((input.dynamicTools as Array<{ name: string }>).map(tool => tool.name), ["gatherthread_project_list", "gatherthread_project_read", "gatherthread_project_write"]);
        assert.deepEqual(input.runtimeWorkspaceRoots, [project]);
        assert.equal(await readFile(path.join(nativeHome, "auth.json"), "utf8"), JSON.stringify({ fixture: true }));
        return { thread: { id: "fresh-native" }, model: "test-model", modelProvider: "openai", cwd: project,
          runtimeWorkspaceRoots: observedRoots, activePermissionProfile: { id: SHARED_CODEX_PERMISSION_PROFILE }, approvalPolicy: "never", instructionSources: [] };
      }, async runTurn(input: Record<string, unknown>) {
        assert.equal(input.threadId, "fresh-native"); assert.equal(input.model, "test-model"); assert.equal(input.effort, "high");
        (input.onStarted as (id: string) => void)("exact-native-turn");
        const tool = { threadId: "fresh-native", turnId: "exact-native-turn", callId: "file-call", namespace: null, tool: "gatherthread_project_read", arguments: { path: "inside.txt" } };
        assert.deepEqual(await call(tool), { success: true, contentItems: [{ type: "inputText", text: "INSIDE_FIXTURE" }] });
        assert.equal((await call({ ...tool, tool: "exec_command", arguments: { cmd: "must never execute" } })).success, false);
        assert.equal((await call({ ...tool, turnId: "other-turn" })).success, false);
        assert.equal((await call({ ...tool, arguments: { path: "../native-auth-fixture.json" } })).success, false);
        return { items: [{ type: "reasoning", text: "HIDDEN" }, { type: "agentMessage", phase: "commentary", text: "INTERMEDIATE" },
          { type: "agentMessage", phase: "final_answer", text: "Public result" }] };
      }, async dispose() { closed = true; } } as unknown as CodexAppServerClient;
    } });
  assert.ok(await executor.preflight());
  assert.equal((await executor.execute(sharedCapsule(), new AbortController().signal)).content, "Public result");
  assert.equal(starts, 1); assert.equal(closed, true); await assert.rejects(readFile(path.join(nativeHome, "auth.json")));
  observedRoots = [control];
  await assert.rejects(executor.execute(sharedCapsule(), new AbortController().signal), /verify its isolated project permissions/);
  assert.equal(starts, 2); await assert.rejects(readFile(path.join(nativeHome, "auth.json")));
  assert.match(sharedCodexConfiguration(), /":root" = "deny"/); assert.match(sharedCodexConfiguration(), /inherit = "none"/);
  assert.match(sharedCodexConfiguration(), /goals = false/);
  assert.equal(nativeSharedEnvironment("private", { OPENAI_API_KEY: "must-not-reach-command", PATH: "path" }).OPENAI_API_KEY, undefined);
  assert.equal(nativeSharedEnvironment("private", { HOME: "owner-home", USERPROFILE: "owner-home", XDG_DATA_HOME: "owner-data" }).HOME, "private");
});

test("native restart reports OFF then READY for a source with no existing share", async () => {
  const reports: string[] = [];
  const api = { async listShares() { return { shares: [] }; },
    async reportSourceAvailability(project: string, runtime: string, state: string) {
      assert.equal(project, "project"); assert.equal(runtime, "runtime-a"); reports.push(state);
    } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute() { throw new Error("No grant exists"); } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    availability: async () => "ready" });
  await controller.tick(); assert.deepEqual(reports, ["offline"]);
  await controller.tick(); assert.deepEqual(reports, ["offline", "ready"]);
  await controller.tick(); assert.deepEqual(reports, ["offline", "ready"]);
  await controller.stop(); assert.deepEqual(reports, ["offline", "ready", "offline"]);
});

test("native restart withdraws old grants and READY requires an owner manual re-enable", async () => {
  const capsule = sharedCapsule(); let enabled = true, calls = 0;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async reportSourceAvailability(_project: string, _runtime: string, state: string) { if (state !== "ready") enabled = false; },
    async reportAvailability() {}, async listShares() { return { shares: [{ ...share, enabled }] }; },
    async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" }] }; },
    async claim() { return { job: capsule.job, capsule, replayed: false }; }, async abortAck() { return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute(_input, signal) { calls++;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted();
    return { content: "public", observedModel: "test-model" }; } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    availability: async () => "ready" });
  await controller.tick(); await controller.tick(); assert.equal(enabled, false); assert.equal(calls, 0);
  enabled = true; await controller.tick(); assert.equal(calls, 1); await controller.stop();
});

test("withdrawal aborts native work and acknowledges cleanup only after executor settles", async () => {
  const capsule = sharedCapsule(); let enabled = true, stopped = false, acknowledgments = 0, calls = 0;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async listShares() { return { shares: [{ ...share, enabled }] }; }, async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" as const }] }; },
    async reportSourceAvailability() {}, async reportAvailability() {}, async claim() { return { job: capsule.job, capsule, replayed: false }; },
    async renewLease() { return { job: capsule.job, lease_expires_at: capsule.lease_expires_at, deadline_at: capsule.deadline_at }; },
    async complete() { throw new Error("withdrawn must not publish"); }, async abortAck() { assert.equal(stopped, true); acknowledgments++; return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute(_input, signal) { calls++;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => setTimeout(() => { stopped = true; resolve(); }, 10), { once: true }));
    signal.throwIfAborted(); return { content: "must not publish", observedModel: "test-model" }; } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    availability: async () => "ready" });
  await controller.tick(); await controller.tick(); assert.equal(calls, 1); enabled = false; await controller.tick(); assert.equal(acknowledgments, 0);
  await controller.stop(); assert.equal(acknowledgments, 1);
});

test("independent local watchdog stops execution while control HTTP remains stalled", async () => {
  const capsule = sharedCapsule(); let now = Date.now(), stalled = false, aborted = false;
  let release!: () => void;
  const entered = Promise.withResolvers<void>();
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1, enabled: true, available: true } as AgentShare;
  const api = { async listShares() { if (stalled) await new Promise<void>(resolve => { release = resolve; entered.resolve(); }); return { shares: [share] }; },
    async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" as const }] }; }, async reportSourceAvailability() {}, async reportAvailability() {},
    async claim() { return { job: capsule.job, capsule, replayed: false }; }, async abortAck() { return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute(_input, signal) {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    signal.throwIfAborted(); return { content: "late", observedModel: "test-model" }; } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    availability: async () => "ready", now: () => now });
  await controller.tick(); await controller.tick(); stalled = true; const blocked = controller.tick(); await entered.promise;
  now += 10001; void controller.tick(); assert.equal(aborted, true); release(); await blocked; await controller.stop();
});

test("an accepted job can claim and renew while its own reservation makes new requests unavailable", async () => {
  const capsule = sharedCapsule(); let calls = 0, renewals = 0;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: false } as AgentShare;
  const api = { async listShares() { return { shares: [share] }; }, async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" as const }] }; },
    async reportSourceAvailability() {}, async reportAvailability() {}, async claim() { return { job: capsule.job, capsule, replayed: false }; },
    async renewLease() { renewals++; return { job: capsule.job, lease_expires_at: capsule.lease_expires_at, deadline_at: capsule.deadline_at }; },
    async abortAck() { return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute(_input, signal) { calls++;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted();
    return { content: "public", observedModel: "test-model" }; } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    availability: async () => "ready" });
  await controller.tick(); await controller.tick(); assert.equal(calls, 1); await controller.tick(); assert.equal(renewals, 1); await controller.stop();
});

test("simultaneous shutdown callers await the same native cleanup barrier", async () => {
  const capsule = sharedCapsule(), rootAbort = new AbortController(); let release!: () => void, exited = false;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async listShares() { return { shares: [share] }; }, async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" as const }] }; },
    async reportSourceAvailability() {}, async reportAvailability() {}, async claim() { return { job: capsule.job, capsule, replayed: false }; }, async abortAck() { return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute(_input, signal) {
    await new Promise<void>(resolve => { release = () => { exited = true; resolve(); }; }); signal.throwIfAborted();
    return { content: "late", observedModel: "test-model" }; } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    signal: rootAbort.signal, availability: async () => "ready" });
  await controller.tick(); await controller.tick(); rootAbort.abort(); const stop1 = controller.stop(), stop2 = controller.stop();
  assert.equal(stop1, stop2); assert.equal(exited, false); release(); await stop2; assert.equal(exited, true);
});

test("shutdown racing an accepted claim acknowledges the never-started native job", async () => {
  const capsule = sharedCapsule(), rootAbort = new AbortController(); let finishClaim!: () => void, calls = 0, acknowledgments = 0;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async reportSourceAvailability() {}, async reportAvailability() {}, async listShares() { return { shares: [share] }; },
    async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" }] }; }, async claim() {
      await new Promise<void>(resolve => { finishClaim = resolve; }); return { job: capsule.job, capsule, replayed: false };
    }, async abortAck() { acknowledgments++; return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute() { calls++; throw new Error("Must not start"); } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    signal: rootAbort.signal, availability: async () => "ready" });
  await controller.tick(); const claimTick = controller.tick();
  for (let i = 0; !finishClaim && i < 10; i++) await Promise.resolve();
  assert.equal(typeof finishClaim, "function"); rootAbort.abort(); const stopped = controller.stop(); finishClaim();
  await claimTick; await stopped; assert.equal(calls, 0); assert.equal(acknowledgments, 1);
});

test("a connection interruption during an in-flight claim prevents execution before cleanup", async () => {
  const capsule = sharedCapsule(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let now = Date.now(), calls = 0, acknowledgments = 0, enabled = false;
  const reports: string[] = [];
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async reportSourceAvailability(_project: string, _runtime: string, state: string) { reports.push(state); if (state !== "ready") enabled = false; },
    async reportAvailability() {}, async listShares() { return { shares: [{ ...share, enabled }] }; },
    async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" }] }; }, async claim() {
      entered.resolve(); await release.promise; return { job: capsule.job, capsule, replayed: false };
    }, async abortAck() { acknowledgments++; return stoppedAcknowledgment(capsule); } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute() { calls++; throw new Error("Must not execute after connection loss"); } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor,
    now: () => now });
  await controller.tick(); await controller.tick(); enabled = true;
  const claim = controller.tick(); await entered.promise; now += 7000; const watchdog = controller.tick(); release.resolve(); await claim; await watchdog;
  assert.equal(calls, 0); await controller.tick(); assert.ok(reports.includes("offline")); assert.equal(acknowledgments, 1);
  await controller.tick(); assert.equal(enabled, false); await controller.stop();
});

test("durable stopped receipts retry after reconnect without exposing context or acknowledging unknown orphan work", async t => {
  if (process.platform === "win32") { t.skip("Windows native sharing and its private POSIX cleanup outbox remain unsupported"); return; }
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gt-shared-outbox-"))); t.after(() => rm(directory, { recursive: true, force: true }));
  const capsule = sharedCapsule(); let connected = false, stopped = false, calls = 0, acknowledged = 0, enabled = true;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async reportSourceAvailability() {}, async reportAvailability() {}, async listShares() { return { shares: [{ ...share, enabled }] }; },
    async listJobs() { return { jobs: [{ ...capsule.job, status: connected ? "cancelled" : "queued", cleanup_pending: true }] }; },
    async claim() { return { job: capsule.job, capsule, replayed: false }; }, async abortAck() {
      assert.equal(stopped, true); if (!connected) throw new Error("Disconnected"); acknowledged++; return stoppedAcknowledgment(capsule);
    } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute(_input, signal) { calls++;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
    signal.throwIfAborted(); return { content: "not published", observedModel: "test-model" }; } };
  const options = { projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", privateStateRoot: directory, api, executor,
    availability: async () => "ready" as const };
  const first = new SharedAgentJobController(options); await first.tick(); await first.tick(); await first.stop();
  assert.equal(stopped, true); assert.equal(acknowledged, 0);
  const outbox = new SharedStoppedReceiptOutbox(directory), receipts = await outbox.list(options);
  assert.equal(receipts.length, 1); assert.deepEqual(Object.keys(receipts[0]!).sort(), ["claimAttempt", "jobId", "ownerDeviceId", "projectId", "sourceRuntimeId", "version"]);
  const names = await readdir(path.join(directory, "stopped-receipts")); assert.equal(names.length, 1);
  const stored = path.join(directory, "stopped-receipts", names[0]!);
  assert.equal((await stat(stored)).mode & 0o077, 0); assert.doesNotMatch(await readFile(stored, "utf8"), /Public shared task|context|content/u);
  await assert.rejects(outbox.list({ ...options, ownerDeviceId: "another-device" }), /scope mismatch/);
  connected = true; enabled = false;
  const second = new SharedAgentJobController(options); await second.tick(); assert.equal(acknowledged, 1);
  assert.deepEqual(await outbox.list(options), []); await second.stop();
  enabled = true;
  const third = new SharedAgentJobController(options); await third.tick(); await third.tick(); await third.stop();
  assert.equal(calls, 1); assert.equal(acknowledged, 1); // A cancelled unknown orphan has no local exit proof.
});

test("unconfirmed native teardown never acknowledges stopped work or releases another local job", async () => {
  const capsule = sharedCapsule(); let calls = 0, acknowledgments = 0, completions = 0;
  const share = { id: "share", project_id: "project", owner_device_id: "device-a", source_runtime_id: "runtime-a", revision: 1,
    enabled: true, available: true } as AgentShare;
  const api = { async listShares() { return { shares: [share] }; }, async listJobs() { return { jobs: [{ ...capsule.job, status: "queued" as const }] }; },
    async reportSourceAvailability() {}, async reportAvailability() {}, async claim() { return { job: capsule.job, capsule, replayed: false }; },
    async abortAck() { acknowledgments++; }, async complete() { completions++; } } as unknown as SharedAgentControlApi;
  const executor: SharedAgentExecutor = { async preflight() { return undefined; }, async execute() { calls++; throw new SharedExecutorCleanupUnconfirmedError(); },
    async close() { throw new SharedExecutorCleanupUnconfirmedError(); } };
  const controller = new SharedAgentJobController({ projectId: "project", sourceRuntimeId: "runtime-a", ownerDeviceId: "device-a", api, executor, availability: async () => "ready" });
  await controller.tick(); await controller.tick(); await Promise.resolve(); await controller.tick(); await controller.tick();
  assert.equal(calls, 1); assert.equal(acknowledgments, 0); assert.equal(completions, 0);
  await assert.rejects(controller.stop(), SharedExecutorCleanupUnconfirmedError);
});

test("a dedicated Codex process group stops background file writes before native cleanup returns", { timeout: 15000 }, async t => {
  if (process.platform === "win32") { t.skip("Windows job confinement remains unsupported"); return; }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-shared-group-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = path.join(root, "fake-native.mjs"), ticks = path.join(root, "ticks");
  await writeFile(fake, `
import {spawn} from 'node:child_process'; import {createInterface} from 'node:readline';
process.on('SIGTERM',()=>{});
const worker=spawn(process.execPath,['-e',"const f=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>f.appendFileSync(process.env.GT_TICK_FILE,'x'),10)"],{env:{GT_TICK_FILE:process.env.GT_TICK_FILE},stdio:'ignore'});
worker.unref();
for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line); if(m.id!==undefined) process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n'); }
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fake], cwd: root,
    env: { GT_TICK_FILE: ticks }, isolatedProcessGroup: true }); t.after(() => client.dispose());
  await client.start();
  for (let i = 0; i < 100; i++) { if ((await readFile(ticks, "utf8").catch(() => "")).length > 0) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok((await readFile(ticks, "utf8")).length > 0);
  await client.dispose(); const after = await readFile(ticks, "utf8");
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(await readFile(ticks, "utf8"), after);
});
