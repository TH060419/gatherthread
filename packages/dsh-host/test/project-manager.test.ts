import assert from "node:assert/strict";
import test from "node:test";
import {
  CollaborationHttpError,
  type AgentRequestClaim,
  type CanonicalEvent,
  type CommitLocalTurnInput,
  type CommitLocalTurnResult,
  type CompleteAgentRequestInput,
  type CurrentActor,
  type ReadEventsResult,
  type SessionSummary,
} from "@gatherthread/bridge";
import {
  parseDshHostConfig,
  type EnabledDshProjectHostConfig,
} from "../src/config.js";
import { DshHostConnector } from "../src/connector.js";
import {
  DshProjectManager,
  type DshManagedConnector,
} from "../src/project-manager.js";
import { MemoryConnectorStateStore } from "../src/state-store.js";
import type {
  DshAgentStatus,
  DshAppendEventInput,
  DshHostFacade,
  DshProjectCollaborationApi,
  DshPromptResult,
  DshRegisteredRuntime,
  DshRuntimeRegistration,
  DshSessionEventRecord,
} from "../src/types.js";

const timestamp = "2026-09-05T00:00:00.000Z";

function projectConfig(
  overrides: Partial<EnabledDshProjectHostConfig> = {},
): EnabledDshProjectHostConfig {
  const parsed = parseDshHostConfig({
    enabled: true,
    bindingMode: "project",
    apiUrl: "https://gatherthread.example/v1",
    credentialReference: { kind: "environment", variable: "GATHERTHREAD_DSH_TOKEN" },
    projectId: "project-1",
    deviceId: "device-1",
    workspacePath: "/readonly/workspace",
    stateRoot: "/private/state/dsh-project",
    provider: "deepseek-official",
    model: "DeepSeek-CustomCase",
    pollIntervalMs: 1_000,
    pollLimit: 20,
    shareToolEvents: false,
    refreshIntervalMs: 60_000,
    maxConcurrentSessions: 2,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
  });
  if (!parsed.enabled || parsed.bindingMode !== "project") {
    throw new Error("expected project config");
  }
  return { ...parsed, ...overrides };
}

function session(
  id: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    projectId: "project-1",
    name: id,
    mode: "multi",
    state: "active",
    role: "participant",
    latestSequence: 0,
    ...overrides,
  };
}

class DiscoveryApi implements DshProjectCollaborationApi {
  actor: CurrentActor = { id: "actor-1", displayName: "Actor", deviceId: "device-1" };
  sessions: SessionSummary[] = [];
  listError: unknown;
  listCalls = 0;
  readonly createCalls: Array<{
    projectId: string;
    input: { sessionId: string; title: string; mode: "solo" | "multi"; idempotencyKey: string };
  }> = [];

  async getCurrentActor(): Promise<CurrentActor> {
    return structuredClone(this.actor);
  }

  async listProjectSessions(projectId: string): Promise<SessionSummary[]> {
    assert.equal(projectId, "project-1");
    this.listCalls += 1;
    if (this.listError !== undefined) {
      const error = this.listError;
      this.listError = undefined;
      throw error;
    }
    return structuredClone(this.sessions);
  }

  async createSession(
    projectId: string,
    input: { sessionId: string; title: string; mode: "solo" | "multi"; idempotencyKey: string },
  ): Promise<SessionSummary> {
    this.createCalls.push({ projectId, input: structuredClone(input) });
    const existing = this.sessions.find((candidate) => candidate.id === input.sessionId);
    if (existing !== undefined) return structuredClone(existing);
    const created = session(input.sessionId, {
      name: input.title,
      mode: input.mode,
      ownerUserId: this.actor.id,
      role: "owner",
      latestSequence: 1,
    });
    this.sessions.push(created);
    return structuredClone(created);
  }

  async readEvents(): Promise<ReadEventsResult> { throw new Error("unused"); }
  async registerRuntime(): Promise<DshRegisteredRuntime> { throw new Error("unused"); }
  async heartbeatRuntime(): Promise<DshRegisteredRuntime> { throw new Error("unused"); }
  async claimAgentRequest(): Promise<AgentRequestClaim> { throw new Error("unused"); }
  async appendAgentProgress(): Promise<CanonicalEvent> { throw new Error("unused"); }
  async appendEvent(): Promise<CanonicalEvent> { throw new Error("unused"); }
  async completeAgentRequest(): Promise<CanonicalEvent> { throw new Error("unused"); }
  async commitLocalTurn(): Promise<CommitLocalTurnResult> { throw new Error("unused"); }
}

