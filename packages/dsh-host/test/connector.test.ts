import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRequestClaim,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CompleteAgentRequestInput,
  ReadEventsResult,
  SessionSummary,
  HistoryContext,
} from "@gatherthread/bridge";
import { CollaborationHttpError, HarnessExecutionUnconfirmedError, HarnessExecutionTerminatedError, SharedStoppedReceiptOutbox } from "@gatherthread/bridge";
import { buildDshCanonicalPrompt } from "../src/canonical-prompt.js";
import { parseDshHostConfig, type EnabledDshHostConfig } from "../src/config.js";
import { DshHostConnector } from "../src/connector.js";
import { createDshHostFacade } from "../src/dsh-compat.js";
import { MemoryConnectorStateStore } from "../src/state-store.js";
import type {
  ConnectorState,
  DshAgentStatus,
  DshContextExecutionInput,
  DshAppendEventInput,
  DshCanonicalEvent,
  DshCanonicalProjection,
  DshCollaborationApi,
  DshHostFacade,
  DshPromptResult,
  DshRegisteredRuntime,
  DshRuntimeRegistration,
  DshSessionEventRecord,
  DshLiveOutputEvent,
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

function dynamicRequest(sequence = 2): DshCanonicalEvent {
  return canonical(sequence, "agent_request", {
    content: "Use the selected DeepSeek route",
    execution_profile: {
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      reasoning_effort: "high",
      runtime_id: "runtime-1",
    },
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
  readonly claims = new Map<string, "claimed" | "completed" | "paused">();
  readonly progress: CompleteAgentRequestInput[] = [];
  readonly appended: DshAppendEventInput[] = [];
  readonly completions: CompleteAgentRequestInput[] = [];
  readonly localTurns: CommitLocalTurnInput[] = [];
  readonly idempotent = new Map<string, DshCanonicalEvent>();
  readCount = 0;
  heartbeatCount = 0;
  claimAttempt = 2;
  claimConflictCode: string | undefined;
  failNextKind: "progress" | "append" | "complete" | "local_turn" | undefined;
  failNextHeartbeat = false;
  readGate: Promise<void> | undefined;
  /** Holds heartbeat responses in flight so a refresh can race one. */
  heartbeatGate: Promise<void> | undefined;
  forcedRuntimeId: string | undefined;
  forcedHeartbeatRuntimeId: string | undefined;
  /** Mimic a server that stores and echoes the latest declaration, as the real one does. */
  echoRegistrations = false;
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
    if (this.#runtime === undefined || this.forcedRuntimeId !== undefined || this.echoRegistrations) {
      this.#runtime = {
        ...structuredClone(input),
        id: this.forcedRuntimeId ?? this.#runtime?.id ?? "runtime-1",
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
    // Snapshot before waiting: a real heartbeat reads the stored row when the
    // request is served, so a gated response carries the declaration the server
    // held before any later registration.
    const observed = this.#runtime === undefined ? undefined : structuredClone(this.#runtime);
    await this.heartbeatGate;
    if (observed === undefined || runtimeId !== observed.id) {
      throw new Error("unknown fake runtime");
    }
    return {
      ...observed,
      id: this.forcedHeartbeatRuntimeId ?? observed.id,
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
      return { claimed: status === "claimed", status, requestId, runtimeId, attemptCount: this.claimAttempt };
    }
    this.claims.set(requestId, "claimed");
    return { claimed: true, status: "claimed", requestId, runtimeId, attemptCount: this.claimAttempt };
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
  failNextProjectionFlush = false;
  readonly projected: DshCanonicalProjection[] = [];

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

  readonly promptProfiles: Array<{
    provider: string;
    model: string;
    reasoningEffort?: string;
  } | undefined> = [];

  snapshotFrom(sequence: number): readonly DshSessionEventRecord[] {
    return structuredClone(this.#persistence.events.slice(sequence));
  }

  async prompt(text: string, profile?: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  }): Promise<DshPromptResult> {
    this.#persistence.prompts.push(text);
    this.promptProfiles.push(profile === undefined ? undefined : structuredClone(profile));
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
    const returned = structuredClone(this.#persistence.events.slice(fromSequence));
    if (this.duplicateReturnedEvent) returned.push(structuredClone(additions[1]!));
    return {
      fromSequence,
      toSequence: this.currentSequence(),
      events: returned,
    };
  }

  async projectCanonicalEvents(
    events: readonly DshCanonicalProjection[],
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
    if (this.failNextProjectionFlush) {
      this.failNextProjectionFlush = false;
      throw new Error("simulated native projection flush failure");
    }
    this.flushCount += 1;
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  emitActiveEvent(): void {
    const event = this.event("step/start", { turn: 1, step: 1 });
    this.#persistence.events.push(event);
    for (const listener of this.#eventListeners) listener(event);
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

class LiveHost extends FakeHost {
  readonly liveListeners = new Set<(event: DshLiveOutputEvent) => void>();
  onLiveOutput(listener: (event: DshLiveOutputEvent) => void) {
    this.liveListeners.add(listener);
    return () => { this.liveListeners.delete(listener); };
  }
  emitLive(event: DshLiveOutputEvent) { this.liveListeners.forEach((listener) => listener(event)); }
  emitLiveText(text: string, sourceSessionId = this.sessionId, revision = 1, kind = "text") {
    this.emitLive({ kind: "assistant-stream", sourceSessionId,
      frame: { type: "start", attemptId: `native-attempt-${revision}`, revision: revision * 10, turn: 1, step: 1 } });
    this.emitLive({ kind: "assistant-stream", sourceSessionId,
      frame: { type: "chunk", attemptId: `native-attempt-${revision}`, revision: revision * 10 + 1, index: 0, time: eventTime,
        chunk: { type: "block-start", index: 0, blockType: kind } } });
    this.emitLive({ kind: "assistant-stream", sourceSessionId,
      frame: { type: "chunk", attemptId: `native-attempt-${revision}`, revision: revision * 10 + 2, index: 1, time: eventTime,
        chunk: { type: kind === "reasoning" ? "reasoning-delta" : "text-delta", index: 0, text } } });
  }
}

class ContextApi extends FakeApi {
  contentRevision = 0;
  contextCalls: Array<{ sessionId: string; view: unknown; throughSequence: unknown }> = [];
  contextError: Error | undefined;
  contextView: "summary" | "original" = "summary";
  async readContext(sessionId: string, view?: "summary" | "original", throughSequence?: number): Promise<HistoryContext> {
    this.contextCalls.push({ sessionId, view, throughSequence });
    if (this.contextError) throw this.contextError;
    return { view: this.contextView, content_revision: this.contentRevision, through_sequence: throughSequence!, items: [this.contextView === "summary"
      ? { kind: "summary", event_id: "summary-response", sequence: 1, actor_user_id: "user-2", content: "FROZEN_SUMMARY", source_event_ids: ["source-1", "source-3"] }
      : { kind: "original", event_id: "source-1", sequence: 1, actor_user_id: "user-2", content: "FROZEN_ORIGINAL" }] };
  }
}

test("DSH author deletion isolates an original-history request without any summaries and retires stale local upload", async () => {
  const cfg = config(); const api = new ContextApi();
  api.contentRevision = 1;
  const deleted = canonical(1, "human_chat", {});
  deleted.contentRevision = 1; deleted.deleted = { deletedAt: now, reason: "author" };
  api.events.push(deleted, request(2));
  const originalRead = api.readEvents.bind(api);
  api.readEvents = async (...args) => ({ ...await originalRead(...args), contentRevision: api.contentRevision });
  const persistence = freshPersistence();
  persistence.events.push({ type: "user/message", seq: 0, time: eventTime,
    data: { id: "old-local", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DELETED_SENTINEL" }] } });
  const host = new ContextHost(cfg.dshSessionId, persistence);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  await connector.start({ schedule: false });
  assert.equal(host.prompts.length, 0, "must not execute in the contaminated native Session");
  assert.equal(host.execution.prompts.length, 1);
  assert.equal(host.preparations[0]?.historyContext.content_revision, 1);
  await connector.uploadLocalTurns();
  assert.equal(api.localTurns.length, 0, "retired native input must remain local only even for manual upload");
  await connector.stop();
});

test("DSH author deletion interrupt retains the execution permit until the native prompt actually stops", async () => {
  const cfg = config(), api = new ContextApi();
  api.sessions[0]!.contentRevision = 0;
  const originalRead = api.readEvents.bind(api);
  api.readEvents = async (...args) => ({ ...await originalRead(...args), contentRevision: api.contentRevision });
  api.events.push(summaryRequest(1, "user-2"), request(2));
  const host = new ContextHost(cfg.dshSessionId, freshPersistence());
  let interrupted = false, released = false;
  let started!: () => void, nativeStopped!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const stoppedPromise = new Promise<void>((resolve) => { nativeStopped = resolve; });
  host.prompt = async (_text, _profile, _id, signal?: AbortSignal) => {
    signal?.addEventListener("abort", () => { interrupted = true; }, { once: true });
    started(); await stoppedPromise;
    released = true;
    if (signal?.aborted) throw new HarnessExecutionTerminatedError("dsh_native_execution_cancelled", "Native fixture is idle after cancellation");
    throw new Error("fixture should only terminate from context deletion");
  };
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  const turn = connector.pollOnce();
  const rejected = assert.rejects(turn, /context_changed/);
  await startedPromise;
  api.contentRevision = 1;
  const timeout = Date.now() + 2500;
  while (!interrupted && Date.now() < timeout) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(interrupted, true, "deletion must interrupt without waiting for model progress");
  assert.equal(released, false, "cancellation notification is not proof of actual native termination");
  assert.equal(api.completions.length, 0);
  nativeStopped(); await rejected;
  assert.equal(released, true);
  assert.equal((await store.load())!.activeRequest, undefined);
  assert.equal(api.completions.length, 0); assert.equal(api.appended.length, 0);
  await connector.stop();
});

for (const action of ["stop", "pause", "deadline", "deleted-session"] as const) {
  test(`DSH Team ${action} observes claim authority without progress and waits for native termination`, async () => {
    const cfg = config(), api = new FakeApi(), persistence = freshPersistence();
    const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "run-1" } };
    api.events.push(event);
    const host = new FakeHost(cfg.dshSessionId, persistence);
    let active = true, interrupted = false, nativeExited = false, acknowledgments = 0, effects = 0;
    let started!: () => void, release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const control: DshCollaborationApi = Object.assign(api, {
      async readAgentExecution() {
        if (!active && action === "deleted-session") throw new CollaborationHttpError(404, "session removed");
        return { active };
      },
      async acknowledgeAgentExecutionStopped() {
        assert.equal(nativeExited, true, "never ACK a mere cancellation request"); acknowledgments += 1;
      },
    });
    host.prompt = async (text: string, _selection?: unknown, _execution?: string, signal?: AbortSignal) => {
      persistence.events.push({ type: "user/message", seq: 0, time: eventTime,
        data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } });
      const timer = setInterval(() => { effects += 1; }, 10);
      signal!.addEventListener("abort", () => { interrupted = true; clearInterval(timer); }, { once: true });
      started(); await releasePromise; clearInterval(timer);
      persistence.events.push({ type: "turn/end", seq: 1, time: eventTime, data: { turn: 1, status: "interrupted" } });
      nativeExited = true;
      if (signal!.aborted) throw new HarnessExecutionTerminatedError("dsh_native_execution_cancelled", "Native fixture is idle after cancellation");
      throw new Error("Fixture must be canceled");
    };
    const store = new MemoryConnectorStateStore();
    const connector = new DshHostConnector({ config: cfg, api: control, host, stateStore: store });
    await connector.start({ schedule: false, runImmediately: false });
    const turn = connector.pollOnce();
    const rejected = assert.rejects(turn, /execution was stopped/);
    await startedPromise; active = false;
    const until = Date.now() + 3000;
    while (!interrupted && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(interrupted, true); assert.equal(nativeExited, false); assert.equal(acknowledgments, 0);
    const writes = effects;
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(effects, writes);
    release(); await rejected;
    assert.equal(acknowledgments, 1); assert.equal(api.completions.length, 0);
    assert.equal((await store.load())!.activeRequest, undefined);
    await connector.uploadLocalTurns();
    assert.equal(api.localTurns.length, 0, "canceled native execution is never recaptured as a local user turn");
    await connector.stop();
  });
}

test("DSH retries a lost native exit ACK after restart without another prompt", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence();
  const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "run-1" } };
  api.events.push(event);
  let acknowledgments = 0;
  const control: DshCollaborationApi = Object.assign(api, {
    async readAgentExecution() { return { active: true }; },
    async acknowledgeAgentExecutionStopped() { acknowledgments += 1; if (acknowledgments === 1) throw new Error("fixture ACK lost"); },
  });
  const store = new MemoryConnectorStateStore();
  const first = new DshHostConnector({ config: cfg, api: control, host: new FakeHost(cfg.dshSessionId, persistence), stateStore: store });
  await first.start({ schedule: false, runImmediately: false });
  await assert.rejects(first.pollOnce(), /ACK lost/);
  assert.equal((await store.load())!.stoppedExecutions!.length, 1);
  assert.equal(persistence.prompts.length, 1);
  await first.stop();
  const second = new DshHostConnector({ config: cfg, api: control, host: new FakeHost(cfg.dshSessionId, persistence), stateStore: store });
  await second.start({ schedule: false, runImmediately: false });
  assert.equal(acknowledgments, 2); assert.equal(persistence.prompts.length, 1);
  assert.deepEqual((await store.load())!.stoppedExecutions, []);
  assert.equal(api.completions.length, 1);
  await second.stop();
});

async function stoppedDshRestartFixture() {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(), store = new MemoryConnectorStateStore();
  const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "pre-start-cleanup" } }; api.events.push(event);
  const receipts: unknown[][] = [], accepted = new Set<string>(), order: string[] = [];
  let beforeReply: (() => Promise<void>) | undefined;
  const control: DshCollaborationApi = Object.assign(api, { async readAgentExecution() { return { active: true }; },
    async acknowledgeAgentExecutionStopped(...receipt: [string, string, string, number]) {
      order.push("stop-ack"); receipts.push(receipt); accepted.add(JSON.stringify(receipt));
      if (receipts.length === 1) throw Error("the accepted stop ACK was lost");
      await beforeReply?.();
    } });
  const first = new DshHostConnector({ config: cfg, api: control, host: new FakeHost(cfg.dshSessionId, persistence), stateStore: store });
  await first.start({ schedule: false, runImmediately: false }); await assert.rejects(first.pollOnce(), /stop ACK was lost/u); await first.stop();
  const stored = (await store.load())!; assert.equal(stored.stoppedExecutions?.length, 1); order.length = 0;
  return { cfg, api, control, persistence, store, receipts, accepted, order, stored,
    beforeReply(callback: () => Promise<void>) { beforeReply = callback; } };
}

for (const blocker of ["session deleted", "permission revoked", "Host unavailable", "registration conflict"] as const) {
  test(`DSH replays an exact confirmed stop receipt before ${blocker} can prevent restart`, async () => {
    const f = await stoppedDshRestartFixture(), host = new FakeHost(f.cfg.dshSessionId, f.persistence);
    const before = structuredClone(f.stored);
    const list = f.api.listProjectSessions.bind(f.api), opening = host.open.bind(host), registering = f.api.registerRuntime.bind(f.api);
    f.api.listProjectSessions = async () => { f.order.push("session-read");
      if (blocker === "session deleted") throw new CollaborationHttpError(404, "session deleted", "not_found");
      if (blocker === "permission revoked") throw new CollaborationHttpError(403, "permission revoked", "forbidden");
      return list(); };
    host.open = async () => { f.order.push("host-open"); if (blocker === "Host unavailable") throw Error("Host unavailable"); return opening(); };
    f.api.registerRuntime = async input => { f.order.push("runtime-register");
      if (blocker === "registration conflict") throw new CollaborationHttpError(409, "registration conflict", "agent_team_native_exit_pending"); return registering(input); };
    const second = new DshHostConnector({ config: f.cfg, api: f.control, host, stateStore: f.store });
    await assert.rejects(second.start({ schedule: false, runImmediately: false }), new RegExp(blocker));
    assert.equal(f.order[0], "stop-ack", "private confirmed cleanup precedes history, native Host acquisition and runtime registration");
    assert.equal(f.receipts.length, 2); assert.deepEqual(f.receipts[1], f.receipts[0]); assert.equal(f.accepted.size, 1, "an ACK lost after acceptance repeats the same exact identity");
    assert.equal(f.persistence.prompts.length, 1, "cleanup never starts or resumes a native model turn");
    assert.deepEqual(await f.store.load(), { ...before, stoppedExecutions: [] }, "only the acknowledged receipt changes even when normal startup fails");
    const third = new DshHostConnector({ config: f.cfg, api: f.control, host: new FakeHost(f.cfg.dshSessionId, f.persistence), stateStore: f.store });
    // Stop before normal startup can proceed; a cleared receipt is not replayed again.
    f.api.listProjectSessions = async () => { throw Error("restart remains blocked"); };
    await assert.rejects(third.start({ schedule: false, runImmediately: false }), /restart remains blocked/u);
    assert.equal(f.receipts.length, 2); await second.stop(); await third.stop();
  });
}

test("DSH early cleanup removes only the exact receipt from freshly loaded state", async () => {
  const f = await stoppedDshRestartFixture(); let latest: ConnectorState | undefined;
  f.beforeReply(async () => { latest = { ...(await f.store.load())!, automaticUpload: false, contentRevision: 2, localOnlySessionIds: ["retired-local-session"] }; await f.store.save(latest); });
  f.api.listProjectSessions = async () => { throw new CollaborationHttpError(404, "session deleted", "not_found"); };
  const second = new DshHostConnector({ config: f.cfg, api: f.control, host: new FakeHost(f.cfg.dshSessionId, f.persistence), stateStore: f.store });
  await assert.rejects(second.start({ schedule: false, runImmediately: false }), /session deleted/u);
  assert.equal(f.receipts.length, 2); assert.deepEqual(await f.store.load(), { ...latest, stoppedExecutions: [] }); await second.stop();
});

for (const field of ["projectId", "sessionId", "dshSessionId"] as const) {
  test(`DSH refuses a mismatched stored ${field} before replaying stop metadata or accessing the Host`, async () => {
    const f = await stoppedDshRestartFixture(), foreign = { ...f.stored, binding: { ...f.stored.binding, [field]: "another-binding" } };
    await f.store.save(foreign); const host = new FakeHost(f.cfg.dshSessionId, f.persistence);
    f.api.listProjectSessions = async () => { assert.fail("a mismatched local binding cannot access cloud history"); };
    const second = new DshHostConnector({ config: f.cfg, api: f.control, host, stateStore: f.store });
    await assert.rejects(second.start({ schedule: false, runImmediately: false }), /different binding/u);
    assert.equal(f.receipts.length, 1); assert.equal(host.openCount, 0); assert.deepEqual(await f.store.load(), foreign); await second.stop();
  });
}

test("DSH cannot turn an unconfirmed active request into an early stop acknowledgment", async () => {
  const f = await stoppedDshRestartFixture(), pending = { ...f.stored, stoppedExecutions: [] };
  assert.ok(pending.activeRequest); await f.store.save(pending);
  f.api.listProjectSessions = async () => { throw new CollaborationHttpError(404, "session deleted", "not_found"); };
  const host = new FakeHost(f.cfg.dshSessionId, f.persistence), second = new DshHostConnector({ config: f.cfg, api: f.control, host, stateStore: f.store });
  await assert.rejects(second.start({ schedule: false, runImmediately: false }), /session deleted/u);
  assert.equal(f.receipts.length, 1); assert.equal(host.openCount, 0); assert.deepEqual(await f.store.load(), pending); await second.stop();
});

test("DSH early shared cleanup survives a deleted source, lost ACK and unavailable session without opening the Host", {
  skip: process.platform === "win32" ? "Private native sharing cleanup is unsupported on Windows" : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gt-dsh-shared-startup-"));
  try {
    const cfg = config({ statePath: path.join(directory, "dsh.json") }), api = new FakeApi(), store = new MemoryConnectorStateStore();
    const receipt = { version: 1 as const, jobId: "deleted-source-shared-job", claimAttempt: 3, sourceRuntimeId: "deleted-source-runtime",
      projectId: cfg.projectId, ownerDeviceId: cfg.deviceId };
    const outbox = new SharedStoppedReceiptOutbox(path.join(directory, "shared-control", receipt.sourceRuntimeId)); await outbox.put(receipt);
    const order: string[] = [], acknowledgments: unknown[][] = [], accepted = new Set<string>();
    const control = Object.assign(api, { agentSharingApi: () => ({ async abortAck(jobId: string, input: unknown) {
      order.push("shared-stop-ack"); acknowledgments.push([jobId, structuredClone(input)]); accepted.add(JSON.stringify([jobId, input]));
      if (acknowledgments.length === 1) throw Error("shared stop ACK lost after acceptance");
      return { job: { id: receipt.jobId, project_id: cfg.projectId, share_id: "deleted-share", share_revision: 1,
        session_id: cfg.sessionId, request_event_id: "deleted-source-request", status: "cancelled", requester_user_id: "borrower", requester_display_name: "Borrower",
        execution_profile: { harness: "deepseek-harness", provider: cfg.provider, model: cfg.model }, created_at: now,
        deadline_at: null, finished_at: now, error_code: "owner_offline", cleanup_pending: false }, replayed: true };
    } }) }) as unknown as DshCollaborationApi;
    api.listProjectSessions = async () => { order.push("session-read"); throw new CollaborationHttpError(404, "session deleted", "not_found"); };
    const firstHost = new FakeHost(cfg.dshSessionId, freshPersistence()), first = new DshHostConnector({ config: cfg, api: control, host: firstHost, stateStore: store });
    await assert.rejects(first.start({ schedule: false, runImmediately: false }), /shared stop ACK lost/u);
    assert.deepEqual(await outbox.list(receipt), [receipt]); assert.equal(firstHost.openCount, 0); assert.deepEqual(order, ["shared-stop-ack"]);
    const secondHost = new FakeHost(cfg.dshSessionId, freshPersistence()), second = new DshHostConnector({ config: cfg, api: control, host: secondHost, stateStore: store });
    await assert.rejects(second.start({ schedule: false, runImmediately: false }), /session deleted/u);
    assert.deepEqual(order, ["shared-stop-ack", "shared-stop-ack", "session-read"]);
    assert.deepEqual(acknowledgments[1], acknowledgments[0]); assert.equal(accepted.size, 1); assert.deepEqual(await outbox.list(receipt), []);
    assert.equal(secondHost.openCount, 0); assert.equal(api.registrations.length, 0); assert.equal(await store.load(), undefined);
    await first.stop(); await second.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("DSH refuses an indeterminate native writer without acknowledging that writer as stopped", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(), store = new MemoryConnectorStateStore();
  const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "run-1" } };
  api.events.push(event);
  let acknowledgments = 0;
  const control: DshCollaborationApi = Object.assign(api, {
    async readAgentExecution() { return { active: true }; },
    async acknowledgeAgentExecutionStopped() { acknowledgments += 1; },
  });
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.prompt = async () => { throw new HarnessExecutionUnconfirmedError("Native DSH Agent still owns an active prompt"); };
  const connector = new DshHostConnector({ config: cfg, api: control, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  await assert.rejects(connector.pollOnce(), HarnessExecutionUnconfirmedError);
  assert.equal(acknowledgments, 0, "a refused duplicate is not native exit evidence");
  assert.equal((await store.load())!.stoppedExecutions, undefined);
  assert.ok((await store.load())!.activeRequest, "retain the exact request's native publication fence");
  await connector.stop();
});

test("a DSH abort during Host preparation supplies no physical native-exit acknowledgment", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(), store = new MemoryConnectorStateStore();
  const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "run-1" } };
  api.events.push(event);
  let active = true, acknowledgments = 0, prepared!: () => void;
  const preparing = new Promise<void>((resolve) => { prepared = resolve; });
  const control: DshCollaborationApi = Object.assign(api, {
    async readAgentExecution() { return { active }; },
    async acknowledgeAgentExecutionStopped() { acknowledgments += 1; },
  });
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.prompt = async (_text: string, _selection?: unknown, _execution?: string, signal?: AbortSignal) => {
    prepared();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    throw new Error("unreachable");
  };
  const connector = new DshHostConnector({ config: cfg, api: control, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  const turn = connector.pollOnce(), rejected = assert.rejects(turn, /execution was stopped/);
  await preparing; active = false; await rejected;
  assert.equal(acknowledgments, 0, "an early AbortError cannot certify that an earlier native owner became idle");
  assert.equal((await store.load())!.stoppedExecutions, undefined);
  assert.ok((await store.load())!.activeRequest);
  await connector.stop();
});

for (const lostAck of [false, true]) {
  test(`the real DSH facade preserves native-idle evidence across a flush failure${lostAck ? " and a lost stop ACK" : ""}`, async () => {
    const cfg = config(), api = new FakeApi(), store = new MemoryConnectorStateStore();
    const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "real-facade-run" } }; api.events.push(event);
    const events: DshSessionEventRecord[] = [], listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let exists = false, prompts = 0, nativeIdle = false, failFlush = true, acknowledgments = 0;
    const emit = (name: string, ...args: unknown[]) => { for (const listener of listeners.get(name) ?? []) listener(...args); };
    const session = { id: cfg.dshSessionId, header: { version: 2, cwd: cfg.workspacePath }, get seq() { return events.length; },
      snapshotEvents(from = 0) { return events.slice(from); },
      append(type: string, data: unknown) { const added = { type, seq: events.length, time: eventTime, data }; events.push(added); emit("session/event", session, added); return added; } };
    const agent = { id: cfg.dshSessionId, ctx: {}, session, status: "idle",
      followup(message: unknown) { prompts++; nativeIdle = false; this.status = "running"; session.append("user/message", message); session.append("turn/start", { turn: prompts }); },
      async whenIdle() { session.append("assistant/message", { message: { content: [{ type: "text", text: "A bounded public answer" }] } });
        session.append("turn/end", { turn: prompts, reason: { kind: "completed" } }); this.status = "idle"; nativeIdle = true; },
      cancel() {},
    };
    const handle = { agent, async dispose() {} }, services = {
      agents: { async create() { exists = true; return handle; }, async resume() { return handle; } },
      sessionPersistence: { async stat() { return exists ? { header: { id: cfg.dshSessionId } } : undefined; } },
      sessions: { async flush() { if (nativeIdle && failFlush) { failFlush = false; throw Error("PRIVATE_REAL_FACADE_FLUSH_EXCEPTION"); } } },
      llm: { async resolveModelInfo(provider: string, model: string) { return { provider, id: model }; } },
    };
    const context = { get(name: string) { return services[name as keyof typeof services]; },
      on(name: string, listener: (...args: unknown[]) => void) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener); },
      effect() { return () => undefined; } };
    const newHost = () => createDshHostFacade({ context, sessionId: cfg.dshSessionId, workspacePath: cfg.workspacePath, provider: cfg.provider, model: cfg.model,
      messageFactory: text => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }),
      moduleImporter: async () => ({ freezeMessage: (message: unknown) => structuredClone(message) }), modelSelectionInstaller: () => () => {},
    });
    const control: DshCollaborationApi = Object.assign(api, { async readAgentExecution() { return { active: true }; },
      async acknowledgeAgentExecutionStopped() { assert.equal(nativeIdle, true); assert.equal(agent.status, "idle"); acknowledgments++;
        if (lostAck && acknowledgments === 1) throw Error("fixture stop ACK lost"); } });
    const first = new DshHostConnector({ config: cfg, api: control, host: newHost(), stateStore: store });
    await first.start({ schedule: false, runImmediately: false });
    await assert.rejects(first.pollOnce(), error => {
      if (lostAck) assert.match((error as Error).message, /stop ACK lost/u);
      else { assert.ok(error instanceof HarnessExecutionTerminatedError); assert.doesNotMatch(error.message, /PRIVATE_REAL_FACADE/u); }
      return true;
    });
    assert.equal(prompts, 1); assert.equal(acknowledgments, 1, "the real facade's idle proof must reach connector's ACK path despite failed postprocessing");
    assert.equal((await store.load())!.stoppedExecutions?.length, lostAck ? 1 : 0);
    await first.stop();
    const second = new DshHostConnector({ config: cfg, api: control, host: newHost(), stateStore: store });
    await second.start({ schedule: false, runImmediately: false });
    assert.equal(prompts, 1, "recovery must use the existing durable completed turn rather than rerun the model");
    assert.equal(acknowledgments, lostAck ? 2 : 1); assert.deepEqual((await store.load())!.stoppedExecutions, []);
    assert.equal(api.completions.length, 1); await second.stop();
  });
}

