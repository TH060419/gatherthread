import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertUsableZcodeCli,
  CollaborationHttpError,
  DEFAULT_ZCODE_TOOL_ALLOWLIST,
  HarnessExecutionTerminatedError,
  LocalBridge,
  MalformedAgentRequestError,
  MemoryCursorStore,
  pendingZcodeLocalSessionId,
  probeZcodeCli,
  probeZcodeProtocol,
  refreshProjectSessionPermissions,
  resolveZcodeCommand,
  renderZcodePrompt,
  runZcodeProtocolTurn,
  saveZcodeState,
  withoutGatherThreadCredentialEnvironment,
  ZcodeProjectHarness,
  ZcodeSessionExecutor,
  type AppendEventInput,
  type AgentProgressInput,
  type CanonicalEvent,
  type CollaborationApi,
  type CompleteAgentRequestInput,
  type RegisteredRuntime,
  type RuntimeRegistration,
  type ZcodeCliProbe,
  type ZcodeConnectorState,
  type ZcodeTurnOutcome,
  type ZcodeTurnRunnerOptions,
} from "../src/index.js";

const usableProbe: ZcodeCliProbe = {
  version: "test-cli 1.0.0",
  supportsAppServer: true,
  supportsPromptMode: true,
  supportsResume: true,
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

interface RecordedTurn {
  resumeSessionId: string | undefined;
  prompt: string;
}

interface FakeTurnResult {
  outcome?: Omit<ZcodeTurnOutcome, "nativeSessionId"> & { nativeSessionId?: string };
  failure?: Error;
  turnEvents?: Parameters<ZcodeTurnRunnerOptions["onTurnEvent"]>[0][];
}

function fakeExecutor(statePath: string, options: Omit<FakeTurnResult, "outcome"> & {
  turns?: FakeTurnResult[];
  capture?: RecordedTurn[];
  shareToolEvents?: boolean;
  toolAllowlist?: readonly string[];
  signal?: AbortSignal;
} = {}): ZcodeSessionExecutor {
  const defaultTurn: FakeTurnResult = {
    ...(options.turnEvents === undefined ? {} : { turnEvents: options.turnEvents }),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
  };
  const providedTurns = options.turns ?? [defaultTurn];
  const turns = providedTurns.map((turn, index) => index === 0 ? { ...defaultTurn, ...turn } : turn);
  const runner = async (turnOptions: ZcodeTurnRunnerOptions): Promise<ZcodeTurnOutcome> => {
    options.capture?.push({
      resumeSessionId: turnOptions.resumeSessionId,
      prompt: turnOptions.prompt,
    });
    const turn = turns.shift() ?? {};
    for (const event of turn.turnEvents ?? []) {
      await turnOptions.onTurnEvent(event);
    }
    if (turn.failure) throw turn.failure;
    return {
      nativeSessionId: turn.outcome?.nativeSessionId ?? "sess_generated_1",
      finalResponse: turn.outcome?.finalResponse ?? "final result text",
      ...(turn.outcome?.observedModel === undefined ? {} : { observedModel: turn.outcome.observedModel }),
    };
  };
  return new ZcodeSessionExecutor({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    sessionId: "session-1",
    workspacePath: ".",
    statePath,
    ...(options.shareToolEvents === undefined ? {} : { shareToolEvents: options.shareToolEvents }),
    ...(options.toolAllowlist === undefined ? {} : { toolAllowlist: options.toolAllowlist }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, runner);
}

function assistantText(localEventId: string, content: string) {
  return { kind: "assistant" as const, localEventId, harness: "zcode" as const, captureFidelity: "harness_transcript" as const, content };
}

function toolCallEvent(localEventId: string, toolName: string, argumentsValue: unknown) {
  return { kind: "tool_call" as const, localEventId, harness: "zcode" as const, captureFidelity: "harness_transcript" as const, toolName, toolCallId: `${localEventId}:id`, arguments: argumentsValue };
}

test("ZCode execution maps protocol events into one final answer and durable binding state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-exec-"));
  const statePath = path.join(root, "state", "binding-session.json");
  const progress: { id: string; content: string }[] = [];
  const executor = fakeExecutor(statePath, {
    shareToolEvents: true,
    turnEvents: [
      assistantText("msg-1:text", "thinking out loud"),
      toolCallEvent("msg-1:tool:0", "Read", { file_path: "a.ts" }),
    ],
    turns: [{ outcome: { nativeSessionId: "sess_generated_1", finalResponse: "final result text", observedModel: "GLM-Test-1" } }],
  });
  const result = await executor.execute({
    request: canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "do the thing" } }),
    canonicalHistory: [
      canonicalEvent({ sequence: 1, type: "human_chat" }),
      canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "do the thing" } }),
    ],
    runtime: runtimeValue(),
    publishProgress: async (update) => {
      progress.push({ id: update.id, content: update.content });
    },
  });

  assert.deepEqual(result.events.map((event) => event.kind), ["tool_call", "assistant"]);
  assert.equal(result.events[0]?.toolName, "Read");
  assert.equal(result.localSessionId, "sess_generated_1");
  assert.equal(result.observedModel, "GLM-Test-1");
  assert.equal(result.events.at(-1)?.content, "final result text");
  assert.equal(result.events.at(-1)?.harness, "zcode");
  assert.deepEqual(progress.map((update) => update.content), ["thinking out loud"]);

  const state = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(state.version, 1);
  assert.equal(state.sessions["session-1"]?.localSessionId, "sess_generated_1");
  assert.equal(state.sessions["session-1"]?.projectedThroughSequence, 5);
  assert.equal(state.sessions["session-1"]?.observedModel, "GLM-Test-1");
  assert.equal(state.sessions["session-1"]?.journal?.status, "completed");
  await rm(root, { recursive: true, force: true });
});

