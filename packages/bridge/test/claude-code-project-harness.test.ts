import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeCodeProjectHarness } from "../src/claude-code-project-harness.js";
import { processCodeSyncControlJobs, type ManagedSession } from "../src/codex-connect.js";
import type { CollaborationApi, CommitLocalTurnInput, HarnessExecutionInput, ProjectSummary, RegisteredRuntime, RuntimeRegistration, SessionSummary } from "../src/types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const project: ProjectSummary = { id: "project-1", name: "Test", role: "owner", state: "active", sessionCount: 0 };

test("native Hooks in an owned Web execution neither block it nor rediscover/upload another Solo", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-owned-hooks-"))), capture = path.join(dir, "run.json");
  const script = path.join(dir, "claude.mjs");
  await writeFile(script, `import {writeFileSync} from 'node:fs';const args=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;writeFileSync(process.env.CLAUDE_TEST_CAPTURE,JSON.stringify({session_id:args[args.indexOf('--session-id')+1]}));setInterval(()=>{},1000);`);
  const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture",
    command: process.execPath, commandArgs: [script], env: { ...process.env, CLAUDE_TEST_CAPTURE: capture } });
  const session: SessionSummary = { id: "session-1", projectId: project.id, mode: "multi", name: "Web", ownerUserId: "user-1", state: "active", latestSequence: 0 };
  const binding = harness.createSessionBinding({ session, sessionKey: "web", statePath: "" });
  await binding.activateLocalPublishing?.();
  const controller = new AbortController();
  const running = binding.executor.execute({ request: { id: "request-web", sessionId: session.id, sequence: 1, type: "agent_request", actorId: "user-1", timestamp: new Date().toISOString(),
    payload: { content: "Task", execution_profile: { harness: "claude-code", provider: "anthropic", model: "claude-sonnet-fixture", runtime_id: "runtime-1" } } }, canonicalHistory: [],
    runtime: { id: "runtime-1", userId: "user-1", deviceId: "device-1", sessionId: session.id, harness: "claude-code", provider: "anthropic", model: "claude-sonnet-fixture", localSessionId: binding.localSessionId, captureFidelity: "harness_transcript" }, signal: controller.signal });
  void running.catch(() => undefined);
  try {
    const deadline = Date.now() + 10000;
    let metadata: { session_id: string };
    for (;;) {
      try { metadata = JSON.parse(await readFile(capture, "utf8")); break; }
      catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    const control = { api: {} as CollaborationApi, actorUserId: "user-1", actorDeviceId: "device-1", project };
    for (const name of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]) {
      assert.deepEqual(await harness.handleNativeHook({ ...metadata, cwd: dir, hook_event_name: name, prompt: "DO_NOT_CAPTURE", last_assistant_message: "DO_NOT_UPLOAD" }, control), { handled: true });
      assert.equal(await harness.isWorkspaceBusy(), true);
    }
    const other = await harness.handleNativeHook({ session_id: randomUUID(), cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "Local human turn" }, control);
    assert.equal(other.block, true);
    assert.equal((await binding.getLocalSyncStatus?.())?.pendingLocalTurns, 0);
    controller.abort();
    await assert.rejects(running, /stopped/);
    assert.equal(await harness.isWorkspaceBusy(), false);
    // After process exit, the retired owned UUID no longer bypasses normal
    // native validation/discovery (this synthetic API intentionally has none).
    await assert.rejects(harness.handleNativeHook({ ...metadata, cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "Task" }, control), /current project API/);
  } finally { controller.abort(); await running.catch(() => undefined); await harness.close(); }
});

async function nativeContextFixture() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-terminal-"))), sessions: SessionSummary[] = [];
  const api = {
    async listProjects() { return [project]; }, async listProjectSessions() { return sessions; },
    async createSession(_id: string, body: { title: string; mode: "solo"; idempotencyKey: string }) {
      const session: SessionSummary = { id: `session-${hash(`user-1\0${body.idempotencyKey}`).slice(0, 32)}`,
        name: body.title, mode: body.mode, projectId: project.id, ownerUserId: "user-1", state: "active", latestSequence: 1 };
      sessions.push(session); return session;
    },
    async readContext() { return { view: "summary", through_sequence: 1, content_revision: 0,
      items: [{ kind: "original", event_id: "chat-1", sequence: 1, actor_user_id: "user-2", content: "UNDISPATCHED_CONTEXT_SENTINEL" }] }; },
  } as unknown as CollaborationApi;
  const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture" });
  const session_id = randomUUID(), control = { api, actorUserId: "user-1", actorDeviceId: "device-1", project };
  return { harness, event: { session_id, cwd: dir }, control };
}

