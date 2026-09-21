import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  AgentRequestClaim,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CompleteAgentRequestInput,
  ReadEventsResult,
  SessionSummary,
} from "@gatherthread/bridge";
import { buildDshCanonicalPrompt } from "../src/canonical-prompt.js";
import { parseDshHostConfig, type EnabledDshHostConfig } from "../src/config.js";
import { DshHostConnector } from "../src/connector.js";
import { MemoryConnectorStateStore } from "../src/state-store.js";
import type {
  ConnectorState,
  DshAgentStatus,
  DshAppendEventInput,
  DshCanonicalEvent,
  DshCollaborationApi,
  DshHostFacade,
  DshPromptResult,
  DshRegisteredRuntime,
  DshRuntimeRegistration,
  DshSessionEventRecord,
} from "../src/types.js";

const now = "2026-09-05T00:00:00.000Z";
const eventTime = Date.parse(now);

function config(overrides: Partial<EnabledDshHostConfig> = {}): EnabledDshHostConfig {
  const parsed = parseDshHostConfig({
    enabled: true,
    apiUrl: "https://gatherthread.example/v1",
    credentialReference: { kind: "environment", variable: "GATHERTHREAD_DSH_TOKEN" },
    projectId: "project-1",
    sessionId: "session-1",
    deviceId: "device-1",
    workspacePath: "/readonly/workspace",
    statePath: "/private/state/dsh.json",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    pollIntervalMs: 50,
    pollLimit: 20,
    shareToolEvents: true,
  });
  if (!parsed.enabled || parsed.bindingMode !== "single") throw new Error("expected single-session config");
  return { ...parsed, ...overrides };
}

function canonical(
  sequence: number,
  type: DshCanonicalEvent["type"],
  payload: unknown,
  actorId = "user-1",
): DshCanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type,
    actorId,
    actorDisplayName: actorId,
    timestamp: now,
    payload,
  };
}

function request(sequence = 2): DshCanonicalEvent {
  return canonical(sequence, "agent_request", {
    content: "Do the work password=hunter2",
    execution_profile: {
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    },
    reasoning: "PRIVATE_REQUEST_REASONING",
  });
}

class FakeConflict extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); }
}

class FakeApi implements DshCollaborationApi {
  readonly sessions: SessionSummary[] = [{
    id: "session-1",
    projectId: "project-1",
    name: "General",
    mode: "multi",
    state: "active",
    role: "owner",
    latestSequence: 0,
  }];
  readonly events: DshCanonicalEvent[] = [];
  readonly registrations: DshRuntimeRegistration[] = [];
  readonly returnedRuntimeIds: string[] = [];
  readonly claims = new Map<string, "claimed" | "completed">();
  readonly progress: CompleteAgentRequestInput[] = [];
  readonly appended: DshAppendEventInput[] = [];
  readonly completions: CompleteAgentRequestInput[] = [];
  readonly localTurns: CommitLocalTurnInput[] = [];
  readonly idempotent = new Map<string, DshCanonicalEvent>();
  readCount = 0;
  heartbeatCount = 0;
  claimConflictCode: string | undefined;
  failNextKind: "progress" | "append" | "complete" | "local_turn" | undefined;
  failNextHeartbeat = false;
  readGate: Promise<void> | undefined;
  forcedRuntimeId: string | undefined;
  forcedHeartbeatRuntimeId: string | undefined;
  #runtime: DshRegisteredRuntime | undefined;

  async listProjectSessions(): Promise<SessionSummary[]> {
    return structuredClone(this.sessions.map((session) => ({
      ...session,
      latestSequence: Math.max(
        session.latestSequence ?? 0,
        ...this.events
          .filter((event) => event.sessionId === session.id)
          .map((event) => event.sequence),
      ),
    })));
  }

  async readEvents(_sessionId: string, afterSequence: number, limit = 200): Promise<ReadEventsResult> {
    this.readCount += 1;
    await this.readGate;
    const remaining = this.events.filter((event) => event.sequence > afterSequence);
    const events = remaining.slice(0, limit);
    const hasMore = remaining.length > events.length;
    const head = this.events.at(-1)?.sequence ?? afterSequence;
    return {
      events: structuredClone(events),
      nextSequence: hasMore ? events.at(-1)?.sequence ?? afterSequence : head,
      hasMore,
    };
  }