test("ZCode execution resumes the recorded native session and excludes own output from hydration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-resume-"));
  const statePath = path.join(root, "binding-session.json");
  await saveZcodeState(statePath, {
    version: 1,
    sessions: { "session-1": { localSessionId: "sess_prev_1", projectedThroughSequence: 3, observedModel: "GLM-Old" } },
  });
  const captured: RecordedTurn[] = [];
  const executor = fakeExecutor(statePath, { capture: captured });
  await executor.execute({
    request: canonicalEvent({ sequence: 10, type: "agent_request", payload: { content: "continue" } }),
    canonicalHistory: [
      canonicalEvent({ sequence: 2, type: "human_chat" }),
      canonicalEvent({ sequence: 3, type: "human_chat" }),
      // The connector's own earlier output (above the stored cursor) must not
      // echo back into the native session.
      { ...canonicalEvent({ sequence: 4, type: "agent_progress", payload: { content: "older progress" } }), runtime: ownProvenance() },
      { ...canonicalEvent({ sequence: 6, type: "agent_response", payload: { content: "older answer" } }), runtime: ownProvenance() },
      canonicalEvent({ sequence: 8, type: "human_chat", payload: { content: "fresh human context" } }),
      canonicalEvent({ sequence: 10, type: "agent_request", payload: { content: "continue" } }),
    ],
    runtime: runtimeValue(),
  });

  assert.equal(captured[0]?.resumeSessionId, "sess_prev_1");
  const prompt = captured[0]?.prompt ?? "";
  assert.ok(prompt.includes("[seq 8] human_chat"));
  assert.ok(!prompt.includes("older progress"));
  assert.ok(!prompt.includes("older answer"));
  // The request is rendered once, as the final instruction, not as transcript.
  assert.equal(prompt.split("continue").length - 1 >= 1, true);
  assert.ok(!prompt.includes("[seq 10]"));
  await rm(root, { recursive: true, force: true });
});

test("ZCode execution writes a running journal before the child and refuses re-execution after interruption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-journal-"));
  const statePath = path.join(root, "binding-session.json");
  const executor = fakeExecutor(statePath, {
    turns: [{ failure: new Error("ZCode app-server exited unexpectedly") }],
  });
  await assert.rejects(
    executor.execute(executionInput()),
    /exited unexpectedly/,
  );
  const afterFailure = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(afterFailure.sessions["session-1"]?.journal?.status, "running");

  // A retry of the same request (claim reclaim, restart recovery) must refuse
  // instead of re-running an interrupted native turn.
  await assert.rejects(
    fakeExecutor(statePath).execute(executionInput()),
    /refusing to run it twice/,
  );
  await rm(root, { recursive: true, force: true });
});

test("ZCode execution replays the recorded result after a transport failure instead of re-running", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-replay-"));
  const statePath = path.join(root, "binding-session.json");
  const captured: RecordedTurn[] = [];
  const first = fakeExecutor(statePath, {
    capture: captured,
    shareToolEvents: true,
    toolAllowlist: ["Read"],
    turnEvents: [toolCallEvent("t1", "Read", { file_path: "a.ts" })],
    turns: [{ outcome: { nativeSessionId: "sess_done_1", finalResponse: "recorded answer" } }],
  });
  await first.execute(executionInput());
  assert.equal(captured.length, 1);

  // Simulate a restart: a fresh executor over the same durable state replays.
  const replay = fakeExecutor(statePath, { capture: captured });
  const result = await replay.execute(executionInput());
  assert.equal(captured.length, 1, "the native turn must not run twice");
  assert.equal(result.localSessionId, "sess_done_1");
  assert.equal(result.events.at(-1)?.content, "recorded answer");
  assert.deepEqual(result.events.filter((event) => event.kind === "tool_call").map((event) => event.toolName), ["Read"]);
  await rm(root, { recursive: true, force: true });
});

