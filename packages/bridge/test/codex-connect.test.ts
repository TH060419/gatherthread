import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ConnectorRetryReporter,
  createPersonalSoloForLocalPrompt,
  parseCodexConnectArgs,
  formatConnectedCodexSessionOutput,
  formatCodexDesktopRevealWarning,
  initializeProjectSession,
  isSessionWritableBy,
  localSoloCreationKey,
  localSoloTitle,
  reconcileProjectSessionPermissions,
  refreshProjectSessionPermissions,
  revealCodexDesktopProject,
  revealCodexDesktopThread,
  resolveCodexCommand,
  resolveCodexHookRelayPath,
  resolveWorkspaceCodexHookPaths,
  runManagedSessionCycle,
  runProjectConnector,
} from "../src/codex-connect.js";
import { managedCodexThreadName } from "../src/codex-app-server.js";
import type { HttpCollaborationClient } from "../src/http-client.js";
import { CollaborationHttpError } from "../src/http-client.js";
import type { ProjectHarnessAdapter, SessionSummary } from "../src/index.js";
import {
  codexSessionKey,
  readCodexHookSpool,
  updateCodexHookRegistry,
  type CanonicalEvent,
  type CollaborationApi,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const socketTemporaryBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();

test("Windows Codex discovery skips shell shims and selects a native executable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-path-"));
  const shim = path.join(directory, "codex");
  const executable = path.join(directory, "codex.exe");
  await Promise.all([
    writeFile(shim, "#!/bin/sh\nexit 0\n"),
    writeFile(executable, "native executable placeholder"),
  ]);
  await Promise.all([chmod(shim, 0o755), chmod(executable, 0o755)]);

  assert.equal(
    await resolveCodexCommand("codex", { PATH: directory }, "win32"),
    executable,
  );
});

test("Windows Codex discovery finds the newest Desktop binary outside PATH", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-desktop-install-"));
  const pathOnlyShim = path.join(directory, "npm-bin");
  const binRoot = path.join(directory, "OpenAI", "Codex", "bin");
  const oldExecutable = path.join(binRoot, "old-version", "codex.exe");
  const newestExecutable = path.join(binRoot, "new-version", "codex.exe");
  await mkdir(pathOnlyShim, { recursive: true });
  await mkdir(path.dirname(oldExecutable), { recursive: true });
  await mkdir(path.dirname(newestExecutable), { recursive: true });
  await Promise.all([
    writeFile(path.join(pathOnlyShim, "codex.cmd"), "@echo off\r\n"),
    writeFile(oldExecutable, "old native executable"),
    writeFile(newestExecutable, "new native executable"),
  ]);
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newestTime = new Date("2026-08-27T00:00:00.000Z");
  await Promise.all([
    utimes(oldExecutable, oldTime, oldTime),
    utimes(newestExecutable, newestTime, newestTime),
  ]);

  assert.equal(
    await resolveCodexCommand("codex", { PATH: pathOnlyShim, LOCALAPPDATA: directory }, "win32"),
    newestExecutable,
  );
});

test("Codex hook transport stays stable across GatherThread project mappings", () => {
  const first = resolveWorkspaceCodexHookPaths("D:\\codes\\Web\\gatherthread", "C:\\Users\\tester", "win32");
  const sameWorkspaceDifferentCase = resolveWorkspaceCodexHookPaths("d:\\CODES\\web\\GATHERTHREAD", "C:\\Users\\tester", "win32");
  assert.deepEqual(first, sameWorkspaceDifferentCase);
  assert.match(first.hookSocketPath, /^\\\\\.\\pipe\\gatherthread-[a-f0-9]{24}-hook-relay$/);
  assert.match(first.hookRegistryPath, /[\\/]\.gatherthread[\\/]codex[\\/]hooks[\\/][a-f0-9]{24}[\\/]hook-registry\.json$/);
});

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

test("personal solo eligibility follows its creator instead of the project owner role", () => {
  const personalSolo: SessionSummary = {
    id: "solo-1",
    ownerUserId: "participant-1",
    mode: "solo",
    role: "participant",
  };
  assert.equal(isSessionWritableBy(personalSolo, "participant-1"), true);
  assert.equal(isSessionWritableBy({ ...personalSolo, role: "owner" }, "project-owner"), false);
  assert.equal(isSessionWritableBy({ ...personalSolo, role: "viewer" }, "participant-1"), false);
  assert.equal(isSessionWritableBy({ ...personalSolo, mode: "multi" }, "participant-1"), true);
  assert.equal(localSoloTitle("\n  First\tlocal\nquestion  "), "First local question");
  assert.equal(Array.from(localSoloTitle("问".repeat(180))).length, 120);
  assert.equal(
    localSoloCreationKey("device-1", "project-1", "thread-1"),
    localSoloCreationKey("device-1", "project-1", "thread-1"),
  );
  assert.notEqual(
    localSoloCreationKey("device-1", "project-1", "thread-1"),
    localSoloCreationKey("device-1", "project-1", "thread-2"),
  );
});