  async registerRuntime(input: DshRuntimeRegistration): Promise<DshRegisteredRuntime> {
    this.registrations.push(structuredClone(input));
    if (this.#runtime === undefined || this.forcedRuntimeId !== undefined) {
      this.#runtime = {
        ...structuredClone(input),
        id: this.forcedRuntimeId ?? "runtime-1",
        userId: "user-1",
        registeredAt: now,
      };
    }
    this.returnedRuntimeIds.push(this.#runtime.id);
    return structuredClone(this.#runtime);
  }

  async heartbeatRuntime(runtimeId: string): Promise<DshRegisteredRuntime> {
    this.heartbeatCount += 1;
    if (this.failNextHeartbeat) {
      this.failNextHeartbeat = false;
      throw new Error("simulated heartbeat transport failure");
    }
    if (this.#runtime === undefined || runtimeId !== this.#runtime.id) {
      throw new Error("unknown fake runtime");
    }
    return {
      ...structuredClone(this.#runtime),
      id: this.forcedHeartbeatRuntimeId ?? this.#runtime.id,
    };
  }

  async claimAgentRequest(
    _sessionId: string,
    requestId: string,
    runtimeId: string,
  ): Promise<AgentRequestClaim> {
    if (this.claimConflictCode !== undefined) throw new FakeConflict(this.claimConflictCode);
    const status = this.claims.get(requestId);
    if (status !== undefined) {
      return { claimed: status === "claimed", status, requestId, runtimeId, attemptCount: 2 };
    }
    this.claims.set(requestId, "claimed");
    return { claimed: true, status: "claimed", requestId, runtimeId, attemptCount: 2 };
  }

  async appendAgentProgress(
    _sessionId: string,
    requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<DshCanonicalEvent> {
    this.maybeFail("progress");
    const existing = this.idempotent.get(input.idempotencyKey);
    if (existing !== undefined) return existing;
    this.progress.push(structuredClone(input));
    return this.appendCanonical("agent_progress", input.payload, input.idempotencyKey, requestId, input.runtimeId);
  }

  async appendEvent(_sessionId: string, input: DshAppendEventInput): Promise<DshCanonicalEvent> {
    this.maybeFail("append");
    const existing = this.idempotent.get(input.idempotencyKey);
    if (existing !== undefined) return existing;
    this.appended.push(structuredClone(input));
    return this.appendCanonical(input.type, input.payload, input.idempotencyKey, input.replyTo, input.runtimeId);
  }

  async completeAgentRequest(
    _sessionId: string,
    requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<DshCanonicalEvent> {
    this.maybeFail("complete");
    const existing = this.idempotent.get(input.idempotencyKey);
    if (existing !== undefined) return existing;
    this.completions.push(structuredClone(input));
    this.claims.set(requestId, "completed");
    return this.appendCanonical("agent_response", input.payload, input.idempotencyKey, requestId, input.runtimeId);
  }

  async commitLocalTurn(
    _sessionId: string,
    input: CommitLocalTurnInput,
  ): Promise<CommitLocalTurnResult> {
    this.maybeFail("local_turn");
    const previous = this.localTurns.find((candidate) => candidate.localTurnId === input.localTurnId);
    if (previous === undefined) this.localTurns.push(structuredClone(input));
    const existingRequest = this.idempotent.get(`${input.localTurnId}:request`);
    const existingResponse = this.idempotent.get(`${input.localTurnId}:response`);
    if (existingRequest !== undefined && existingResponse !== undefined) {
      return {
        localTurnId: input.localTurnId,
        runtimeId: input.runtimeId,
        headBeforeCommit: existingRequest.sequence - 1,
        reconciliationRequired: existingRequest.sequence - 1 > input.basedOnSequence,
        requestEvent: existingRequest,
        responseEvent: existingResponse,
        toolEvents: [],
      };
    }
    const headBeforeCommit = this.events.at(-1)?.sequence ?? 0;
    const requestEvent = this.appendCanonical(
      "agent_request",
      input.requestPayload,
      `${input.localTurnId}:request`,
      undefined,
      input.runtimeId,
    );
    const responseEvent = this.appendCanonical(
      "agent_response",
      input.responsePayload,
      `${input.localTurnId}:response`,
      requestEvent.id,
      input.runtimeId,
    );
    return {
      localTurnId: input.localTurnId,
      runtimeId: input.runtimeId,
      headBeforeCommit,
      reconciliationRequired: headBeforeCommit > input.basedOnSequence,
      requestEvent,
      responseEvent,
      toolEvents: [],
    };
  }

  private maybeFail(kind: "progress" | "append" | "complete" | "local_turn"): void {
    if (this.failNextKind === kind) {
      this.failNextKind = undefined;
      throw new Error("simulated offline transport");
    }
  }

  private appendCanonical(
    type: DshCanonicalEvent["type"],
    payload: unknown,
    idempotencyKey: string,
    _replyTo?: string,
    runtimeId?: string,
  ): DshCanonicalEvent {
    const event = canonical((this.events.at(-1)?.sequence ?? 0) + 1, type, payload);
    if (runtimeId !== undefined) {
      event.runtime = {
        userId: "user-1",
        deviceId: "device-1",
        runtimeId,
        harness: "deepseek-harness" as never,
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        localSessionId: "fake-local-session",
        captureFidelity: "harness_transcript",
      };
    }
    this.events.push(event);
    this.idempotent.set(idempotencyKey, event);
    return event;
  }
}

interface FakeDshPersistence {
  exists: boolean;
  events: DshSessionEventRecord[];
  prompts: string[];
}

class FakeHost implements DshHostFacade {
  readonly sessionId: string;
  readonly #persistence: FakeDshPersistence;
  readonly #eventListeners = new Set<(event: DshSessionEventRecord) => void>();
  readonly #statusListeners = new Set<(status: DshAgentStatus) => void>();
  readonly #disposeSignal: Promise<void>;
  #signalDispose: (() => void) | undefined;
  disposeCount = 0;
  openCount = 0;
  duplicateReturnedEvent = false;
  nextAnswer = "public final";
  promptGate: Promise<void> | undefined;
  flushCount = 0;
  failNextProjection = false;
  readonly projected: Array<{ eventId: string; role: string; content: string }> = [];

  constructor(sessionId: string, persistence: FakeDshPersistence) {
    this.sessionId = sessionId;
    this.#persistence = persistence;
    this.#disposeSignal = new Promise<void>((resolve) => { this.#signalDispose = resolve; });
  }

  async open(): Promise<"created" | "resumed"> {
    this.openCount += 1;
    const mode = this.#persistence.exists ? "resumed" : "created";
    this.#persistence.exists = true;
    return mode;
  }

  currentSequence(): number {
    return this.#persistence.events.length;
  }

  get prompts(): readonly string[] {
    return this.#persistence.prompts;
  }

  snapshotFrom(sequence: number): readonly DshSessionEventRecord[] {
    return structuredClone(this.#persistence.events.slice(sequence));
  }

  async prompt(text: string): Promise<DshPromptResult> {
    this.#persistence.prompts.push(text);
    const fromSequence = this.currentSequence();
    this.emitStatus("running");
    await Promise.race([
      this.promptGate ?? Promise.resolve(),
      this.#disposeSignal.then(() => {
        throw new Error("fake DSH agent disposed during prompt");
      }),
    ]);
    const definitions: Array<{ type: string; data: unknown }> = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "tool/call", data: {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "shell",
        arguments: JSON.stringify({ cmd: "echo safe", ["api" + "_key"]: "PRIVATE_API_KEY" }),
        reasoning: "PRIVATE_TOOL_REASONING",
      } },
      { type: "tool/result", data: {
        turn: 1,
        step: 1,
        message: {
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            content: [
              { type: "reasoning", text: "PRIVATE_RESULT_REASONING" },
              { type: "text", text: "password=hunter2 safe result" },
            ],
          }],
        },
        meta: { hidden: "PRIVATE_META" },
      } },
      { type: "assistant/message", data: {
        message: {
          content: [
            { type: "reasoning", text: "PRIVATE_ASSISTANT_REASONING" },
            { type: "text", text: this.nextAnswer },
          ],
          source: { replayState: "PRIVATE_REPLAY_STATE" },
        },
        stream: "PRIVATE_STREAM",
      } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const additions: DshSessionEventRecord[] = [];
    for (const definition of definitions) {
      const event = this.event(definition.type, definition.data);
      additions.push(event);
      this.#persistence.events.push(event);
      for (const listener of this.#eventListeners) listener(event);
    }
    this.emitStatus("idle");
    const returned = structuredClone(additions);
    if (this.duplicateReturnedEvent) returned.push(structuredClone(additions[1]!));
    return {
      fromSequence,
      toSequence: this.currentSequence(),
      events: returned,
    };
  }

  async projectCanonicalEvents(
    events: ReadonlyArray<{ eventId: string; role: string; content: string }>,
  ): Promise<void> {
    if (this.failNextProjection) {
      this.failNextProjection = false;
      throw new Error("simulated native projection failure");
    }
    for (const event of events) {
      if (!this.projected.some((candidate) => candidate.eventId === event.eventId)) {
        this.projected.push(structuredClone(event));
      }
    }
    this.flushCount += 1;
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  emitLocalTurn(input = "LOCAL_DSH_REQUEST", output = "LOCAL_DSH_RESPONSE"): void {
    const turn = 99;
    const definitions: Array<{ type: string; data: unknown }> = [
      { type: "turn/start", data: { turn } },
      { type: "step/start", data: { turn, step: 1 } },
      { type: "user/message", data: {
        id: `local-user-${this.currentSequence()}`,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: input }],
      } },
      { type: "assistant/message", data: {
        turn,
        step: 1,
        message: {
          id: `local-assistant-${this.currentSequence()}`,
          role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
          content: [
            { type: "reasoning", text: "PRIVATE_LOCAL_REASONING" },
            { type: "text", text: output },
          ],
        },
      } },
      { type: "step/end", data: { turn, step: 1 } },
      { type: "turn/end", data: { turn, reason: { kind: "completed" } } },
    ];
    for (const definition of definitions) {
      const event = this.event(definition.type, definition.data);
      this.#persistence.events.push(event);
      for (const listener of this.#eventListeners) listener(event);
    }
  }

  onSessionEvent(listener: (event: DshSessionEventRecord) => void): () => void {
    this.#eventListeners.add(listener);
    return () => { this.#eventListeners.delete(listener); };
  }

  onStatus(listener: (status: DshAgentStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => { this.#statusListeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.#signalDispose?.();
    this.#signalDispose = undefined;
  }

  listenerCount(): number {
    return this.#eventListeners.size + this.#statusListeners.size;
  }

  private event(type: string, data: unknown): DshSessionEventRecord {
    return { type, seq: this.currentSequence(), time: eventTime, data };
  }

  private emitStatus(status: DshAgentStatus): void {
    for (const listener of this.#statusListeners) listener(status);
  }
}

function freshPersistence(): FakeDshPersistence {
  return { exists: false, events: [], prompts: [] };
}

test("ordinary canonical updates are durably projected before a later request without duplicate prompt history", async () => {
  const cfg = config();
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ runImmediately: false, schedule: false });

  api.events.push(canonical(1, "human_chat", { content: "EARLY_REMOTE_CONTEXT" }, "user-2"));
  await connector.pollOnce();
  assert.deepEqual(host.projected.map((event) => event.eventId), ["event-1"]);

  api.events.push(request(2));
  await connector.pollOnce();
  assert.equal(host.projected.filter((event) => event.eventId === "event-1").length, 1);
  assert.equal(host.projected.some((event) => event.eventId === "event-2"), false);
  assert.equal(host.projected[0]?.content, "EARLY_REMOTE_CONTEXT");
  assert.doesNotMatch(host.projected[0]?.content ?? "", /PRIVATE_/);
  assert.match(host.projected[0]?.role ?? "", /^user$/);
  assert.doesNotMatch(host.prompts.at(-1) ?? "", /EARLY_REMOTE_CONTEXT|canonical context follows/);
  assert.match(host.prompts.at(-1) ?? "", /Do the work password=\[REDACTED\]/);
  await connector.stop();
});

test("a completed local DSH turn is atomically committed and its canonical echo is not projected back", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ runImmediately: false, schedule: false });

  host.emitLocalTurn();
  await connector.pollOnce();
  assert.equal(api.localTurns.length, 1);
  assert.deepEqual(api.localTurns[0]?.requestPayload, {
    content: "LOCAL_DSH_REQUEST",
    capture_fidelity: "harness_transcript",
    source_harness: "deepseek-harness",
  });
  assert.deepEqual(api.localTurns[0]?.responsePayload, {
    text: "LOCAL_DSH_RESPONSE",
    capture_fidelity: "harness_transcript",
    source_harness: "deepseek-harness",
  });
  assert.doesNotMatch(JSON.stringify(api.localTurns), /PRIVATE_LOCAL_REASONING|reasoning/i);

  await connector.pollOnce();
  assert.equal(api.localTurns.length, 1, "local turn retries must be idempotent");
  assert.deepEqual(host.projected, [], "this runtime's canonical request/response must not echo into DSH");
  assert.equal((await store.load())?.outbox.length, 0);
  await connector.stop();
});

test("per-conversation automatic upload can be disabled and manual upload discovers the missed DSH turn", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ runImmediately: false, schedule: false });

  const disabled = await connector.setLocalAutoUpload(false);
  assert.equal(disabled.automaticUpload, false);
  host.emitLocalTurn("PRIVATE_UNTIL_MANUAL", "MANUAL_DSH_RESPONSE");
  await connector.pollOnce();
  assert.equal(api.localTurns.length, 0, "ordinary polling must honor the disabled upload preference");
  assert.equal(connector.localSyncStatus().uploadableLocalTurns, 1);

  const uploaded = await connector.uploadLocalTurns();
  assert.equal(uploaded.discoveredLocalTurns, 1);
  assert.equal(uploaded.uploadedLocalTurns, 1);
  assert.equal(uploaded.automaticUpload, false, "manual recovery must not silently change the preference");
  assert.equal(api.localTurns[0]?.requestPayload && (api.localTurns[0].requestPayload as any).content, "PRIVATE_UNTIL_MANUAL");
  assert.equal(api.localTurns[0]?.basedOnSequence, 0, "manual recovery must not invent a historical cloud base");
  assert.equal((await store.load())?.automaticUpload, false);
  await connector.stop();
});