test("ZCode deactivation aborts publication before and after the native turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-deactivate-"));
  const statePath = path.join(root, "binding-session.json");
  const before = fakeExecutor(statePath, {});
  before.deactivate();
  await assert.rejects(before.execute(executionInput()), /deactivated before it could run/);

  // Deactivation during the native turn records the completed journal
  // (restart replays instead of re-running) but refuses publication.
  const holder: { executor?: ZcodeSessionExecutor } = {};
  const late = new ZcodeSessionExecutor({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    sessionId: "session-1",
    workspacePath: ".",
    statePath,
  }, async () => {
    holder.executor?.deactivate();
    return { nativeSessionId: "sess_late_1", finalResponse: "too late" };
  });
  holder.executor = late;
  await assert.rejects(late.execute(executionInput()), /deactivated after the native turn/);
  const state = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(state.sessions["session-1"]?.journal?.status, "completed");
  assert.equal(state.sessions["session-1"]?.localSessionId, "sess_late_1");
  await rm(root, { recursive: true, force: true });
});

test("deactivate and the shared shutdown signal abort an in-flight ZCode turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-abort-"));
  // A runner that hangs until its signal fires (and refuses an already-aborted
  // signal), mirroring how the real protocol turn binds the shutdown signal.
  const hangUntilAborted = async (turnOptions: ZcodeTurnRunnerOptions): Promise<ZcodeTurnOutcome> => {
    const signal = turnOptions.signal;
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("ZCode execution aborted");
    }
    return new Promise<ZcodeTurnOutcome>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("ZCode execution aborted"));
      }, { once: true });
    });
  };
  const baseOptions = {
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    sessionId: "session-1",
    workspacePath: ".",
  };

  // Deactivation aborts the in-flight turn through the executor's derived
  // controller and stays idempotent.
  const statePath = path.join(root, "state.json");
  const executor = new ZcodeSessionExecutor({ ...baseOptions, statePath }, hangUntilAborted);
  const pending = executor.execute(executionInput());
  executor.deactivate();
  executor.deactivate();
  await assert.rejects(pending, /deactivated/);
  // The interrupted turn stays journaled as running: a restart refuses to
  // re-run it instead of double-executing.
  const state = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(state.sessions["session-1"]?.journal?.status, "running");

  // The shared connector signal reaches the same derived controller.
  const shared = new AbortController();
  const sharedExecutor = new ZcodeSessionExecutor({
    ...baseOptions,
    statePath: path.join(root, "shared.json"),
    signal: shared.signal,
  }, hangUntilAborted);
  const sharedPending = sharedExecutor.execute(executionInput());
  shared.abort(new Error("ZCode connector shutdown requested"));
  await assert.rejects(sharedPending, /shutdown requested/);
  await rm(root, { recursive: true, force: true });
});

test("ZCode shouldExecute only claims requests explicitly targeted at zcode", () => {
  const executor = fakeExecutor("unused-state.json");
  const runtime = runtimeValue();
  const request = (payload: unknown) => canonicalEvent({ sequence: 1, type: "agent_request", payload });
  // Legacy requests without an execution profile belong to the Codex target.
  assert.equal(executor.shouldExecute(request({ content: "x" }), runtime), false);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "zcode", model: "m" } }), runtime), true);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "codex", model: "m" } }), runtime), false);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "deepseek-harness", model: "m" } }), runtime), false);
  assert.equal(executor.shouldExecute(request({ execution_profile: { harness: "zcode", model: "m" } }), {
    ...runtime,
    userId: "user-2",
  }), false);
  // A structurally unparseable profile throws the typed error so the bridge
  // can skip exactly that request while still retrying recoverable failures.
  assert.throws(
    () => executor.shouldExecute(request({ execution_profile: { harness: "bad\nharness" } }), runtime),
    MalformedAgentRequestError,
  );
  assert.throws(
    () => executor.shouldExecute(request({ execution_profile: { harness: "a\u0000b" } }), runtime),
    MalformedAgentRequestError,
  );
});

