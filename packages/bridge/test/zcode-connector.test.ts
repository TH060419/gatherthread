import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertUsableZcodeCli,
  LocalBridge,
  MemoryCursorStore,
  pendingZcodeLocalSessionId,
  probeZcodeCli,
  resolveZcodeCommand,
  renderZcodePrompt,
  saveZcodeState,
  ZcodeProjectHarness,
  ZcodeSessionExecutor,
  zcodeHeadlessArgs,
  type AppendEventInput,
  type AgentProgressInput,
  type CanonicalEvent,
  type CollaborationApi,
  type CompleteAgentRequestInput,
  type RegisteredRuntime,
  type RuntimeRegistration,
  type ZcodeCliProbe,
  type ZcodeConnectorState,
} from "../src/index.js";

const usableProbe: ZcodeCliProbe = {
  version: "test-cli 1.0.0",
  supportsHeadless: true,
  supportsStreamJson: true,
  supportsResume: true,
  supportsStdinPrompt: true,
};

function canonicalEvent(overrides: Partial<CanonicalEvent> & { sequence: number; type: CanonicalEvent["type"] }): CanonicalEvent {
  return {
    id: `event-${overrides.sequence}`,
    sessionId: "session-1",
    actorId: "user-1",
    actorDisplayName: "Ada",
    timestamp: "2026-09-20T00:00:00.000Z",
    payload: { content: `body ${overrides.sequence}` },
    ...overrides,
  };
}

interface RecordedSpawn {
  args: string[];
  stdinPrompt: string | undefined;
}

function recordedExecutor(statePath: string, options: {
  stream?: string;
  exitCode?: number;
  capture?: RecordedSpawn[];
  shareToolEvents?: boolean;
} = {}): ZcodeSessionExecutor {
  const stream = options.stream ?? defaultStream("credentials-removed");
  const spawnRunner = async (spawnOptions: {
    args: readonly string[];
    stdinPrompt: string | undefined;
    onStdoutLine: (line: string) => void;
  }) => {
    options.capture?.push({
      args: [...spawnOptions.args],
      stdinPrompt: spawnOptions.stdinPrompt,
    });
    if ((options.exitCode ?? 0) !== 0) throw new Error("ZCode CLI exited unsuccessfully (1)");
    for (const line of stream.split("\n")) spawnOptions.onStdoutLine(line);
  };
  return new ZcodeSessionExecutor({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    sessionId: "session-1",
    workspacePath: ".",
    statePath,
    shareToolEvents: options.shareToolEvents ?? true,
  }, spawnRunner);
}

function defaultStream(answerText: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess_generated_1", model: "GLM-Test-1" }),
    JSON.stringify({ type: "assistant", uuid: "a1", session_id: "sess_generated_1", message: { role: "assistant", content: [
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "text", text: "thinking out loud" },
    ] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", session_id: "sess_generated_1", message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
    ] } }),
    JSON.stringify({ type: "user", uuid: "u1", session_id: "sess_generated_1", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ] } }),
    JSON.stringify({ type: "assistant", uuid: "a3", session_id: "sess_generated_1", message: { role: "assistant", content: [
      { type: "text", text: answerText },
    ] } }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "sess_generated_1", result: "final result text" }),
    "",
  ].join("\n");
}

test("ZCode execution maps stream-json into one final answer, shared tool events, and durable binding state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-exec-"));
  const statePath = path.join(root, "state", "binding-session.json");
  const progress: { id: string; content: string }[] = [];
  const executor = recordedExecutor(statePath);
  const result = await executor.execute({
    request: canonicalEvent({ sequence: 5, type: "agent_request" }),
    canonicalHistory: [
      canonicalEvent({ sequence: 1, type: "human_chat" }),
      canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "do the thing" } }),
    ],
    runtime: runtimeValue(),
    publishProgress: async (update) => {
      progress.push({ id: update.id, content: update.content });
    },
  });

  assert.deepEqual(result.events.map((event) => event.kind), ["tool_call", "tool_result", "assistant"]);
  assert.equal(result.localSessionId, "sess_generated_1");
  assert.equal(result.observedModel, "GLM-Test-1");
  assert.equal(result.events.at(-1)?.content, "final result text");
  assert.equal(result.events.at(-1)?.harness, "zcode");
  assert.deepEqual(progress.map((update) => update.content), ["thinking out loud", "credentials-removed"]);

  const state = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(state.version, 1);
  assert.equal(state.sessions["session-1"]?.localSessionId, "sess_generated_1");
  assert.equal(state.sessions["session-1"]?.projectedThroughSequence, 5);
  assert.equal(state.sessions["session-1"]?.observedModel, "GLM-Test-1");
  await rm(root, { recursive: true, force: true });
});