test("a disabled conversation preserves a missed local turn before claiming a later Web request", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ runImmediately: false, schedule: false });
  await connector.setLocalAutoUpload(false);
  host.emitLocalTurn("PRIVATE_BEFORE_WEB_REQUEST", "LOCAL_FIRST");
  api.events.push(request(1));

  await connector.pollOnce();
  assert.equal(api.claims.size, 0, "the later Web request must wait for the user's upload choice");
  assert.equal(host.prompts.length, 0);
  assert.equal(connector.localSyncStatus().uploadableLocalTurns, 1);

  await connector.uploadLocalTurns();
  await connector.pollOnce();
  assert.equal(api.claims.get("event-1"), "completed");
  assert.equal(host.prompts.length, 1);
  await connector.stop();
});

test("manual DSH recovery deduplicates a failed outbox turn and uploads newer turns in one action", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ runImmediately: false, schedule: false });
  await connector.setLocalAutoUpload(false);
  host.emitLocalTurn("FIRST_OFFLINE_TURN", "FIRST_RESPONSE");
  api.failNextKind = "local_turn";
  await assert.rejects(connector.uploadLocalTurns(), /simulated offline transport/);

  host.emitLocalTurn("SECOND_OFFLINE_TURN", "SECOND_RESPONSE");
  const pending = connector.localSyncStatus();
  assert.equal(pending.pendingLocalTurns, 1);
  assert.equal(pending.uploadableLocalTurns, 2, "the durable turn must not also be counted as newly discoverable");

  const recovered = await connector.uploadLocalTurns();
  assert.equal(recovered.discoveredLocalTurns, 1);
  assert.equal(recovered.uploadedLocalTurns, 2);
  assert.equal(recovered.uploadableLocalTurns, 0);
  assert.deepEqual(api.localTurns.map((turn) => (turn.requestPayload as { content: string }).content), [
    "FIRST_OFFLINE_TURN",
    "SECOND_OFFLINE_TURN",
  ]);
  await connector.stop();
});

