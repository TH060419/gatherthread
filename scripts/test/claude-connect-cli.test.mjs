import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseClaudeConnectArgs, normalizeClaudeNativeHookEvent, ClaudeNativeHookRelay } from "../../packages/claude-connect/dist/index.js";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
test("Claude CLI preserves exact routes, explicit file consent and safe permissions", () => {
  const flags = ["--url", "https://test.gatherthread.cn/", "--model", "claude-sonnet-fixture", "--project", "project-1", "--workspace", root];
  const parsed = parseClaudeConnectArgs([...flags, "--plugin-hooks", "--code-sync", "--github-code-sync", "example/project"]);
  assert.equal(parsed.apiUrl, "https://test.gatherthread.cn/v1");
  assert.equal(parsed.permissionMode, "native");
  for (const mode of ["native", "manual", "plan"]) assert.equal(parseClaudeConnectArgs([...flags, "--permission-mode", mode]).permissionMode, mode);
  assert.equal(parsed.githubCodeSync, "example/project");
  for (const alias of ["default", "best", "fable", "sonnet", "opus", "haiku", "opusplan", "sonnet[1m]", "proxy/claude-sonnet-fixture", "claude-", "claude-sonnet[1m]", `claude-${"x".repeat(114)}`]) {
    assert.throws(() => parseClaudeConnectArgs(["--url", "https://gatherthread.cn", "--model", alias]), /exact Claude model/u);
  }
  assert.throws(() => parseClaudeConnectArgs([...flags, "--permission-mode", "bypassPermissions"]), /native, manual or plan/u);
  assert.throws(() => parseClaudeConnectArgs([...flags, "--code-sync"]), /reviewed/u);
  assert.throws(() => parseClaudeConnectArgs([...flags, "--token", "not-accepted"]), /never command arguments/u);
  for (const url of ["http://example.com", "https://example.com/path", "https://user:password@example.com", "https://example.com?token=x"]) {
    assert.throws(() => parseClaudeConnectArgs(["--url", url, "--model", "claude-sonnet-fixture"]), /credential-free/u);
  }
});

test("Claude Hook projection strips provider metadata, private instructions and transcript paths", () => {
  const event = { hook_event_name: "UserPromptSubmit", session_id: randomUUID(), cwd: root, prompt: "Public task",
    transcript_path: "/private/session.jsonl", system_prompt: "PRIVATE_INSTRUCTIONS", provider_headers: { authorization: "PRIVATE" } };
  assert.deepEqual(normalizeClaudeNativeHookEvent(event, root), { hook_event_name: event.hook_event_name,
    session_id: event.session_id, cwd: root, prompt: "Public task" });
  assert.throws(() => normalizeClaudeNativeHookEvent({ ...event, cwd: path.dirname(root) }, root), /Unbound/u);
  assert.throws(() => normalizeClaudeNativeHookEvent({ ...event, prompt: "x".repeat(65537) }, root), /Invalid/u);
});
test("terminal Claude metadata survives an uncapturable answer or invalid proof path", () => {
  const stop = { hook_event_name: "Stop", session_id: randomUUID(), cwd: root,
    last_assistant_message: "x".repeat(262145), transcript_path: "not-an-absolute-path" };
  const normalized = normalizeClaudeNativeHookEvent(stop, root);
  assert.equal(normalized.hook_event_name, "Stop");
  assert.equal(normalized.last_assistant_message, undefined);
  assert.equal(normalized.transcript_path, undefined);
});

test("Claude native private state rejects a symlink in any state ancestor", async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "gch-link-")));
  const workspacePath = path.join(temporary, "w"), homeDirectory = path.join(temporary, "h"), outside = path.join(temporary, "outside");
  await Promise.all([workspacePath, homeDirectory, outside].map(directory => mkdir(directory)));
  await symlink(outside, path.join(homeDirectory, ".gatherthread"), process.platform === "win32" ? "junction" : "dir");
  const relay = new ClaudeNativeHookRelay({ workspacePath, homeDirectory, onEvent: async () => ({}) });
  await assert.rejects(relay.start(), /ancestor links|canonical private root/u);
  await relay.close();
});