test("DSH Team preparation failure does not acknowledge a possibly older native owner", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(), store = new MemoryConnectorStateStore();
  const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: "run-1" } };
  api.events.push(event);
  const host = new FakeHost(cfg.dshSessionId, persistence), sequence = host.currentSequence.bind(host), claim = api.claimAgentRequest.bind(api);
  let failPreparation = false, acknowledgments = 0;
  api.claimAgentRequest = async (...args) => { const result = await claim(...args); failPreparation = true; return result; };
  host.currentSequence = () => { if (failPreparation) { failPreparation = false; throw new Error("Team native preparation failed"); } return sequence(); };
  const control: DshCollaborationApi = Object.assign(api, {
    async readAgentExecution() { return { active: true }; },
    async acknowledgeAgentExecutionStopped() { acknowledgments += 1; },
  });
  const connector = new DshHostConnector({ config: cfg, api: control, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  await assert.rejects(connector.pollOnce(), /native preparation failed/);
  assert.equal(acknowledgments, 0); assert.equal(persistence.prompts.length, 0); assert.equal((await store.load())!.stoppedExecutions, undefined);
  api.claimAgentRequest = claim;
  await connector.pollOnce();
  assert.equal(persistence.prompts.length, 1); assert.equal(acknowledgments, 1); assert.equal(api.completions.length, 1);
  await connector.stop();
});

