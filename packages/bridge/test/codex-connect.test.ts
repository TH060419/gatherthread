import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ConnectorRetryReporter,
  parseCodexConnectArgs,
  formatConnectedCodexSessionOutput,
  formatCodexDesktopRevealWarning,
  initializeProjectSession,
  reconcileProjectSessionPermissions,
  refreshProjectSessionPermissions,
  refreshManagedSessionName,
  synchronizeManagedSessionTitle,
  revealCodexDesktopProject,
  revealCodexDesktopThread,
  resolveCodexHookRelayPath,
  runProjectConnector,
} from "../src/codex-connect.js";
import type { HttpCollaborationClient } from "../src/http-client.js";
import { CollaborationHttpError } from "../src/http-client.js";
import type { ProjectHarnessAdapter, SessionSummary } from "../src/index.js";
import { codexSessionKey, type CanonicalEvent, type CollaborationApi } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("connector retry reporting coalesces stable failures and reports recovery once", () => {
  let now = 0;
  const output: string[] = [];
  const reporter = new ConnectorRetryReporter({
    token: "secret-token",
    intervalMs: 60_000,
    now: () => now,
    write: (message) => output.push(message),
  });
  reporter.retrying("session-1", new Error("writer busy secret-token"));
  now = 1_000;
  reporter.retrying("session-1", new Error("writer busy secret-token"));
  now = 60_001;
  reporter.retrying("session-1", new Error("writer busy secret-token"));
  reporter.recovered("session-1");
  reporter.recovered("session-1");
  assert.equal(output.length, 3);
  assert.match(output[0] ?? "", /writer busy \[REDACTED\]/);
  assert.match(output[1] ?? "", /retrying/);
  assert.match(output[2] ?? "", /recovered/);
});

test("Codex connector accepts a private HTTPS origin and applies safe defaults", () => {
  const parsed = parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--workspace", ".",
    "--project", "project-alpha",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.apiUrl, "https://host.tailnet.ts.net/v1");
  assert.equal(parsed.model, "gpt-5.6-sol");
  assert.equal(parsed.sandbox, "workspace-write");
  assert.equal(parsed.shareToolEvents, true);
  assert.equal(parsed.projectId, "project-alpha");
  assert.equal(parsed.createWorkspace, false);
});

test("Codex connector parses project workspace creation without accepting an ambiguous workspace", () => {
  const parsed = parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--project", "project-alpha",
    "--create-workspace",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.createWorkspace, true);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--workspace", ".",
    "--create-workspace",
  ]), /cannot be combined/);
});

test("Codex connector rejects public plaintext URLs and unsafe sandbox modes", () => {
  assert.throws(() => parseCodexConnectArgs([
    "--url", "http://example.com",
  ]), /must use HTTPS/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://example.com",
    "--sandbox", "danger-full-access",
  ]), /read-only or workspace-write/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://user:secret@example.com",
  ]), /cannot contain credentials/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://example.com",
    "--model", "--dangerously-treated-as-an-option",
  ]), /requires a value/);
});