test("ZCode tool sharing is opt-in, allowlisted, and bounded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-tools-"));
  const turnEvents = [
    toolCallEvent("t-read", "Read", { file_path: "a.ts" }),
    toolCallEvent("t-bash", "Bash", { command: "rm -rf /" }),
    toolCallEvent("t-big", "Read", { blob: "x".repeat(40_000) }),
    assistantText("t-answer", "answer"),
  ];
  const outcome = { nativeSessionId: "sess_tools_1", finalResponse: "done" };

  // Default: final answer only.
  const quiet = fakeExecutor(path.join(root, "a.json"), { turnEvents, turns: [{ outcome }] });
  assert.deepEqual((await quiet.execute(executionInput())).events.map((event) => event.kind), ["assistant"]);

  // Opt-in: allowlisted tools only, oversized values truncated.
  const shared = fakeExecutor(path.join(root, "b.json"), {
    shareToolEvents: true,
    turnEvents,
    turns: [{ outcome }],
  });
  const sharedEvents = (await shared.execute(executionInput())).events;
  assert.deepEqual(sharedEvents.filter((event) => event.kind === "tool_call").map((event) => event.toolName), ["Read", "Read"]);
  const bounded = sharedEvents.find((event) => event.localEventId === "t-big");
  assert.ok(Buffer.byteLength(JSON.stringify(bounded?.arguments) ?? "") < 40_000);
  assert.equal((bounded?.arguments as { truncated?: boolean })?.truncated, true);
  await rm(root, { recursive: true, force: true });
});

test("ZCode tool allowlist default covers read-only discovery tools", () => {
  assert.deepEqual(DEFAULT_ZCODE_TOOL_ALLOWLIST, ["Read", "Glob", "Grep"]);
  const executor = fakeExecutor("unused.json", { shareToolEvents: true, toolAllowlist: ["Write"] });
  // The policy is enforced inside the executor; Write would be shared here,
  // but the default allowlist stays read-only for operators who do not
  // override it.
  assert.equal(executor.shouldExecute(
    canonicalEvent({ sequence: 1, type: "agent_request", payload: { execution_profile: { harness: "zcode" } } }),
    runtimeValue(),
  ), true);
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

test("the ZCode child environment strips every GatherThread credential variable", () => {
  const stripped = withoutGatherThreadCredentialEnvironment({
    GATHERTHREAD_TOKEN: "secret-token",
    gatherthread_api_url: "https://example.internal",
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "pepper",
    PATH: "C:\Windows",
    HOME: "/home/tester",
  });
  assert.deepEqual(Object.keys(stripped).sort(), ["HOME", "PATH"]);
});

test("ZCode CLI capability probe refuses builds without the app-server subcommand", async () => {
  const probe = await probeZcodeCli(
    { command: "fake", baseArgs: [], source: "test" },
    async (_spec, args) => args[0] === "--version"
      ? "zcode 9.9.9 (build abc)\n"
      : [
        "Usage: zcode [command] [options]",
        "Commands:",
        "  app-server Run the ZCode Protocol stdio app server",
        "  -p, --prompt <text>  Run a single prompt without opening the TUI",
        "  --resume <sessionId>  Resume a persisted session by sessionId (sess_...)",
        "  --json           Print machine-readable JSON where supported",
      ].join("\n"),
  );
  assert.equal(probe.version, "zcode 9.9.9 (build abc)");
  assert.equal(probe.supportsAppServer, true);
  assertUsableZcodeCli(probe);

  const legacy = await probeZcodeCli(
    { command: "fake", baseArgs: [], source: "test" },
    async (_spec, args) => args[0] === "--version" ? "zcode 0.1.0\n" : "Usage: zcode\n  -p  print\n",
  );
  assert.throws(() => assertUsableZcodeCli(legacy), /app-server/);
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

test("an explicit --zcode-command pointing at a script shim is refused with an actionable error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-shim-"));
  for (const extension of [".bat", ".cmd", ".ps1"]) {
    const shimPath = path.join(root, `zcode${extension}`);
    await writeFile(shimPath, "@echo off\r\n");
    await assert.rejects(
      resolveZcodeCommand(shimPath, { PATH: "" }, "win32"),
      (error: unknown) => error instanceof Error
        && error.message.includes(`--zcode-command option points at a ${extension} script shim`)
        && error.message.includes("glm/zcode.cjs"),
    );
  }
  await rm(root, { recursive: true, force: true });
});

test("ZCode protocol probe refuses a server speaking an unexpected protocol version", async () => {
  await withFakeAppServer(
    `let buffer = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "session/list") { process.stdout.write(JSON.stringify({ id: message.id, result: { sessions: [], protocol: { name: "ZCode Protocol", version: 2 } } }) + "\\n"); } } });`,
    async (commandSpec, directory) => {
      await assert.rejects(
        probeZcodeProtocol(commandSpec, { cwd: directory, timeoutMs: 5000 }),
        /version 2/,
      );
    },
  );
});

test("ZCode protocol turn runs against a compatible app-server", async () => {
  const script = `
let buffer = "";
let eventSeq = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "session/requestRuntimePreferences") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\\n");
      continue;
    }
    if (message.method === "session/create") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        session: { sessionId: "sess_fake_1", status: "idle" },
        protocol: { name: "ZCode Protocol", version: 1 },
      } }) + "\\n");
      continue;
    }
    if (message.method === "session/subscribe") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { eventSeq: 0, events: [], sessionId: message.params.sessionId } }) + "\\n");
      continue;
    }
    if (message.method === "session/send") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { accepted: true, sessionId: message.params.sessionId } }) + "\\n");
      const events = [
        { type: "message.upserted", messageId: "m1", content: "working" },
        { type: "turn.completed", response: "fake final answer" },
      ];
      for (const payload of events) {
        process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "e" + (++eventSeq), payload } }) + "\\n");
      }
      continue;
    }
    if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
  }
});
`;
  await withFakeAppServer(script, async (commandSpec, directory) => {
    const toolEvents: Parameters<ZcodeTurnRunnerOptions["onTurnEvent"]>[0][] = [];
    const outcome = await runZcodeProtocolTurn({
      spec: commandSpec,
      workspacePath: directory,
      resumeSessionId: undefined,
      prompt: "hello",
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
      signal: undefined,
      onTurnEvent: async (event) => {
        toolEvents.push(event);
      },
    });
    assert.equal(outcome.nativeSessionId, "sess_fake_1");
    assert.equal(outcome.finalResponse, "fake final answer");
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0]?.content, "working");
  });
});