test("ordinary DSH preparation failure on an older server never strands unsupported exit receipts", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(), store = new MemoryConnectorStateStore();
  api.events.push(request(1));
  const host = new FakeHost(cfg.dshSessionId, persistence);
  const originalSequence = host.currentSequence.bind(host), originalClaim = api.claimAgentRequest.bind(api);
  let failPreparation = false, acknowledgments = 0;
  api.claimAgentRequest = async (...args) => { const claim = await originalClaim(...args); failPreparation = true; return claim; };
  host.currentSequence = () => {
    if (failPreparation) { failPreparation = false; throw new Error("legacy native preparation failed"); }
    return originalSequence();
  };
  const control: DshCollaborationApi = Object.assign(api, {
    async readAgentExecution() { throw new CollaborationHttpError(404, "legacy endpoint absent"); },
    async acknowledgeAgentExecutionStopped() { acknowledgments += 1; throw new CollaborationHttpError(404, "legacy endpoint absent"); },
  });
  const first = new DshHostConnector({ config: cfg, api: control, host, stateStore: store });
  await first.start({ schedule: false, runImmediately: false });
  await assert.rejects(first.pollOnce(), /legacy native preparation failed/);
  assert.equal(acknowledgments, 0); assert.equal((await store.load())!.stoppedExecutions, undefined);
  await first.stop();
  api.claimAgentRequest = originalClaim;
  const second = new DshHostConnector({ config: cfg, api: control, host: new FakeHost(cfg.dshSessionId, persistence), stateStore: store });
  await second.start({ schedule: false });
  assert.equal(api.completions.length, 1); assert.equal(persistence.prompts.length, 1);
  assert.equal(acknowledgments, 0); assert.equal((await store.load())!.stoppedExecutions, undefined);
  await second.stop();
});