test("a newly adopted native DSH Session uploads its existing completed turn before canonical replay", async () => {
  const cfg = config({ dshSessionId: "session-1" });
  const api = new FakeApi();
  const persistence = freshPersistence();
  persistence.exists = true;
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.emitLocalTurn("NATIVE_FIRST_REQUEST", "NATIVE_FIRST_RESPONSE");
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
    adoptExistingLocalSession: true,
  });

  await connector.start({ schedule: false });
  assert.equal(api.localTurns.length, 1);
  assert.deepEqual(api.localTurns[0]?.requestPayload, {
    content: "NATIVE_FIRST_REQUEST",
    capture_fidelity: "harness_transcript",
    source_harness: "deepseek-harness",
  });
  assert.deepEqual(api.localTurns[0]?.responsePayload, {
    text: "NATIVE_FIRST_RESPONSE",
    capture_fidelity: "harness_transcript",
    source_harness: "deepseek-harness",
  });
  await connector.stop();
});

test("a failed native projection retains its canonical cursor and retries without loss", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(canonical(1, "human_chat", { content: "RETRY_REMOTE_CONTEXT" }, "user-2"));
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  host.failNextProjection = true;
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ runImmediately: false, schedule: false });

  await assert.rejects(connector.pollOnce(), /simulated native projection failure/);
  assert.equal((await store.load())?.projectionCursor, 0);
  assert.equal((await store.load())?.serverCursor, 0);
  await connector.pollOnce();
  assert.deepEqual(host.projected.map((event) => event.eventId), ["event-1"]);
  assert.equal((await store.load())?.projectionCursor, 1);
  await connector.stop();
});