async function withFakeAppServer(script: string, run: (spec: { command: string; baseArgs: string[]; source: string }, directory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-proto-"));
  const scriptPath = path.join(root, "fake-app-server.cjs");
  await writeFile(scriptPath, script);
  try {
    await run({ command: process.execPath, baseArgs: [scriptPath], source: "test" }, root);
  } finally {
    // The fake app-server child may still be releasing the directory on Windows.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

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

test("local bridge completes a claimed ZCode request and redacts shared tool content", async () => {
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
  await bridge.connect();
  const statePath = path.join(root, "state.json");
  const executor = fakeExecutor(statePath, {
    shareToolEvents: true,
    toolAllowlist: ["Read"],
    turnEvents: [
      assistantText("commentary-1", "public progress note"),
      toolCallEvent("tool-1", "Read", { note: "token gta_abc123def456ghijklmnopqr inside arguments" }),
    ],
    turns: [{ outcome: { nativeSessionId: "sess_bridge_1", finalResponse: "final result text", observedModel: "GLM-Test-1" } }],
  });
  const outcome = await bridge.processAgentRequest(api.history[1] as CanonicalEvent, executor);

  assert.equal(outcome.claimed, true);
  assert.deepEqual(api.appended.map((event) => event.type), ["tool_call"]);
  const toolPayload = JSON.stringify(api.appended[0]?.payload);
  assert.ok(!toolPayload.includes("gta_abc123def456ghijklmnopqr"), "tool arguments must be redacted before persistence");
  assert.equal(api.completeInput && (api.completeInput.payload as { text?: string }).text, "final result text");
  assert.equal(api.completeInput?.observedModel, "GLM-Test-1");
  const progressPayloads = api.progressInputs.map((input) => input.payload as { phase?: string; content?: string; status?: string });
  assert.ok(progressPayloads.some((payload) => payload.phase === "lifecycle" && payload.status === "started"));
  assert.ok(progressPayloads.some((payload) => payload.phase === "commentary" && payload.content === "public progress note"));
  assert.ok(api.appended.every((event) => event.runtime?.harness === "zcode"));
  await rm(root, { recursive: true, force: true });
});

test("ZCode harness recovers native session identities and deactivation covers new bindings", async () => {
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
  // Compare canonical file identity: temp paths differ in spelling across
  // macOS (/var vs /private/var) and Windows (short vs long names).
  assert.equal(preflight.workspacePath, await realpath(root));
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
    stateRoot,
  });
  const freshBinding = freshHarness.createSessionBinding({
    session: { id: "session-2", mode: "multi" },
    sessionKey: "bbbbbbbbbbbbbbbbbbbbbbbb",
    statePath: path.join(stateRoot, "bbbbbbbbbbbbbbbbbbbbbbbb-session.json"),
  });
  assert.equal(freshBinding.localSessionId, pendingZcodeLocalSessionId("bbbbbbbbbbbbbbbbbbbbbbbb"));

  await harness.close();
  await freshHarness.close();
  await rm(root, { recursive: true, force: true });
});

test("ZCode harness deactivation refuses later executor runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-revoke-"));
  const statePath = path.join(root, "state.json");
  const harness = new ZcodeProjectHarness({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    workspacePath: root,
    provider: "GLM Account",
    model: "default",
  });
  const binding = harness.createSessionBinding({
    session: { id: "session-1", mode: "multi" },
    sessionKey: "key-1",
    statePath,
  });
  await harness.deactivateExecutionBindings();
  await assert.rejects(binding.executor.execute(executionInput()), /deactivated/);
  await harness.close();
  await rm(root, { recursive: true, force: true });
});