test("ZCode headless arguments resume the recorded native session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-resume-"));
  const statePath = path.join(root, "binding-session.json");
  await saveZcodeState(statePath, {
    version: 1,
    sessions: { "session-1": { localSessionId: "sess_prev_1", projectedThroughSequence: 3, observedModel: "GLM-Old" } },
  });
  const captured: RecordedSpawn[] = [];
  const executor = recordedExecutor(statePath, { capture: captured });
  const result = await executor.execute({
    request: canonicalEvent({ sequence: 5, type: "agent_request" }),
    canonicalHistory: [
      canonicalEvent({ sequence: 2, type: "human_chat" }),
      canonicalEvent({ sequence: 3, type: "human_chat" }),
      canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "continue" } }),
    ],
    runtime: runtimeValue(),
  });

  assert.equal(result.localSessionId, "sess_generated_1");
  const spawn = captured[0];
  assert.ok(spawn);
  const resumeIndex = spawn.args.indexOf("--resume");
  assert.ok(resumeIndex >= 0);
  assert.equal(spawn.args[resumeIndex + 1], "sess_prev_1");
  assert.equal(spawn.stdinPrompt, undefined);
  await rm(root, { recursive: true, force: true });
});

test("ZCode execution strips GatherThread credentials from the child environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-env-"));
  const statePath = path.join(root, "binding-session.json");
  const script = `
const lines = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_env_1", model: "GLM-Test-1" }),
  JSON.stringify({ type: "assistant", uuid: "a1", session_id: "sess_env_1", message: { role: "assistant", content: [
    { type: "text", text: ["GATHERTHREAD_TOKEN", "GATHERTHREAD_BEARER_TOKEN", "GATHERTHREAD_AUTH_TOKEN_PEPPER"].every((name) => process.env[name] === undefined) ? "credentials-removed" : "credential-leaked" }
  ] } }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_env_1", result: "done" })
];
process.stdout.write(lines.join("\\n") + "\\n");
`;
  const executor = new ZcodeSessionExecutor({
    probe: usableProbe,
    // "--" stops Node from parsing the headless arguments intended for the script.
    spec: { command: process.execPath, baseArgs: ["-e", script, "--"], source: "test" },
    sessionId: "session-1",
    workspacePath: root,
    statePath,
    shareToolEvents: true,
  });
  const result = await executor.execute({
    request: canonicalEvent({ sequence: 1, type: "agent_request" }),
    canonicalHistory: [canonicalEvent({ sequence: 1, type: "agent_request" })],
    runtime: runtimeValue(),
  });
  assert.equal(result.events.at(-1)?.content, "done");
  const state = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(state.sessions["session-1"]?.localSessionId, "sess_env_1");
  await rm(root, { recursive: true, force: true });
});

test("ZCode execution fails closed on malformed streams, empty answers, and child failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-fail-"));
  const malformed = recordedExecutor(path.join(root, "a.json"), {
    stream: `${JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } })}\nnot-json\n`,
  });
  await assert.rejects(malformed.execute(executionInput()), /malformed stream-json/);

  const empty = recordedExecutor(path.join(root, "b.json"), {
    stream: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "s", result: "   " }),
      "",
    ].join("\n"),
  });
  await assert.rejects(empty.execute(executionInput()), /without a final answer/);

  const crashed = recordedExecutor(path.join(root, "c.json"), { exitCode: 1 });
  await assert.rejects(crashed.execute(executionInput()), /exited unsuccessfully/);

  for (const name of ["a", "b", "c"]) {
    await assert.rejects(readFile(path.join(root, `${name}.json`), "utf8"));
  }
  await rm(root, { recursive: true, force: true });
});

test("ZCode tool sharing can be disabled while the final answer is still published", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-tools-"));
  const executor = recordedExecutor(path.join(root, "state.json"), { shareToolEvents: false });
  const result = await executor.execute(executionInput());
  assert.deepEqual(result.events.map((event) => event.kind), ["assistant"]);
  await rm(root, { recursive: true, force: true });
});

test("ZCode execution refuses an unsupported persisted state version instead of guessing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-state-"));
  const statePath = path.join(root, "state.json");
  await writeFile(statePath, `${JSON.stringify({ version: 99, sessions: {} })}\n`);
  const executor = recordedExecutor(statePath);
  await assert.rejects(executor.execute(executionInput()), /Unsupported ZCode connector state version/);
  await rm(root, { recursive: true, force: true });
});

test("ZCode shouldExecute follows the requested harness profile exactly", () => {
  const executor = recordedExecutor("unused-state.json");
  const runtime = runtimeValue();
  const request = (payload: unknown) => canonicalEvent({ sequence: 1, type: "agent_request", payload });
  assert.equal(executor.shouldExecute(request({ content: "x" }), runtime), true);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "zcode", model: "m" } }), runtime), true);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "codex", model: "m" } }), runtime), false);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "zcode", model: "m" } }), {
    ...runtime,
    userId: "user-2",
  }), false);
  assert.throws(() => executor.shouldExecute(request({ execution_profile: { harness: "bad\nharness" } }), runtime), /invalid target harness/);
});

