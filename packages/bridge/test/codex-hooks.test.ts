import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CodexHookRelayServer,
  drainCodexHookSpool,
  installCodexHookConfig,
  isAllowedCodexHookEvent,
  readCodexHookSpool,
  renderCodexHookConfig,
  runCodexHookForwarder,
  updateCodexHookRegistry,
} from "../src/index.js";

test("Codex hook relay returns bounded additional context without credentials in config", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\gatherthread-test-${process.pid}-${Date.now()}`
    : path.join(directory, "relay.sock");
  const spoolPath = path.join(directory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", add: { "thread-1": "execution" } });
  const events: unknown[] = [];
  const relay = new CodexHookRelayServer({
    socketPath,
    onEvent: async (event) => {
      events.push(event);
      return { additionalContext: "Cloud delta through sequence 7." };
    },
  });
  try {
    await relay.start();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      const config = JSON.stringify(renderCodexHookConfig({
        hookScriptPath: "/safe path/codex-hook.js",
        socketPath,
        spoolPath,
        registryPath,
      }));
      assert.doesNotMatch(config, /Bearer|GATHERTHREAD_TOKEN|gta_/);
      t.diagnostic("Unix sockets are blocked by the current test sandbox; relay integration is exercised outside it");
      return;
    }
    throw error;
  }
  t.after(() => relay.close());
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
  input.end(JSON.stringify(promptEvent()));
  await runCodexHookForwarder({ socketPath, spoolPath, registryPath, stdin: input, stdout: output });
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(rendered), {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Cloud delta through sequence 7.",
    },
  });
  const config = JSON.stringify(renderCodexHookConfig({
    hookScriptPath: "/safe path/codex-hook.js",
    socketPath,
    spoolPath,
    registryPath,
  }));
  assert.match(config, /UserPromptSubmit/);
  assert.match(config, /Stop/);
  assert.doesNotMatch(config, /Bearer|GATHERTHREAD_TOKEN|gta_/);
});

test("Codex hook installation preserves existing project hooks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-install-"));
  const configPath = path.join(directory, ".codex", "hooks.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(configPath), { recursive: true }));
  await writeFile(configPath, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-stop" }] }] },
    custom: true,
  }));
  await installCodexHookConfig({
    workspacePath: directory,
    config: renderCodexHookConfig({
      hookScriptPath: "/safe/codex-hook.js",
      socketPath: "/private/relay.sock",
      spoolPath: "/private/spool.jsonl",
      registryPath: "/private/registry.json",
    }),
  });
  const installed = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(installed.custom, true);
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.UserPromptSubmit.length, 1);
});

test("Windows hook configuration passes the named-pipe endpoint to the same forwarder", () => {
  const endpoint = "\\\\.\\pipe\\gatherthread-0123456789abcdef01234567-hook-relay";
  const config = renderCodexHookConfig({
    hookScriptPath: "C:\\GatherThread Project\\codex-hook.js",
    socketPath: endpoint,
    spoolPath: "C:\\GatherThread State\\hook-outbox.jsonl",
    registryPath: "C:\\GatherThread State\\hook-registry.json",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  }) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
  const command = config.hooks.Stop[0]?.hooks[0]?.command ?? "";
  assert.match(command, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.ok(command.includes(`"--socket" "${endpoint}"`));
  assert.doesNotMatch(command, /gta_|Bearer|GATHERTHREAD_TOKEN/);
  assert.throws(() => renderCodexHookConfig({
    hookScriptPath: "C:\\unsafe%PATH%\\codex-hook.js",
    socketPath: endpoint,
    spoolPath: "C:\\state\\spool.jsonl",
    registryPath: "C:\\state\\registry.json",
    platform: "win32",
  }), /Windows shell metacharacters/);
});

test("Codex hook relay recovers stale sockets and refuses active or non-socket paths", {
  skip: process.platform === "win32" ? "Unix socket filesystem lifecycle is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-socket-"));
  const socketPath = path.join(directory, "relay.sock");
  const active = new CodexHookRelayServer({ socketPath, onEvent: async () => ({}) });
  try {
    await active.start();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.diagnostic("Unix sockets are blocked by the current test sandbox; lifecycle coverage runs outside it");
      return;
    }
    throw error;
  }
  const duplicate = new CodexHookRelayServer({ socketPath, onEvent: async () => ({}) });
  await assert.rejects(duplicate.start(), /already active/);
  await active.close();
  await writeFile(socketPath, "do not replace");
  await assert.rejects(duplicate.start(), /non-socket/);

  const stalePath = path.join(directory, "stale.sock");
  const child = spawn(process.execPath, ["-e", [
    "const net=require('node:net');",
    "const s=net.createServer();",
    "s.listen(process.argv[1],()=>process.stdout.write('ready\\n'));",
    "setInterval(()=>{},1000);",
  ].join(""), stalePath], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("close", (code) => { if (code !== null) reject(new Error(`stale socket child exited ${code}`)); });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  const recovered = new CodexHookRelayServer({ socketPath: stalePath, onEvent: async () => ({}) });
  await recovered.start();
  await recovered.close();
});

test("Codex hook relay tightens a legacy owner state directory before binding", {
  skip: process.platform === "win32" ? "POSIX directory modes do not apply on Windows" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-legacy-mode-"));
  await chmod(directory, 0o755);
  const relay = new CodexHookRelayServer({
    socketPath: path.join(directory, "relay.sock"),
    onEvent: async () => ({}),
  });
  try {
    await relay.start();
    await relay.close();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    t.diagnostic("Unix sockets are blocked by the current test sandbox; mode migration still runs before listen");
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("Codex hook relay refuses to tighten a symbolic-link directory", {
  skip: process.platform === "win32" ? "POSIX symbolic-link directory modes do not apply on Windows" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-symlink-mode-"));
  const target = path.join(root, "shared-target");
  await mkdir(target, { mode: 0o755 });
  const linkedDirectory = path.join(root, "linked-state");
  await symlink(target, linkedDirectory);
  const relay = new CodexHookRelayServer({
    socketPath: path.join(linkedDirectory, "relay.sock"),
    onEvent: async () => ({}),
  });
  await assert.rejects(relay.start(), /socket directory must be private/);
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});

test("Windows hook relay uses named-pipe lifecycle and fails closed on listen conflicts", async () => {
  const endpoint = "\\\\.\\pipe\\gatherthread-0123456789abcdef01234567-hook-relay";
  const listening = new FakeRelayServer();
  const relay = new CodexHookRelayServer({
    socketPath: endpoint,
    platform: "win32",
    serverFactory: () => listening as unknown as NetServer,
    onEvent: async () => ({}),
  });
  await relay.start();
  assert.equal(listening.endpoint, endpoint);
  await relay.close();
  assert.equal(listening.closeCount, 1);

  const conflict = new FakeRelayServer(Object.assign(new Error("pipe already active"), { code: "EADDRINUSE" }));
  const duplicate = new CodexHookRelayServer({
    socketPath: endpoint,
    platform: "win32",
    serverFactory: () => conflict as unknown as NetServer,
    onEvent: async () => ({}),
  });
  await assert.rejects(duplicate.start(), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "EADDRINUSE",
  );
});

test("offline Codex hook writes a private spool and continues fail-open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-offline-"));
  const spoolDirectory = path.join(directory, "private-spool");
  const spoolPath = path.join(spoolDirectory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", add: { "thread-1": "execution" } });
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
  input.end(JSON.stringify(promptEvent()));
  await runCodexHookForwarder({
    socketPath: path.join(directory, "missing.sock"),
    spoolPath,
    registryPath,
    stdin: input,
    stdout: output,
  });
  assert.deepEqual(JSON.parse(rendered), {});
  assert.equal((await readCodexHookSpool(spoolPath))[0]?.hook_event_name, "UserPromptSubmit");
  if (process.platform !== "win32") {
    assert.equal((await stat(spoolPath)).mode & 0o777, 0o600);
    assert.equal((await stat(spoolDirectory)).mode & 0o777, 0o700);
  }
});

test("Codex hook drain recovers every stale file in deterministic order", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-recovery-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  await writeFile(`${spoolPath}.draining-zz-0002`, `${JSON.stringify(promptEvent("second"))}\n`, { mode: 0o600 });
  await writeFile(`${spoolPath}.draining-zz-0001`, `${JSON.stringify(promptEvent("first"))}\n`, { mode: 0o600 });
  await writeFile(spoolPath, `${JSON.stringify(promptEvent("active"))}\n`, { mode: 0o600 });
  const prompts: string[] = [];
  assert.equal(await drainCodexHookSpool(spoolPath, async (event) => {
    if (event.hook_event_name === "UserPromptSubmit") prompts.push(event.prompt);
  }), 3);
  assert.deepEqual(prompts, ["first", "second", "active"]);
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".draining-")), []);
});

test("Codex hook drain preserves valid events and quarantines truncated JSONL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-corrupt-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  const truncated = '{"hook_event_name":"Stop","session_id":"thread-1"';
  await writeFile(spoolPath, [
    JSON.stringify(promptEvent("before")),
    "not-json",
    JSON.stringify(promptEvent("after")),
    truncated,
  ].join("\n"), { mode: 0o600 });
  const prompts: string[] = [];
  assert.equal(await drainCodexHookSpool(spoolPath, async (event) => {
    if (event.hook_event_name === "UserPromptSubmit") prompts.push(event.prompt);
  }), 2);
  assert.deepEqual(prompts, ["before", "after"]);
  const quarantineNames = (await readdir(directory)).filter((name) => name.includes(".quarantine-"));
  assert.equal(quarantineNames.length, 1);
  const quarantinePath = path.join(directory, quarantineNames[0]!);
  const quarantine = await readFile(quarantinePath, "utf8");
  assert.match(quarantine, /not-json/);
  assert.match(quarantine, /hook_event_name/);
  assert.doesNotMatch(quarantine, /before|after/);
  if (process.platform !== "win32") {
    assert.equal((await stat(quarantinePath)).mode & 0o777, 0o600);
  }
  assert.equal(await drainCodexHookSpool(spoolPath, async () => assert.fail("quarantine must not be replayed")), 0);
});

test("Codex hook drain retains only unprocessed events after a handler failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-retry-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  await writeFile(spoolPath, [
    JSON.stringify(promptEvent("done")),
    JSON.stringify(promptEvent("retry")),
  ].join("\n") + "\n", { mode: 0o600 });
  await assert.rejects(drainCodexHookSpool(spoolPath, async (event) => {
    if (event.hook_event_name === "UserPromptSubmit" && event.prompt === "retry") throw new Error("offline");
  }), /offline/);
  const retried: string[] = [];
  assert.equal(await drainCodexHookSpool(spoolPath, async (event) => {
    if (event.hook_event_name === "UserPromptSubmit") retried.push(event.prompt);
  }), 1);
  assert.deepEqual(retried, ["retry"]);
});

test("stale spool entries outside the refreshed execution allowlist are discarded without replay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-acl-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
  await updateCodexHookRegistry({
    registryPath,
    workspacePath: "/workspace",
    add: { "thread-revoked": "execution", "thread-retained": "execution" },
  });
  await writeFile(spoolPath, [
    JSON.stringify({ ...promptEvent("revoked"), session_id: "thread-revoked" }),
    JSON.stringify({ ...promptEvent("retained"), session_id: "thread-retained" }),
  ].join("\n") + "\n", { mode: 0o600 });
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", remove: ["thread-revoked"] });
  const replayed: string[] = [];
  await drainCodexHookSpool(spoolPath, async (event) => {
    if (!await isAllowedCodexHookEvent(registryPath, event)) return;
    if (event.hook_event_name === "UserPromptSubmit") replayed.push(event.prompt);
  });
  assert.deepEqual(replayed, ["retained"]);
  assert.deepEqual(await readCodexHookSpool(spoolPath), []);
});

test("Codex hook spool enforces byte and entry quotas without acknowledging loss", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-quota-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", add: { "thread-1": "execution" } });
  await forwardOffline({ directory, spoolPath, registryPath, prompt: "kept", maxSpoolBytes: 16 * 1024, maxSpoolEntries: 1 });
  await assert.rejects(forwardOffline({
    directory,
    spoolPath,
    registryPath,
    prompt: "rejected-by-entry-limit",
    maxSpoolBytes: 16 * 1024,
    maxSpoolEntries: 1,
  }), /spool is full.*not acknowledged/);
  assert.deepEqual((await readCodexHookSpool(spoolPath)).map((event) => event.hook_event_name === "UserPromptSubmit" ? event.prompt : ""), ["kept"]);

  const byteLimitedPath = path.join(directory, "byte-limited.jsonl");
  await assert.rejects(forwardOffline({
    directory,
    spoolPath: byteLimitedPath,
    registryPath,
    prompt: "too large",
    maxSpoolBytes: 8,
    maxSpoolEntries: 10,
  }), /spool is full.*not acknowledged/);
  assert.deepEqual(await readCodexHookSpool(byteLimitedPath), []);
});

test("Codex hook spool never reclaims an active lock based on old mtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-live-lock-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
  const lockPath = `${spoolPath}.lock`;
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", add: { "thread-1": "execution" } });
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, created_at: "2000-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  await utimes(lockPath, new Date(0), new Date(0));
  await assert.rejects(forwardOffline({
    directory,
    spoolPath,
    registryPath,
    prompt: "must-not-race",
    maxSpoolBytes: 16 * 1024,
    maxSpoolEntries: 10,
  }), /spool is busy.*not acknowledged/);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
  assert.deepEqual(await readCodexHookSpool(spoolPath), []);
});

test("Codex hook spool reclaims a lock only after its owner process is dead", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-dead-lock-"));
  const spoolPath = path.join(directory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("close", (code) => { if (code !== null) reject(new Error(`lock owner child exited ${code}`)); });
  });
  const deadPid = child.pid;
  assert.ok(deadPid);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", add: { "thread-1": "execution" } });
  await writeFile(`${spoolPath}.lock`, `${JSON.stringify({ pid: deadPid, created_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  await forwardOffline({
    directory,
    spoolPath,
    registryPath,
    prompt: "recovered",
    maxSpoolBytes: 16 * 1024,
    maxSpoolEntries: 10,
  });
  assert.deepEqual((await readCodexHookSpool(spoolPath)).map((event) => event.hook_event_name === "UserPromptSubmit" ? event.prompt : ""), ["recovered"]);
});

test("unmanaged and snapshot Codex tasks are neither relayed nor spooled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-private-"));
  const registryPath = path.join(directory, "registry.json");
  const spoolPath = path.join(directory, "offline.jsonl");
  await updateCodexHookRegistry({
    registryPath,
    workspacePath: "/workspace",
    add: { "snapshot-thread": "snapshot_connector" },
  });
  for (const sessionId of ["unrelated-thread", "snapshot-thread"]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
    input.end(JSON.stringify({ ...promptEvent(), session_id: sessionId }));
    await runCodexHookForwarder({
      socketPath: path.join(directory, "missing.sock"),
      spoolPath,
      registryPath,
      stdin: input,
      stdout: output,
    });
    assert.deepEqual(JSON.parse(rendered), {});
  }
  assert.deepEqual(await readCodexHookSpool(spoolPath), []);
});

