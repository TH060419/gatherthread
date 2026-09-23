import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BridgeDaemon,
  CollaborationHttpError,
  HarnessExecutionTerminatedError,
  LocalBridge,
  MemoryCursorStore,
  type AppendEventInput,
  type AgentProgressInput,
  type AgentRequestClaim,
  type CanonicalEvent,
  type CollaborationApi,
  type CompleteAgentRequestInput,
  type RegisteredRuntime,
  type RuntimeRegistration,
} from "../src/index.js";

class FakeApi implements CollaborationApi {
  readonly appended: AppendEventInput[] = [];
  readonly history: CanonicalEvent[] = [];
  heartbeatCount = 0;
  completeInput?: CompleteAgentRequestInput;
  progressInputs: AgentProgressInput[] = [];
  runtime: RegisteredRuntime = {
    id: "runtime-1",
    userId: "user-1",
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt",
    localSessionId: "local-1",
    captureFidelity: "harness_transcript",
  };

  async listSessions() { return []; }
  async registerRuntime(runtime: RuntimeRegistration) {
    this.runtime = { ...runtime, id: "runtime-1", userId: "user-1" };
    return this.runtime;
  }
  async readEvents(_sessionId: string, after: number) {
    const events = this.history.filter((item) => item.sequence > after);
    return { events, nextSequence: events.at(-1)?.sequence ?? after, hasMore: false };
  }
  async appendEvent(sessionId: string, input: AppendEventInput) {
    this.appended.push(input);
    return canonical(sessionId, this.appended.length, input);
  }
  async claimAgentRequest(_sessionId: string, requestId: string, runtimeId: string): Promise<AgentRequestClaim> {
    return { claimed: true, status: "claimed" as const, requestId, runtimeId, attemptCount: 2 };
  }
  async completeAgentRequest(_sessionId: string, _requestId: string, input: CompleteAgentRequestInput) {
    this.completeInput = input;
    return canonical("session-1", 10, {
      type: "agent_response",
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      runtimeId: input.runtimeId,
    });
  }
  async appendAgentProgress(_sessionId: string, _requestId: string, input: AgentProgressInput) {
    this.progressInputs.push(input);
    return canonical("session-1", 9, {
      type: "agent_progress",
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      runtimeId: input.runtimeId,
    });
  }
  async heartbeatRuntime() {
    this.heartbeatCount += 1;
    return { ...this.runtime, status: "online" as const, lastSeenAt: "2026-08-25T00:00:00.000Z" };
  }
}