class ContextHost extends FakeHost {
  readonly execution: FakeHost;
  readonly executionPersistence: FakeDshPersistence;
  readonly executionId = `gatherthread-execution-${"a".repeat(32)}`;
  readonly preparations: DshContextExecutionInput[] = [];
  constructor(id: string, persistence: FakeDshPersistence, executionPersistence = freshPersistence()) {
    super(id, persistence);
    this.executionPersistence = executionPersistence;
    this.execution = new FakeHost(this.executionId, executionPersistence);
  }
  async prepareContextExecution(input: DshContextExecutionInput) {
    this.preparations.push(structuredClone(input));
    if (!input.resume) this.executionPersistence.events.push({ type: "user/message", seq: this.execution.currentSequence(), time: eventTime,
      data: { id: `context-${input.requestId}`, source: { kind: "plugin", plugin: "gatherthread" }, content: [{ type: "text", text: JSON.stringify(input.historyContext) }] } });
    return { sessionId: this.executionId, fromSequence: this.execution.currentSequence() };
  }
  override currentSequence(executionId?: string) { return executionId ? this.execution.currentSequence() : super.currentSequence(); }
  override snapshotFrom(sequence: number, executionId?: string) { return executionId ? this.execution.snapshotFrom(sequence) : super.snapshotFrom(sequence); }
  override prompt(text: string, profile?: { provider: string; model: string; reasoningEffort?: string }, executionId?: string) {
    return executionId ? this.execution.prompt(text, profile) : super.prompt(text, profile);
  }
  override onSessionEvent(listener: (event: DshSessionEventRecord) => void) {
    const disposers = [super.onSessionEvent((event) => listener({ ...event, sourceSessionId: this.sessionId })),
      this.execution.onSessionEvent((event) => listener({ ...event, sourceSessionId: this.executionId }))];
    return () => disposers.forEach((dispose) => dispose());
  }
  override onStatus(listener: (status: DshAgentStatus, sourceSessionId?: string) => void) {
    const disposers = [super.onStatus((status) => listener(status, this.sessionId)),
      this.execution.onStatus((status) => listener(status, this.executionId))];
    return () => disposers.forEach((dispose) => dispose());
  }
  override async dispose() { await this.execution.dispose(); await super.dispose(); }
}

function summaryRequest(sequence: number, actorId = "user-1"): DshCanonicalEvent {
  const event = request(sequence);
  return { ...event, actorId, payload: { ...event.payload as object, content: "Summarize selected JSON: SELECTED_SOURCE_ONLY",
    history_summary: { version: 1, source_event_ids: ["source-1"], source_digest: "a".repeat(64) } } };
}

test("DSH ordinary sessions retain native context and do not require the new server context API", async () => {
  const cfg = config(); const api = new ContextApi();
  api.contextError = Object.assign(new Error("old server has no context route"), { status: 404 });
  api.events.push(canonical(1, "human_chat", { content: "ordinary history" }), request(2));
  const host = new ContextHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  await connector.start({ schedule: false });
  assert.equal(host.prompts.length, 1);
  assert.equal(host.execution.prompts.length, 0);
  assert.equal(host.preparations.length, 0);
  assert.equal(api.contextCalls.length, 0);
  await connector.stop();
});

test("DSH summary-aware requests freeze policy, preserve native upload cursor, and passively show only public results", async () => {
  const cfg = config({ executionProfiles: [
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
    { provider: "deepseek-official", model: "deepseek-reasoner", reasoningEfforts: ["high"] },
  ] }); const api = new ContextApi(); const store = new MemoryConnectorStateStore();
  api.events.push(summaryRequest(1, "user-2"), dynamicRequest(2));
  const host = new ContextHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false });
  assert.deepEqual(api.contextCalls, [{ sessionId: "session-1", view: undefined, throughSequence: 1 }]);
  assert.equal(host.preparations[0]?.historyContext.items[0]?.content, "FROZEN_SUMMARY");
  assert.deepEqual(host.execution.promptProfiles[0], { provider: "deepseek-official", model: "deepseek-reasoner", reasoningEffort: "high" });
  assert.equal(host.prompts.length, 0);
  assert.equal((await store.load())?.publishedDshSequence, 0, "auxiliary sequence never skips native local turns");
  assert.equal((await store.load())?.activeRequest, undefined, "full context is removed when delivery is durable");
  assert.doesNotMatch(JSON.stringify([api.progress, api.appended, api.completions]), /FROZEN_SUMMARY|source_event_ids|gatherthread-execution-/);
  assert.equal((api.completions[0]?.payload as any).context_execution, "isolated");
  await connector.pollOnce(); // completed claim passively materializes the normal request
  await connector.pollOnce(); // then its isolated answer is projected to the original Session
  assert.equal(host.execution.prompts.length, 1);
  assert.deepEqual(host.projected.map((event) => event.role), ["user", "assistant"]);
  assert.doesNotMatch(JSON.stringify(host.projected), /SELECTED_SOURCE_ONLY/);
  host.emitLocalTurn("NATIVE_AFTER_ISOLATED", "native response");
  await connector.pollOnce();
  assert.equal(api.localTurns.length, 1);
  assert.match(JSON.stringify(api.localTurns), /NATIVE_AFTER_ISOLATED/);
  api.contextView = "original";
  api.events.push(dynamicRequest((api.events.at(-1)?.sequence ?? 0) + 1));
  await connector.pollOnce();
  assert.equal(host.preparations.at(-1)?.historyContext.view, "original");
  assert.equal(host.preparations.at(-1)?.historyContext.items[0]?.content, "FROZEN_ORIGINAL");
  assert.equal(host.prompts.length, 0);
  await connector.stop();
});

test("DSH selected-only summary requests never read full context or project their selected originals", async () => {
  const cfg = config(); const api = new ContextApi();
  api.events.push(canonical(1, "human_chat", { content: "UNSELECTED_HISTORY" }, "user-2"), summaryRequest(2));
  api.contextError = new Error("must not read unrelated history");
  const host = new ContextHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  await connector.start({ schedule: false });
  assert.equal(host.preparations[0]?.selectedOnly, true);
  assert.deepEqual(host.preparations[0]?.historyContext.items, []);
  assert.equal(api.contextCalls.length, 0);
  assert.match(host.execution.prompts[0]!, /SELECTED_SOURCE_ONLY/);
  assert.doesNotMatch(host.execution.prompts[0]!, /UNSELECTED_HISTORY/);
  await connector.pollOnce(); await connector.pollOnce();
  assert.doesNotMatch(JSON.stringify(host.projected), /SELECTED_SOURCE_ONLY/);
  assert.match(JSON.stringify(host.projected), /public final/);
  await connector.stop();
});

test("DSH marked sessions fail closed when context is unavailable and never fall back to a native paid run", async () => {
  for (const unavailable of ["missing-api", "server-error", "missing-host"] as const) {
    const cfg = config(); const api = unavailable === "missing-api" ? new FakeApi() : new ContextApi();
    if (api instanceof ContextApi && unavailable === "server-error") api.contextError = Object.assign(new Error("context unsupported"), { status: 404 });
    api.events.push(summaryRequest(1, "user-2"), request(2));
    const host = unavailable === "missing-host" ? new FakeHost(cfg.dshSessionId, freshPersistence()) : new ContextHost(cfg.dshSessionId, freshPersistence());
    const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
    await connector.start({ schedule: false, runImmediately: false });
    await assert.rejects(connector.pollOnce(), /context.*unavailable|context unsupported/);
    assert.equal(host.prompts.length, 0);
    if (host instanceof ContextHost) assert.equal(host.execution.prompts.length, 0);
    await connector.stop();
  }
});