function ownProvenance() {
  return {
    userId: "user-1",
    deviceId: "device-1",
    runtimeId: "runtime-1",
    harness: "zcode" as const,
    provider: "GLM Account",
    model: "default",
    localSessionId: "pending:key-1",
    captureFidelity: "harness_transcript" as const,
  };
}

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
    request: canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "request body" } }),
    canonicalHistory: [canonicalEvent({ sequence: 5, type: "agent_request", payload: { content: "request body" } })],
    runtime: runtimeValue(),
  };
}

test("the shared permission refresh with retain/preserve lists never disables live bindings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-refresh-"));
  const statePath = path.join(root, "state.json");
  const harness = new ZcodeProjectHarness({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    workspacePath: root,
    provider: "GLM Account",
    model: "default",
    turnRunner: async () => ({ nativeSessionId: "sess_refresh_1", finalResponse: "final result text" }),
  });
  // The audited failure sequence: the connector's first successful refresh
  // runs reconcileProjectSessionPermissions before any session is managed.
  const refresh = await refreshProjectSessionPermissions({
    loadSessions: async () => [{ id: "session-1", mode: "multi", role: "owner" }],
    actorUserId: "user-1",
    managed: new Map(),
    harness,
  });
  assert.equal(refresh.status, "updated");
  const binding = harness.createSessionBinding({
    session: { id: "session-1", mode: "multi" },
    sessionKey: "key-1",
    statePath,
  });
  const result = await binding.executor.execute(executionInput());
  assert.equal(result.events.at(-1)?.content, "final result text");
  await harness.close();
  await rm(root, { recursive: true, force: true });
});

test("deactivation honors retain/preserve lists and only removes excluded sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-retain-"));
  const harness = new ZcodeProjectHarness({
    probe: usableProbe,
    spec: { command: "zcode-fake", baseArgs: [], source: "test" },
    workspacePath: root,
    provider: "GLM Account",
    model: "default",
    turnRunner: async () => ({ nativeSessionId: "sess_retain_1", finalResponse: "final result text" }),
  });
  const kept = harness.createSessionBinding({
    session: { id: "session-keep", mode: "multi" },
    sessionKey: "keep-key",
    statePath: path.join(root, "keep.json"),
  });
  const dropped = harness.createSessionBinding({
    session: { id: "session-drop", mode: "multi" },
    sessionKey: "drop-key",
    statePath: path.join(root, "drop.json"),
  });

  // Read-only reconciliation: keep both alive.
  await harness.deactivateExecutionBindings({
    retainSessionIds: ["session-keep"],
    preserveSessionIds: ["session-drop"],
  });
  await kept.executor.execute({
    ...executionInput(),
    runtime: { ...runtimeValue(), sessionId: "session-keep" },
  });

  // session-drop fell out of every allowlist: only it is deactivated.
  await harness.deactivateExecutionBindings({
    retainSessionIds: ["session-keep"],
    preserveSessionIds: ["session-keep"],
  });
  await assert.rejects(
    dropped.executor.execute({
      ...executionInput(),
      runtime: { ...runtimeValue(), sessionId: "session-drop" },
    }),
    /deactivated/,
  );
  await kept.executor.execute({
    ...executionInput(),
    runtime: { ...runtimeValue(), sessionId: "session-keep" },
  });
  await harness.close();
  await assert.rejects(
    kept.executor.execute({
      ...executionInput(),
      runtime: { ...runtimeValue(), sessionId: "session-keep" },
    }),
    /deactivated/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a malformed execution profile advances the polling cursor instead of wedging the session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-wedge-"));
  const api = new FakeApi();
  api.history.push(
    canonicalEvent({
      sequence: 2,
      type: "agent_request",
      payload: { content: "poison", execution_profile: { harness: "bad\nharness" } },
    }),
    canonicalEvent({ sequence: 3, type: "agent_request", payload: { content: "real request", execution_profile: { harness: "zcode" } } }),
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
  await bridge.connect();
  const executor = fakeExecutor(path.join(root, "state.json"), {
    turns: [{ outcome: { nativeSessionId: "sess_after_wedge", finalResponse: "answered after the malformed request" } }],
  });
  const outcome = await bridge.processPendingAgentRequests(executor);
  assert.equal(outcome.examined, 2, "both events must be examined");
  assert.equal(outcome.claimed, 1, "the valid request behind the malformed one must be claimed");
  await rm(root, { recursive: true, force: true });
});