class FakeManagedConnector implements DshManagedConnector {
  stopped = false;
  starts = 0;
  stops = 0;

  constructor(private readonly failStart = false) {}

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) throw new Error("simulated per-session attach failure");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stops += 1;
  }
}

test("project discovery reuses authoritative Solo/Multi permissions and reconciles lifecycle", async () => {
  const api = new DiscoveryApi();
  api.sessions = [
    session("multi"),
    session("owned-solo", { mode: "solo", ownerUserId: "actor-1" }),
    session("foreign-solo", { mode: "solo", ownerUserId: "other-user", role: "owner" }),
    session("viewer", { role: "viewer" }),
  ];
  const created = new Map<string, FakeManagedConnector[]>();
  const manager = new DshProjectManager({
    config: projectConfig(),
    api,
    createConnector: ({ config }) => {
      const connector = new FakeManagedConnector();
      created.set(config.sessionId, [...created.get(config.sessionId) ?? [], connector]);
      return connector;
    },
  });

  await manager.start();
  assert.deepEqual(manager.activeSessionIds(), ["multi", "owned-solo"]);
  assert.equal(created.has("foreign-solo"), false, "project role cannot override another user's Solo owner");
  assert.equal(created.has("viewer"), false);

  api.sessions.push(session("new-session"));
  await manager.refreshOnce();
  assert.deepEqual(manager.activeSessionIds(), ["multi", "new-session", "owned-solo"]);

  api.sessions = [
    session("multi", { role: "viewer" }),
    session("owned-solo", { mode: "solo", ownerUserId: "actor-1", state: "archived" }),
  ];
  await manager.refreshOnce();
  assert.deepEqual(manager.activeSessionIds(), []);
  assert.equal(created.get("multi")?.[0]?.stops, 1);
  assert.equal(created.get("owned-solo")?.[0]?.stops, 1);
  assert.equal(created.get("new-session")?.[0]?.stops, 1);
  await manager.stop();
});

test("a completed native DSH session becomes one idempotent cloud Solo and keeps its native identity", async () => {
  const api = new DiscoveryApi();
  const nativeCandidates = [{ localSessionId: "session-native-1", title: "First DSH task" }];
  const attached: Array<{ sessionId: string; dshSessionId: string }> = [];
  const manager = new DshProjectManager({
    config: projectConfig(),
    api,
    canCreateLocalSessions: true,
    discoverLocalSessions: async () => structuredClone(nativeCandidates),
    createConnector: ({ config }) => {
      attached.push({ sessionId: config.sessionId, dshSessionId: config.dshSessionId });
      return new FakeManagedConnector();
    },
  });

  await manager.start();
  assert.equal(api.createCalls.length, 1);
  assert.equal(api.createCalls[0]?.projectId, "project-1");
  assert.deepEqual({ ...api.createCalls[0]?.input, idempotencyKey: undefined }, {
    sessionId: "session-native-1",
    title: "First DSH task",
    mode: "solo",
    idempotencyKey: undefined,
  });
  assert.match(api.createCalls[0]?.input.idempotencyKey ?? "", /^dsh-native:[a-f0-9]{64}$/u);
  assert.deepEqual(attached, [{ sessionId: "session-native-1", dshSessionId: "session-native-1" }]);
  assert.deepEqual(manager.activeSessionIds(), ["session-native-1"]);

  await manager.refreshOnce();
  assert.equal(api.createCalls.length, 1, "an already represented native Session must not be recreated");
  await manager.stop();
});

test("project manager accepts a native-only cloud Session identity mapper", async () => {
  const api = new DiscoveryApi();
  api.sessions = [session("cloud-session")];
  const attached: Array<{ sessionId: string; dshSessionId: string }> = [];
  const manager = new DshProjectManager({
    config: projectConfig(),
    api,
    mapCloudSessionId: (sessionId) => `native-v2-${sessionId}`,
    createConnector: ({ config }) => {
      attached.push({ sessionId: config.sessionId, dshSessionId: config.dshSessionId });
      return new FakeManagedConnector();
    },
  });
  await manager.start();
  assert.deepEqual(attached, [{ sessionId: "cloud-session", dshSessionId: "native-v2-cloud-session" }]);
  await manager.stop();
});