test("rejected terminal Claude capture releases activity and preserves context for another prompt", async t => {
  for (const answer of ["", "x".repeat(128 * 1024 + 1), undefined]) await t.test(answer === undefined ? "missing" : answer ? "oversized" : "empty", async () => {
    const { harness, event, control } = await nativeContextFixture();
    try {
      await harness.handleNativeHook({ ...event, hook_event_name: "UserPromptSubmit", prompt: "First question" }, control);
      await harness.handleNativeHook({ ...event, hook_event_name: "Stop", last_assistant_message: answer }, control).catch(() => undefined);
      assert.equal(await harness.isWorkspaceBusy(), false);
      assert.equal(await harness.withWorkspaceOperation(async () => "available"), "available");
      const retry = await harness.handleNativeHook({ ...event, hook_event_name: "UserPromptSubmit", prompt: "Next question" }, control);
      assert.match(retry.additionalContext ?? "", /UNDISPATCHED_CONTEXT_SENTINEL/);
    } finally { await harness.close(); }
  });
});

test("failed native prompts never advance the shared-context delivery cursor", async t => {
  for (const terminal of ["StopFailure", "SessionEnd"]) await t.test(terminal, async () => {
    const { harness, event, control } = await nativeContextFixture();
    try {
      const lost = await harness.handleNativeHook({ ...event, hook_event_name: "UserPromptSubmit", prompt: "Lost Hook response" }, control);
      assert.match(lost.additionalContext ?? "", /UNDISPATCHED_CONTEXT_SENTINEL/);
      await harness.handleNativeHook({ ...event, hook_event_name: terminal }, control);
      const retry = await harness.handleNativeHook({ ...event, hook_event_name: "UserPromptSubmit", prompt: "Retry question" }, control);
      assert.match(retry.additionalContext ?? "", /UNDISPATCHED_CONTEXT_SENTINEL/);
    } finally { await harness.close(); }
  });
});

