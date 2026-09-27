import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClaudeCodeProjectAdapter,
  CodexRolloutAdapter,
  discoverJsonlTranscripts,
  redactTranscriptEvent,
  resolveAuthorizedPath,
  tailJsonlTranscript,
} from "../src/index.js";

test("Codex rollout import keeps visible messages and structured tool events only", () => {
  const adapter = new CodexRolloutAdapter();
  const records = [
    { type: "response_item", payload: { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "hello" }] } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "private" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: "hidden" } },
    { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: "{\"cmd\":\"pwd\"}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
  ];
  const events = records.flatMap((record) => adapter.parseLine(JSON.stringify(record)));
  assert.deepEqual(events.map((item) => item.kind), ["user", "tool_call", "tool_result"]);
  assert.equal(events[0]?.content, "hello");
  assert.deepEqual(events[1]?.arguments, { cmd: "pwd" });
  assert.ok(events.every((item) => item.captureFidelity === "harness_transcript"));
});

test("Claude Code import splits visible text, tool calls, and tool results", () => {
  const adapter = new ClaudeCodeProjectAdapter();
  const assistant = adapter.parseLine(JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "working" },
      { type: "tool_use", id: "t1", name: "Read", input: { file: "a" } },
    ] },
  }));
  const result = adapter.parseLine(JSON.stringify({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "contents" },
    ] },
  }));
  assert.deepEqual([...assistant, ...result].map((item) => item.kind), [
    "assistant", "tool_call", "tool_result",
  ]);
  assert.equal(assistant[0]?.content, "working");
});

test("redaction covers secret-bearing strings and nested structured values", () => {
  const redacted = redactTranscriptEvent({
    kind: "tool_call",
    localEventId: "1",
    harness: "codex",
    captureFidelity: "harness_transcript",
    content: "Authorization: Bearer abcdefghijklmnop",
    arguments: {
      api_key: "top-secret",
      nested: "password=hunter2 GATHERTHREAD_TOKEN=gta_01234567890123456789012345678901 browser=gtb_01234567890123456789012345678901 legacy=acp_01234567890123456789012345678901",
      systemPrompt: "private instructions",
      privateKey: "private material",
      localSessionId: "/private/local/thread.jsonl",
      GATHERTHREAD_AUTH_TOKEN_PEPPER: "private pepper",
      tokenCount: 12,
    },
  });
  assert.equal(redacted.content, "Authorization: [REDACTED]");
  assert.deepEqual(redacted.arguments, {
    api_key: "[REDACTED]",
    nested: "password=[REDACTED] GATHERTHREAD_TOKEN=[REDACTED] browser=[REDACTED] legacy=[REDACTED]",
    systemPrompt: "[REDACTED]",
    privateKey: "[REDACTED]",
    localSessionId: "[REDACTED]",
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "[REDACTED]",
    tokenCount: 12,
  });
});

test("tailing advances only through complete lines and resumes without duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adapter-tail-"));
  const transcript = path.join(root, "rollout.jsonl");
  const first = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "one" } });
  const second = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "two" } });
  await writeFile(transcript, `${first}\n${second.slice(0, 20)}`);

  const initial = await tailJsonlTranscript(new CodexRolloutAdapter(), transcript, undefined, {
    authorizedRoots: [root],
  });
  assert.deepEqual(initial.events.map((item) => item.content), ["one"]);
  await writeFile(transcript, `${first}\n${second}\n`);
  const resumed = await tailJsonlTranscript(new CodexRolloutAdapter(), transcript, initial.cursor, {
    authorizedRoots: [root],
  });
  assert.deepEqual(resumed.events.map((item) => item.content), ["two"]);
});

test("authorized roots reject traversal and symlink escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adapter-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "adapter-outside-"));
  const target = path.join(outside, "secret.jsonl");
  const link = path.join(root, "escape");
  const linkedTarget = path.join(link, "secret.jsonl");
  await writeFile(target, "{}\n");
  await assert.rejects(resolveAuthorizedPath(target, [root]), /outside authorized roots/);
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveAuthorizedPath(linkedTarget, [root]), /outside authorized roots/);
  await assert.rejects(resolveAuthorizedPath(target, []), /explicitly authorized/);
});

test("transcript discovery and tailing refuse hardlinks to files outside authorized roots", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "adapter-hardlink-"));
  const root = path.join(temporary, "authorized");
  await mkdir(root);
  const outside = path.join(temporary, "outside.jsonl");
  const transcript = path.join(root, "linked.jsonl");
  await writeFile(outside, `${JSON.stringify({
    type: "response_item", payload: { type: "message", role: "user", content: "private outside transcript" },
  })}\n`);
  await link(outside, transcript);
  await assert.rejects(tailJsonlTranscript(new CodexRolloutAdapter(), transcript, undefined, {
    authorizedRoots: [root],
  }), /single-link regular file/u);
  assert.deepEqual(await discoverJsonlTranscripts("codex", [root]), []);
});

test("discovery is recursive but remains scoped to explicitly authorized roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adapter-discovery-"));
  const outside = await mkdtemp(path.join(tmpdir(), "adapter-discovery-outside-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "session.jsonl"), "{}\n");
  await writeFile(path.join(root, "nested", "ignore.txt"), "no");
  await writeFile(path.join(outside, "outside.jsonl"), "{}\n");
  await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

  const files = await discoverJsonlTranscripts("codex", [root]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, await realpath(path.join(root, "nested", "session.jsonl")));
});