test("a local-turn transport failure replays its durable outbox after restart", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const firstHost = new FakeHost(cfg.dshSessionId, persistence);
  const first = new DshHostConnector({ config: cfg, api, host: firstHost, stateStore: store });
  await first.start({ runImmediately: false, schedule: false });
  firstHost.emitLocalTurn("OFFLINE_LOCAL_REQUEST", "OFFLINE_LOCAL_RESPONSE");
  api.failNextKind = "local_turn";
  await assert.rejects(first.pollOnce(), /simulated offline transport/);
  assert.equal((await store.load())?.outbox[0]?.kind, "local_turn");
  await first.stop();

  const resumedHost = new FakeHost(cfg.dshSessionId, persistence);
  const resumed = new DshHostConnector({ config: cfg, api, host: resumedHost, stateStore: store });
  await resumed.start({ schedule: false });
  assert.equal(api.localTurns.length, 1);
  assert.equal((await store.load())?.outbox.length, 0);
  assert.deepEqual(resumedHost.projected, [], "the replayed local turn must not echo back");
  await resumed.stop();
});

test("legacy transport cursors backfill canonical history into a resumed native Session", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(canonical(1, "human_chat", { content: "LEGACY_MISSING_HISTORY" }, "user-2"));
  const persistence: FakeDshPersistence = { exists: true, events: [], prompts: [] };
  const store = new MemoryConnectorStateStore({
    version: 1,
    binding: {
      projectId: cfg.projectId,
      sessionId: cfg.sessionId,
      dshSessionId: cfg.dshSessionId,
    },
    serverCursor: 1,
    publishedDshSequence: 0,
    outbox: [],
  });
  const host = new FakeHost(cfg.dshSessionId, persistence);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false });
  assert.deepEqual(host.projected.map((event) => event.content), ["LEGACY_MISSING_HISTORY"]);
  assert.equal((await store.load())?.projectionCursor, 1);
  await connector.stop();
});

test("connector runs register, replay, claim, prompt, progress/tool/final, cursor, and clean reload end to end", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(
    canonical(1, "human_chat", { content: "shared context", reasoning: "PRIVATE_CANONICAL" }),
    request(2),
  );
  const persistence = freshPersistence();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.duplicateReturnedEvent = true;
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });

  await connector.start({ schedule: false });
  assert.equal(api.registrations.length, 1);
  assert.equal(api.claims.get("event-2"), "completed");
  assert.equal(persistence.prompts.length, 1);
  assert.deepEqual(host.projected.map((event) => event.content), ["shared context"]);
  assert.doesNotMatch(persistence.prompts[0] ?? "", /shared context/);
  assert.match(persistence.prompts[0] ?? "", /password=\[REDACTED\]/);
  assert.doesNotMatch(persistence.prompts[0] ?? "", /PRIVATE_/);
  assert.deepEqual(api.progress.map((item) => (item.payload as { status: string }).status), ["running", "idle"]);
  assert.deepEqual(api.progress.map((item) => item.claimAttempt), [2, 2]);
  assert.equal(api.appended.filter((item) => item.type === "tool_call").length, 1);
  assert.equal(api.appended.filter((item) => item.type === "tool_result").length, 1);
  assert.equal(api.completions.length, 1);
  assert.equal(api.completions[0]?.claimAttempt, 2);
  assert.equal((api.completions[0]?.payload as { text: string }).text, "public final");
  const uploaded = JSON.stringify({ progress: api.progress, tools: api.appended, final: api.completions });
  assert.doesNotMatch(uploaded, /PRIVATE_|hunter2|reasoning|replayState|stream/i);
  assert.match(uploaded, /\[REDACTED\]/);
  assert.deepEqual(await store.load(), {
    version: 3,
    binding: {
      projectId: "project-1",
      sessionId: "session-1",
      dshSessionId: cfg.dshSessionId,
    },
    serverCursor: 2,
    projectionCursor: 2,
    publishedDshSequence: 5,
    automaticUpload: true,
    outbox: [],
  });
  await connector.stop();
  assert.equal(host.disposeCount, 1);
  assert.equal(host.listenerCount(), 0);

  const reloadedHost = new FakeHost(cfg.dshSessionId, persistence);
  const reloaded = new DshHostConnector({ config: cfg, api, host: reloadedHost, stateStore: store });
  await reloaded.start({ schedule: false });
  assert.equal(reloadedHost.openCount, 1);
  assert.equal(persistence.prompts.length, 1, "reload must not prompt a completed request twice");
  assert.equal(api.completions.length, 1, "idempotent reload must not duplicate final events");
  assert.equal(api.registrations.length, 2);
  assert.deepEqual(api.returnedRuntimeIds, ["runtime-1", "runtime-1"]);
  await reloaded.stop();
  assert.equal(reloadedHost.listenerCount(), 0);
});