test("ZCode prompt rendering quotes shared history as untrusted data with the request last", () => {
  const prompt = renderZcodePrompt({
    history: [
      canonicalEvent({ sequence: 1, type: "human_chat" }),
      canonicalEvent({ sequence: 4, type: "tool_call" }),
    ],
    request: canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "do the thing" } }),
    resume: false,
  });
  assert.ok(prompt.includes("untrusted"));
  const requestIndex = prompt.indexOf("Current request from Ada:");
  assert.ok(requestIndex > prompt.indexOf("[seq 1] human_chat"));
  assert.ok(requestIndex > prompt.indexOf("[seq 4] tool_call"));
  assert.ok(prompt.endsWith("Answer the current request. Reply with the final answer text only."));
});

test("ZCode headless arguments switch to stdin prompts above the argv budget and refuse unsupported resume", () => {
  const small = zcodeHeadlessArgs({ probe: usableProbe, prompt: "hello" });
  assert.deepEqual(small.args, ["-p", "--output-format", "stream-json", "hello"]);
  assert.equal(small.stdinPrompt, undefined);

  const oversizedPrompt = "x".repeat(31_000);
  const large = zcodeHeadlessArgs({ probe: usableProbe, prompt: oversizedPrompt, resumeSessionId: "sess_prev" });
  assert.deepEqual(large.args, ["-p", "--resume", "sess_prev", "--output-format", "stream-json", "--input-format", "text"]);
  assert.equal(large.stdinPrompt, oversizedPrompt);

  assert.throws(() => zcodeHeadlessArgs({
    probe: { ...usableProbe, supportsStdinPrompt: false },
    prompt: oversizedPrompt,
  }), /argument budget/);
  assert.throws(() => zcodeHeadlessArgs({
    probe: { ...usableProbe, supportsStdinPrompt: false, supportsResume: false },
    prompt: "hello",
    resumeSessionId: "sess_prev",
  }), /--resume support/);
  assert.throws(() => zcodeHeadlessArgs({ probe: usableProbe, prompt: "" }), /must not be empty/);
});

test("ZCode CLI capability probe refuses builds that omit required headless flags", async () => {
  const probe = await probeZcodeCli(
    { command: "fake", baseArgs: [], source: "test" },
    async (_spec, args) => args[0] === "--version"
      ? "zcode 9.9.9 (build abc)\n"
      : "Usage: zcode [options]\n  -p, --print  print mode\n  --output-format text|json|stream-json\n  --resume <id>\n  --input-format <fmt>\n",
  );
  assert.equal(probe.version, "zcode 9.9.9 (build abc)");
  assertUsableZcodeCli(probe);

  const limited = await probeZcodeCli(
    { command: "fake", baseArgs: [], source: "test" },
    async (_spec, args) => args[0] === "--version" ? "zcode 0.1.0\n" : "Usage: zcode\n  -p  print\n",
  );
  assert.throws(() => assertUsableZcodeCli(limited), /stream-json output .*--resume/);
});

test("ZCode CLI resolution prefers an explicit entry and fails closed when nothing is found", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-cli-"));
  const scriptPath = path.join(root, "zcode.cjs");
  await writeFile(scriptPath, "process.stdout.write('ok\\n');\n");
  const explicit = await resolveZcodeCommand(scriptPath, { PATH: "" }, "win32");
  assert.equal(explicit.command, process.execPath);
  assert.deepEqual(explicit.baseArgs, [path.resolve(scriptPath)]);

  await assert.rejects(resolveZcodeCommand(path.join(root, "missing.cjs"), {}, "win32"), /does not exist/);
  await assert.rejects(resolveZcodeCommand(undefined, { PATH: root }, "win32"), /Could not locate the ZCode CLI/);
  await rm(root, { recursive: true, force: true });
});

class FakeApi implements CollaborationApi {
  readonly appended: AppendEventInput[] = [];
  readonly history: CanonicalEvent[] = [];
  completeInput?: CompleteAgentRequestInput;
  progressInputs: AgentProgressInput[] = [];