test("DSH isolated lost acknowledgement retains one bounded frozen context and replays only the receipt after restart", async () => {
  const cfg = config(); const api = new ContextApi(); const store = new MemoryConnectorStateStore();
  const native = freshPersistence(); const execution = freshPersistence();
  api.events.push(summaryRequest(1, "user-2"), request(2));
  api.failNextKind = "complete";
  const host = new ContextHost(cfg.dshSessionId, native, execution);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  await assert.rejects(connector.pollOnce(), /offline transport/);
  const saved = (await store.load())!;
  assert.equal(saved.activeRequest?.contextExecution?.historyContext.items[0]?.content, "FROZEN_SUMMARY");
  assert.equal(saved.publishedDshSequence, 0);
  assert.doesNotMatch(JSON.stringify(saved.outbox), /FROZEN_SUMMARY/);
  await connector.stop();
  api.contextView = "original";
  const resumedHost = new ContextHost(cfg.dshSessionId, native, execution);
  const resumed = new DshHostConnector({ config: cfg, api, host: resumedHost, stateStore: store });
  await resumed.start({ schedule: false });
  assert.equal(execution.prompts.length, 1, "a lost acknowledgement never calls the model again");
  assert.equal(api.contextCalls.length, 1, "recovery cannot re-read a changed context policy");
  assert.equal((await store.load())?.activeRequest, undefined);
  assert.doesNotMatch(JSON.stringify(await store.load()), /FROZEN_SUMMARY/);
  await resumed.stop();
});

test("DSH isolated recovery of a completed native turn uses the stored context fence, not a changed policy", async () => {
  const cfg = config(); const api = new ContextApi(); const store = new MemoryConnectorStateStore();
  const native = freshPersistence(); const execution = freshPersistence();
  api.events.push(summaryRequest(1, "user-2"), request(2)); api.failNextKind = "complete";
  const host = new ContextHost(cfg.dshSessionId, native, execution);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  await assert.rejects(connector.pollOnce(), /offline transport/);
  const saved = (await store.load())!;
  // Simulate a process ending after the DSH turn was flushed but before the
  // connector's settlement transaction was saved. Only native log can prove it.
  delete saved.activeRequest!.dshToSequence; saved.outbox = [];
  await store.save(saved); await connector.stop();
  api.contextView = "original";
  const resumedHost = new ContextHost(cfg.dshSessionId, native, execution);
  const resumed = new DshHostConnector({ config: cfg, api, host: resumedHost, stateStore: store });
  await resumed.start({ schedule: false });
  assert.equal(resumedHost.preparations[0]?.resume, true);
  assert.equal(resumedHost.preparations[0]?.historyContext.view, "summary");
  assert.equal(resumedHost.preparations[0]?.historyContext.through_sequence, 1);
  assert.equal(api.contextCalls.length, 1);
  assert.equal(execution.prompts.length, 1, "durable completion cannot replay the model");
  assert.equal((await store.load())?.activeRequest, undefined);
  await resumed.stop();
});

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
  assert.equal(host.projected[0]?.actorDisplayName, "user-2");
  assert.doesNotMatch(host.projected[0]?.content ?? "", /PRIVATE_/);
  assert.match(host.projected[0]?.role ?? "", /^user$/);
  assert.doesNotMatch(host.prompts.at(-1) ?? "", /EARLY_REMOTE_CONTEXT|canonical context follows/);
  assert.match(host.prompts.at(-1) ?? "", /Do the work password=\[REDACTED\]/);
  await connector.stop();
});

test("Solo projections retain the original user bubble text without a sender label", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.sessions[0] = { ...api.sessions[0]!, mode: "solo", ownerUserId: "user-1" };
  api.events.push(canonical(1, "human_chat", { content: "Solo history" }, "user-1"));
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({ config: cfg, api, host, actorUserId: "user-1", stateStore: new MemoryConnectorStateStore() });
  await connector.start({ runImmediately: false, schedule: false });
  await connector.pollOnce();
  assert.equal(host.projected[0]?.content, "Solo history");
  assert.equal(host.projected[0]?.actorDisplayName, undefined);
  await connector.stop();
});

test("a running connector changes sender labels after both Solo/Multi mode transitions", async () => {
  const cfg = config();
  const api = new FakeApi();
  api.sessions[0] = { ...api.sessions[0]!, mode: "solo", ownerUserId: "user-1" };
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({ config: cfg, api, host, actorUserId: "user-1", stateStore: new MemoryConnectorStateStore() });
  await connector.start({ runImmediately: false, schedule: false });

  api.events.push(canonical(1, "human_chat", { content: "First Solo" }, "user-1"));
  await connector.pollOnce();
  api.sessions[0] = { ...api.sessions[0]!, mode: "multi" };
  connector.updateSessionSummary(api.sessions[0]!);
  api.events.push(canonical(2, "human_chat", { content: "Now Multi" }, "user-2"));
  await connector.pollOnce();
  api.sessions[0] = { ...api.sessions[0]!, mode: "solo" };
  connector.updateSessionSummary(api.sessions[0]!);
  api.events.push(canonical(3, "human_chat", { content: "Solo again" }, "user-1"));
  await connector.pollOnce();

  assert.deepEqual(host.projected.map(({ content, actorDisplayName }) => ({ content, actorDisplayName })), [
    { content: "First Solo", actorDisplayName: undefined },
    { content: "Now Multi", actorDisplayName: "user-2" },
    { content: "Solo again", actorDisplayName: undefined },
  ]);
  assert.throws(() => connector.updateSessionSummary({ ...api.sessions[0]!, id: "other-session" }), /not this writable binding/u);
  assert.throws(() => connector.updateSessionSummary({ ...api.sessions[0]!, role: "viewer" }), /not this writable binding/u);
  await connector.stop();
});

test("native DeepSeek runtimes advertise exact profiles and apply the selected model and effort per request", async () => {
  const executionProfiles = [{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
  }, {
    provider: "deepseek-official",
    model: "deepseek-reasoner",
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
  }];
  const cfg = config({ executionProfiles });
  const api = new FakeApi();
  api.events.push(dynamicRequest(1));
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });

  await connector.start({ schedule: false });
  assert.deepEqual(api.registrations[0]?.executionProfiles, executionProfiles);
  assert.deepEqual(host.promptProfiles, [{
    provider: "deepseek-official",
    model: "deepseek-reasoner",
    reasoningEffort: "high",
  }]);
  assert.equal(api.completions[0]?.observedModel, "deepseek-reasoner");
  assert.equal(api.completions[0]?.observedReasoningEffort, "high");
  assert.ok(api.progress.every((item) => item.observedModel === "deepseek-reasoner"));
  assert.ok(api.progress.every((item) => item.observedReasoningEffort === "high"));
  await connector.stop();
});

test("dynamic DSH requests without an exact runtime target stay passive", async () => {
  const cfg = config({
    executionProfiles: [{
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    }],
  });
  const api = new FakeApi();
  api.events.push(canonical(1, "agent_request", {
    content: "untargeted dynamic request",
    execution_profile: {
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      reasoning_effort: "high",
    },
  }));
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });

  await connector.start({ schedule: false });
  assert.equal(api.claims.size, 0);
  assert.equal(host.prompts.length, 0);
  await connector.stop();
});

test("dynamic DeepSeek profiles fail closed before claim when model or effort was not advertised", async () => {
  const cfg = config({
    executionProfiles: [{
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    }],
  });
  const api = new FakeApi();
  api.events.push(canonical(1, "agent_request", {
    content: "unsupported effort",
    execution_profile: {
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      reasoning_effort: "low",
      runtime_id: "runtime-1",
    },
  }));
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await assert.rejects(connector.start({ schedule: false }), /reasoning effort was not advertised/);
  assert.equal(api.claims.size, 0);
  assert.equal(host.prompts.length, 0);
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

test("cloud history preserves text beyond 64 KiB without executing or changing a non-DeepSeek route", async () => {
  const cfg = config({ provider: "other-provider", model: "native-model", pollLimit: 1 });
  const api = new FakeApi();
  const middle = "共享上下文".repeat(6_000);
  const content = `OLD_HISTORY_BEGIN\n${middle}\npassword=synthetic-secret\nLATEST_HISTORY_TAIL`;
  const redacted = `OLD_HISTORY_BEGIN\n${middle}\npassword=[REDACTED]\nLATEST_HISTORY_TAIL`;
  assert.ok(Buffer.byteLength(JSON.stringify({ content }), "utf8") < 256 * 1_024);
  assert.ok(Buffer.byteLength(redacted, "utf8") > 64 * 1_024);
  api.events.push(
    canonical(1, "human_chat", { content }, "user-2"),
    canonical(2, "agent_response", { text: content, reasoning: "PRIVATE_REASONING" }, "user-2"),
  );
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false });

  assert.deepEqual(host.projected.map(({ eventId, role }) => ({ eventId, role })), [
    { eventId: "event-1", role: "user" },
    { eventId: "event-2", role: "assistant" },
  ]);
  for (const event of host.projected) {
    assert.ok(event.content.endsWith("LATEST_HISTORY_TAIL"), "the accepted event tail must reach native history");
    assert.equal(event.content, redacted);
  }
  assert.equal(host.flushCount, 2, "each complete page must be flushed before its cursor advances");
  assert.equal((await store.load())?.projectionCursor, 2);
  assert.equal((await store.load())?.serverCursor, 2);
  assert.equal(host.prompts.length, 0, "passive history projection must never wake a model");
  assert.deepEqual(host.promptProfiles, []);
  assert.equal(api.registrations[0]?.provider, "other-provider");
  assert.equal(api.registrations[0]?.model, "native-model");
  await connector.pollOnce();
  assert.equal(host.projected.length, 2);
  assert.equal(host.flushCount, 2);
  await connector.stop();
});