test("connector rejects a provider target that differs from its DSH binding before claim or prompt", async () => {
  const cfg = config();
  const api = new FakeApi();
  const targeted = canonical(1, "agent_request", {
    content: "Use the requested provider",
    execution_profile: {
      harness: "deepseek-harness",
      provider: "different-provider",
      model: cfg.model,
    },
  });
  api.events.push(targeted);
  const persistence = freshPersistence();
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host: new FakeHost(cfg.dshSessionId, persistence),
    stateStore: new MemoryConnectorStateStore(),
  });
  await assert.rejects(
    connector.start({ schedule: false }),
    /provider does not match the configured Host binding/,
  );
  assert.equal(api.claims.size, 0);
  assert.equal(persistence.prompts.length, 0);
  assert.equal(api.progress.length, 0);
  assert.equal(api.completions.length, 0);
});

test("offline outbox failure survives disposal and resumes without re-prompting", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(canonical(1, "human_chat", { text: "context" }), request(2));
  api.failNextKind = "append";
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const firstHost = new FakeHost(cfg.dshSessionId, persistence);
  const first = new DshHostConnector({ config: cfg, api, host: firstHost, stateStore: store });

  await assert.rejects(first.start({ schedule: false }), /simulated offline transport/);
  const interruptedState = await store.load();
  assert.equal(interruptedState?.activeRequest?.dshToSequence, 5);
  assert.ok((interruptedState?.outbox.length ?? 0) > 0);
  assert.equal(persistence.prompts.length, 1);
  assert.equal(firstHost.disposeCount, 1);

  const resumedHost = new FakeHost(cfg.dshSessionId, persistence);
  const resumed = new DshHostConnector({ config: cfg, api, host: resumedHost, stateStore: store });
  await resumed.start({ schedule: false });
  assert.equal(persistence.prompts.length, 1, "outbox replay must not call the model again");
  assert.equal(api.appended.length, 2);
  assert.equal(api.completions.length, 1);
  assert.equal((await store.load())?.outbox.length, 0);
  assert.equal((await store.load())?.activeRequest, undefined);
  await resumed.stop();
});

test("a second request skips this runtime's native outputs but retains other collaborators' updates", async () => {
  const cfg = config({ shareToolEvents: true });
  const api = new FakeApi();
  api.events.push(canonical(1, "human_chat", { content: "first shared context" }), request(2));
  const persistence = freshPersistence();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.nextAnswer = "FIRST_NATIVE_ANSWER";
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ schedule: false });
  const ownOutputHead = api.events.at(-1)?.sequence ?? 0;
  const otherRuntime = {
    userId: "user-2",
    deviceId: "device-2",
    runtimeId: "runtime-other",
    harness: "codex" as const,
    provider: "openai",
    model: "gpt-test",
    localSessionId: "other-local",
    captureFidelity: "harness_transcript" as const,
  };
  api.events.push(
    canonical(ownOutputHead + 1, "human_chat", { content: "OTHER_PARTICIPANT_UPDATE" }, "user-2"),
    {
      ...canonical(ownOutputHead + 2, "agent_response", { text: "OTHER_RUNTIME_RESPONSE" }, "user-2"),
      runtime: otherRuntime,
    },
    canonical(ownOutputHead + 3, "agent_request", {
      content: "second request",
      execution_profile: { harness: "deepseek-harness", model: "deepseek-v4-flash" },
    }),
  );
  host.nextAnswer = "second final";
  await connector.pollOnce();
  assert.equal(persistence.prompts.length, 2);
  const secondPrompt = persistence.prompts[1] ?? "";
  assert.equal(secondPrompt, "second request");
  assert.deepEqual(
    host.projected.map((event) => event.content),
    ["first shared context", "OTHER_PARTICIPANT_UPDATE", "OTHER_RUNTIME_RESPONSE"],
  );
  assert.doesNotMatch(
    secondPrompt,
    /FIRST_NATIVE_ANSWER|DeepSeek Harness started processing|DeepSeek Harness returned to idle|safe result|echo safe/,
  );
  assert.equal((api.completions.at(-1)?.payload as { text: string }).text, "second final");
  await connector.stop();
});

test("a changed runtime id fails closed without dropping a persisted outbox", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(request(1));
  api.failNextKind = "append";
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const first = new DshHostConnector({
    config: cfg,
    api,
    host: new FakeHost(cfg.dshSessionId, persistence),
    stateStore: store,
  });
  await assert.rejects(first.start({ schedule: false }), /simulated offline transport/);
  const before = await store.load();
  assert.ok((before?.outbox.length ?? 0) > 0);

  api.forcedRuntimeId = "runtime-2";
  const changed = new DshHostConnector({
    config: cfg,
    api,
    host: new FakeHost(cfg.dshSessionId, persistence),
    stateStore: store,
  });
  await assert.rejects(changed.start({ schedule: false }), /outbox belongs to a different runtime/);
  assert.deepEqual(await store.load(), before);
});