test("Claude native Hooks create only generic Solo metadata, keep upload off, inject context and upload a completed turn idempotently", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-hooks-")));
  const sessions: SessionSummary[] = [];
  const creations: unknown[] = [], commits: CommitLocalTurnInput[] = [];
  let largeContext = true;
  let loseFirstCommitReply = true;
  const committedIds = new Set<string>();
  const api = {
    async listProjects() { return [project]; },
    async listProjectSessions() { return sessions; },
    async createSession(_project: string, body: { title: string; mode: "solo"; idempotencyKey: string }) {
      creations.push(body); const session: SessionSummary = { id: `session-${hash(`user-1\0${body.idempotencyKey}`).slice(0, 32)}`,
        name: body.title, mode: body.mode, projectId: project.id, ownerUserId: "user-1", role: "owner", state: "active", latestSequence: 1, contentRevision: 0 };
      sessions.push(session); return session;
    },
    async registerRuntime(value: RuntimeRegistration) { return { ...value, id: "runtime-1", userId: "user-1" } as RegisteredRuntime; },
    async readContext() { return { view: "summary", through_sequence: 1, content_revision: 0, items: [{ kind: "original", event_id: "chat-1", sequence: 1,
      actor_user_id: "user-2", content: largeContext ? '"'.repeat(40000) : "Shared public context" }] }; },
    async commitLocalTurn(_session: string, value: CommitLocalTurnInput) {
      if (!committedIds.has(value.localTurnId)) { committedIds.add(value.localTurnId); commits.push(value); }
      if (loseFirstCommitReply) { loseFirstCommitReply = false; throw new Error("Fixture lost acknowledgment"); }
      return { requestEvent: { id: `request-${value.localTurnId}` }, responseEvent: { id: `answer-${value.localTurnId}` }, toolEvents: [] };
    },
  } as unknown as CollaborationApi;
  const config = path.join(dir, "config");
  const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture", nativeConfigDirectory: config });
  const control = { api, actorUserId: "user-1", actorDeviceId: "device-1", project };
  const session_id = randomUUID();
  await harness.handleNativeHook({ hook_event_name: "SessionStart", session_id, cwd: dir, model: "claude-sonnet-fixture" }, control);
  await assert.rejects(harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id, cwd: dir, prompt: "PRIVATE_LOCAL_PROMPT" }, control), /context is too large/);
  largeContext = false;
  const hooked = await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id, cwd: dir, prompt: "PRIVATE_LOCAL_PROMPT" }, control);
  assert.match(hooked.additionalContext ?? "", /Shared public context/);
  assert.doesNotMatch(JSON.stringify(creations), /PRIVATE_LOCAL_PROMPT|[0-9a-f]{8}-[0-9a-f]{4}-/);
  const session = sessions[0]!;
  const binding = harness.createSessionBinding({ session, sessionKey: hash(session.id).slice(0, 24), statePath: path.join(dir, "ignored.json") });
  await binding.activateLocalPublishing?.();
  assert.equal((await binding.getLocalSyncStatus?.())?.automaticUpload, false);
  const projectDirectory = path.join(config, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  await mkdir(projectDirectory, { recursive: true });
  const transcript = path.join(projectDirectory, `${session_id}.jsonl`);
  const records = [
    { type: "user", sessionId: session_id, cwd: dir, timestamp: new Date().toISOString(), message: { content: "PRIVATE_LOCAL_PROMPT" } },
    { type: "assistant", sessionId: session_id, cwd: dir, timestamp: new Date().toISOString(), message: { model: "claude-opus-fixture", content: [{ type: "text", text: "Public answer" }] } },
  ];
  await writeFile(transcript, records.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  await harness.handleNativeHook({ hook_event_name: "Stop", session_id, cwd: dir, last_assistant_message: "Public answer", transcript_path: transcript }, control);
  assert.equal(commits.length, 0);
  assert.equal((await binding.getLocalSyncStatus?.())?.pendingLocalTurns, 1);
  const runtime = await api.registerRuntime({ ...harness.descriptor, sessionId: session.id, deviceId: "device-1", localSessionId: binding.localSessionId });
  await assert.rejects(binding.uploadLocalTurns!({ api, runtime }), /lost acknowledgment/);
  assert.equal((await binding.getLocalSyncStatus?.())?.pendingLocalTurns, 1);
  // A later turn must not make the first idempotent receipt permanently unprovable.
  await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id, cwd: dir, prompt: "Second question" }, control);
  records.push(
    { type: "user", sessionId: session_id, cwd: dir, timestamp: new Date().toISOString(), message: { content: "Second question" } },
    { type: "assistant", sessionId: session_id, cwd: dir, timestamp: new Date().toISOString(), message: { model: "claude-haiku-fixture", content: [{ type: "text", text: "Second answer" }] } },
  );
  await writeFile(transcript, records.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  await harness.handleNativeHook({ hook_event_name: "Stop", session_id, cwd: dir, last_assistant_message: "Second answer", transcript_path: transcript }, control);
  assert.equal((await binding.getLocalSyncStatus?.())?.pendingLocalTurns, 2);
  await binding.uploadLocalTurns?.({ api, runtime });
  await binding.uploadLocalTurns?.({ api, runtime });
  assert.equal(commits.length, 2);
  assert.equal(commits[0]?.observedModel, "claude-opus-fixture");
  assert.equal(commits[1]?.observedModel, "claude-haiku-fixture");
  assert.doesNotMatch(JSON.stringify(commits), /transcriptPath|nativeSessionId|promptDigest|answerDigest/);
  assert.equal((await binding.getLocalSyncStatus?.())?.pendingLocalTurns, 0);
  await binding.setLocalAutoUpload?.(true);
  assert.equal((await binding.getLocalSyncStatus?.())?.automaticUpload, true);
  await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id, cwd: dir, prompt: "Interrupted" }, control);
  assert.equal(await binding.isLocalRunActive?.(), true);
  await harness.handleNativeHook({ hook_event_name: "StopFailure", session_id, cwd: dir }, control);
  assert.equal(await binding.isLocalRunActive?.(), false);
  await binding.executor.projectCanonicalEvents?.([], runtime);
  assert.equal(await binding.executor.prepareCanonicalProjection?.(runtime), 0);
  await harness.deactivateExecutionBindings({ retainSessionIds: [] });
  const replacement = harness.createSessionBinding({ session, sessionKey: hash(session.id).slice(0, 24), statePath: "" });
  assert.notEqual(replacement, binding);
  await harness.close();
});