test("long native projection retries after an uncertain flush without advancing or duplicating history", async () => {
  const cfg = config();
  const api = new FakeApi();
  const content = `LONG_HISTORY_BEGIN\n${"context ".repeat(10_000)}\nLONG_HISTORY_TAIL`;
  api.events.push(canonical(1, "human_chat", { content }, "user-2"));
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  host.failNextProjectionFlush = true;
  const store = new MemoryConnectorStateStore();
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ runImmediately: false, schedule: false });

  await assert.rejects(connector.pollOnce(), /simulated native projection flush failure/);
  assert.equal((await store.load())?.projectionCursor, 0);
  assert.equal((await store.load())?.serverCursor, 0);
  assert.equal(host.projected.length, 1, "the native append may have committed before flush failed");
  assert.ok(host.projected[0]?.content.endsWith("LONG_HISTORY_TAIL"));
  await connector.pollOnce();
  assert.equal(host.projected.length, 1, "retry must reuse the canonical event identity");
  assert.equal(host.projected[0]?.content, content);
  assert.equal(host.flushCount, 1);
  assert.equal((await store.load())?.projectionCursor, 1);
  assert.equal((await store.load())?.serverCursor, 1);
  await connector.stop();
});

test("local DSH uploads retain their independent 64 KiB public text limit", async () => {
  const cfg = config({ shareToolEvents: false });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  await connector.start({ runImmediately: false, schedule: false });
  host.emitLocalTurn(
    `password=synthetic-secret\n${"local input ".repeat(8_000)}INPUT_TAIL`,
    `${"local output ".repeat(8_000)}OUTPUT_TAIL`,
  );
  await connector.pollOnce();

  assert.equal(api.localTurns.length, 1);
  const input = (api.localTurns[0]?.requestPayload as { content: string }).content;
  const output = (api.localTurns[0]?.responsePayload as { text: string }).text;
  for (const text of [input, output]) {
    assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1_024);
    assert.match(text, /\[TRUNCATED\]$/u);
    assert.doesNotMatch(text, /INPUT_TAIL|OUTPUT_TAIL|synthetic-secret/u);
  }
  assert.match(input, /password=\[REDACTED\]/u);
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
  const lifecycleProgress = api.progress.filter(
    (item) => (item.payload as { phase?: string }).phase === "lifecycle",
  );
  assert.deepEqual(
    lifecycleProgress.map((item) => (item.payload as { status: string }).status),
    ["running", "idle"],
  );
  assert.ok(
    api.progress.some((item) => (item.payload as { phase?: string }).phase === "activity"),
    "durable DSH activity should renew the claim before completion",
  );
  assert.ok(api.progress.every((item) => item.claimAttempt === 2));
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

  api.claimAttempt = 3;
  const resumedHost = new FakeHost(cfg.dshSessionId, persistence);
  const resumed = new DshHostConnector({ config: cfg, api, host: resumedHost, stateStore: store });
  await resumed.start({ schedule: false });
  assert.equal(persistence.prompts.length, 1, "outbox replay must not call the model again");
  assert.equal(api.appended.length, 2);
  assert.deepEqual(api.appended.map((item) => item.claimAttempt), [3, 3]);
  assert.equal(api.completions.length, 1);
  assert.equal(api.completions[0]?.claimAttempt, 3, "recovered outbox must use the renewed claim attempt");
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
  const cfg = config({
    shareToolEvents: false,
    executionProfiles: [{
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    }],
  });
  const api = new FakeApi();
  const chat = canonical(1, "human_chat", { content: "shared before crash" });
  const activeRequest = dynamicRequest(2);
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
  assert.deepEqual(host.promptProfiles, [{
    provider: "deepseek-official",
    model: "deepseek-reasoner",
    reasoningEffort: "high",
  }]);
  assert.equal((api.completions[0]?.payload as { text: string }).text, "recovered final");
  assert.equal(api.completions[0]?.observedModel, "deepseek-reasoner");
  assert.equal(api.completions[0]?.observedReasoningEffort, "high");
  assert.doesNotMatch(JSON.stringify(api.completions), /PRIVATE_CRASH_REASONING|partial/);
  assert.equal((await store.load())?.activeRequest, undefined);
  await connector.stop();
});

test("terminal failure while recovering retires durable active state and resumes canonical replay", async () => {
  const cfg = config();
  const api = new FakeApi();
  const activeRequest = request(1);
  api.events.push(activeRequest, canonical(2, "agent_response", {
    text: "This Agent request was interrupted and could not be recovered.",
    status: "failed",
  }));
  api.claimConflictCode = "agent_request_failed";
  const state: ConnectorState = {
    version: 3,
    binding: { projectId: cfg.projectId, sessionId: cfg.sessionId, dshSessionId: cfg.dshSessionId },
    serverCursor: 0,
    projectionCursor: 0,
    publishedDshSequence: 0,
    automaticUpload: true,
    activeRequest: {
      requestId: activeRequest.id,
      requestSequence: activeRequest.sequence,
      dshFromSequence: 0,
      promptDigest: "a".repeat(64),
      claimAttempt: 3,
    },
    outbox: [{
      id: "pending-progress",
      kind: "progress",
      requestId: activeRequest.id,
      input: {
        runtimeId: "runtime-1",
        claimAttempt: 3,
        idempotencyKey: "pending-progress",
        payload: { content: "stale pending progress" },
      },
    }],
  };
  const store = new MemoryConnectorStateStore(state);
  const persistence = freshPersistence();
  persistence.exists = true;
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host: new FakeHost(cfg.dshSessionId, persistence),
    stateStore: store,
  });

  await connector.start({ schedule: false });
  let recovered = await store.load();
  assert.equal(recovered?.activeRequest, undefined);
  assert.deepEqual(recovered?.outbox, []);
  assert.equal(recovered?.serverCursor, 1);
  await connector.pollOnce();
  recovered = await store.load();
  assert.equal(recovered?.serverCursor, 2);
  assert.equal(persistence.prompts.length, 0);
  await connector.stop();
});

test("a paused active request is retired instead of retried on every poll", async () => {
  const cfg = config();
  const api = new FakeApi();
  const activeRequest = request(1);
  api.events.push(activeRequest);
  api.claims.set(activeRequest.id, "paused");
  const state: ConnectorState = {
    version: 3,
    binding: { projectId: cfg.projectId, sessionId: cfg.sessionId, dshSessionId: cfg.dshSessionId },
    serverCursor: 0,
    projectionCursor: 0,
    publishedDshSequence: 0,
    automaticUpload: true,
    activeRequest: {
      requestId: activeRequest.id,
      requestSequence: activeRequest.sequence,
      dshFromSequence: 0,
      promptDigest: "a".repeat(64),
      claimAttempt: 1,
    },
    outbox: [{
      id: "pending-progress",
      kind: "progress",
      requestId: activeRequest.id,
      input: {
        runtimeId: "runtime-1",
        claimAttempt: 1,
        idempotencyKey: "pending-progress",
        payload: { content: "fenced progress" },
      },
    }],
  };
  const store = new MemoryConnectorStateStore(state);
  const persistence = freshPersistence();
  persistence.exists = true;
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host: new FakeHost(cfg.dshSessionId, persistence),
    stateStore: store,
  });
  // The author paused while this connector held the request. That is terminal
  // for this request, not an unknown state to retry: the connector must release
  // the local work instead of driving a fenced execution for ever.
  await connector.start({ schedule: false });
  const settled = await store.load();
  assert.equal(settled?.activeRequest, undefined, "a paused request must not stay active");
  assert.deepEqual(settled?.outbox, [], "its fenced outbox work must be dropped");
  assert.equal(persistence.prompts.length, 0, "a paused request must never be driven");
  await connector.stop();
});

for (const automaticUpload of [true, false]) {
  test(`paused completed native work is not recaptured; later local work is preserved (auto=${automaticUpload})`, async () => {
    const cfg = config();
    const api = new FakeApi();
    const activeRequest = request(1);
    api.events.push(activeRequest);
    api.claims.set(activeRequest.id, "paused");
    const persistence = freshPersistence();
    persistence.exists = true;
    const host = new FakeHost(cfg.dshSessionId, persistence);
    // Native completion existed, but its acknowledgement was lost before the
    // connector could persist dshToSequence. Production cloud prompts also use
    // source.kind=user, so they otherwise qualify for local capture.
    host.emitLocalTurn("CLOUD_REQUEST", "FENCED_COMPLETED_ANSWER");
    const cloudEnd = host.currentSequence();
    host.emitLocalTurn("GENUINE_LOCAL_REQUEST", "GENUINE_LOCAL_ANSWER");
    const store = new MemoryConnectorStateStore({ version: 3,
      binding: { projectId: cfg.projectId, sessionId: cfg.sessionId, dshSessionId: cfg.dshSessionId },
      serverCursor: 0, projectionCursor: 0, publishedDshSequence: 0, automaticUpload,
      activeRequest: { requestId: activeRequest.id, requestSequence: 1,
        dshFromSequence: 0, promptDigest: createHash("sha256").update("CLOUD_REQUEST").digest("hex"), claimAttempt: 1 }, outbox: [] });
    const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
    await connector.start({ schedule: false, runImmediately: false });
    assert.equal((await store.load())?.publishedDshSequence, cloudEnd);
    assert.equal((await store.load())?.activeRequest, undefined);
    await connector.pollOnce();
    if (!automaticUpload) await connector.uploadLocalTurns();
    assert.equal(api.localTurns.length, 1);
    assert.deepEqual(api.localTurns[0]?.requestPayload, { content: "GENUINE_LOCAL_REQUEST",
      capture_fidelity: "harness_transcript", source_harness: "deepseek-harness" });
    assert.deepEqual(api.localTurns[0]?.responsePayload, { text: "GENUINE_LOCAL_ANSWER",
      capture_fidelity: "harness_transcript", source_harness: "deepseek-harness" });
    assert.equal(persistence.prompts.length, 0);
    await connector.stop();
  });
}