test("crash-repaired active request resumes through DSH context instead of replaying canonical history", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const chat = canonical(1, "human_chat", { content: "shared before crash" });
  const activeRequest = request(2);
  api.events.push(chat, activeRequest);
  api.claims.set(activeRequest.id, "claimed");
  const originalPrompt = buildDshCanonicalPrompt([chat, activeRequest], activeRequest);
  const persistence: FakeDshPersistence = {
    exists: true,
    prompts: [originalPrompt],
    events: [
      { type: "turn/start", seq: 0, time: eventTime, data: { turn: 1 } },
      { type: "assistant/message", seq: 1, time: eventTime, data: { message: { content: [
        { type: "reasoning", text: "PRIVATE_CRASH_REASONING" },
        { type: "text", text: "partial" },
      ] } } },
      { type: "turn/end", seq: 2, time: eventTime, data: { turn: 1, reason: { kind: "interrupted" } } },
      { type: "session/end-seed", seq: 3, time: eventTime, data: {} },
    ],
  };
  const state: ConnectorState = {
    version: 3,
    binding: {
      projectId: cfg.projectId,
      sessionId: cfg.sessionId,
      dshSessionId: cfg.dshSessionId,
    },
    serverCursor: 0,
    projectionCursor: 0,
    publishedDshSequence: 0,
    automaticUpload: true,
    activeRequest: {
      requestId: activeRequest.id,
      requestSequence: activeRequest.sequence,
      dshFromSequence: 0,
      promptDigest: createHash("sha256").update(originalPrompt).digest("hex"),
    },
    outbox: [],
  };
  const store = new MemoryConnectorStateStore(state);
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.nextAnswer = "recovered final";
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });

  await connector.start({ schedule: false });
  assert.equal(persistence.prompts.length, 2);
  assert.match(persistence.prompts[1] ?? "", /^Continue the interrupted GatherThread request/);
  assert.doesNotMatch(persistence.prompts[1] ?? "", /shared before crash|Do the work/);
  assert.equal((api.completions[0]?.payload as { text: string }).text, "recovered final");
  assert.doesNotMatch(JSON.stringify(api.completions), /PRIVATE_CRASH_REASONING|partial/);
  assert.equal((await store.load())?.activeRequest, undefined);
  await connector.stop();
});

test("terminal claim conflict advances safely without driving DSH", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(request(1));
  api.claimConflictCode = "agent_request_already_completed";
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false });
  assert.equal(persistence.prompts.length, 0);
  assert.equal((await store.load())?.serverCursor, 1);
  await connector.stop();
});

test("a request the server has given up on advances without driving DSH", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.events.push(request(1));
  api.claimConflictCode = "agent_request_failed";
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false });
  assert.equal(persistence.prompts.length, 0, "an abandoned request must not be re-driven locally");
  assert.equal(
    (await store.load())?.serverCursor,
    1,
    "a terminal failure must advance the cursor instead of being retried on every poll",
  );
  await connector.stop();
});

test("concurrent polling coalesces, and unload removes timer/listeners/write owner", async () => {
  const cfg = config();
  const api = new FakeApi();
  let releaseRead: (() => void) | undefined;
  api.readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ runImmediately: false, schedule: false });
  const first = connector.pollOnce();
  const second = connector.pollOnce();
  assert.equal(first, second);
  releaseRead?.();
  await first;
  assert.equal(api.readCount, 1);
  await connector.stop();
  assert.equal(host.listenerCount(), 0);
  assert.equal(host.disposeCount, 1);

  const readsAfterStop = api.readCount;
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(api.readCount, readsAfterStop);
});

test("manual upload waits for an in-flight poll before mutating the local outbox", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  let releaseRead: (() => void) | undefined;
  api.readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ runImmediately: false, schedule: false });
  await connector.setLocalAutoUpload(false);
  host.emitLocalTurn("MANUAL_DURING_POLL", "SERIALIZED_RESPONSE");

  const poll = connector.pollOnce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const upload = connector.uploadLocalTurns();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.localTurns.length, 0, "manual upload must not race an active poll");

  releaseRead?.();
  await poll;
  const result = await upload;
  assert.equal(result.uploadedLocalTurns, 1);
  assert.equal(api.localTurns.length, 1);
  await connector.stop();
});

test("scheduled polling stops across unload and a clean HMR-style reload owns one fresh listener set", async () => {
  const cfg = config();
  const api = new FakeApi();
  const persistence = freshPersistence();
  const store = new MemoryConnectorStateStore();
  const firstHost = new FakeHost(cfg.dshSessionId, persistence);
  const first = new DshHostConnector({ config: cfg, api, host: firstHost, stateStore: store });
  await first.start({ runImmediately: false, schedule: true });
  await new Promise<void>((resolve) => setTimeout(resolve, 70));
  assert.ok(api.readCount >= 1);
  await first.stop();
  const readsAtUnload = api.readCount;
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(api.readCount, readsAtUnload, "unloaded timer must not poll again");
  assert.equal(firstHost.listenerCount(), 0);
  assert.equal(firstHost.disposeCount, 1);

  const secondHost = new FakeHost(cfg.dshSessionId, persistence);
  const second = new DshHostConnector({ config: cfg, api, host: secondHost, stateStore: store });
  await second.start({ runImmediately: false, schedule: false });
  assert.equal(secondHost.listenerCount(), 2);
  assert.equal(api.registrations.length, 2);
  assert.equal(api.registrations[0]?.localSessionId, api.registrations[1]?.localSessionId);
  await second.stop();
  assert.equal(secondHost.listenerCount(), 0);
});

test("runtime heartbeat is independent of polling, retries transport failure, and stops on unload", async () => {
  const cfg = config({ pollIntervalMs: 60_000 });
  const api = new FakeApi();
  api.failNextHeartbeat = true;
  const errors: Error[] = [];
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
    heartbeatIntervalMs: 5,
    onBackgroundError: (error) => errors.push(error),
  });

  await connector.start({ runImmediately: false, schedule: true });
  await waitFor(() => api.heartbeatCount >= 2);
  assert.equal(api.readCount, 0, "heartbeat must not depend on the canonical-event poll interval");
  assert.match(errors[0]?.message ?? "", /simulated heartbeat transport failure/);
  await connector.stop();
  const heartbeatsAtUnload = api.heartbeatCount;
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(api.heartbeatCount, heartbeatsAtUnload);
  assert.equal(host.listenerCount(), 0);
  assert.equal(host.disposeCount, 1);
});