  async listSessions() { return []; }
  async registerRuntime(runtime: RuntimeRegistration) {
    return { ...runtime, id: "runtime-1", userId: "user-1" } as RegisteredRuntime;
  }
  async readEvents(_sessionId: string, after: number) {
    const events = this.history.filter((item) => item.sequence > after);
    return { events, nextSequence: events.at(-1)?.sequence ?? after, hasMore: false };
  }
  async appendEvent(_sessionId: string, input: AppendEventInput) {
    this.appended.push(input);
    return canonicalEvent({ sequence: 100 + this.appended.length, type: "tool_call" });
  }
  async claimAgentRequest(_sessionId: string, requestId: string, runtimeId: string) {
    return { claimed: true, status: "claimed" as const, requestId, runtimeId };
  }
  async completeAgentRequest(_sessionId: string, _requestId: string, input: CompleteAgentRequestInput) {
    this.completeInput = input;
    return canonicalEvent({ sequence: 200, type: "agent_response" });
  }
  async appendAgentProgress(_sessionId: string, _requestId: string, input: AgentProgressInput) {
    this.progressInputs.push(input);
    return canonicalEvent({ sequence: 150, type: "agent_progress" });
  }
}

test("local bridge completes a claimed ZCode request with tool events, commentary, and the final response", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-bridge-"));
  const api = new FakeApi();
  api.history.push(
    canonicalEvent({ sequence: 1, type: "human_chat", payload: { content: "shared context" } }),
    canonicalEvent({ sequence: 2, type: "agent_request", payload: { content: "plan the work" } }),
  );
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: {
      sessionId: "session-1",
      deviceId: "device-1",
      harness: "zcode",
      provider: "GLM Account",
      model: "default",
      localSessionId: pendingZcodeLocalSessionId("key-1"),
      captureFidelity: "harness_transcript",
    },
    transcriptRoots: {},
  });
  const runtime = await bridge.connect();
  const executor = recordedExecutor(path.join(root, "state.json"));
  const outcome = await bridge.processAgentRequest(api.history[1] as CanonicalEvent, executor);

  assert.equal(outcome.claimed, true);
  assert.deepEqual(api.appended.map((event) => event.type), ["tool_call", "tool_result"]);
  assert.equal(api.completeInput && (api.completeInput.payload as { text?: string }).text, "final result text");
  assert.equal(api.completeInput?.observedModel, "GLM-Test-1");
  assert.equal(runtime.harness, "zcode");
  const progressPayloads = api.progressInputs.map((input) => input.payload as { phase?: string; content?: string; status?: string });
  assert.ok(progressPayloads.some((payload) => payload.phase === "lifecycle" && payload.status === "started"));
  assert.ok(progressPayloads.some((payload) => payload.phase === "commentary" && payload.content === "thinking out loud"));
  assert.ok(api.appended.every((event) => event.runtime?.harness === "zcode"));
  await rm(root, { recursive: true, force: true });
});

test("ZCode harness recovers native session identities from per-session state files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-harness-"));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  await saveZcodeState(path.join(stateRoot, "aaaaaaaaaaaaaaaaaaaaaaaa-session.json"), {
    version: 1,
    sessions: { "session-1": { localSessionId: "sess_recovered_1", projectedThroughSequence: 4 } },
  });
  const harness = new ZcodeProjectHarness({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    workspacePath: root,
    provider: "GLM Account",
    model: "default",
    shareToolEvents: true,
    stateRoot,
  });
  const preflight = await harness.preflight();
  assert.equal(preflight.version, usableProbe.version);
  assert.equal(preflight.workspacePath, path.resolve(root));
  const binding = harness.createSessionBinding({
    session: { id: "session-1", mode: "multi" },
    sessionKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
    statePath: path.join(stateRoot, "aaaaaaaaaaaaaaaaaaaaaaaa-session.json"),
  });
  assert.equal(binding.localSessionId, "sess_recovered_1");

  const freshHarness = new ZcodeProjectHarness({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    workspacePath: root,
    provider: "GLM Account",
    model: "default",
    shareToolEvents: true,
  });
  const freshBinding = freshHarness.createSessionBinding({
    session: { id: "session-2", mode: "multi" },
    sessionKey: "bbbbbbbbbbbbbbbbbbbbbbbb",
    statePath: path.join(stateRoot, "bbbbbbbbbbbbbbbbbbbbbbbb-session.json"),
  });
  assert.equal(freshBinding.localSessionId, pendingZcodeLocalSessionId("bbbbbbbbbbbbbbbbbbbbbbbb"));
  await harness.close();
  await rm(root, { recursive: true, force: true });
});

function runtimeValue(): RegisteredRuntime {
  return {
    id: "runtime-1",
    userId: "user-1",
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "zcode",
    provider: "GLM Account",
    model: "default",
    localSessionId: "pending:key-1",
    captureFidelity: "harness_transcript",
  };
}

function executionInput() {
  return {
    request: canonicalEvent({ sequence: 5, type: "agent_request" }),
    canonicalHistory: [canonicalEvent({ sequence: 5, type: "agent_request" })],
    runtime: runtimeValue(),
  };
}