test("a terminal claim conflict advances the cursor instead of wedging the zcode session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-conflict-"));
  const conflicted = canonicalEvent({
    sequence: 2,
    type: "agent_request",
    payload: { content: "resolved elsewhere", execution_profile: { harness: "zcode" } },
  });
  const next = canonicalEvent({
    sequence: 3,
    type: "agent_request",
    payload: { content: "real request", execution_profile: { harness: "zcode" } },
  });
  const api = new FakeApi();
  api.history.push(conflicted, next);
  let conflictedClaims = 0;
  api.claimAgentRequest = async (_sessionId, requestId, runtimeId) => {
    if (requestId === conflicted.id) {
      conflictedClaims += 1;
      throw new CollaborationHttpError(409, "already completed", "agent_request_already_completed");
    }
    return { claimed: true, status: "claimed" as const, requestId, runtimeId };
  };
  const cursorStore = new MemoryCursorStore();
  const bridge = new LocalBridge({
    api,
    cursorStore,
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
  await bridge.connect();
  const statePath = path.join(root, "state.json");
  const executor = fakeExecutor(statePath, {
    turns: [{ outcome: { nativeSessionId: "sess_after_conflict", finalResponse: "answered after the conflict" } }],
  });
  const outcome = await bridge.processPendingAgentRequests(executor);
  assert.equal(outcome.claimed, 1, "the valid request behind the terminal conflict must still be claimed");
  assert.equal(conflictedClaims, 1, "the conflicted request must be claimed exactly once");
  assert.equal((await cursorStore.load()).server["session-1"], 3, "the cursor advances past the conflict and the completed request");

  // No hot retry: later polls re-examine nothing and never re-claim the
  // terminally conflicted request.
  const followUp = await bridge.processPendingAgentRequests(executor);
  assert.equal(followUp.examined, 0);
  assert.equal(conflictedClaims, 1);

  const state = JSON.parse(await readFile(statePath, "utf8")) as ZcodeConnectorState;
  assert.equal(state.sessions["session-1"]?.projectedThroughSequence, 3);
  assert.equal(state.sessions["session-1"]?.journal?.status, "completed");
  await rm(root, { recursive: true, force: true });
});

test("protocol probes and turns fail closed on structurally wrong servers", async () => {
  await withFakeAppServer(
    `let buffer = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "session/list") { process.stdout.write(JSON.stringify({ id: message.id, result: { nope: true } }) + "\\n"); } else if (message.id !== undefined) { process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"); } } });`,
    async (commandSpec, directory) => {
      await assert.rejects(
        probeZcodeProtocol(commandSpec, { cwd: directory, timeoutMs: 5000 }),
        /did not answer session\/list/,
      );
    },
  );

  // A turn against a server whose session/create omits the protocol
  // declaration must refuse instead of executing.
  await withFakeAppServer(
    `let buffer = ""; let eventSeq = 0; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue; let message; try { message = JSON.parse(line); } catch { continue; } if (message.method === "session/requestRuntimePreferences") { process.stdout.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\\n"); continue; } if (message.method === "session/create") { process.stdout.write(JSON.stringify({ id: message.id, result: { session: { sessionId: "sess_noproto_1" } } }) + "\\n"); continue; } if (message.id !== undefined) { process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"); } } });`,
    async (commandSpec, directory) => {
      await assert.rejects(
        runZcodeProtocolTurn({
          spec: commandSpec,
          workspacePath: directory,
          resumeSessionId: undefined,
          prompt: "hello",
          timeoutMs: 10_000,
          maxOutputBytes: 1_000_000,
          signal: undefined,
          onTurnEvent: () => undefined,
        }),
        /did not declare its protocol/,
      );
    },
  );
});

