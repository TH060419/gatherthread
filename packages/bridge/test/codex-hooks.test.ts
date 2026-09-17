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
  isCodexHookSourceEnabled,
  readCodexHookSpool,
  renderCodexHookConfig,
  resolveWorkspaceCodexHookPaths,
  runCodexHookForwarder,
  updateCodexHookRegistry,
} from "../src/index.js";

test("Hook discovery admits only unknown project tasks and excludes connector-owned threads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-discovery-"));
  const registryPath = path.join(directory, "registry.json");
  const event = {
    hook_event_name: "UserPromptSubmit" as const,
    session_id: "desktop-new-task",
    turn_id: "turn-1",
    cwd: "/workspace",
    model: "gpt-test",
    prompt: "First local prompt",
  };
  await updateCodexHookRegistry({
    registryPath,
    workspacePath: "/workspace",
    discoverUnregistered: true,
    add: {
      "background-task": "background_execution",
      "snapshot-task": "snapshot_connector",
      "retired-task": "local_only",
    },
  });
  assert.equal(await isAllowedCodexHookEvent(registryPath, event), true);
  assert.equal(await isAllowedCodexHookEvent(registryPath, { ...event, cwd: "/workspace/subdirectory" }), true);
  assert.equal(await isAllowedCodexHookEvent(registryPath, { ...event, session_id: "background-task" }), false);
  assert.equal(await isAllowedCodexHookEvent(registryPath, { ...event, session_id: "snapshot-task" }), false);
  assert.equal(await isAllowedCodexHookEvent(registryPath, { ...event, session_id: "retired-task" }), false);
  assert.equal(await isAllowedCodexHookEvent(registryPath, { ...event, cwd: "/other" }), false);
  await updateCodexHookRegistry({ registryPath, workspacePath: "/workspace", discoverUnregistered: false });
  assert.equal(await isAllowedCodexHookEvent(registryPath, event), false);
});

test("Hook workspace checks resolve symlinks and reject a lexical descendant outside the root", {
  skip: process.platform === "win32" ? "POSIX symlink containment fixture" : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-containment-"));
  const workspacePath = path.join(directory, "workspace");
  const outsidePath = path.join(directory, "outside");
  await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
  await mkdir(path.join(workspacePath, "nested"));
  await symlink(outsidePath, path.join(workspacePath, "escape"), "dir");
  const registryPath = path.join(directory, "registry.json");
  await updateCodexHookRegistry({
    registryPath,
    workspacePath,
    add: { "thread-1": "execution" },
  });
  assert.equal(await isAllowedCodexHookEvent(registryPath, {
    ...promptEvent(), cwd: path.join(workspacePath, "nested"),
  }), true);
  assert.equal(await isAllowedCodexHookEvent(registryPath, {
    ...promptEvent(), cwd: path.join(workspacePath, "escape"),
  }), false);
});

test("disabling Hooks atomically creates a private registry and clears stale thread authorization", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-disabled-hooks-"));
  const registryPath = path.join(directory, "nested", "private", "registry.json");
  await updateCodexHookRegistry({
    registryPath,
    workspacePath: "/workspace",
    discoverUnregistered: true,
    add: {
      "desktop-task": "execution",
      "background-task": "background_execution",
    },
  });
  await updateCodexHookRegistry({
    registryPath,
    workspacePath: "/workspace",
    clearThreads: true,
    discoverUnregistered: false,
  });
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(registry.threads, {});
  assert.equal(registry.discoverUnregistered, false);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.dirname(registryPath))).mode & 0o777, 0o700);
    assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  }
});