test("runtime heartbeat starts before a blocked initial DSH prompt completes", async () => {
  const cfg = config({ pollIntervalMs: 60_000 });
  const api = new FakeApi();
  api.events.push(request(1));
  const persistence = freshPersistence();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  let releasePrompt: (() => void) | undefined;
  host.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
    heartbeatIntervalMs: 5,
  });

  const start = connector.start({ schedule: true });
  await waitFor(() => persistence.prompts.length === 1);
  await waitFor(() => api.heartbeatCount >= 1);
  assert.equal(api.readCount, 1);
  releasePrompt?.();
  await start;
  await connector.stop();
});

test("runtime identity drift during heartbeat fails closed without changing durable state", async () => {
  const cfg = config({ pollIntervalMs: 60_000 });
  const api = new FakeApi();
  const errors: Error[] = [];
  const store = new MemoryConnectorStateStore();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: store,
    heartbeatIntervalMs: 5,
    onBackgroundError: (error) => errors.push(error),
  });

  await connector.start({ runImmediately: false, schedule: true });
  const before = await store.load();
  api.forcedHeartbeatRuntimeId = "runtime-changed";
  await waitFor(() => host.disposeCount === 1);
  assert.match(errors[0]?.message ?? "", /changed the DSH runtime identity/);
  await assert.rejects(connector.pollOnce(), /not running/);
  assert.deepEqual(await store.load(), before);
  assert.equal(host.listenerCount(), 0);
  await connector.stop();
});

test("runtime identity drift interrupts a blocked initial prompt and rejects start without publishing", async () => {
  const cfg = config({ pollIntervalMs: 60_000 });
  const api = new FakeApi();
  api.events.push(request(1));
  const persistence = freshPersistence();
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.promptGate = new Promise<void>(() => undefined);
  const store = new MemoryConnectorStateStore();
  const errors: Error[] = [];
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: store,
    heartbeatIntervalMs: 5,
    onBackgroundError: (error) => errors.push(error),
  });

  const start = connector.start({ schedule: true });
  await waitFor(() => persistence.prompts.length === 1);
  const duringPrompt = await store.load();
  assert.equal(duringPrompt?.serverCursor, 0);
  assert.deepEqual(duringPrompt?.outbox, []);
  assert.equal(duringPrompt?.activeRequest?.dshToSequence, undefined);

  api.forcedHeartbeatRuntimeId = "runtime-changed";
  await assert.rejects(
    bounded(start, 500),
    /changed the DSH runtime identity/,
  );
  assert.match(errors[0]?.message ?? "", /changed the DSH runtime identity/);
  assert.equal(host.disposeCount, 1);
  assert.equal(host.listenerCount(), 0);
  assert.equal(api.progress.length, 0);
  assert.equal(api.appended.length, 0);
  assert.equal(api.completions.length, 0);
  const after = await store.load();
  assert.equal(after?.serverCursor, 0);
  assert.equal(after?.publishedDshSequence, 0);
  assert.deepEqual(after?.outbox, []);
  assert.equal(after?.activeRequest?.dshToSequence, undefined);
  await bounded(connector.stop(), 500);
});

test("ambiguous state/session identity and viewer access fail closed", async () => {
  const cfg = config();
  const api = new FakeApi();
  const persistence: FakeDshPersistence = { exists: true, events: [], prompts: [] };
  const missingState = new DshHostConnector({
    config: cfg,
    api,
    host: new FakeHost(cfg.dshSessionId, persistence),
    stateStore: new MemoryConnectorStateStore(),
  });
  await assert.rejects(
    missingState.start({ schedule: false }),
    /exists without connector state/,
  );

  const viewerApi = new FakeApi();
  viewerApi.sessions[0] = { ...viewerApi.sessions[0]!, role: "viewer" };
  const viewerHost = new FakeHost(cfg.dshSessionId, freshPersistence());
  const viewer = new DshHostConnector({
    config: cfg,
    api: viewerApi,
    host: viewerHost,
    stateStore: new MemoryConnectorStateStore(),
  });
  await assert.rejects(viewer.start({ schedule: false }), /not writable by the current actor/);
  assert.equal(viewerHost.disposeCount, 1);

  const staleState: ConnectorState = {
    version: 3,
    binding: {
      projectId: cfg.projectId,
      sessionId: cfg.sessionId,
      dshSessionId: cfg.dshSessionId,
    },
    serverCursor: 5,
    projectionCursor: 5,
    publishedDshSequence: 0,
    automaticUpload: true,
    outbox: [],
  };
  const rewoundHost = new FakeHost(cfg.dshSessionId, freshPersistence());
  const rewound = new DshHostConnector({
    config: cfg,
    api: new FakeApi(),
    host: rewoundHost,
    stateStore: new MemoryConnectorStateStore(staleState),
  });
  await assert.rejects(rewound.start({ schedule: false }), /head precedes the persisted DSH cursor/);
  assert.equal(rewoundHost.openCount, 0);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for connector condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function bounded<T>(value: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("connector operation exceeded its time bound")), milliseconds).unref?.();
    }),
  ]);
}