test("Claude native hook refuses another workspace and never creates cloud state for a viewer", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-hook-acl-")));
  const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture" });
  let created = 0;
  const api = { async listProjects() { return [{ ...project, role: "viewer" }]; }, async createSession() { created++; } } as unknown as CollaborationApi;
  const control = { api, actorUserId: "user-1", actorDeviceId: "device-1", project };
  await assert.rejects(harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id: randomUUID(), cwd: path.dirname(dir), prompt: "private" }, control), /workspace/);
  const result = await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id: randomUUID(), cwd: dir, prompt: "private" }, control);
  assert.equal(result.handled, false); assert.equal(created, 0);
  await harness.close();
});

test("native sync uploads completed turns during its own prompt without publishing the active draft", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-native-sync-"))), config = path.join(dir, "config");
  const sessions: SessionSummary[] = [], commits: CommitLocalTurnInput[] = [];
  const api = {
    async listProjects() { return [project]; }, async listProjectSessions() { return sessions; },
    async createSession(_id: string, body: { title: string; mode: "solo"; idempotencyKey: string }) {
      const session: SessionSummary = { id: `session-${hash(`user-1\0${body.idempotencyKey}`).slice(0, 32)}`,
        name: body.title, mode: body.mode, projectId: project.id, ownerUserId: "user-1", state: "active", latestSequence: 0 };
      sessions.push(session); return session;
    },
    async readContext() { return { view: "summary", through_sequence: 0, content_revision: 0, items: [] }; },
    async commitLocalTurn(_id: string, value: CommitLocalTurnInput) {
      commits.push(value); return { requestEvent: { id: "request-1" }, responseEvent: { id: "answer-1" } };
    },
  } as unknown as CollaborationApi;
  const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture", nativeConfigDirectory: config });
  const session_id = randomUUID(), control = { api, actorUserId: "user-1", actorDeviceId: "device-1", project };
  try {
    await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id, cwd: dir, prompt: "Completed question" }, control);
    const transcript = path.join(config, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), `${session_id}.jsonl`);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, [
      { type: "user", sessionId: session_id, cwd: dir, timestamp: new Date().toISOString(), message: { content: "Completed question" } },
      { type: "assistant", sessionId: session_id, cwd: dir, timestamp: new Date().toISOString(), message: { model: "claude-sonnet-fixture", content: [{ type: "text", text: "Completed answer" }] } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
    await harness.handleNativeHook({ hook_event_name: "Stop", session_id, cwd: dir, last_assistant_message: "Completed answer", transcript_path: transcript }, control);
    const session = sessions[0]!, binding = harness.createSessionBinding({ session, sessionKey: "test", statePath: "" });
    const runtime = { ...harness.descriptor, id: "runtime-1", userId: "user-1", deviceId: "device-1", sessionId: session.id, localSessionId: binding.localSessionId } as RegisteredRuntime;
    await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id, cwd: dir, prompt: "/gatherthread:sync upload completed turns" }, control);
    assert.equal((await binding.getLocalSyncStatus!()).uploadableLocalTurns, 1);
    assert.equal((await binding.uploadLocalTurns!({ api, runtime })).uploadedLocalTurns, 1);
    assert.equal((await binding.uploadLocalTurns!({ api, runtime })).uploadedLocalTurns, 0);
    assert.equal(commits.length, 1);
    assert.equal((commits[0]!.requestPayload as { content: string }).content, "Completed question");
    assert.equal(await binding.isLocalRunActive!(), true);
    assert.equal((await binding.getLocalSyncStatus!()).automaticUpload, false);
    await binding.setLocalAutoUpload!(true);
    await binding.synchronizeLocalTurns!({ api, runtime });
    assert.equal(commits.length, 1, "Automatic sync cannot publish the active draft");
  } finally { await harness.close(); }
});