test("viewer project bindings never create cloud Sessions from local DSH activity", async () => {
  const api = new DiscoveryApi();
  const manager = new DshProjectManager({
    config: projectConfig(),
    api,
    canCreateLocalSessions: false,
    discoverLocalSessions: async () => [{ localSessionId: "session-viewer-local", title: "Private local work" }],
    createConnector: () => new FakeManagedConnector(),
  });

  await manager.start();
  assert.equal(api.createCalls.length, 0);
  assert.deepEqual(manager.activeSessionIds(), []);
  await manager.stop();
});

test("one Session failure backs off without blocking peers; transient discovery preserves and 403 revokes all", async () => {
  let now = 0;
  const api = new DiscoveryApi();
  api.sessions = [session("good"), session("flaky")];
  const attempts = new Map<string, number>();
  const instances = new Map<string, FakeManagedConnector[]>();
  const observedErrors: Error[] = [];
  const manager = new DshProjectManager({
    config: projectConfig({ retryBaseMs: 100, retryMaxMs: 400 }),
    api,
    now: () => now,
    onBackgroundError: (error) => observedErrors.push(error),
    createConnector: ({ config }) => {
      const attempt = (attempts.get(config.sessionId) ?? 0) + 1;
      attempts.set(config.sessionId, attempt);
      const connector = new FakeManagedConnector(config.sessionId === "flaky" && attempt === 1);
      instances.set(config.sessionId, [...instances.get(config.sessionId) ?? [], connector]);
      return connector;
    },
  });

  await manager.start();
  assert.deepEqual(manager.activeSessionIds(), ["good"]);
  assert.equal(attempts.get("flaky"), 1);
  assert.match(observedErrors[0]?.message ?? "", /simulated per-session attach failure/);

  now = 99;
  await manager.refreshOnce();
  assert.equal(attempts.get("flaky"), 1, "retry must wait for its exponential deadline");
  now = 100;
  await manager.refreshOnce();
  assert.equal(attempts.get("flaky"), 2);
  assert.deepEqual(manager.activeSessionIds(), ["flaky", "good"]);

  api.listError = new Error("temporary offline fixture");
  const transient = await manager.refreshOnce();
  assert.equal(transient.status, "transient_failure");
  assert.deepEqual(manager.activeSessionIds(), ["flaky", "good"]);

  api.listError = new CollaborationHttpError(403, "project forbidden", "forbidden");
  const revoked = await manager.refreshOnce();
  assert.equal(revoked.status, "project_inaccessible");
  assert.equal(manager.stopped, true);
  assert.deepEqual(manager.activeSessionIds(), []);
  assert.equal(instances.get("good")?.[0]?.stops, 1);
  assert.equal(instances.get("flaky")?.[1]?.stops, 1);
  await manager.stop();
});

test("initial 404 and authenticated device drift both fail closed before any Session attach", async () => {
  const inaccessible = new DiscoveryApi();
  inaccessible.listError = new CollaborationHttpError(404, "project missing", "not_found");
  let creations = 0;
  const missingManager = new DshProjectManager({
    config: projectConfig(),
    api: inaccessible,
    createConnector: () => {
      creations += 1;
      return new FakeManagedConnector();
    },
  });
  await assert.rejects(missingManager.start(), /project missing/);
  assert.equal(missingManager.stopped, true);
  assert.equal(creations, 0);

  const wrongDevice = new DiscoveryApi();
  wrongDevice.actor = { ...wrongDevice.actor, deviceId: "different-device" };
  const deviceManager = new DshProjectManager({
    config: projectConfig(),
    api: wrongDevice,
    createConnector: () => {
      creations += 1;
      return new FakeManagedConnector();
    },
  });
  await assert.rejects(deviceManager.start(), /does not match the authenticated actor/);
  assert.equal(wrongDevice.listCalls, 0);
  assert.equal(creations, 0);
});