async function forwardOffline(input: {
  directory: string;
  spoolPath: string;
  registryPath: string;
  prompt: string;
  maxSpoolBytes: number;
  maxSpoolEntries: number;
}): Promise<void> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.end(JSON.stringify(promptEvent(input.prompt)));
  await runCodexHookForwarder({
    socketPath: path.join(input.directory, "missing.sock"),
    spoolPath: input.spoolPath,
    registryPath: input.registryPath,
    stdin,
    stdout,
    maxSpoolBytes: input.maxSpoolBytes,
    maxSpoolEntries: input.maxSpoolEntries,
  });
}

function promptEvent(prompt = "local request") {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-1",
    turn_id: "turn-1",
    cwd: "/workspace",
    model: "gpt-test",
    prompt,
  };
}

class FakeRelayServer extends EventEmitter {
  endpoint: string | undefined;
  closeCount = 0;
  readonly #listenError: Error | undefined;

  constructor(listenError?: Error) {
    super();
    this.#listenError = listenError;
  }

  listen(endpoint: string, callback: () => void): this {
    this.endpoint = endpoint;
    if (this.#listenError) queueMicrotask(() => this.emit("error", this.#listenError));
    else queueMicrotask(callback);
    return this;
  }

  close(callback: (error?: Error) => void): this {
    this.closeCount += 1;
    queueMicrotask(callback);
    return this;
  }
}