test("Codex connector direct entry point runs on native filesystem paths", async () => {
  const entryPoint = fileURLToPath(new URL("../src/codex-connect.js", import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [entryPoint, "--help"]);
  assert.match(stdout, /GatherThread Codex connector/);
  assert.equal(stderr, "");
});

test("Codex connector polling keeps the process alive until the next cycle", async () => {
  const moduleUrl = new URL("../src/codex-connect.js", import.meta.url).href;
  const script = `
    import { waitForConnectorPoll } from ${JSON.stringify(moduleUrl)};
    await waitForConnectorPoll(50, new AbortController().signal);
    process.stdout.write("poll-completed");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "poll-completed");
});

test("Codex hook relay paths are stable, platform-correct, and credential-free", () => {
  const mappingId = "0123456789abcdef01234567";
  assert.equal(
    resolveCodexHookRelayPath(mappingId, "/private/state", "linux"),
    "/private/state/hook-relay.sock",
  );
  const windowsPath = resolveCodexHookRelayPath(
    mappingId,
    "C:\\Users\\owner\\gta_secret-must-not-appear",
    "win32",
  );
  assert.equal(windowsPath, `\\\\.\\pipe\\gatherthread-${mappingId}-hook-relay`);
  assert.match(windowsPath, /^\\\\\.\\pipe\\gatherthread-[a-f0-9]{24}-hook-relay$/);
  assert.doesNotMatch(windowsPath, /gta_|secret|owner/i);
  assert.throws(
    () => resolveCodexHookRelayPath("gta_unsafe", "/private/state", "win32"),
    /24 lowercase hexadecimal/,
  );
});

test("connector with hooks disabled starts and closes no IPC relay", async () => {
  const shutdown = new AbortController();
  shutdown.abort();
  let starts = 0;
  let closes = 0;
  await runProjectConnector({
    api: {} as HttpCollaborationClient,
    actorDeviceId: "device-1",
    project: { id: "project-1", name: "Project", role: "owner", state: "active", sessionCount: 0 },
    stateRoot: "/private/state",
    harness: {} as ProjectHarnessAdapter,
    signal: shutdown.signal,
    token: "test-token",
    hookSocketPath: "/must/not/listen.sock",
    hookSpoolPath: "/must/not/drain.jsonl",
    hookRegistryPath: "/must/not/read.json",
    hooksEnabled: false,
    hookRelay: {
      start: async () => { starts += 1; },
      close: async () => { closes += 1; },
    },
  });
  assert.equal(starts, 0);
  assert.equal(closes, 0);
});

test("create-workspace reveals the exact validated project once with no GatherThread environment", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "gatherthread-desktop-reveal-"));
  const verifiedWorkspacePath = await realpath(workspacePath);
  const legacyTokenEnvironmentName = ["RELAY", "ROOM_TOKEN"].join("");
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const result = await revealCodexDesktopProject({
    enabled: true,
    command: "/opt/codex/bin/codex",
    workspacePath,
    env: {
      PATH: "/safe/bin",
      GATHERTHREAD_TOKEN: "gta_secret",
      GATHERTHREAD_API_URL: "https://private.example/v1",
      gatherthread_custom_secret: "private",
      [legacyTokenEnvironmentName]: "legacy-secret",
    },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new FakeRevealChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(result, { status: "opened" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "/opt/codex/bin/codex");
  assert.deepEqual(calls[0]?.args, ["app", verifiedWorkspacePath]);
  assert.equal(calls[0]?.options.cwd, verifiedWorkspacePath);
  assert.equal((calls[0]?.options.env as NodeJS.ProcessEnv).PATH, "/safe/bin");
  assert.deepEqual(
    Object.keys(calls[0]?.options.env as NodeJS.ProcessEnv).filter((name) => name.toUpperCase().startsWith("GATHERTHREAD_")),
    [],
  );
  assert.equal((calls[0]?.options.env as NodeJS.ProcessEnv)[legacyTokenEnvironmentName], undefined);
});

test("desktop task reveal uses the registered Codex thread URL without exposing credentials", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "gatherthread-desktop-task-reveal-"));
  const verifiedWorkspacePath = await realpath(workspacePath);
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const result = await revealCodexDesktopThread({
    threadId: "01a03ae9-4a09-7651-ac01-f8de1dccf68c",
    workspacePath,
    platform: "darwin",
    env: { PATH: "/safe/bin", GATHERTHREAD_TOKEN: "gta_secret" },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new FakeRevealChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(result, { status: "launched" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "open");
  assert.deepEqual(calls[0]?.args, ["codex://threads/01a03ae9-4a09-7651-ac01-f8de1dccf68c"]);
  assert.equal(calls[0]?.options.cwd, verifiedWorkspacePath);
  assert.equal((calls[0]?.options.env as NodeJS.ProcessEnv).GATHERTHREAD_TOKEN, undefined);
});

test("desktop task reveal uses a non-shell Windows launcher and rejects unsafe ids", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "gatherthread-desktop-task-windows-"));
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const result = await revealCodexDesktopThread({
    threadId: "01a03ae9-4a09-7651-ac01-f8de1dccf68c",
    workspacePath,
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new FakeRevealChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(result, { status: "launched" });
  assert.equal(calls[0]?.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[0]?.args, [
    "/d", "/s", "/c", "start", "", "codex://threads/01a03ae9-4a09-7651-ac01-f8de1dccf68c",
  ]);
  assert.equal(calls[0]?.options.shell, false);
  assert.equal((await revealCodexDesktopThread({
    threadId: "01a03ae9-4a09-7651-ac01-f8de1dccf68c & calc.exe",
    workspacePath,
    platform: "win32",
  })).status, "failed");
});

test("connected session output gives the exact managed Desktop task without manual move instructions or local secrets", () => {
  const output = formatConnectedCodexSessionOutput("Research Project", {
    ...session("owner", "multi"),
    name: "Shared analysis",
  });
  assert.match(output, /^Connected session: Shared analysis \[multi\] as "GatherThread · Research Project · Shared analysis"$/m);
  assert.doesNotMatch(output, /Move to project|manual grouping/i);
  assert.doesNotMatch(output, /gta_|GATHERTHREAD_TOKEN|\/Users\/|\\Users\\/);
});

test("explicit workspace skips Desktop reveal and reveal failures or timeouts remain fail-soft", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "gatherthread-desktop-fail-soft-"));
  let spawns = 0;
  assert.deepEqual(await revealCodexDesktopProject({
    enabled: false,
    command: "codex",
    workspacePath,
    spawnProcess() { spawns += 1; return new FakeRevealChild(); },
  }), { status: "skipped" });
  assert.equal(spawns, 0);

  const failed = await revealCodexDesktopProject({
    enabled: true,
    command: "codex",
    workspacePath,
    spawnProcess() {
      const child = new FakeRevealChild();
      queueMicrotask(() => child.emit("close", 1, null));
      return child;
    },
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.status === "failed" ? failed.error.message : "", /exited unsuccessfully/);

  const hanging = new FakeRevealChild();
  const timedOut = await revealCodexDesktopProject({
    enabled: true,
    command: "codex",
    workspacePath,
    timeoutMs: 5,
    spawnProcess() { return hanging; },
  });
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.status === "failed" ? timedOut.error.message : "", /timed out/);
  assert.deepEqual(hanging.killSignals, ["SIGKILL"]);
  const warning = formatCodexDesktopRevealWarning(
    new Error("failed\ngta_secret"),
    workspacePath,
    "gta_secret",
  );
  assert.doesNotMatch(warning, /gta_secret|[\r\n]/);
  assert.match(warning, /synchronization will continue/);
  assert.match(warning, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("new binding materializes through the authoritative cursor before one-time activation and resumes after failure", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-connect-order-"));
  const order: string[] = [];
  let failProjection = true;
  let successfulActivations = 0;
  const history = [canonicalEvent(1), canonicalEvent(2)];
  const api = projectApi(history, order);
  const harness = projectHarness({
    order,
    project(events) {
      const sequence = events[0]?.sequence ?? 0;
      order.push(`project:${sequence}`);
      if (sequence === 2 && failProjection) {
        failProjection = false;
        throw new Error("projection interrupted");
      }
    },
    activate() {
      successfulActivations += 1;
      order.push("activate");
    },
  });
  const cloudSession = { ...session("owner", "multi"), latestSequence: 2 };

  await assert.rejects(initializeProjectSession({
    api, actorDeviceId: "device-1", stateRoot, harness, session: cloudSession,
  }), /projection interrupted/);
  assert.equal(successfulActivations, 0);
  const cursorPath = path.join(stateRoot, `${codexSessionKey("session-1")}-cursor.json`);
  assert.equal(JSON.parse(await readFile(cursorPath, "utf8")).server["session-1"], 1);

  await initializeProjectSession({
    api, actorDeviceId: "device-1", stateRoot, harness, session: cloudSession,
  });
  assert.equal(successfulActivations, 1);
  assert.deepEqual(order, [
    "create", "rename", "deactivate:initializing", "register", "project:1", "project:2",
    "create", "rename", "deactivate:initializing", "register", "project:2", "activate",
  ]);
});

test("initialization prepares an empty native conversation and rewinds a stale bridge cursor to native coverage", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-native-prepare-"));
  const sessionKey = codexSessionKey("session-1");
  await writeFile(path.join(stateRoot, `${sessionKey}-cursor.json`), `${JSON.stringify({
    version: 1,
    server: { "session-1": 2 },
    local: {},
  })}\n`);
  const order: string[] = [];
  const history = [canonicalEvent(1), canonicalEvent(2)];
  const api = projectApi(history, order);
  const harness = projectHarness({
    order,
    prepare: () => {
      order.push("prepare:0");
      return 0;
    },
    project(events) { order.push(`project:${events[0]?.sequence ?? "empty"}`); },
    activate() { order.push("activate"); },
  });

  await initializeProjectSession({
    api,
    actorDeviceId: "device-1",
    stateRoot,
    harness,
    session: { ...session("owner", "multi"), latestSequence: 2 },
  });

  assert.deepEqual(order, [
    "create", "rename", "deactivate:initializing", "register", "prepare:0",
    "project:1", "project:2", "activate",
  ]);
  assert.equal(JSON.parse(await readFile(path.join(stateRoot, `${sessionKey}-cursor.json`), "utf8")).server["session-1"], 2);

  order.length = 0;
  await initializeProjectSession({
    api: projectApi([], order),
    actorDeviceId: "device-1",
    stateRoot: await mkdtemp(path.join(tmpdir(), "gatherthread-native-empty-")),
    harness,
    session: { ...session("owner", "multi"), latestSequence: 0 },
  });
  assert.ok(order.includes("prepare:0"), "an empty cloud session must still materialize its native thread");
});

test("activation failure rolls publishing back and retries without reprojecting materialized history", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-connect-activation-"));
  const order: string[] = [];
  let failActivation = true;
  const api = projectApi([canonicalEvent(1)], order);
  const harness = projectHarness({
    order,
    project(events) { order.push(`project:${events[0]?.sequence ?? 0}`); },
    activate() {
      order.push("activate");
      if (failActivation) {
        failActivation = false;
        throw new Error("activation interrupted");
      }
    },
    deactivate() { /* fail-closed rollback is recorded by the harness seam */ },
  });
  const cloudSession = { ...session("owner", "multi"), latestSequence: 1 };
  await assert.rejects(initializeProjectSession({
    api, actorDeviceId: "device-1", stateRoot, harness, session: cloudSession,
  }), /activation interrupted/);
  assert.deepEqual(order.filter((item) => item === "deactivate:initializing"), [
    "deactivate:initializing",
    "deactivate:initializing",
  ]);
  await initializeProjectSession({
    api, actorDeviceId: "device-1", stateRoot, harness, session: cloudSession,
  });
  assert.deepEqual(order.filter((item) => item.startsWith("project:")), ["project:1"]);
  assert.deepEqual(order.filter((item) => item === "activate"), ["activate", "activate"]);
});

test("authoritative session rename updates one existing native binding exactly once", async () => {
  const names: string[] = [];
  const managed = {
    name: "Old name",
    rename: async (cloud: SessionSummary) => { names.push(cloud.name ?? cloud.id); },
  };
  const renamed = { ...session("owner", "multi"), name: "New name" };
  assert.equal(await refreshManagedSessionName(managed, renamed), true);
  assert.equal(await refreshManagedSessionName(managed, renamed), false);
  assert.deepEqual(names, ["New name"]);
  assert.equal(managed.name, "New name");
});

test("native title upload is owner-only, idempotent, and loses to an authoritative cloud rename", async () => {
  const updates: Array<{ sessionId: string; title: string; idempotencyKey: string }> = [];
  const nativeNames = [
    "GatherThread · Project · Local title",
    "GatherThread · Project · Local title",
    "stale local title",
    "participant local title",
  ];
  const restored: string[] = [];
  const current = {
    name: "Cloud title",
    rename: async (cloud: SessionSummary) => { restored.push(cloud.name ?? cloud.id); },
    readNativeName: async () => nativeNames.shift() ?? null,
  };
  const api = {
    updateSession: async (sessionId: string, input: { title: string; idempotencyKey: string }) => {
      updates.push({ sessionId, ...input });
      return { ...session("owner", "multi"), name: input.title };
    },
  } as unknown as CollaborationApi;
  const owner = { ...session("owner", "multi"), name: "Cloud title" };

  assert.equal(await synchronizeManagedSessionTitle({
    current, session: owner, projectName: "Project", actorDeviceId: "device-1", api,
  }), "uploaded");
  assert.equal(await synchronizeManagedSessionTitle({
    current, session: owner, projectName: "Project", actorDeviceId: "device-1", api,
  }), "awaiting_cloud");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.title, "Local title");
  assert.match(updates[0]?.idempotencyKey ?? "", /^codex-title-[a-f0-9]{64}$/);

  const cloudRenamed = { ...owner, name: "Concurrent cloud title" };
  assert.equal(await refreshManagedSessionName(current, cloudRenamed), true);
  assert.equal(await synchronizeManagedSessionTitle({
    current, session: cloudRenamed, projectName: "Project", actorDeviceId: "device-1", api,
  }), "unchanged");
  assert.equal(updates.length, 1, "cloud rename wins without uploading the stale local title");

  const participant = { ...session("participant", "multi"), name: "Concurrent cloud title" };
  assert.equal(await synchronizeManagedSessionTitle({
    current, session: participant, projectName: "Project", actorDeviceId: "device-1", api,
  }), "restored_cloud");
  assert.equal(updates.length, 1, "participants must never attempt a title mutation");
  assert.deepEqual(restored, ["Concurrent cloud title", "Concurrent cloud title"]);
});

test("uncertain native title upload retries the identical idempotency key", async () => {
  const keys: string[] = [];
  let attempts = 0;
  const current = {
    name: "Cloud",
    readNativeName: async () => "Local",
  };
  const api = {
    updateSession: async (_sessionId: string, input: { title: string; idempotencyKey: string }) => {
      keys.push(input.idempotencyKey);
      attempts += 1;
      if (attempts === 1) throw new TypeError("response lost");
      return { ...session("owner", "multi"), name: input.title };
    },
  } as unknown as CollaborationApi;
  const cloud = { ...session("owner", "multi"), name: "Cloud" };
  await assert.rejects(synchronizeManagedSessionTitle({
    current, session: cloud, projectName: "Project", actorDeviceId: "device-1", api,
  }), /response lost/);
  assert.equal(await synchronizeManagedSessionTitle({
    current, session: cloud, projectName: "Project", actorDeviceId: "device-1", api,
  }), "uploaded");
  assert.equal(attempts, 2);
  assert.equal(keys[0], keys[1]);
});

test("native title normalization trims the managed suffix and rejects control characters", async () => {
  const updates: string[] = [];
  const restored: string[] = [];
  const api = {
    updateSession: async (_sessionId: string, input: { title: string }) => {
      updates.push(input.title);
      return { ...session("owner", "multi"), name: input.title };
    },
  } as unknown as CollaborationApi;
  const cloud = { ...session("owner", "multi"), name: "Cloud" };
  assert.equal(await synchronizeManagedSessionTitle({
    current: {
      name: "Cloud",
      readNativeName: async () => "GatherThread · Project ·   Trimmed title   ",
    },
    session: cloud,
    projectName: "Project",
    actorDeviceId: "device-1",
    api,
  }), "uploaded");
  assert.deepEqual(updates, ["Trimmed title"]);
  assert.equal(await synchronizeManagedSessionTitle({
    current: {
      name: "Cloud",
      readNativeName: async () => "unsafe\nname",
      rename: async (session) => { restored.push(session.name ?? session.id); },
    },
    session: cloud,
    projectName: "Project",
    actorDeviceId: "device-1",
    api,
  }), "restored_cloud");
  assert.deepEqual(updates, ["Trimmed title"]);
  assert.deepEqual(restored, ["Cloud"]);
});

test("authoritative ACL downgrade removes owner and participant-solo execution bindings", async () => {
  for (const downgraded of [
    session("viewer", "multi"),
    session("participant", "solo"),
  ]) {
    const reasons: string[] = [];
    const retained: string[][] = [];
    const managed = new Map([[
      "session-1",
      { deactivateLocalPublishing: async (reason: string) => { reasons.push(reason); } },
    ]]);
    const harness = {
      deactivateExecutionBindings: async (input?: { retainSessionIds?: readonly string[] }) => {
        retained.push([...(input?.retainSessionIds ?? [])]);
      },
    } as unknown as ProjectHarnessAdapter;
    const result = await reconcileProjectSessionPermissions({ sessions: [downgraded], managed, harness });
    assert.equal(managed.size, 0);
    assert.deepEqual(reasons, ["read_only"]);
    assert.deepEqual(retained, [[]]);
    assert.deepEqual(result.eligibleSessions, []);
    assert.deepEqual(result.errors, []);
  }
});

test("ACL refresh preserves initializing session state without adding it to the execution allowlist", async () => {
  const reconciliations: Array<{ retain: string[]; preserve: string[] }> = [];
  await reconcileProjectSessionPermissions({
    sessions: [session("owner", "multi")],
    managed: new Map(),
    harness: {
      deactivateExecutionBindings: async (input?: {
        retainSessionIds?: readonly string[];
        preserveSessionIds?: readonly string[];
      }) => {
        reconciliations.push({
          retain: [...(input?.retainSessionIds ?? [])],
          preserve: [...(input?.preserveSessionIds ?? [])],
        });
      },
    } as unknown as ProjectHarnessAdapter,
  });
  assert.deepEqual(reconciliations, [{ retain: [], preserve: ["session-1"] }]);
});

test("removed sessions deactivate locally before the project allowlist is reconciled", async () => {
  const order: string[] = [];
  const managed = new Map([[
    "session-1",
    { deactivateLocalPublishing: async (reason: string) => {
      assert.equal(managed.has("session-1"), false, "managed mapping must be removed before registry deactivation");
      order.push(reason);
    } },
  ]]);
  const harness = {
    deactivateExecutionBindings: async () => { order.push("registry"); },
  } as unknown as ProjectHarnessAdapter;
  await reconcileProjectSessionPermissions({ sessions: [], managed, harness });
  assert.deepEqual(order, ["removed", "registry"]);
});

test("archived cloud sessions are removed from execution without reviving their mapping", async () => {
  const reasons: string[] = [];
  const managed = new Map([[
    "session-1",
    { deactivateLocalPublishing: async (reason: string) => { reasons.push(reason); } },
  ]]);
  const result = await reconcileProjectSessionPermissions({
    sessions: [session("owner", "multi", "archived")],
    managed,
    harness: { deactivateExecutionBindings: async () => undefined } as unknown as ProjectHarnessAdapter,
  });
  assert.deepEqual(reasons, ["archived"]);
  assert.equal(managed.size, 0);
  assert.deepEqual(result.visibleSessions, []);
  assert.deepEqual(result.eligibleSessions, []);
});

test("transient project refresh failure preserves bindings while typed 404 is classified as revocation", async () => {
  let reconciliations = 0;
  const managed = new Map([["session-1", { deactivateLocalPublishing: async () => undefined }]]);
  const harness = {
    deactivateExecutionBindings: async () => { reconciliations += 1; },
  } as unknown as ProjectHarnessAdapter;
  const transient = await refreshProjectSessionPermissions({
    loadSessions: async () => { throw new TypeError("network unavailable"); },
    managed,
    harness,
  });
  assert.equal(transient.status, "transient_failure");
  assert.equal(managed.size, 1);
  assert.equal(reconciliations, 0);

  const revoked = await refreshProjectSessionPermissions({
    loadSessions: async () => { throw new CollaborationHttpError(404, "project missing"); },
    managed,
    harness,
  });
  assert.equal(revoked.status, "project_inaccessible");
  assert.equal(managed.size, 1, "the connector cleanup branch owns final project-wide removal");
  assert.equal(reconciliations, 0);
});

function session(
  role: NonNullable<SessionSummary["role"]>,
  mode: SessionSummary["mode"],
  state: SessionSummary["state"] = "active",
): SessionSummary {
  return {
    id: "session-1",
    projectId: "project-1",
    name: "Session",
    role,
    mode,
    state,
    latestSequence: 0,
  };
}

function canonicalEvent(sequence: number): CanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type: "human_chat",
    actorId: "user-1",
    timestamp: "2026-08-25T00:00:00.000Z",
    payload: { text: `message ${sequence}` },
  };
}

function projectApi(history: CanonicalEvent[], order: string[]): CollaborationApi {
  return {
    listSessions: async () => [],
    registerRuntime: async (runtime) => {
      order.push("register");
      return { ...runtime, id: "runtime-1", userId: "user-1" };
    },
    readEvents: async (_sessionId, afterSequence) => {
      const events = history.filter((event) => event.sequence > afterSequence);
      return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence, hasMore: false };
    },
    appendEvent: async () => { throw new Error("not used"); },
    claimAgentRequest: async () => { throw new Error("not used"); },
    completeAgentRequest: async () => { throw new Error("not used"); },
  };
}

function projectHarness(input: {
  order: string[];
  project(events: readonly CanonicalEvent[]): void;
  activate(): void;
  deactivate?(): void;
  prepare?(): number;
}): ProjectHarnessAdapter {
  return {
    descriptor: {
      harness: "codex",
      provider: "openai",
      model: "gpt-test",
      captureFidelity: "harness_transcript",
      capabilities: [],
    },
    preflight: async () => ({ version: "test", authentication: "test", workspacePath: "/workspace" }),
    createSessionBinding: () => {
      input.order.push("create");
      return {
        localSessionId: "local-session-1",
        executor: {
          execute: async () => { throw new Error("not used"); },
          projectCanonicalEvents: async (events) => input.project(events),
          ...(input.prepare === undefined ? {} : { prepareCanonicalProjection: async () => input.prepare?.() ?? 0 }),
        },
        rename: async () => { input.order.push("rename"); },
        activateLocalPublishing: async () => input.activate(),
        deactivateLocalPublishing: async (reason) => {
          input.order.push(`deactivate:${reason}`);
          input.deactivate?.();
        },
      };
    },
    close: async () => undefined,
  };
}

class FakeRevealChild extends EventEmitter {
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
  }
}