test("Codex hook forwarder waits for a newly activated MULTI registry binding", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\gatherthread-test-${process.pid}-${Date.now()}`
    : path.join(directory, "relay.sock");
  const spoolPath = path.join(directory, "offline.jsonl");
  const registryPath = path.join(directory, "registry.json");
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
  const registryActivation = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void updateCodexHookRegistry({
        registryPath,
        workspacePath: "/workspace",
        add: { "thread-1": "execution" },
      }).then(resolve, reject);
    }, 50);
  });
  input.end(JSON.stringify(promptEvent()));
  await runCodexHookForwarder({ socketPath, spoolPath, registryPath, stdin: input, stdout: output });
  await registryActivation;
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

test("Codex hook installation replaces a stale GatherThread relay definition", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-replace-"));
  const configPath = path.join(directory, ".codex", "hooks.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(configPath), { recursive: true }));
  const stale = renderCodexHookConfig({
    hookScriptPath: "/safe/codex-hook.js",
    socketPath: "/private/old-relay.sock",
    spoolPath: "/private/old-spool.jsonl",
    registryPath: "/private/old-registry.json",
  });
  const current = renderCodexHookConfig({
    hookScriptPath: "/safe/codex-hook.js",
    socketPath: "/private/stable-relay.sock",
    spoolPath: "/private/stable-spool.jsonl",
    registryPath: "/private/stable-registry.json",
  });
  await writeFile(configPath, JSON.stringify(stale));
  await installCodexHookConfig({ workspacePath: directory, config: current });
  const installed = await readFile(configPath, "utf8");
  assert.doesNotMatch(installed, /old-relay|old-spool|old-registry/);
  assert.match(installed, /stable-relay/);
});

test("Codex hook installation does not rewrite an unchanged trusted definition", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-idempotent-"));
  const configPath = path.join(directory, ".codex", "hooks.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  const config = renderCodexHookConfig({
    hookScriptPath: "/safe/codex-hook.js",
    socketPath: "/private/stable-relay.sock",
    spoolPath: "/private/stable-spool.jsonl",
    registryPath: "/private/stable-registry.json",
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  await utimes(configPath, fixedTime, fixedTime);
  await installCodexHookConfig({ workspacePath: directory, config });
  assert.equal((await stat(configPath)).mtimeMs, fixedTime.getTime());
});

test("switching from installed project Hooks to plugin Hooks authorizes exactly one source", async (t) => {
  const temporaryBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const directory = await mkdtemp(path.join(temporaryBase, "gths-"));
  const homeDirectory = path.join(directory, "home");
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const paths = resolveWorkspaceCodexHookPaths(workspacePath, homeDirectory);
  const projectConfigPath = await installCodexHookConfig({
    workspacePath,
    config: renderCodexHookConfig({
      hookScriptPath: "/safe/codex-hook.js",
      socketPath: paths.hookSocketPath,
      spoolPath: paths.hookSpoolPath,
      registryPath: paths.hookRegistryPath,
    }),
  });
  await updateCodexHookRegistry({
    registryPath: paths.hookRegistryPath,
    workspacePath,
    add: { "thread-1": "execution" },
    hookSource: "project",
  });
  // The mode switch changes runtime authorization; it deliberately leaves the
  // already reviewed project configuration on disk.
  await updateCodexHookRegistry({
    registryPath: paths.hookRegistryPath,
    workspacePath,
    hookSource: "plugin",
  });
  assert.equal(await isCodexHookSourceEnabled(paths.hookRegistryPath, "project"), false);
  assert.equal(await isCodexHookSourceEnabled(paths.hookRegistryPath, "plugin"), true);
  assert.match(await readFile(projectConfigPath, "utf8"), /GatherThread local hook relay/);

  const events: unknown[] = [];
  const relay = new CodexHookRelayServer({
    socketPath: paths.hookSocketPath,
    hookSource: "plugin",
    onEvent: async (event) => {
      events.push(event);
      return { additionalContext: "one plugin capsule" };
    },
  });
  try {
    await relay.start();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.diagnostic("Hook IPC is blocked by the current test sandbox; source-registry assertions still ran");
      return;
    }
    throw error;
  }
  try {
    const event = { ...promptEvent("switch modes"), cwd: workspacePath };
    const projectInput = new PassThrough();
    const projectOutput = new PassThrough();
    let projectRendered = "";
    projectOutput.on("data", (chunk) => { projectRendered += chunk.toString("utf8"); });
    projectInput.end(JSON.stringify(event));
    await runCodexHookForwarder({
      socketPath: paths.hookSocketPath,
      spoolPath: paths.hookSpoolPath,
      registryPath: paths.hookRegistryPath,
      stdin: projectInput,
      stdout: projectOutput,
    });
    assert.deepEqual(JSON.parse(projectRendered), {});
    assert.deepEqual(await readCodexHookSpool(paths.hookSpoolPath), []);
    assert.equal(events.length, 0);

    const pluginScript = path.join(process.cwd(), "plugins", "gatherthread", "scripts", "hook-forwarder.mjs");
    const plugin = spawn(process.execPath, [pluginScript], {
      env: { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    plugin.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    plugin.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    plugin.stdin.end(JSON.stringify(event));
    const code = await new Promise<number | null>((resolve, reject) => {
      plugin.once("error", reject);
      plugin.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "one plugin capsule",
      },
    });
    assert.equal(events.length, 1);
  } finally {
    await relay.close();
  }
});

test("Windows hook configuration uses a PowerShell-safe override for the same forwarder", () => {
  const endpoint = "\\\\.\\pipe\\gatherthread-0123456789abcdef01234567-hook-relay";
  const config = renderCodexHookConfig({
    hookScriptPath: "C:\\GatherThread Project\\codex-hook.js",
    socketPath: endpoint,
    spoolPath: "C:\\GatherThread State\\hook-outbox.jsonl",
    registryPath: "C:\\GatherThread State\\hook-registry.json",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  }) as { hooks: { Stop: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }> } };
  const handler = config.hooks.Stop[0]?.hooks[0];
  const command = handler?.command ?? "";
  const commandWindows = handler?.commandWindows ?? "";
  assert.match(command, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.ok(command.includes(`"--socket" "${endpoint}"`));
  assert.equal(commandWindows, `& ${command}`);
  assert.doesNotMatch(command, /gta_|Bearer|GATHERTHREAD_TOKEN/);
  assert.throws(() => renderCodexHookConfig({
    hookScriptPath: "C:\\unsafe%PATH%\\codex-hook.js",
    socketPath: endpoint,
    spoolPath: "C:\\state\\spool.jsonl",
    registryPath: "C:\\state\\registry.json",
    platform: "win32",
  }), /Windows shell metacharacters/);
});

test("Windows command override launches through PowerShell", {
  skip: process.platform === "win32" ? false : "PowerShell command execution is Windows-only",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread hook powershell-"));
  const scriptPath = path.join(directory, "hook fixture.js");
  await writeFile(scriptPath, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}\\n'));\n");
  const config = renderCodexHookConfig({
    hookScriptPath: scriptPath,
    socketPath: "\\\\.\\pipe\\gatherthread-test-hook-relay",
    spoolPath: path.join(directory, "hook outbox.jsonl"),
    registryPath: path.join(directory, "hook registry.json"),
    nodePath: process.execPath,
    platform: "win32",
  }) as { hooks: { UserPromptSubmit: Array<{ hooks: Array<{ commandWindows: string }> }> } };
  const commandWindows = config.hooks.UserPromptSubmit[0]?.hooks[0]?.commandWindows;
  assert.ok(commandWindows);
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", commandWindows], {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdin.end("{}");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout, "{}\n");
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

test("unmanaged, snapshot, and local-only Codex tasks are neither relayed nor spooled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-hook-private-"));
  const registryPath = path.join(directory, "registry.json");
  const spoolPath = path.join(directory, "offline.jsonl");
  await updateCodexHookRegistry({
    registryPath,
    workspacePath: "/workspace",
    add: {
      "snapshot-thread": "snapshot_connector",
      "retired-thread": "local_only",
    },
  });
  for (const sessionId of ["unrelated-thread", "snapshot-thread", "retired-thread"]) {
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
    hook_event_name: "UserPromptSubmit" as const,
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
