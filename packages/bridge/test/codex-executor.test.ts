import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexCliExecutor,
  type CanonicalEvent,
  type RegisteredRuntime,
} from "../src/index.js";

test("Codex executor creates then resumes one thread with complete canonical deltas", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-executor-"));
  const statePath = path.join(directory, "codex-state.json");
  const capturePath = path.join(directory, "capture.jsonl");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
const resumed = args.includes("resume");
const threadId = "thread-test-1";
await appendFile(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({
  args,
  stdin,
  gatherThreadTokenPresent: process.env.GATHERTHREAD_TOKEN !== undefined,
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    id: resumed ? "command-2" : "command-1",
    type: "command_execution",
    command: "npm test",
    status: "completed",
    exit_code: 0,
    aggregated_output: "tests passed",
  },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { id: resumed ? "answer-2" : "answer-1", type: "agent_message", text: resumed ? "second answer" : "first answer" },
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);

  const executor = new CodexCliExecutor({
    workspacePath: directory,
    statePath,
    model: "gpt-test",
    command: process.execPath,
    commandArgs: [fakeCodex],
    env: {
      ...process.env,
      FAKE_CODEX_CAPTURE: capturePath,
      GATHERTHREAD_TOKEN: "gta_secret-that-must-not-reach-codex",
    },
  });
  const runtime = registeredRuntime();
  const firstRequest = canonical(2, "agent_request", { content: "implement the first step" });
  const first = await executor.execute({
    request: firstRequest,
    canonicalHistory: [
      canonical(1, "human_chat", { content: "shared constraint one" }, "user-2"),
      firstRequest,
    ],
    runtime,
  });
  assert.equal(first.localSessionId, "thread-test-1");
  assert.deepEqual(first.events.map((event) => event.kind), ["tool_call", "tool_result", "assistant"]);
  assert.equal(first.events.at(-1)?.content, "first answer");

  const secondRequest = canonical(5, "agent_request", { content: "implement the second step" });
  const second = await executor.execute({
    request: secondRequest,
    canonicalHistory: [
      canonical(1, "human_chat", { content: "shared constraint one" }, "user-2"),
      firstRequest,
      canonical(3, "agent_response", { text: "first answer" }, "user-1", runtimeProvenance(runtime)),
      canonical(4, "human_chat", { content: "new collaborator context" }, "user-2"),
      secondRequest,
    ],
    runtime,
  });
  assert.equal(second.events.at(-1)?.content, "second answer");

  const captures = (await readFile(capturePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(captures.length, 2);
  assert.ok(captures[0].args.includes("--ask-for-approval"));
  assert.ok(captures[0].args.includes("never"));
  assert.ok(captures[0].args.includes("workspace-write"));
  assert.equal(captures[0].gatherThreadTokenPresent, false);
  assert.match(captures[0].stdin, /shared constraint one/);
  assert.match(captures[0].stdin, /implement the first step/);
  assert.ok(captures[1].args.includes("resume"));
  assert.ok(captures[1].args.includes("thread-test-1"));
  assert.doesNotMatch(captures[1].stdin, /shared constraint one/);
  assert.doesNotMatch(captures[1].stdin, /first answer/);
  assert.match(captures[1].stdin, /new collaborator context/);
  assert.match(captures[1].stdin, /implement the second step/);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.threadId, "thread-test-1");
  assert.equal(state.coveredThroughSequence, 5);
});

test("Codex executor rejects oversized hydration before starting the harness", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gatherthread-codex-limit-"));
  const executor = new CodexCliExecutor({
    workspacePath: directory,
    statePath: path.join(directory, "state.json"),
    model: "gpt-test",
    command: "/does/not/exist",
    maxPromptBytes: 256,
  });
  const request = canonical(2, "agent_request", { content: "run" });
  await assert.rejects(executor.execute({
    request,
    canonicalHistory: [canonical(1, "human_chat", { content: "x".repeat(1_000) }), request],
    runtime: registeredRuntime(),
  }), /hydration prompt exceeds/);
});

function registeredRuntime(): RegisteredRuntime {
  return {
    id: "runtime-1",
    runtimeId: "runtime-1",
    userId: "user-1",
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-test",
    localSessionId: "gatherthread-session-1",
    captureFidelity: "harness_transcript",
  };
}

function runtimeProvenance(runtime: RegisteredRuntime) {
  return {
    userId: runtime.userId,
    deviceId: runtime.deviceId,
    runtimeId: runtime.id,
    harness: runtime.harness,
    provider: runtime.provider,
    model: runtime.model,
    localSessionId: runtime.localSessionId,
    captureFidelity: runtime.captureFidelity,
  };
}

function canonical(
  sequence: number,
  type: CanonicalEvent["type"],
  payload: unknown,
  actorId = "user-1",
  runtime?: CanonicalEvent["runtime"],
): CanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type,
    actorId,
    timestamp: `2026-08-25T00:00:0${sequence}.000Z`,
    payload,
    ...(runtime === undefined ? {} : { runtime }),
  };
}
