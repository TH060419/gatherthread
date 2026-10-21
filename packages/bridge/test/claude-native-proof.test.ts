import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureClaudeNativeTranscriptAnchor, readClaudeNativeTurnProof } from "../src/claude-native-proof.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("native Claude proof reads only its exact current turn and observes the actual model after a switch", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-proof-")));
  const workspace = path.join(dir, "workspace"), config = path.join(dir, "config");
  await mkdir(workspace); const project = path.join(config, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-")); await mkdir(project, { recursive: true });
  const id = randomUUID(), file = path.join(project, `${id}.jsonl`);
  const startedAt = "2026-10-22T00:00:01.000Z";
  const records = [
    { type: "user", uuid: "user-1", sessionId: id, cwd: workspace, timestamp: startedAt, message: { role: "user", content: "Question" } },
    { type: "assistant", uuid: "assistant-1", sessionId: id, cwd: workspace, timestamp: "2026-10-22T00:00:02.000Z", message: { role: "assistant", model: "claude-opus-fixture", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "Answer" }] } },
  ];
  await writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  const options = { configDirectory: config, workspacePath: workspace, nativeSessionId: id, transcriptPath: file,
    promptDigest: hash("Question"), answerDigest: hash("Answer"), startedAt };
  assert.deepEqual(await readClaudeNativeTurnProof(options), { observedModel: "claude-opus-fixture" });
  await assert.rejects(readClaudeNativeTurnProof({ ...options, promptDigest: hash("Different") }), /current|prompt|proof/);
  await assert.rejects(readClaudeNativeTurnProof({ ...options, answerDigest: hash("Different") }), /final|answer|proof/);
  await assert.rejects(readClaudeNativeTurnProof({ ...options, nativeSessionId: randomUUID() }), /session|path|proof/);
  await assert.rejects(readClaudeNativeTurnProof({ ...options, workspacePath: dir }), /workspace|path|proof/);
  await assert.rejects(readClaudeNativeTurnProof({ ...options, startedAt: "2026-10-22T00:00:03.000Z" }), /current|proof|turn/);
  const invalidDate = records.map(record => record.type === "assistant" ? { ...record, timestamp: "invalid-date" } : record);
  await writeFile(file, invalidDate.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  await assert.rejects(readClaudeNativeTurnProof(options), /current|proof|turn/);
  await writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  const outside = path.join(dir, `${id}.jsonl`); await writeFile(outside, "{}\n", { mode: 0o600 });
  await assert.rejects(readClaudeNativeTurnProof({ ...options, transcriptPath: outside }), /path|root|proof/);
  const hard = path.join(project, "hard.jsonl"); await link(file, hard);
  await assert.rejects(readClaudeNativeTurnProof(options), /regular|link|proof/);
  const symbolic = path.join(project, `${randomUUID()}.jsonl`); await symlink(outside, symbolic);
  await assert.rejects(readClaudeNativeTurnProof({ ...options, transcriptPath: symbolic }), /path|link|proof/);
});

test("a Stop metadata anchor preserves an older private turn after more than a MiB of later native output", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-proof-anchor-")));
  const workspace = path.join(dir, "workspace"), config = path.join(dir, "config");
  await mkdir(workspace); const project = path.join(config, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-")); await mkdir(project, { recursive: true });
  const id = randomUUID(), file = path.join(project, `${id}.jsonl`), startedAt = "2026-10-22T00:00:01.000Z";
  const original = [
    { type: "user", sessionId: id, cwd: workspace, timestamp: startedAt, message: { content: "First question" } },
    { type: "assistant", sessionId: id, cwd: workspace, timestamp: "2026-10-22T00:00:02.000Z", message: { model: "claude-opus-fixture", content: [{ type: "text", text: "First answer" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(file, original, { mode: 0o600 });
  const options = { configDirectory: config, workspacePath: workspace, nativeSessionId: id, transcriptPath: file,
    promptDigest: hash("First question"), answerDigest: hash("First answer"), startedAt, endedAt: "2026-10-22T00:00:03.000Z" };
  const transcriptAnchor = await captureClaudeNativeTranscriptAnchor(options);
  assert.ok(transcriptAnchor);
  const later = JSON.stringify({ type: "progress", ignored: "x".repeat(2 * 1024 * 1024) }) + "\n";
  await writeFile(file, original + later, { mode: 0o600 });
  await assert.rejects(readClaudeNativeTurnProof(options), /proof/);
  assert.deepEqual(await readClaudeNativeTurnProof({ ...options, transcriptAnchor }), { observedModel: "claude-opus-fixture" });
});