test("Claude native hook socket requires its private per-run capability", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX socket test; named pipe naming has deterministic coverage");
  const temporary = await realpath(await mkdtemp("/tmp/gch-")), workspacePath = path.join(temporary, "w"), homeDirectory = path.join(temporary, "h");
  await Promise.all([workspacePath, homeDirectory].map(directory => mkdir(directory)));
  const received = [];
  const relay = new ClaudeNativeHookRelay({ workspacePath, homeDirectory, onEvent: async event => { received.push(event); return { additionalContext: "Untrusted shared context" }; } });
  await relay.start(); t.after(() => relay.close());
  const hash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 24);
  const directory = path.join(homeDirectory, ".gatherthread/claude-code/hooks", hash);
  const registry = JSON.parse(await readFile(path.join(directory, "hook-registry.json"), "utf8"));
  const event = { hook_event_name: "UserPromptSubmit", session_id: randomUUID(), cwd: workspacePath, prompt: "Public task", transcript_path: "PRIVATE" };
  const send = capability => new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(directory, "hook-relay.sock")); let value = "";
    socket.setEncoding("utf8"); socket.once("connect", () => socket.write(JSON.stringify({ capability, event }) + "\n"));
    socket.on("data", chunk => { value += chunk; }); socket.once("end", () => resolve(JSON.parse(value))); socket.once("error", reject);
  });
  assert.deepEqual(await send("wrong-capability"), {});
  assert.equal(received.length, 0);
  assert.deepEqual(await send(registry.capability), { additionalContext: "Untrusted shared context" });
  assert.equal(received.length, 1);
  assert.doesNotMatch(JSON.stringify(received), /transcript_path|PRIVATE/u);
});

test("Claude Hook blocks only an authenticated explicit prompt conflict and keeps other failures fail-open", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX socket integration; Windows uses the same selected response protocol");
  const temporary = await realpath(await mkdtemp("/tmp/gch-block-")), workspacePath = path.join(temporary, "w"), homeDirectory = path.join(temporary, "h");
  await Promise.all([workspacePath, homeDirectory].map(directory => mkdir(directory)));
  let mode = "block";
  const received = [];
  const relay = new ClaudeNativeHookRelay({ workspacePath, homeDirectory, onEvent: async event => {
    received.push(event);
    if (mode === "throw") throw new Error("PRIVATE_TRANSPORT_DIAGNOSTIC");
    return mode === "block" ? { block: true, reason: "PRIVATE_INTERNAL_STATE", additionalContext: "PRIVATE_CONFLICT_CONTEXT" }
      : { additionalContext: "Public shared context" };
  } });
  await relay.start(); t.after(() => relay.close());
  const forward = (name, body = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "plugins/gatherthread-claude/scripts/hook-forwarder.mjs")], {
      env: { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
    child.once("error", reject); child.once("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: name, session_id: randomUUID(), cwd: workspacePath,
      prompt: "Public prompt", last_assistant_message: "Public answer", block: true, reason: "PRIVATE_INJECTED_REASON", ...body }));
  });
  const blocked = await forward("UserPromptSubmit");
  assert.equal(blocked.status, 0); assert.equal(blocked.stderr, "");
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block"); assert.match(decision.reason, /GatherThread.*finish/u);
  assert.doesNotMatch(blocked.stdout, /PRIVATE_|additionalContext/u);
  assert.deepEqual(JSON.parse((await forward("Stop")).stdout), {});
  mode = "throw";
  const failed = await forward("UserPromptSubmit");
  assert.equal(failed.status, 0); assert.equal(failed.stdout, "{}\n"); assert.equal(failed.stderr, "");
  mode = "context";
  assert.deepEqual(JSON.parse((await forward("UserPromptSubmit")).stdout), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Public shared context" },
  });
  assert.deepEqual(JSON.parse((await forward("Stop", { last_assistant_message: "x".repeat(1024 * 1024 + 1),
    unused_metadata: { nested: ["quoted } \\\" and \\ private text".repeat(40000)] } })).stdout), {});
  assert.equal(received.at(-1).hook_event_name, "Stop");
  assert.equal(received.at(-1).last_assistant_message, undefined);
});