test("bridge imports authorized transcripts with redaction, provenance, and durable local cursor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-import-"));
  const transcript = path.join(root, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", id: "a1", content: "token=supersecretvalue" },
  })}\n`);
  const api = new FakeApi();
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: { codex: [root] },
  });
  await bridge.connect();
  const first = await bridge.importTranscript("session-1", "codex", transcript);
  const second = await bridge.importTranscript("session-1", "codex", transcript);

  assert.equal(first.appended.length, 1);
  assert.equal(second.appended.length, 0);
  assert.equal((api.appended[0]?.payload as any).text, "token=[REDACTED]");
  assert.equal(api.appended[0]?.runtime?.captureFidelity, "harness_transcript");
  assert.equal(api.appended[0]?.runtime?.deviceId, "device-1");
});

test("server cursor resumes incremental history", async () => {
  const api = new FakeApi();
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "1", payload: {} }),
    canonical("session-1", 2, { type: "human_chat", idempotencyKey: "2", payload: {} }),
  );
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await bridge.connect();
  assert.equal((await bridge.readServerIncrement("session-1")).length, 2);
  assert.equal((await bridge.readServerIncrement("session-1")).length, 0);
});

test("authoritative first materialization resumes per event after a partial failure", async () => {
  const api = new FakeApi();
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "1", payload: {} }),
    canonical("session-1", 2, { type: "human_chat", idempotencyKey: "2", payload: {} }),
    canonical("session-1", 3, { type: "human_chat", idempotencyKey: "3", payload: {} }),
  );
  const cursorStore = new MemoryCursorStore();
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const firstAttempt: number[] = [];
  await assert.rejects(bridge.materializeAuthoritativeHistory({
    async execute() { throw new Error("not used"); },
    async projectCanonicalEvents(events) {
      const sequence = events[0]?.sequence ?? 0;
      if (sequence === 2) throw new Error("injection interrupted");
      firstAttempt.push(sequence);
    },
  }, 3), /injection interrupted/);
  assert.deepEqual(firstAttempt, [1]);
  assert.equal((await cursorStore.load()).server["session-1"], 1);

  const resumed: number[] = [];
  assert.equal(await bridge.materializeAuthoritativeHistory({
    async execute() { throw new Error("not used"); },
    async projectCanonicalEvents(events) { resumed.push(...events.map((event) => event.sequence)); },
  }, 3), 3);
  assert.deepEqual(resumed, [2, 3]);
  assert.equal((await cursorStore.load()).server["session-1"], 3);
});

test("provider_request snapshots require explicit capture authorization and exact observation", async () => {
  const api = new FakeApi();
  const blocked = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await blocked.connect();
  await assert.rejects(blocked.uploadContextSnapshot("session-1", {
    captureFidelity: "provider_request",
    content: { messages: [] },
    exactProviderRequest: true,
    observedBy: "harness_hook",
  }), /explicit bridge authorization/);

  const allowed = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration("provider_request"),
    transcriptRoots: {},
    allowProviderRequestCapture: true,
  });
  await allowed.connect();
  await allowed.uploadContextSnapshot("session-1", {
    captureFidelity: "provider_request",
    content: { messages: [] },
    exactProviderRequest: true,
    observedBy: "authorized_proxy",
  });
  assert.equal((api.appended.at(-1)?.payload as any).capture_fidelity, "provider_request");
});

test("agent request claim hydrates canonical history and completes with redacted harness output", async () => {
  const api = new FakeApi();
  const request = canonical("session-1", 2, {
    type: "agent_request",
    idempotencyKey: "request",
    payload: { content: "answer" },
  });
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "chat", payload: { content: "context" } }),
    request,
  );
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await bridge.connect();
  const result = await bridge.processAgentRequest(request, {
    async execute(input) {
      assert.deepEqual(input.canonicalHistory.map((item) => item.sequence), [1, 2]);
      await input.publishProgress?.({ id: "commentary-1", content: "Checking token=supersecretvalue" });
      return {
        events: [{
          kind: "tool_call",
          localEventId: "tool-1",
          harness: "codex",
          captureFidelity: "harness_transcript",
          toolName: "shell",
          toolCallId: "call-1",
          arguments: { command: "echo safe" },
        }, {
          kind: "assistant",
          localEventId: "answer-1",
          harness: "codex",
          captureFidelity: "harness_transcript",
          content: "Bearer abcdefghijklmnop",
        }],
      };
    },
  });
  assert.equal(result.claimed, true);
  assert.equal(api.progressInputs.length, 2);
  assert.deepEqual(api.progressInputs.map((input) => input.claimAttempt), [2, 2]);
  assert.equal((api.progressInputs[0]?.payload as any)?.content, "Agent started processing the request.");
  assert.equal((api.progressInputs[0]?.payload as any)?.phase, "lifecycle");
  assert.match(api.progressInputs[0]?.idempotencyKey ?? "", /:progress:start$/);
  assert.match(api.progressInputs[1]?.idempotencyKey ?? "", /:progress:/);
  assert.doesNotMatch(JSON.stringify(api.progressInputs[1]?.payload), /supersecretvalue/);
  assert.equal(api.appended[0]?.replyTo, request.id);
  assert.equal(api.appended[0]?.claimAttempt, 2);
  assert.equal((api.completeInput?.payload as any).text, "[REDACTED]");
  assert.equal(api.completeInput?.claimAttempt, 2);
});

test("a marked summary session never falls back to raw context when the connector lacks the context API", async () => {
  const api = new FakeApi();
  const request = canonical("session-1", 3, {
    type: "agent_request", idempotencyKey: "current", payload: { content: "continue" },
  });
  api.history.push(canonical("session-1", 1, {
    type: "agent_request", idempotencyKey: "summary", payload: {
      content: "selected summary prompt", history_summary: {
        version: 1, source_event_ids: ["source"], source_digest: "a".repeat(64),
      },
    },
  }), request);
  const bridge = new LocalBridge({ api, cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  await assert.rejects(() => bridge.processAgentRequest(request, {
    async execute() { throw new Error("must not execute with raw context"); },
  }), /cannot read GatherThread's summarized context/);
});

test("pending request polling persists the server cursor only after execution completes", async () => {
  const api = new FakeApi();
  const cursorStore = new MemoryCursorStore();
  const request = canonical("session-1", 2, {
    type: "agent_request",
    idempotencyKey: "request",
    payload: { text: "answer" },
  });
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "chat", payload: {} }),
    request,
  );
  const bridge = new LocalBridge({
    api,
    cursorStore,
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await bridge.connect();
  await assert.rejects(bridge.processPendingAgentRequests({
    async execute() { throw new Error("adapter failed"); },
  }), /adapter failed/);
  assert.equal((await cursorStore.load()).server["session-1"], 1);

  const result = await bridge.processPendingAgentRequests({
    async execute() {
      return { events: [{
        kind: "assistant",
        localEventId: "answer-2",
        harness: "codex",
        captureFidelity: "harness_transcript",
        content: "done",
      }] };
    },
  });
  assert.equal(result.claimed, 1);
  assert.equal((await cursorStore.load()).server["session-1"], 2);
});

test("known terminal harness failure completes the server claim with a bounded failed response", async () => {
  const api = new FakeApi();
  const cursorStore = new MemoryCursorStore();
  api.history.push(canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "terminal-request",
    payload: { text: "run" },
  }));
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const result = await bridge.processPendingAgentRequests({
    async execute() {
      throw new HarnessExecutionTerminatedError("codex_turn_failed", `failed token=${"x".repeat(40)}`);
    },
  });
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 1);
  assert.equal((api.completeInput?.payload as any).status, "failed");
  assert.equal((api.completeInput?.payload as any).error.code, "codex_turn_failed");
  assert.doesNotMatch(JSON.stringify(api.completeInput?.payload), /token=x/);
  assert.equal((await cursorStore.load()).server["session-1"], 1);
});

test("losing a cross-device claim race projects and advances only for the typed claimed conflict", async () => {
  const request = canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "raced-request",
    payload: { text: "work once" },
  });
  const api = new FakeApi();
  api.history.push(request);
  api.claimAgentRequest = async () => {
    throw new CollaborationHttpError(409, "already claimed", "agent_request_already_claimed");
  };
  const cursorStore = new MemoryCursorStore();
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const projected: number[] = [];
  const result = await bridge.processPendingAgentRequests({
    async execute() { throw new Error("claim loser must not execute"); },
    async projectCanonicalEvents(events) { projected.push(...events.map((event) => event.sequence)); },
  });
  assert.deepEqual(projected, [1]);
  assert.equal(result.claimed, 0);
  assert.equal((await cursorStore.load()).server["session-1"], 1);

  const otherApi = new FakeApi();
  otherApi.history.push(request);
  otherApi.claimAgentRequest = async () => {
    throw new CollaborationHttpError(409, "runtime busy", "runtime_busy");
  };
  const otherCursor = new MemoryCursorStore();
  const otherBridge = new LocalBridge({ api: otherApi, cursorStore: otherCursor, runtime: runtimeRegistration(), transcriptRoots: {} });
  await otherBridge.connect();
  await assert.rejects(otherBridge.processPendingAgentRequests({
    async execute() { throw new Error("must not execute"); },
    async projectCanonicalEvents() { throw new Error("unrelated 409 must not be projected"); },
  }), (error: unknown) => error instanceof CollaborationHttpError && error.code === "runtime_busy");
  assert.equal((await otherCursor.load()).server["session-1"] ?? 0, 0);
});

test("a request the server has given up on is projected instead of retried forever", async () => {
  const request = canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "abandoned-request",
    payload: { text: "work no runtime could finish" },
  });
  const api = new FakeApi();
  api.history.push(request);
  api.claimAgentRequest = async () => {
    throw new CollaborationHttpError(409, "abandoned", "agent_request_failed");
  };
  const cursorStore = new MemoryCursorStore();
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const projected: number[] = [];
  const result = await bridge.processPendingAgentRequests({
    async execute() { throw new Error("an abandoned request must not be executed"); },
    async projectCanonicalEvents(events) { projected.push(...events.map((event) => event.sequence)); },
  });
  assert.deepEqual(projected, [1], "the canonical failure must reach the native projection");
  assert.equal(result.claimed, 0);
  assert.equal(
    (await cursorStore.load()).server["session-1"],
    1,
    "a terminal failure must advance the cursor rather than be retried on every poll",
  );
});

test("an atomically completed local turn is projected without retrying its agent request", async () => {
  const request = canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "completed-local-request",
    payload: { text: "already answered on Desktop" },
  });
  const api = new FakeApi();
  api.history.push(request);
  api.claimAgentRequest = async () => {
    throw new CollaborationHttpError(409, "already completed", "agent_request_already_completed");
  };
  const cursorStore = new MemoryCursorStore();
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const projected: number[] = [];
  const result = await bridge.processPendingAgentRequests({
    async execute() { throw new Error("a completed local turn must never execute again"); },
    async projectCanonicalEvents(events) { projected.push(...events.map((event) => event.sequence)); },
  });
  assert.deepEqual(projected, [1]);
  assert.equal(result.claimed, 0);
  assert.equal((await cursorStore.load()).server["session-1"], 1);
});

test("request polling projects remote requests and advances without claiming them", async () => {
  const api = new FakeApi();
  let claims = 0;
  api.claimAgentRequest = async (...args) => {
    claims += 1;
    return { claimed: true, status: "claimed" as const, requestId: args[1], runtimeId: args[2] };
  };
  const cursorStore = new MemoryCursorStore();
  const chat = canonical("session-1", 1, { type: "human_chat", idempotencyKey: "chat", payload: { text: "shared" } });
  const remoteRequest = { ...canonical("session-1", 2, {
    type: "agent_request",
    idempotencyKey: "remote-request",
    payload: { text: "remote work" },
  }), actorId: "user-2" };
  const remoteResponse = { ...canonical("session-1", 3, {
    type: "agent_response",
    idempotencyKey: "remote-response",
    payload: { text: "remote answer" },
  }), actorId: "user-2" };
  api.history.push(chat, remoteRequest, remoteResponse);
  const projected: number[] = [];
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const result = await bridge.processPendingAgentRequests({
    async execute() { throw new Error("remote requests must not execute locally"); },
    async projectCanonicalEvents(events) { projected.push(...events.map((event) => event.sequence)); },
  });
  assert.deepEqual(projected, [1, 2, 3]);
  assert.equal(claims, 0);
  assert.equal(result.claimed, 0);
  assert.equal((await cursorStore.load()).server["session-1"], 3);
});

test("executor eligibility can skip a locally committed request without blocking the cursor", async () => {
  const api = new FakeApi();
  let claims = 0;
  api.claimAgentRequest = async (...args) => {
    claims += 1;
    return { claimed: true, status: "claimed" as const, requestId: args[1], runtimeId: args[2] };
  };
  api.history.push(canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "committed-local-request",
    payload: { text: "already completed on desktop" },
  }));
  const cursorStore = new MemoryCursorStore();
  const bridge = new LocalBridge({ api, cursorStore, runtime: runtimeRegistration(), transcriptRoots: {} });
  await bridge.connect();
  const projected: number[] = [];
  await bridge.processPendingAgentRequests({
    async execute() { throw new Error("bound local request must not execute again"); },
    shouldExecute: async () => false,
    projectCanonicalEvents: async (events) => { projected.push(...events.map((event) => event.sequence)); },
  });
  assert.equal(claims, 0);
  assert.deepEqual(projected, [1]);
  assert.equal((await cursorStore.load()).server["session-1"], 1);
});

test("bridge daemon exits cleanly when its abort signal is raised", async () => {
  const api = new FakeApi();
  api.history.push(canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "request",
    payload: { text: "answer" },
  }));
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  const shutdown = new AbortController();
  const daemon = new BridgeDaemon({
    bridge,
    signal: shutdown.signal,
    pollIntervalMs: 60_000,
    executor: {
      async execute() {
        shutdown.abort();
        return { events: [{
          kind: "assistant",
          localEventId: "answer-3",
          harness: "codex",
          captureFidelity: "harness_transcript",
          content: "done",
        }] };
      },
    },
  });
  await daemon.run();
  assert.equal(api.completeInput?.payload && (api.completeInput.payload as any).text, "done");
});

test("bridge daemon refreshes runtime presence independently of request polling", async () => {
  const api = new FakeApi();
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  const shutdown = new AbortController();
  const originalHeartbeat = api.heartbeatRuntime.bind(api);
  api.heartbeatRuntime = async () => {
    const runtime = await originalHeartbeat();
    shutdown.abort();
    return runtime;
  };
  const daemon = new BridgeDaemon({
    bridge,
    signal: shutdown.signal,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 1,
    executor: {
      async execute() {
        throw new Error("no request should execute");
      },
    },
  });

  await daemon.run();
  assert.equal(api.heartbeatCount, 1);
});

function canonical(
  sessionId: string,
  sequence: number,
  input: AppendEventInput,
): CanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId,
    sequence,
    type: input.type,
    actorId: "user-1",
    timestamp: "2026-08-25T00:00:00.000Z",
    payload: input.payload,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  };
}

function runtimeRegistration(
  captureFidelity: RuntimeRegistration["captureFidelity"] = "harness_transcript",
): RuntimeRegistration {
  return {
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt",
    localSessionId: "local-1",
    captureFidelity,
  };
}