test("an open paused native turn retains its fence across restart until its own end", async () => {
  const cfg = config();
  const api = new FakeApi();
  const activeRequest = request(1);
  api.events.push(activeRequest);
  api.claims.set(activeRequest.id, "paused");
  const persistence = freshPersistence();
  persistence.exists = true;
  const firstHost = new FakeHost(cfg.dshSessionId, persistence);
  firstHost.emitLocalTurn("CLOUD_REQUEST", "FENCED_COMPLETED_ANSWER");
  const closingEvents = persistence.events.splice(4);
  const store = new MemoryConnectorStateStore({ version: 3,
    binding: { projectId: cfg.projectId, sessionId: cfg.sessionId, dshSessionId: cfg.dshSessionId },
    serverCursor: 0, projectionCursor: 0, publishedDshSequence: 0, automaticUpload: true,
    activeRequest: { requestId: activeRequest.id, requestSequence: 1,
      dshFromSequence: 0, promptDigest: createHash("sha256").update("CLOUD_REQUEST").digest("hex"), claimAttempt: 1 }, outbox: [] });
  const first = new DshHostConnector({ config: cfg, api, host: firstHost, stateStore: store });
  await first.start({ schedule: false });
  await first.uploadLocalTurns();
  assert.ok((await store.load())?.activeRequest);
  assert.equal(api.localTurns.length, 0);
  await first.stop();
  const nextHost = new FakeHost(cfg.dshSessionId, persistence);
  const next = new DshHostConnector({ config: cfg, api, host: nextHost, stateStore: store });
  await next.start({ schedule: false });
  assert.ok((await store.load())?.activeRequest);
  // Even an interrupted turn closes the excluded execution range.
  const last = closingEvents.at(-1)!;
  persistence.events.push(...closingEvents.slice(0, -1), { ...last, data: { turn: 99, reason: { kind: "interrupted" } } });
  nextHost.emitLocalTurn("LATER_LOCAL", "LATER_ANSWER");
  await next.pollOnce();
  await next.pollOnce();
  assert.equal((await store.load())?.activeRequest, undefined);
  assert.equal(api.localTurns.length, 1);
  assert.deepEqual(api.localTurns[0]?.requestPayload, { content: "LATER_LOCAL",
    capture_fidelity: "harness_transcript", source_harness: "deepseek-harness" });
  assert.equal(persistence.prompts.length, 0);
  await next.stop();
});

test("pausing a prompt that never began does not discard subsequent genuine local work", async () => {
  const cfg = config();
  const api = new FakeApi();
  const activeRequest = request(1);
  api.events.push(activeRequest);
  api.claims.set(activeRequest.id, "paused");
  const persistence = freshPersistence();
  persistence.exists = true;
  const host = new FakeHost(cfg.dshSessionId, persistence);
  host.emitLocalTurn("GENUINE_LOCAL_REQUEST", "GENUINE_LOCAL_ANSWER");
  const store = new MemoryConnectorStateStore({ version: 3,
    binding: { projectId: cfg.projectId, sessionId: cfg.sessionId, dshSessionId: cfg.dshSessionId },
    serverCursor: 0, projectionCursor: 0, publishedDshSequence: 0, automaticUpload: false,
    activeRequest: { requestId: activeRequest.id, requestSequence: 1,
      dshFromSequence: 0, promptDigest: createHash("sha256").update("CLOUD_REQUEST").digest("hex"), claimAttempt: 1 }, outbox: [] });
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: store });
  await connector.start({ schedule: false, runImmediately: false });
  assert.equal((await store.load())?.publishedDshSequence, 0);
  assert.equal((await store.load())?.activeRequest, undefined);
  await connector.uploadLocalTurns();
  assert.equal(api.localTurns.length, 1);
  assert.deepEqual(api.localTurns[0]?.requestPayload, { content: "GENUINE_LOCAL_REQUEST",
    capture_fidelity: "harness_transcript", source_harness: "deepseek-harness" });
  assert.equal(persistence.prompts.length, 0);
  await connector.stop();
});

test("live durable DSH events renew the claim before the prompt returns", async () => {
  const cfg = config();
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
  });

  const started = connector.start({ schedule: false });
  await waitFor(() => persistence.prompts.length === 1);
  const progressBeforeEvent = api.progress.length;
  host.emitActiveEvent();
  host.emitActiveEvent();
  host.emitActiveEvent();
  await waitFor(() => api.progress.length > progressBeforeEvent);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.progress.length, progressBeforeEvent + 1, "a durable event burst should coalesce");
  assert.ok(api.progress.every((item) => item.claimAttempt === 2));
  releasePrompt?.();
  await started;
  await connector.stop();
});

test("DSH connector publishes native streamed work before completion under the exact selected claim", async () => {
  const cfg = config({ shareToolEvents: false, executionProfiles: [{ provider: "deepseek-official", model: "deepseek-reasoner", reasoningEfforts: ["high"] }] });
  class LiveApi extends FakeApi {
    readonly routes: Array<[string, string]> = [];
    override appendAgentProgress(sessionId: string, requestId: string, input: CompleteAgentRequestInput) {
      this.routes.push([sessionId, requestId]);
      return super.appendAgentProgress(sessionId, requestId, input);
    }
  }
  const api = new LiveApi(); api.events.push(dynamicRequest(1));
  const persistence = freshPersistence(); const host = new LiveHost(cfg.dshSessionId, persistence);
  let releasePrompt!: () => void; host.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  const started = connector.start({ schedule: false });
  await waitFor(() => persistence.prompts.length === 1);
  host.emitLiveText("PRIVATE_FOREIGN_SESSION ", "unrelated-native-session");
  host.emitLiveText("writing answer now ");
  await waitFor(() => api.progress.some((input) => (input.payload as { phase?: string }).phase === "stream"));
  assert.equal(api.completions.length, 0, "tokens must be published before native completion");
  host.emitLiveText("exposed native thinking ", host.sessionId, 2, "reasoning");
  host.emitLive({ kind: "session-event", sourceSessionId: host.sessionId,
    event: { type: "tool/call", seq: 1, time: eventTime,
      data: { turn: 1, step: 1, callId: "live-call", name: "shell", arguments: '{"cmd":"echo safe","password":"PRIVATE_SECRET"}' } } });
  host.emitLive({ kind: "session-event", sourceSessionId: host.sessionId,
    event: { type: "tool/result", seq: 2, time: eventTime, data: { turn: 1, step: 1,
      message: { content: [{ type: "tool-result", toolCallId: "live-call", content: [{ type: "text", text: "visible result" }] }] },
      meta: "PRIVATE_TOOL_META" } } });
  host.emitLive({ kind: "session-event", sourceSessionId: host.sessionId,
    event: { type: "todo/write", seq: 3, time: eventTime, data: { todos: [{ content: "Check result", status: "in_progress" }] } } });
  releasePrompt(); await started;
  const stream = api.progress.filter((input) => (input.payload as { phase?: string }).phase === "stream");
  assert.deepEqual([...new Set(stream.map((input) => (input.payload as { stream_kind: string }).stream_kind))].sort(),
    ["answer", "plan", "reasoning", "tool"]);
  assert.ok(stream.every((input) => input.runtimeId === "runtime-1" && input.claimAttempt === 2
    && input.observedModel === "deepseek-reasoner" && input.observedReasoningEffort === "high"));
  assert.ok(api.routes.every(([sessionId, requestId]) => sessionId === "session-1" && requestId === "event-1"));
  assert.doesNotMatch(JSON.stringify(stream), /PRIVATE_|native-attempt|live-call|unrelated-native-session/);
  assert.equal(api.appended.length, 0, "the separate native-local shareToolEvents preference is not broadened");
  const count = api.progress.length;
  host.emitLiveText("PRIVATE_AFTER_FINISH ", host.sessionId, 3);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.progress.length, count);
  await connector.stop(); assert.equal(host.liveListeners.size, 0);
});

test("DSH connector refuses queued native stream callbacks after stopping their scope", async () => {
  let releaseProgress!: () => void;
  const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve; });
  class BlockedApi extends FakeApi {
    override async appendAgentProgress(sessionId: string, requestId: string, input: CompleteAgentRequestInput) {
      await progressGate;
      return super.appendAgentProgress(sessionId, requestId, input);
    }
  }
  const cfg = config(); const api = new BlockedApi(); api.events.push(request(1));
  const persistence = freshPersistence(); const host = new LiveHost(cfg.dshSessionId, persistence);
  host.promptGate = new Promise<void>(() => undefined);
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  const started = connector.start({ schedule: false }).catch(() => undefined);
  await waitFor(() => persistence.prompts.length === 1);
  host.emitLiveText("PRIVATE_STALE_STREAM ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await bounded(connector.stop(), 1000); await started;
  releaseProgress();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.progress.filter((input) => (input.payload as { phase?: string }).phase === "stream").length, 0);
  assert.equal(api.completions.length, 0);
  assert.equal(host.liveListeners.size, 0);
});

test("DSH isolated context execution excludes live output from the parent native Session", async () => {
  class LiveContextHost extends ContextHost {
    readonly liveListeners = new Set<(event: DshLiveOutputEvent) => void>();
    onLiveOutput(listener: (event: DshLiveOutputEvent) => void) {
      this.liveListeners.add(listener); return () => { this.liveListeners.delete(listener); };
    }
    text(text: string, sourceSessionId: string, revision: number) {
      const emitter = new LiveHost(sourceSessionId, freshPersistence());
      emitter.onLiveOutput((event) => this.liveListeners.forEach((listener) => listener(event)));
      emitter.emitLiveText(text, sourceSessionId, revision);
    }
  }
  const cfg = config(); const api = new ContextApi(); api.events.push(summaryRequest(1));
  const host = new LiveContextHost(cfg.dshSessionId, freshPersistence());
  let releasePrompt!: () => void; host.execution.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const connector = new DshHostConnector({ config: cfg, api, host, stateStore: new MemoryConnectorStateStore() });
  const started = connector.start({ schedule: false });
  await waitFor(() => host.execution.prompts.length === 1);
  host.text("PRIVATE_PARENT_SESSION ", host.sessionId, 1);
  host.text("selected context answer ", host.executionId, 1);
  await waitFor(() => api.progress.some((input) => (input.payload as { phase?: string }).phase === "stream"));
  releasePrompt(); await started;
  const stream = api.progress.filter((input) => (input.payload as { phase?: string }).phase === "stream");
  assert.ok(stream.some((input) => (input.payload as { content: string }).content.includes("selected context answer")));
  assert.doesNotMatch(JSON.stringify(stream), /PRIVATE_PARENT_SESSION|gatherthread-execution-/);
  await connector.stop(); assert.equal(host.liveListeners.size, 0);
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
  const states: string[] = [];
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
    heartbeatIntervalMs: 5,
    onBackgroundError: (error) => errors.push(error),
    onLifecycle: (update) => states.push(update.state),
  });

  await connector.start({ runImmediately: false, schedule: true });
  await waitFor(() => api.heartbeatCount >= 2);
  assert.equal(api.readCount, 0, "heartbeat must not depend on the canonical-event poll interval");
  assert.match(errors[0]?.message ?? "", /simulated heartbeat transport failure/);
  assert.equal(states.at(-1), "idle", "an idle connector also recovers its connection state");
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