test("permission downgrade cancels a queued permit before claim while another Session continues", async () => {
  const api = new RuntimeApi();
  api.sessions = [session("session-a"), session("session-b")];
  const hosts = new Map<string, PromptHost>();
  const connectors = new Map<string, DshHostConnector>();
  const manager = new DshProjectManager({
    config: projectConfig({ maxConcurrentSessions: 1 }),
    api,
    createConnector: ({ config, actorUserId, executionGate }) => {
      const host = new PromptHost(config.dshSessionId);
      hosts.set(config.sessionId, host);
      const connector = new DshHostConnector({
        config,
        api,
        host,
        stateStore: new MemoryConnectorStateStore(),
        actorUserId,
        executionGate,
      });
      connectors.set(config.sessionId, connector);
      return {
        get stopped() { return connector.stopped; },
        start: () => connector.start({ runImmediately: false, schedule: false }),
        stop: () => connector.stop(),
      };
    },
  });
  await manager.start();

  api.events.set("session-a", [agentRequest("session-a", 1)]);
  api.events.set("session-b", [agentRequest("session-b", 1)]);
  const firstHost = hosts.get("session-a");
  const secondHost = hosts.get("session-b");
  const firstConnector = connectors.get("session-a");
  const secondConnector = connectors.get("session-b");
  if (!firstHost || !secondHost || !firstConnector || !secondConnector) throw new Error("missing fixture");
  firstHost.blockPrompt();
  const firstPoll = firstConnector.pollOnce();
  await waitFor(() => firstHost.promptCount === 1);
  const secondPoll = secondConnector.pollOnce();
  await waitFor(() => (api.readCounts.get("session-b") ?? 0) >= 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(api.claimCounts.get("session-b") ?? 0, 0, "waiting for capacity must precede claim");

  api.sessions = [session("session-a"), session("session-b", { role: "viewer" })];
  const refresh = await bounded(manager.refreshOnce(), 200);
  assert.equal(refresh.status, "updated");
  await assert.rejects(secondPoll, /connector stopped|not running/);
  assert.equal(api.claimCounts.get("session-b") ?? 0, 0);
  assert.equal(secondHost.promptCount, 0);
  assert.equal(api.publicationCounts.get("session-b") ?? 0, 0);
  assert.deepEqual(manager.activeSessionIds(), ["session-a"]);

  firstHost.releasePrompt();
  await firstPoll;
  assert.equal(api.claimCounts.get("session-a"), 1);
  assert.equal(api.completionCounts.get("session-a"), 1);
  assert.ok((api.publicationCounts.get("session-a") ?? 0) >= 1);
  await manager.stop();
});

class RuntimeApi implements DshProjectCollaborationApi {
  sessions: SessionSummary[] = [];
  readonly events = new Map<string, CanonicalEvent[]>();
  readonly readCounts = new Map<string, number>();
  readonly claimCounts = new Map<string, number>();
  readonly publicationCounts = new Map<string, number>();
  readonly completionCounts = new Map<string, number>();
  readonly #runtimes = new Map<string, DshRegisteredRuntime>();

  async getCurrentActor(): Promise<CurrentActor> {
    return { id: "actor-1", displayName: "Actor", deviceId: "device-1" };
  }

  async listProjectSessions(): Promise<SessionSummary[]> {
    return structuredClone(this.sessions.map((summary) => {
      const latestSequence = this.events.get(summary.id)?.at(-1)?.sequence
        ?? summary.latestSequence;
      return {
        ...summary,
        ...(latestSequence === undefined ? {} : { latestSequence }),
      };
    }));
  }

  async createSession(): Promise<SessionSummary> {
    throw new Error("unused");
  }

  async readEvents(sessionId: string, afterSequence: number, limit = 200): Promise<ReadEventsResult> {
    this.readCounts.set(sessionId, (this.readCounts.get(sessionId) ?? 0) + 1);
    const remaining = (this.events.get(sessionId) ?? []).filter((event) => event.sequence > afterSequence);
    const events = remaining.slice(0, limit);
    return {
      events: structuredClone(events),
      nextSequence: remaining.at(-1)?.sequence ?? afterSequence,
      hasMore: remaining.length > events.length,
    };
  }

  async registerRuntime(input: DshRuntimeRegistration): Promise<DshRegisteredRuntime> {
    const existing = this.#runtimes.get(input.localSessionId);
    if (existing !== undefined) return structuredClone(existing);
    const runtime = {
      ...structuredClone(input),
      id: `runtime-${input.sessionId}`,
      userId: "actor-1",
      registeredAt: timestamp,
    };
    this.#runtimes.set(input.localSessionId, runtime);
    return structuredClone(runtime);
  }

  async heartbeatRuntime(runtimeId: string): Promise<DshRegisteredRuntime> {
    const runtime = [...this.#runtimes.values()].find((candidate) => candidate.id === runtimeId);
    if (runtime === undefined) throw new Error("unknown runtime");
    return structuredClone(runtime);
  }

  async claimAgentRequest(
    sessionId: string,
    requestId: string,
    runtimeId: string,
  ): Promise<AgentRequestClaim> {
    this.claimCounts.set(sessionId, (this.claimCounts.get(sessionId) ?? 0) + 1);
    return { claimed: true, status: "claimed", requestId, runtimeId };
  }

  async appendAgentProgress(
    sessionId: string,
    _requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<CanonicalEvent> {
    return this.publish(sessionId, "agent_progress", input.payload);
  }

  async appendEvent(sessionId: string, input: DshAppendEventInput): Promise<CanonicalEvent> {
    return this.publish(sessionId, input.type, input.payload);
  }

  async completeAgentRequest(
    sessionId: string,
    _requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<CanonicalEvent> {
    this.completionCounts.set(sessionId, (this.completionCounts.get(sessionId) ?? 0) + 1);
    return this.publish(sessionId, "agent_response", input.payload);
  }

  async commitLocalTurn(
    _sessionId: string,
    _input: CommitLocalTurnInput,
  ): Promise<CommitLocalTurnResult> {
    throw new Error("unused");
  }

  private publish(
    sessionId: string,
    type: CanonicalEvent["type"],
    payload: unknown,
  ): CanonicalEvent {
    this.publicationCounts.set(sessionId, (this.publicationCounts.get(sessionId) ?? 0) + 1);
    const records = this.events.get(sessionId) ?? [];
    const event: CanonicalEvent = {
      id: `${sessionId}-published-${records.length + 1}`,
      sessionId,
      sequence: (records.at(-1)?.sequence ?? 0) + 1,
      type,
      actorId: "actor-1",
      actorDisplayName: "Actor",
      timestamp,
      payload,
    };
    records.push(event);
    this.events.set(sessionId, records);
    return structuredClone(event);
  }
}

class PromptHost implements DshHostFacade {
  readonly sessionId: string;
  readonly #events: DshSessionEventRecord[] = [];
  readonly #eventListeners = new Set<(event: DshSessionEventRecord) => void>();
  readonly #statusListeners = new Set<(status: DshAgentStatus) => void>();
  #promptGate: Promise<void> | undefined;
  #releasePrompt: (() => void) | undefined;
  #disposed = false;
  promptCount = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async open(): Promise<"created"> { return "created"; }
  currentSequence(): number { return this.#events.length; }
  snapshotFrom(sequence: number): readonly DshSessionEventRecord[] {
    return structuredClone(this.#events.slice(sequence));
  }
  async projectCanonicalEvents(): Promise<void> {}
  async flush(): Promise<void> {}

  blockPrompt(): void {
    this.#promptGate = new Promise<void>((resolve) => { this.#releasePrompt = resolve; });
  }

  releasePrompt(): void {
    this.#releasePrompt?.();
    this.#releasePrompt = undefined;
  }

  async prompt(): Promise<DshPromptResult> {
    if (this.#disposed) throw new Error("fake Host disposed");
    this.promptCount += 1;
    const fromSequence = this.currentSequence();
    this.emitStatus("running");
    await this.#promptGate;
    if (this.#disposed) throw new Error("fake Host disposed");
    for (const definition of [
      { type: "turn/start", data: { turn: 1 } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "public final" }] } } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ]) {
      const event = {
        type: definition.type,
        seq: this.#events.length,
        time: Date.parse(timestamp),
        data: definition.data,
      };
      this.#events.push(event);
      for (const listener of this.#eventListeners) listener(event);
    }
    this.emitStatus("idle");
    return {
      fromSequence,
      toSequence: this.currentSequence(),
      events: this.snapshotFrom(fromSequence),
    };
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
    this.#disposed = true;
  }

  private emitStatus(status: DshAgentStatus): void {
    for (const listener of this.#statusListeners) listener(status);
  }
}

function agentRequest(sessionId: string, sequence: number): CanonicalEvent {
  return {
    id: `${sessionId}-request`,
    sessionId,
    sequence,
    type: "agent_request",
    actorId: "actor-1",
    actorDisplayName: "Actor",
    timestamp,
    payload: {
      content: `request for ${sessionId}`,
      execution_profile: {
        harness: "deepseek-harness",
        model: "DeepSeek-CustomCase",
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for manager fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

async function bounded<T>(value: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("manager operation exceeded its time bound")), milliseconds).unref?.();
    }),
  ]);
}