test("Claude native discovery locks workspace activity before ACL awaits, and source sync blocks a new native prompt", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-hook-busy-")));
  const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture" });
  let releaseAcl!: () => void;
  const acl = new Promise<void>(resolve => { releaseAcl = resolve; });
  const api = { async listProjects() { await acl; return [{ ...project, role: "viewer" }]; } } as unknown as CollaborationApi;
  const control = { api, actorUserId: "user-1", actorDeviceId: "device-1", project };
  const nativeId = randomUUID();
  const pending = harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id: nativeId, cwd: dir, prompt: "Private first native prompt" }, control);
  assert.equal(await harness.isWorkspaceBusy(), true);
  const job = { id: "snapshot-1", sessionId: "session-managed", targetRuntimeId: "runtime-managed", status: "claimed", kind: "code_download" };
  let executions = 0; const failures: unknown[] = [];
  await processCodeSyncControlJobs({ api: {
    async listSnapshotRequests(status: string) { return status === "pending" ? [job] : []; },
    async claimSnapshotRequest() { return job; },
    async failSnapshotRequest(_id: string, _runtime: string, failure: unknown) { failures.push(failure); },
    async completeSnapshotRequest() { throw new Error("Busy operation must not complete"); },
  } as never, managed: new Map([["session-managed", { bridge: { runtime: { id: "runtime-managed", harness: "claude-code" } } } as ManagedSession]]),
    busy: () => harness.isWorkspaceBusy(), workspaceOperation: operation => harness.withWorkspaceOperation(operation),
    codeSync: { async execute() { executions++; throw new Error("must not execute"); } } });
  assert.equal(executions, 0); assert.match(JSON.stringify(failures), /code_sync_busy/);
  releaseAcl(); await pending;
  assert.equal(await harness.isWorkspaceBusy(), true, "An offline/unbound native turn may still write files");
  await harness.handleNativeHook({ hook_event_name: "StopFailure", session_id: nativeId, cwd: dir }, control);
  assert.equal(await harness.isWorkspaceBusy(), false);
  let releaseFiles!: () => void;
  const files = new Promise<void>(resolve => { releaseFiles = resolve; });
  const mutation = harness.withWorkspaceOperation(async () => { await files; return "done"; });
  await Promise.resolve(); await Promise.resolve();
  const blocked = await harness.handleNativeHook({ hook_event_name: "UserPromptSubmit", session_id: randomUUID(), cwd: dir, prompt: "Wait while files change" }, control);
  assert.equal(blocked.block, true); assert.match(blocked.reason ?? "", /file|synchron/i);
  releaseFiles(); assert.equal(await mutation, "done");
  await harness.close();
});

test("Claude remote and file reservations recheck after the same delayed idle snapshot", async t => {
  for (const first of ["remote", "files"] as const) await t.test(first, async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-reserve-")));
    const harness = new ClaudeCodeProjectHarness({ workspacePath: dir, stateRoot: path.join(dir, "private"), model: "claude-sonnet-fixture" });
    const session: SessionSummary = { id: "session-1", mode: "solo", projectId: project.id, ownerUserId: "user-1" };
    const binding = harness.createSessionBinding({ session, sessionKey: "fixture", statePath: "" });
    await binding.activateLocalPublishing!();
    let ready!: () => void, release!: () => void, probes = 0;
    const bothReady = new Promise<void>(resolve => { ready = resolve; });
    const snapshot = new Promise<void>(resolve => { release = resolve; });
    // Deliberately pause both point-in-time probes after observing the same idle
    // snapshot. Only the subsequent synchronous reservation can settle the race.
    harness.isWorkspaceBusy = async () => { if (++probes === 2) ready(); await snapshot; return false; };
    const input: HarnessExecutionInput = { request: { id: "request-1", sessionId: session.id, sequence: 1, type: "agent_request", actorId: "wrong-user",
      timestamp: new Date().toISOString(), payload: {} }, canonicalHistory: [], runtime: { id: "runtime-1", userId: "user-1", deviceId: "device-1",
      sessionId: session.id, harness: "claude-code", provider: "anthropic", model: "claude-sonnet-fixture", localSessionId: binding.localSessionId, captureFidelity: "harness_transcript" } };
    let fileEntries = 0;
    const remote = () => binding.executor.execute(input);
    const files = () => harness.withWorkspaceOperation(async () => { fileEntries++; await Promise.resolve(); return "files-entered"; });
    const firstOperation = first === "remote" ? remote() : files();
    await Promise.resolve(); await Promise.resolve();
    const secondOperation = first === "remote" ? files() : remote();
    const results = Promise.allSettled([firstOperation, secondOperation]);
    await bothReady; release();
    const settled = await results;
    // The intentionally invalid route throws only after the remote reservation;
    // it never spawns a process or invokes a model.
    const remoteEntries = settled.filter(result => result.status === "rejected" && /exact runtime route/.test(String(result.reason))).length;
    assert.equal(fileEntries + remoteEntries, 1);
    assert.ok(settled.some(result => result.status === "rejected" && /busy|Wait for/.test(String(result.reason))));
    await harness.close();
  });
});