test("first local prompt creates one deterministic personal solo while viewers stay local-only", async () => {
  const actorUserId = "participant-1";
  let role: "participant" | "viewer" = "participant";
  const creates: Array<{ projectId: string; title: string; mode: string; idempotencyKey: string }> = [];
  const api = {
    listProjects: async () => [{ id: "project-1", name: "Project", role, state: "active", sessionCount: 0 }],
    createSession: async (projectId: string, input: { title: string; mode: "solo" | "multi"; idempotencyKey: string }) => {
      creates.push({ projectId, ...input });
      return {
        id: `session-${createHash("sha256").update(`${actorUserId}\0${input.idempotencyKey}`).digest("hex").slice(0, 32)}`,
        projectId,
        ownerUserId: actorUserId,
        name: input.title,
        mode: input.mode,
        state: "active" as const,
        latestSequence: 1,
      };
    },
  } as unknown as HttpCollaborationClient;
  const first = await createPersonalSoloForLocalPrompt({
    api,
    actorUserId,
    actorDeviceId: "device-1",
    projectId: "project-1",
    localConversationId: "desktop-thread-1",
    prompt: "  Investigate the replay race  ",
  });
  const retried = await createPersonalSoloForLocalPrompt({
    api,
    actorUserId,
    actorDeviceId: "device-1",
    projectId: "project-1",
    localConversationId: "desktop-thread-1",
    prompt: "  Investigate the replay race  ",
  });
  assert.equal(first?.id, retried?.id);
  assert.equal(first?.ownerUserId, actorUserId);
  assert.equal(first?.role, "participant");
  assert.equal(creates[0]?.mode, "solo");
  assert.equal(creates[0]?.title, "Investigate the replay race");
  assert.equal(creates[0]?.idempotencyKey, creates[1]?.idempotencyKey);

  role = "viewer";
  assert.equal(await createPersonalSoloForLocalPrompt({
    api,
    actorUserId,
    actorDeviceId: "device-1",
    projectId: "project-1",
    localConversationId: "viewer-local-thread",
    prompt: "This must remain local",
  }), null);
  assert.equal(creates.length, 2);
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
  assert.equal(parsed.contextWindowTokens, 128_000);
  assert.equal(parsed.sandbox, "workspace-write");
  assert.equal(parsed.shareToolEvents, true);
  assert.equal(parsed.projectId, "project-alpha");
  assert.equal(parsed.createWorkspace, false);
  assert.equal(parsed.installHooks, false);
  assert.equal(parsed.pluginHooks, false);
  assert.equal(parsed.preflightOnly, false);
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

test("Codex connector accepts a bounded context ceiling", () => {
  const parsed = parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--context-window-tokens", "257000",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.contextWindowTokens, 257_000);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--context-window-tokens", "2048",
  ]), /4096 to 2000000/);
});

test("Codex connector enables exactly one explicit Hook source", () => {
  const parsed = parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--plugin-hooks",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.pluginHooks, true);
  assert.equal(parsed.installHooks, false);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--plugin-hooks",
    "--install-hooks",
  ]), /cannot be combined/);
});

test("Codex connector parses a side-effect-bounded preflight", () => {
  const parsed = parseCodexConnectArgs([
    "--url", "https://host.tailnet.ts.net",
    "--preflight-only",
  ]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.preflightOnly, true);
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
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://example.com",
    "--project", "project-alpha'; Remove-Item -Recurse ~; '",
  ]), /project ID/);
  assert.throws(() => parseCodexConnectArgs([
    "--url", "https://example.com",
    "--codex-command", "codex\nmalicious",
  ]), /Codex command/);
});