test("long DSH execution publishes busy immediately and keeps presence without fabricating work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: eventTime });
  const cfg = config({ pollIntervalMs: 60_000 });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  let release!: () => void;
  host.promptGate = new Promise<void>((resolve) => { release = resolve; });
  const connector = new DshHostConnector({ config: cfg, api, host,
    stateStore: new MemoryConnectorStateStore() });
  t.after(async () => { release(); await connector.stop(); });
  await connector.start({ runImmediately: false });
  api.events.push(request(1));
  const pending = connector.pollOnce();
  await waitFor(() => host.prompts.length === 1);
  // Native running is observable before the first durable tool/answer event.
  await Promise.resolve();
  assert.ok(api.progress.some((item) => (item.payload as { status?: string }).status === "running"));
  const progressCount = api.progress.length;
  for (let i = 0; i < 36; i += 1) {
    t.mock.timers.tick(10_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(api.heartbeatCount, 36, "presence must survive both the 30s TTL and a six-minute blocked prompt");
  assert.equal(api.progress.length, progressCount, "idle heartbeats must not fabricate work or renew an inactive claim");
  assert.equal(api.completions.length, 0);
  release();
  await pending;
  assert.equal(api.completions.length, 1);
});

test("DSH heartbeat recovery restores running before a long prompt settles", async (t) => {
  const cfg = config({ pollIntervalMs: 60_000 });
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  let release!: () => void;
  host.promptGate = new Promise<void>((resolve) => { release = resolve; });
  const states: string[] = [];
  const connector = new DshHostConnector({ config: cfg, api, host,
    stateStore: new MemoryConnectorStateStore(), heartbeatIntervalMs: 5,
    onLifecycle: (update) => states.push(update.state) });
  t.after(async () => { release(); await connector.stop(); });
  await connector.start({ runImmediately: false });
  api.events.push(request(1));
  const pending = connector.pollOnce();
  await waitFor(() => host.prompts.length === 1);
  api.failNextHeartbeat = true;
  await waitFor(() => states.at(-1) === "offline");
  const atFailure = api.heartbeatCount;
  await waitFor(() => api.heartbeatCount > atFailure);
  assert.equal(states.at(-1), "running", "successful heartbeat must not leave a busy Agent stuck offline until completion");
  assert.equal(api.completions.length, 0);
  release();
  await pending;
});

test("a late DSH heartbeat failure cannot change a stopped connector back to offline", async () => {
  let rejectHeartbeat!: (error: Error) => void;
  let heartbeatStarted = false;
  class PendingHeartbeatApi extends FakeApi {
    override heartbeatRuntime(): Promise<DshRegisteredRuntime> {
      heartbeatStarted = true;
      return new Promise((_, reject) => { rejectHeartbeat = reject; });
    }
  }
  const cfg = config({ pollIntervalMs: 60_000 });
  const states: string[] = [];
  const connector = new DshHostConnector({ config: cfg, api: new PendingHeartbeatApi(),
    host: new FakeHost(cfg.dshSessionId, freshPersistence()), stateStore: new MemoryConnectorStateStore(),
    heartbeatIntervalMs: 5, onLifecycle: (update) => states.push(update.state) });
  await connector.start({ runImmediately: false });
  await waitFor(() => heartbeatStarted);
  const stopped = connector.stop();
  rejectHeartbeat(new Error("late transport error"));
  await stopped;
  assert.equal(states.at(-1), "stopped");
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

test("runtime identity drift interrupts a blocked initial prompt without publishing a result or further work", async () => {
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
  assert.equal(api.progress.length, 1, "only the native start observed before identity drift may be published");
  assert.equal((api.progress[0]?.payload as { status?: string }).status, "running");
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

test("a catalog refresh waits for an in-flight heartbeat instead of reading it as identity drift", async () => {
  const cfg = config({
    executionProfiles: [{ provider: "deepseek-official", model: "deepseek-v4-flash" }],
  });
  const api = new FakeApi();
  api.echoRegistrations = true;
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
    heartbeatIntervalMs: 5,
  });
  await connector.start({ runImmediately: false });

  // Park a heartbeat mid-flight so its response still carries the previous
  // declaration when the refresh below tries to replace it.
  let release: () => void = () => {};
  api.heartbeatGate = new Promise<void>((resolve) => { release = resolve; });
  await waitFor(() => api.heartbeatCount >= 1);

  const refreshed = [
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
    { provider: "deepseek-official", model: "deepseek-v4.1", reasoningEfforts: ["low"] },
  ];
  const update = connector.updateExecutionProfiles(refreshed);
  assert.equal(api.registrations.length, 1, "the refresh must not commit while a heartbeat can still answer");
  release();
  await update;

  // The stale heartbeat answer is the declaration this connector held when the
  // request was served, so it must not be treated as identity drift.
  assert.equal(connector.stopped, false);
  assert.deepEqual(api.registrations.at(-1)?.executionProfiles, refreshed);
  assert.deepEqual(api.returnedRuntimeIds, ["runtime-1", "runtime-1"]);
  await connector.stop();
});

test("a refreshed DSH model catalog is re-registered on the same runtime identity", async () => {
  const cfg = config({
    executionProfiles: [{ provider: "deepseek-official", model: "deepseek-v4-flash" }],
  });
  const api = new FakeApi();
  api.echoRegistrations = true;
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ runImmediately: false, schedule: false });

  // An unchanged catalog costs nothing: the server already has this declaration.
  await connector.updateExecutionProfiles([{ provider: "deepseek-official", model: "deepseek-v4-flash" }]);
  assert.equal(api.registrations.length, 1);

  // A model published after connect is declared without changing the identity, so
  // an in-flight claim on this runtime stays valid.
  const refreshed = [
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
    { provider: "deepseek-official", model: "deepseek-v4.1", reasoningEfforts: ["low", "high"] },
  ];
  await connector.updateExecutionProfiles(refreshed);
  assert.equal(api.registrations.length, 2);
  assert.deepEqual(api.registrations[1]?.executionProfiles, refreshed);
  assert.deepEqual(api.returnedRuntimeIds, ["runtime-1", "runtime-1"]);
  await connector.stop();
});

test("a server that does not confirm a refreshed catalog keeps the previous declaration", async () => {
  const cfg = config({
    executionProfiles: [{ provider: "deepseek-official", model: "deepseek-v4-flash" }],
  });
  // The echo stays stale, the way a server that ignored the new field would reply.
  const api = new FakeApi();
  const host = new FakeHost(cfg.dshSessionId, freshPersistence());
  const connector = new DshHostConnector({
    config: cfg,
    api,
    host,
    stateStore: new MemoryConnectorStateStore(),
  });
  await connector.start({ runImmediately: false, schedule: false });
  const refreshed = [
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
    { provider: "deepseek-official", model: "deepseek-v4.1" },
  ];
  await assert.rejects(connector.updateExecutionProfiles(refreshed), /did not confirm/u);
  // Nothing was committed, so the next refresh tries again instead of pretending
  // this runtime offers a model the server never recorded.
  await assert.rejects(connector.updateExecutionProfiles(refreshed), /did not confirm/u);
  assert.equal(api.registrations.length, 3);
  await connector.stop();
});

test("a connector that has not started refuses a catalog update", async () => {
  const cfg = config();
  const connector = new DshHostConnector({
    config: cfg,
    api: new FakeApi(),
    host: new FakeHost(cfg.dshSessionId, freshPersistence()),
    stateStore: new MemoryConnectorStateStore(),
  });
  await assert.rejects(
    connector.updateExecutionProfiles([{ provider: "deepseek-official", model: "deepseek-v4.1" }]),
    /not running/u,
  );
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

test("a Team cancelled while capturing files never prompts and releases its unstarted claim", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(), store = new MemoryConnectorStateStore();
  const event = request(1); event.payload = { ...(event.payload as object), agent_team: { run_id: 'file-baseline-run' } }; api.events.push(event);
  let active = true, acknowledgments = 0, capturing!: () => void;
  const captureStarted = new Promise<void>(resolve => { capturing = resolve; });
  const control: DshCollaborationApi = Object.assign(api, {
    async readAgentExecution() { return { active }; },
    async acknowledgeAgentExecutionStopped() { acknowledgments++; },
  });
  const connector = new DshHostConnector({ config: cfg, api: control, host: new FakeHost(cfg.dshSessionId, persistence), stateStore: store,
    beforeExecution: async (id, signal) => {
      assert.equal(id, event.id); capturing();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await connector.start({ schedule: false, runImmediately: false });
  const rejected = assert.rejects(connector.pollOnce(), /execution was stopped/);
  await captureStarted; active = false; await rejected;
  assert.equal(persistence.prompts.length, 0); assert.equal(acknowledgments, 1);
  assert.equal((await store.load())!.activeRequest, undefined);
  await connector.stop();
});
test("a failed optional file snapshot cannot prevent an authorized Agent task", async () => {
  const cfg = config(), api = new FakeApi(), persistence = freshPersistence(); api.events.push(request(1)); let called = 0;
  const connector = new DshHostConnector({ config: cfg, api, host: new FakeHost(cfg.dshSessionId, persistence), stateStore: new MemoryConnectorStateStore(),
    beforeExecution: async () => { called++; throw new Error('fixture unreadable project file'); } });
  await connector.start({ schedule: false, runImmediately: false }); await connector.pollOnce();
  assert.equal(called, 1); assert.equal(persistence.prompts.length, 1); assert.equal(api.completions.length, 1);
  await connector.stop();
});