test("a mid-turn child crash surfaces the real exit cause instead of a timeout", async () => {
  const script = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "session/requestRuntimePreferences") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\\n");
      continue;
    }
    if (message.method === "session/create") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        session: { sessionId: "sess_crash_1" },
        protocol: { name: "ZCode Protocol", version: 1 },
      } }) + "\\n");
      continue;
    }
    if (message.method === "session/send") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { accepted: true } }) + "\\n");
      process.stderr.write("fatal: model runtime crashed\\n");
      process.exit(1);
    }
    if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
  }
});
`;
  await withFakeAppServer(script, async (commandSpec, directory) => {
    await assert.rejects(
      runZcodeProtocolTurn({
        spec: commandSpec,
        workspacePath: directory,
        resumeSessionId: undefined,
        prompt: "hello",
        timeoutMs: 10_000,
        maxOutputBytes: 1_000_000,
        signal: undefined,
        onTurnEvent: () => undefined,
      }),
      (error: unknown) => error instanceof HarnessExecutionTerminatedError
        && error.failureCode === "zcode_child_exited"
        && /fatal: model runtime crashed/.test(error.message),
    );
  });
});

test("projection events delivered before our send are ignored as replay", async () => {
  // The fake emits a replayed message.upserted while answering subscribe —
  // before the connector's session/send resolves. It must never surface as
  // this request's progress.
  const script = `
let buffer = "";
let eventSeq = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "session/requestRuntimePreferences") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\\n");
      continue;
    }
    if (message.method === "session/resume") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        session: { sessionId: "sess_replay_1" },
        protocol: { name: "ZCode Protocol", version: 1 },
        messages: [{ info: { messageId: "replayed" } }],
      } }) + "\\n");
      continue;
    }
    if (message.method === "session/subscribe") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { eventSeq: 0, events: [], sessionId: message.params.sessionId } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "replay", type: "message.upserted", payload: { messageId: "replayed", content: "replayed old answer" } } }) + "\\n");
      continue;
    }
    if (message.method === "session/send") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { accepted: true, sessionId: message.params.sessionId } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "fresh", type: "message.upserted", payload: { messageId: "fresh", content: "fresh commentary" } } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "done", type: "turn.completed", payload: { response: "fresh final answer" } } }) + "\\n");
      continue;
    }
    if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
  }
});
`;
  await withFakeAppServer(script, async (commandSpec, directory) => {
    const surfaced: string[] = [];
    const outcome = await runZcodeProtocolTurn({
      spec: commandSpec,
      workspacePath: directory,
      resumeSessionId: "sess_replay_1",
      prompt: "hello",
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
      signal: undefined,
      onTurnEvent: async (event) => {
        if (event.kind === "assistant") surfaced.push(event.content ?? "");
      },
    });
    assert.equal(outcome.finalResponse, "fresh final answer");
    assert.deepEqual(surfaced, ["fresh commentary"]);
  });
});

test("a replayed prior turn.completed cannot settle the current turn", async () => {
  // The fake emits the previous turn's turn.completed while answering
  // session/subscribe — before the connector's session/send write. It must
  // never settle this turn with the stale response.
  const script = `
let buffer = "";
let eventSeq = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "session/requestRuntimePreferences") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\\n");
      continue;
    }
    if (message.method === "session/resume") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        session: { sessionId: "sess_stale_1" },
        protocol: { name: "ZCode Protocol", version: 1 },
      } }) + "\\n");
      continue;
    }
    if (message.method === "session/subscribe") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { eventSeq: 0, events: [], sessionId: message.params.sessionId } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "stale", type: "turn.completed", payload: { response: "stale prior answer" } } }) + "\\n");
      continue;
    }
    if (message.method === "session/send") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { accepted: true, sessionId: message.params.sessionId } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "fresh" + (++eventSeq), type: "message.upserted", payload: { messageId: "fresh", content: "fresh commentary" } } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "done", type: "turn.completed", payload: { response: "fresh final answer" } } }) + "\\n");
      continue;
    }
    if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
  }
});
`;
  await withFakeAppServer(script, async (commandSpec, directory) => {
    const surfaced: string[] = [];
    const outcome = await runZcodeProtocolTurn({
      spec: commandSpec,
      workspacePath: directory,
      resumeSessionId: "sess_stale_1",
      prompt: "hello",
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
      signal: undefined,
      onTurnEvent: async (event) => {
        if (event.kind === "assistant") surfaced.push(event.content ?? "");
      },
    });
    assert.equal(outcome.finalResponse, "fresh final answer", "the stale replayed response must not be published");
    assert.deepEqual(surfaced, ["fresh commentary"]);
  });
});