test("Codex connector direct entry point runs on native filesystem paths", async () => {
  const entryPoint = fileURLToPath(new URL("../src/codex-connect-bin.js", import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [entryPoint, "--help"]);
  assert.match(stdout, /GatherThread Codex connector/);
  assert.equal(stderr, "");
});

test("Codex connector default CLI initializes a disabled Hook registry under a fresh home", async () => {
  const homeDirectory = await mkdtemp(path.join(socketTemporaryBase, "gt-home-"));
  const workspacePath = await mkdtemp(path.join(socketTemporaryBase, "gatherthread-codex-workspace-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/me") {
      response.end(JSON.stringify({ data: { id: "user-1", username: "Owner", device_id: "device-1" } }));
      return;
    }
    if (request.url === "/v1/projects") {
      response.end(JSON.stringify({ data: { projects: [{
        id: "project-1", title: "Project", role: "owner", state: "active", session_count: 0,
      }] } }));
      return;
    }
    if (request.url === "/v1/projects/project-1/sessions") {
      response.end(JSON.stringify({ data: { sessions: [] } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const entryPoint = fileURLToPath(new URL("../src/codex-connect-bin.js", import.meta.url));
  const child = spawn(process.execPath, [
    entryPoint,
    "--url", `http://127.0.0.1:${address.port}`,
    "--project", "project-1",
    "--workspace", workspacePath,
    "--codex-command", process.execPath,
  ], {
    env: {
      ...process.env,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      GATHERTHREAD_TOKEN: "gta_test-device-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Codex connector did not initialize: ${stderr}`)), 10_000);
      const inspect = () => {
        if (!stdout.includes("Desktop local-turn sync is disabled")) return;
        clearTimeout(timeout);
        resolve();
      };
      child.stdout.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        if (stdout.includes("Desktop local-turn sync is disabled")) return;
        clearTimeout(timeout);
        reject(new Error(`Codex connector exited ${code}: ${stderr}`));
      });
      inspect();
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  const canonicalWorkspacePath = await realpath(workspacePath);
  const registryPath = resolveWorkspaceCodexHookPaths(canonicalWorkspacePath, homeDirectory).hookRegistryPath;
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.workspacePath, canonicalWorkspacePath);
  assert.deepEqual(registry.threads, {});
  assert.equal(registry.discoverUnregistered, false);
  assert.equal(registry.hookSource, "disabled");
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

test("managed session cycle commits local Hooks before Web execution and defers visible history until after it", async () => {
  const order: string[] = [];
  let releaseVisibleHistory: (() => void) | undefined;
  const visibleHistoryGate = new Promise<void>((resolve) => { releaseVisibleHistory = resolve; });
  const runtime = {
    id: "runtime-1",
    runtimeId: "runtime-1",
    userId: "user-1",
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-test",
    localSessionId: "local-1",
    captureFidelity: "harness_transcript",
  } as const;
  const current = {
    bridge: {
      runtime,
      processPendingAgentRequests: async () => { order.push("web-agent"); },
    },
    executor: {},
    lastHeartbeatAt: 0,
    synchronizeLocalTurns: async () => { order.push("local-hooks"); },
    synchronizeCanonicalHistory: async () => {
      order.push("visible-history:start");
      await visibleHistoryGate;
      order.push("visible-history:end");
    },
  } as unknown as Parameters<typeof runManagedSessionCycle>[0];

  const running = runManagedSessionCycle(current, {} as CollaborationApi);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["local-hooks", "web-agent", "visible-history:start"],
    "a blocked visible Desktop lease must begin only after the Web Agent has been serviced");
  releaseVisibleHistory?.();
  await running;
  assert.deepEqual(order, ["local-hooks", "web-agent", "visible-history:start", "visible-history:end"]);

  const localFailure = {
    ...current,
    synchronizeLocalTurns: async () => { throw new Error("local commit uncertain"); },
    synchronizeCanonicalHistory: async () => { throw new Error("must not run"); },
  } as unknown as Parameters<typeof runManagedSessionCycle>[0];
  await assert.rejects(runManagedSessionCycle(localFailure, {} as CollaborationApi), /local commit uncertain/);
  assert.equal(order.filter((step) => step === "web-agent").length, 1,
    "a local-turn commit error must not be swallowed or overtaken by another Web execution");
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
    actorUserId: "user-1",
    actorDeviceId: "device-1",
    project: { id: "project-1", name: "Project", role: "owner", state: "active", sessionCount: 0 },
    stateRoot: "/private/state",
    harness: {} as ProjectHarnessAdapter,
    signal: shutdown.signal,
    token: "test-token",
    hookSocketPath: "/must/not/listen.sock",
    hookSpoolPath: "/must/not/drain.jsonl",
    hookRegistryPath: "/must/not/read.json",
    hookWorkspacePath: "/private/workspace",
    hookMode: "disabled",
    hookRelay: {
      start: async () => { starts += 1; },
      close: async () => { closes += 1; },
    },
  });
  assert.equal(starts, 0);
  assert.equal(closes, 0);
});

test("plugin Hook mode preserves but never drains the compatibility project Hook spool", async () => {
  for (const hookMode of ["project", "plugin"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `gatherthread-codex-${hookMode}-spool-`));
    const workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath);
    const paths = resolveWorkspaceCodexHookPaths(workspacePath, directory);
    await updateCodexHookRegistry({
      registryPath: paths.hookRegistryPath,
      workspacePath,
      add: { "snapshot-thread": "snapshot_connector" },
      hookSource: "project",
    });
    await writeFile(paths.hookSpoolPath, `${JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "snapshot-thread",
      turn_id: "turn-1",
      cwd: workspacePath,
      model: "gpt-test",
      prompt: "must not be replayed by plugin mode",
    })}\n`, { mode: 0o600 });
    const shutdown = new AbortController();
    let scheduled = false;
    const project = { id: "project-1", name: "Project", role: "owner", state: "active", sessionCount: 0 } as const;
    const api = {
      listProjects: async () => [project],
      listProjectSessions: async () => {
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => shutdown.abort(), 10);
        }
        return [];
      },
    } as unknown as HttpCollaborationClient;
    await runProjectConnector({
      api,
      actorUserId: "user-1",
      actorDeviceId: "device-1",
      project,
      stateRoot: path.join(directory, "state"),
      harness: {} as ProjectHarnessAdapter,
      signal: shutdown.signal,
      token: "test-token",
      hookSocketPath: paths.hookSocketPath,
      hookSpoolPath: paths.hookSpoolPath,
      hookRegistryPath: paths.hookRegistryPath,
      hookWorkspacePath: workspacePath,
      hookMode,
      hookRelay: { start: async () => undefined, close: async () => undefined },
    });
    assert.equal((await readCodexHookSpool(paths.hookSpoolPath)).length, hookMode === "plugin" ? 1 : 0);
  }
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
  assert.match(output, /^Connected session: Shared analysis \[multi\] as "Shared analysis · MULTI · GatherThread"$/m);
  assert.doesNotMatch(output, /Move to project|manual grouping/i);
  assert.doesNotMatch(output, /gta_|GATHERTHREAD_TOKEN|\/Users\/|\\Users\\/);
});

test("managed local conversation names retain an uppercase session type suffix", () => {
  assert.equal(managedCodexThreadName({ id: "solo-1", name: "Personal notes", mode: "solo" }),
    "Personal notes · SOLO · GatherThread");
  const longName = managedCodexThreadName({ id: "multi-1", name: "x".repeat(300), mode: "multi" });
  assert.equal(longName.length, 240);
  assert.match(longName, / · MULTI · GatherThread$/);
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
    "create", "deactivate:initializing", "register", "project:1", "project:2",
    "create", "deactivate:initializing", "register", "project:2", "activate",
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
    "create", "deactivate:initializing", "register", "prepare:0",
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

test("session initialization never renames an adopted local conversation", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-independent-local-title-"));
  let renameCalls = 0;
  const harness: ProjectHarnessAdapter = {
    descriptor: {
      harness: "codex",
      provider: "openai",
      model: "gpt-test",
      captureFidelity: "harness_transcript",
      capabilities: [],
    },
    preflight: async () => ({ version: "test", authentication: "test", workspacePath: "/workspace" }),
    createSessionBinding: () => ({
      localSessionId: "local-session-independent-title",
      executor: {
        execute: async () => { throw new Error("not used"); },
        projectCanonicalEvents: async () => undefined,
      },
      adoptLocalConversation: async () => undefined,
      rename: async () => { renameCalls += 1; },
      activateLocalPublishing: async () => undefined,
      deactivateLocalPublishing: async () => undefined,
    }),
    close: async () => undefined,
  };
  await initializeProjectSession({
    api: projectApi([], []),
    actorDeviceId: "device-1",
    stateRoot,
    harness,
    session: { ...session("owner", "solo"), latestSequence: 0 },
    adoptLocalConversationId: "native-user-title",
  });
  assert.equal(renameCalls, 0, "cloud metadata must never overwrite a user-owned local task title");
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

test("cloud renames preserve the existing binding by stable session id", async () => {
  const binding = { deactivateLocalPublishing: async () => undefined };
  const managed = new Map([["session-1", binding]]);
  const renamed = { ...session("owner", "multi"), name: "A completely different cloud title" };
  const retained: string[][] = [];
  const result = await reconcileProjectSessionPermissions({
    sessions: [renamed],
    managed,
    harness: {
      deactivateExecutionBindings: async (input?: { retainSessionIds?: readonly string[] }) => {
        retained.push([...(input?.retainSessionIds ?? [])]);
      },
    } as unknown as ProjectHarnessAdapter,
  });
  assert.equal(managed.size, 1);
  assert.equal(managed.get("session-1"), binding, "a title change must not replace or duplicate the binding");
  assert.equal(result.eligibleSessions[0]?.id, "session-1");
  assert.equal(result.eligibleSessions[0]?.name, "A completely different cloud title");
  assert.deepEqual(retained, [["session-1"]]);
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
