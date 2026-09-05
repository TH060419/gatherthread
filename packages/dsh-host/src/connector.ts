import { createHash } from "node:crypto";
import { redactValue } from "@gatherthread/adapters";
import { isSessionWritableBy } from "@gatherthread/bridge";
import {
  buildDshCanonicalPrompt,
  requestedDshProfile,
} from "./canonical-prompt.js";
import { isTerminalClaimConflict } from "./collaboration-api.js";
import {
  finalVisibleAssistant,
  mapDshSessionEvents,
} from "./event-mapper.js";
import type { EnabledDshHostConfig } from "./config.js";
import type {
  ConnectorOutboxOperation,
  ConnectorState,
  ConnectorStateStore,
  DshAgentStatus,
  DshCanonicalEvent,
  DshCollaborationApi,
  DshConnectorLifecycleState,
  DshConnectorLifecycleUpdate,
  DshExecutionGate,
  DshHostFacade,
  DshMappedEvent,
  DshRegisteredRuntime,
  DshSessionEventRecord,
} from "./types.js";
import type { SessionSummary } from "@gatherthread/bridge";

export interface DshHostConnectorOptions {
  config: EnabledDshHostConfig;
  api: DshCollaborationApi;
  host: DshHostFacade;
  stateStore: ConnectorStateStore;
  onBackgroundError?: (error: Error) => void;
  heartbeatIntervalMs?: number;
  actorUserId?: string;
  executionGate?: DshExecutionGate;
  onLifecycle?: (update: DshConnectorLifecycleUpdate) => void;
}

export interface DshConnectorStartOptions {
  runImmediately?: boolean;
  schedule?: boolean;
}

export interface DshPollResult {
  scanned: number;
  claimed: number;
  completed: number;
}

/**
 * One project/session binding and one DSH write owner. The connector is not a
 * replacement for GatherThread's bridge: it is an opt-in Host-side runner with
 * its own cursor/outbox and no effect on Codex or Claude processes.
 */
export class DshHostConnector {
  readonly #config: EnabledDshHostConfig;
  readonly #api: DshCollaborationApi;
  readonly #host: DshHostFacade;
  readonly #stateStore: ConnectorStateStore;
  readonly #onBackgroundError: ((error: Error) => void) | undefined;
  readonly #heartbeatIntervalMs: number;
  readonly #actorUserId: string | undefined;
  readonly #executionGate: DshExecutionGate | undefined;
  readonly #onLifecycle: ((update: DshConnectorLifecycleUpdate) => void) | undefined;
  #state: ConnectorState | undefined;
  #runtime: DshRegisteredRuntime | undefined;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #pollPromise: Promise<DshPollResult> | undefined;
  #heartbeatPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #backgroundFatalError: Error | undefined;
  readonly #lifecycleAbort = new AbortController();
  #listenerDisposers: Array<() => void> = [];
  #activeStatuses: DshAgentStatus[] = [];
  #liveEventSequences = new Set<number>();
  #session: SessionSummary | undefined;
  #visibleState: DshConnectorLifecycleState = "connecting";

  constructor(options: DshHostConnectorOptions) {
    if (options.host.sessionId !== options.config.dshSessionId) {
      throw new Error("DSH Host facade Session does not match the configured binding");
    }
    this.#config = options.config;
    this.#api = options.api;
    this.#host = options.host;
    this.#stateStore = options.stateStore;
    this.#onBackgroundError = options.onBackgroundError;
    this.#actorUserId = options.actorUserId;
    this.#executionGate = options.executionGate;
    this.#onLifecycle = options.onLifecycle;
    if (options.heartbeatIntervalMs !== undefined
      && (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 1)) {
      throw new Error("DSH connector heartbeat interval must be a positive integer");
    }
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  async start(options: DshConnectorStartOptions = {}): Promise<void> {
    if (this.#started) throw new Error("DSH connector is already started");
    if (this.#stopped) throw new Error("DSH connector cannot restart after disposal");
    this.#started = true;
    this.#notifyLifecycle("connecting");
    this.#listenerDisposers.push(this.#host.onSessionEvent((event) => {
      const active = this.#state?.activeRequest;
      if (active !== undefined && event.seq >= active.dshFromSequence) {
        this.#liveEventSequences.add(event.seq);
      }
    }));
    this.#listenerDisposers.push(this.#host.onStatus((status) => {
      if (this.#state?.activeRequest === undefined) return;
      if (this.#activeStatuses.at(-1) !== status) this.#activeStatuses.push(status);
      this.#notifyLifecycle(status);
    }));

    try {
      const session = await this.#verifySessionBinding();
      this.#session = session;
      this.#notifyLifecycle("connecting");
      const storedState = await this.#stateStore.load();
      if (storedState !== undefined
        && session.latestSequence !== undefined
        && storedState.serverCursor > session.latestSequence) {
        throw new Error("GatherThread Session head precedes the persisted DSH cursor; refusing identity reuse");
      }
      const mode = await this.#host.open();
      this.#state = this.#reconcileState(storedState, mode);
      await this.#stateStore.save(this.#state);
      this.#runtime = await this.#api.registerRuntime({
        sessionId: this.#config.sessionId,
        deviceId: this.#config.deviceId,
        harness: "deepseek-harness",
        provider: this.#config.provider,
        model: this.#config.model,
        localSessionId: this.#config.dshSessionId,
        captureFidelity: "harness_transcript",
        capabilities: [
          "agent_request",
          "agent_progress",
          "durable_session_events",
          "native_session_resume",
          "outbox_replay",
        ],
        purpose: "execution",
      });
      this.#assertRuntime(this.#runtime);
      this.#notifyLifecycle("idle");
      if (options.schedule !== false) this.#scheduleHeartbeat();
      await this.#flushOutbox();
      await this.#finalizeDeliveredRequest();
      if (this.#state.activeRequest !== undefined) {
        await this.#withExecutionPermit(() => this.#recoverActiveRequest());
      }
      if (options.runImmediately !== false) await this.pollOnce();
      if (this.#backgroundFatalError !== undefined) throw this.#backgroundFatalError;
      if (options.schedule !== false) this.#schedulePoll();
    } catch (error) {
      this.#notifyLifecycle("error");
      await this.stop();
      throw this.#backgroundFatalError ?? error;
    }
  }

  pollOnce(): Promise<DshPollResult> {
    if (!this.#started || this.#stopped) {
      return Promise.reject(new Error("DSH connector is not running"));
    }
    if (this.#pollPromise !== undefined) return this.#pollPromise;
    this.#pollPromise = this.#poll()
      .then((result) => {
        this.#notifyLifecycle(this.#visibleState === "running" ? "running" : "idle", true);
        return result;
      })
      .catch((error: unknown) => {
        if (!this.#stopped) this.#notifyLifecycle("offline");
        throw error;
      })
      .finally(() => {
        this.#pollPromise = undefined;
      });
    return this.#pollPromise;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= (async () => {
      this.#stopped = true;
      this.#notifyLifecycle("stopped");
      this.#lifecycleAbort.abort(new Error("DSH connector stopped"));
      if (this.#timer !== undefined) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
      if (this.#heartbeatTimer !== undefined) {
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = undefined;
      }
      for (const dispose of this.#listenerDisposers.splice(0)) dispose();
      await this.#host.dispose();
      try {
        await this.#pollPromise;
      } catch {
        // The active call was canceled by Host disposal; durable state remains
        // for official resume on the next plugin load.
      }
      try {
        await this.#heartbeatPromise;
      } catch {
        // HTTP abort or a fatal identity mismatch already leaves the connector
        // stopped without changing its durable cursor/outbox.
      }
    })();
    return this.#stopPromise;
  }

  async #poll(): Promise<DshPollResult> {
    const state = this.#requireState();
    await this.#flushOutbox();
    await this.#finalizeDeliveredRequest();
    if (state.activeRequest !== undefined) {
      await this.#withExecutionPermit(() => this.#recoverActiveRequest());
      return { scanned: 0, claimed: 0, completed: 1 };
    }

    let scanCursor = state.serverCursor;
    const pending: DshCanonicalEvent[] = [];
    let scanned = 0;
    while (!this.#stopped) {
      const page = await this.#api.readEvents(
        this.#config.sessionId,
        scanCursor,
        this.#config.pollLimit,
      );
      this.#validatePage(page.events, scanCursor);
      for (const event of page.events) {
        scanCursor = Math.max(scanCursor, event.sequence);
        scanned += 1;
        pending.push(event);
        const profile = requestedDshProfile(event);
        if (profile === undefined || event.actorId !== this.#requireRuntime().userId) continue;
        if (profile.runtimeId !== undefined && profile.runtimeId !== this.#requireRuntime().id) continue;
        if (profile.provider !== undefined && profile.provider !== this.#config.provider) {
          throw new Error("DeepSeek Harness Agent request provider does not match the configured Host binding");
        }
        if (profile.model !== this.#config.model) {
          throw new Error("DeepSeek Harness Agent request model does not match the configured Host binding");
        }
        // The alpha server has no claim-abandon or lease-expiry API. Capacity
        // and this connector's lifecycle therefore gate the entire
        // claim -> prompt -> durable settlement transaction.
        const outcome = await this.#withExecutionPermit(
          () => this.#executeRequest(event, pending),
        );
        return {
          scanned,
          claimed: outcome.claimed ? 1 : 0,
          completed: outcome.completed ? 1 : 0,
        };
      }

      if (!page.hasMore) {
        state.serverCursor = Math.max(state.serverCursor, page.nextSequence, scanCursor);
        await this.#stateStore.save(state);
        return { scanned, claimed: 0, completed: 0 };
      }
      if (page.nextSequence <= scanCursor && page.events.length === 0) {
        throw new Error("GatherThread replay did not advance its cursor");
      }
      scanCursor = Math.max(scanCursor, page.nextSequence);
    }
    throw new Error("DSH connector stopped during event replay");
  }

  async #executeRequest(
    request: DshCanonicalEvent,
    history: readonly DshCanonicalEvent[],
  ): Promise<{ claimed: boolean; completed: boolean }> {
    if (this.#stopped) throw new Error("DSH connector stopped before claiming an Agent request");
    const state = this.#requireState();
    const runtime = this.#requireRuntime();
    let claim;
    try {
      claim = await this.#api.claimAgentRequest(
        this.#config.sessionId,
        request.id,
        runtime.id,
      );
    } catch (error) {
      if (!isTerminalClaimConflict(error)) throw error;
      state.serverCursor = Math.max(state.serverCursor, request.sequence);
      await this.#stateStore.save(state);
      return { claimed: false, completed: false };
    }
    if (!claim.claimed || claim.status === "completed") {
      state.serverCursor = Math.max(state.serverCursor, request.sequence);
      await this.#stateStore.save(state);
      return { claimed: false, completed: false };
    }

    const prompt = buildDshCanonicalPrompt(history, request, runtime.id);
    const baseline = this.#host.currentSequence();
    state.activeRequest = {
      requestId: request.id,
      requestSequence: request.sequence,
      dshFromSequence: baseline,
      promptDigest: digest(prompt),
    };
    this.#activeStatuses = [];
    this.#liveEventSequences.clear();
    await this.#stateStore.save(state);
    const result = await this.#host.prompt(prompt);
    if (result.fromSequence !== baseline || result.toSequence < result.fromSequence) {
      throw new Error("DSH Host prompt returned an inconsistent durable event range");
    }
    this.#assertLiveEventsDurable(result);
    await this.#settleActiveRequest(result.events, result.toSequence);
    return { claimed: true, completed: true };
  }

  async #recoverActiveRequest(): Promise<void> {
    if (this.#stopped) throw new Error("DSH connector stopped before recovering an Agent request");
    const state = this.#requireState();
    const active = state.activeRequest;
    if (active === undefined) return;
    if (active.dshToSequence !== undefined) {
      await this.#flushOutbox();
      await this.#finalizeDeliveredRequest();
      return;
    }
    const history = await this.#readThroughRequest(active.requestId, active.requestSequence);
    const request = history.find((event) => event.id === active.requestId);
    if (request === undefined || request.type !== "agent_request") {
      throw new Error("Active GatherThread request is unavailable during DSH resume");
    }
    const prompt = buildDshCanonicalPrompt(history, request, this.#requireRuntime().id);
    if (digest(prompt) !== active.promptDigest) {
      throw new Error("Active GatherThread request changed during DSH resume");
    }

    const recovered = this.#host.snapshotFrom(active.dshFromSequence);
    const settlement = turnSettlement(recovered);
    if (settlement === "completed") {
      await this.#settleActiveRequest(recovered, this.#host.currentSequence());
      return;
    }
    if (settlement !== undefined && settlement !== "interrupted") {
      throw new Error(`DSH active request ended with unsupported settlement: ${settlement}`);
    }
    if (settlement === undefined && recovered.length > 0) {
      throw new Error("DSH active request has an unclosed durable turn after Host resume");
    }

    const continuation = settlement === "interrupted"
      ? "Continue the interrupted GatherThread request using the DSH Session context already restored by the Host. Return only the public final answer."
      : prompt;
    const baseline = this.#host.currentSequence();
    state.activeRequest = {
      ...active,
      dshFromSequence: baseline,
    };
    this.#activeStatuses = [];
    this.#liveEventSequences.clear();
    await this.#stateStore.save(state);
    const result = await this.#host.prompt(continuation);
    if (result.fromSequence !== baseline || result.toSequence < result.fromSequence) {
      throw new Error("DSH Host recovery prompt returned an inconsistent durable event range");
    }
    this.#assertLiveEventsDurable(result);
    await this.#settleActiveRequest(result.events, result.toSequence);
  }

  async #settleActiveRequest(
    durableEvents: readonly DshSessionEventRecord[],
    toSequence: number,
  ): Promise<void> {
    const state = this.#requireState();
    const active = state.activeRequest;
    if (active === undefined) throw new Error("No active GatherThread request to settle");
    if (turnSettlement(durableEvents) !== "completed") {
      throw new Error("DSH Agent did not durably complete the active turn");
    }
    const mapped = mapDshSessionEvents(durableEvents);
    const final = finalVisibleAssistant(mapped);
    if (final === undefined) {
      throw new Error("DSH Agent completed without a public assistant answer");
    }
    if (state.outbox.length > 0) throw new Error("DSH connector outbox was not empty before settlement");
    state.activeRequest = { ...active, dshToSequence: toSequence };
    state.outbox = this.#outboxFor(mapped, this.#activeStatuses, active.requestId);
    await this.#stateStore.save(state);
    await this.#flushOutbox();
    await this.#finalizeDeliveredRequest();
  }

  #outboxFor(
    events: readonly DshMappedEvent[],
    statuses: readonly DshAgentStatus[],
    requestId: string,
  ): ConnectorOutboxOperation[] {
    const runtime = this.#requireRuntime();
    const prefix = `${this.#config.deviceId}:${digest(requestId).slice(0, 24)}`;
    const operations: ConnectorOutboxOperation[] = [];
    for (const [index, status] of statuses.entries()) {
      const idempotencyKey = `${prefix}:dsh-status-${status}-${index}`;
      operations.push({
        id: idempotencyKey,
        kind: "progress",
        requestId,
        input: {
          runtimeId: runtime.id,
          idempotencyKey,
          payload: {
            content: status === "running"
              ? "DeepSeek Harness started processing the request."
              : "DeepSeek Harness returned to idle.",
            phase: "lifecycle",
            status,
            capture_fidelity: "harness_transcript",
            source_harness: "deepseek-harness",
          },
          observedModel: this.#config.model,
        },
      });
    }
    if (this.#config.shareToolEvents) {
      for (const event of events.filter((item) => item.kind !== "assistant").slice(0, 32)) {
        const idempotencyKey = `${prefix}:${event.localEventId}`;
        const payload = event.kind === "tool_call"
          ? {
            tool_name: event.toolName,
            tool_call_id: event.toolCallId,
            arguments: event.arguments,
            capture_fidelity: "harness_transcript",
            source_harness: "deepseek-harness",
            source_timestamp: event.timestamp,
            dsh_event_sequence: event.sequence,
          }
          : {
            tool_call_id: event.toolCallId,
            result: event.result,
            is_error: event.isError,
            ...(event.errorCode === undefined ? {} : { error_code: event.errorCode }),
            capture_fidelity: "harness_transcript",
            source_harness: "deepseek-harness",
            source_timestamp: event.timestamp,
            dsh_event_sequence: event.sequence,
          };
        operations.push({
          id: idempotencyKey,
          kind: "append",
          input: {
            type: event.kind,
            idempotencyKey,
            payload: redactValue(payload),
            replyTo: requestId,
            runtimeId: runtime.id,
            observedModel: this.#config.model,
          },
        });
      }
    }
    const final = finalVisibleAssistant(events);
    if (final === undefined) throw new Error("No public DSH final answer is available");
    const completionKey = `${prefix}:dsh-complete`;
    operations.push({
      id: completionKey,
      kind: "complete",
      requestId,
      input: {
        runtimeId: runtime.id,
        idempotencyKey: completionKey,
        payload: {
          text: final.content,
          capture_fidelity: "harness_transcript",
          source_harness: "deepseek-harness",
          source_timestamp: final.timestamp,
          dsh_event_sequence: final.sequence,
        },
        observedModel: this.#config.model,
      },
    });
    return operations;
  }

  async #flushOutbox(): Promise<void> {
    const state = this.#requireState();
    const runtime = this.#requireRuntime();
    while (state.outbox.length > 0) {
      const operation = state.outbox[0];
      if (operation === undefined) break;
      if (operation.input.runtimeId !== runtime.id) {
        throw new Error("DSH connector outbox belongs to a different runtime");
      }
      if (operation.kind === "progress") {
        await this.#api.appendAgentProgress(
          this.#config.sessionId,
          operation.requestId,
          operation.input,
        );
      } else if (operation.kind === "append") {
        await this.#api.appendEvent(this.#config.sessionId, operation.input);
      } else {
        await this.#api.completeAgentRequest(
          this.#config.sessionId,
          operation.requestId,
          operation.input,
        );
      }
      state.outbox.shift();
      await this.#stateStore.save(state);
    }
  }

  async #finalizeDeliveredRequest(): Promise<void> {
    const state = this.#requireState();
    const active = state.activeRequest;
    if (active?.dshToSequence === undefined || state.outbox.length > 0) return;
    state.serverCursor = Math.max(state.serverCursor, active.requestSequence);
    state.publishedDshSequence = Math.max(
      state.publishedDshSequence,
      active.dshToSequence,
    );
    delete state.activeRequest;
    this.#activeStatuses = [];
    this.#liveEventSequences.clear();
    await this.#stateStore.save(state);
  }

  async #readThroughRequest(requestId: string, requestSequence: number): Promise<DshCanonicalEvent[]> {
    const state = this.#requireState();
    let cursor = state.serverCursor;
    const events: DshCanonicalEvent[] = [];
    while (true) {
      const page = await this.#api.readEvents(this.#config.sessionId, cursor, this.#config.pollLimit);
      this.#validatePage(page.events, cursor);
      for (const event of page.events) {
        events.push(event);
        cursor = Math.max(cursor, event.sequence);
        if (event.id === requestId) {
          if (event.sequence !== requestSequence) {
            throw new Error("Active GatherThread request sequence changed during DSH resume");
          }
          return events;
        }
      }
      if (!page.hasMore) break;
      if (page.nextSequence <= cursor && page.events.length === 0) {
        throw new Error("GatherThread replay did not advance while recovering an active request");
      }
      cursor = Math.max(cursor, page.nextSequence);
    }
    throw new Error("Active GatherThread request is absent from canonical replay");
  }

  async #verifySessionBinding(): Promise<SessionSummary> {
    const sessions = await this.#api.listProjectSessions(this.#config.projectId);
    const session = sessions.find((candidate) => candidate.id === this.#config.sessionId);
    if (session === undefined || session.projectId !== this.#config.projectId) {
      throw new Error("Configured GatherThread Session is not in the configured Project");
    }
    if (session.state !== "active") throw new Error("Configured GatherThread Session is archived");
    if (!isSessionWritableBy(session, this.#actorUserId)) {
      throw new Error("Configured GatherThread Session is not writable by the current actor");
    }
    return session;
  }

  #withExecutionPermit<T>(operation: () => Promise<T>): Promise<T> {
    return this.#executionGate?.run(operation, this.#lifecycleAbort.signal) ?? operation();
  }

  #reconcileState(
    stored: ConnectorState | undefined,
    mode: "created" | "resumed",
  ): ConnectorState {
    if (stored === undefined) {
      if (mode === "resumed") {
        throw new Error("Persisted DSH Session exists without connector state; refusing ambiguous resume");
      }
      return {
        version: 1,
        binding: {
          projectId: this.#config.projectId,
          sessionId: this.#config.sessionId,
          dshSessionId: this.#config.dshSessionId,
        },
        serverCursor: 0,
        publishedDshSequence: 0,
        outbox: [],
      };
    }
    if (mode === "created") {
      throw new Error("Connector state exists without its persisted DSH Session; refusing identity reuse");
    }
    const expected = JSON.stringify([
      this.#config.projectId,
      this.#config.sessionId,
      this.#config.dshSessionId,
    ]);
    const actual = JSON.stringify([
      stored.binding.projectId,
      stored.binding.sessionId,
      stored.binding.dshSessionId,
    ]);
    if (actual !== expected) throw new Error("DSH connector state belongs to a different binding");
    return stored;
  }

  #assertRuntime(runtime: DshRegisteredRuntime): void {
    if (runtime.sessionId !== this.#config.sessionId
      || runtime.deviceId !== this.#config.deviceId
      || runtime.harness !== "deepseek-harness"
      || runtime.provider !== this.#config.provider
      || runtime.model !== this.#config.model
      || runtime.localSessionId !== this.#config.dshSessionId
      || runtime.captureFidelity !== "harness_transcript"
      || runtime.purpose !== "execution") {
      throw new Error("GatherThread returned an incompatible DSH runtime registration");
    }
  }

  #validatePage(events: readonly DshCanonicalEvent[], afterSequence: number): void {
    let previous = afterSequence;
    for (const event of events) {
      if (event.sessionId !== this.#config.sessionId
        || !Number.isSafeInteger(event.sequence)
        || event.sequence <= previous) {
        throw new Error("GatherThread returned an invalid or unordered canonical replay page");
      }
      previous = event.sequence;
    }
  }

  #assertLiveEventsDurable(result: {
    fromSequence: number;
    toSequence: number;
    events: readonly DshSessionEventRecord[];
  }): void {
    const durable = new Set(result.events.map((event) => event.seq));
    for (const sequence of this.#liveEventSequences) {
      if (sequence >= result.fromSequence
        && sequence < result.toSequence
        && !durable.has(sequence)) {
        throw new Error("A live DSH SessionEvent was absent from the flushed durable snapshot");
      }
    }
  }

  #schedulePoll(): void {
    if (this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        this.#onBackgroundError?.(publicError(error));
      });
    }, this.#config.pollIntervalMs);
    this.#timer.unref?.();
  }

  #scheduleHeartbeat(): void {
    if (this.#stopped) return;
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat().catch((error: unknown) => {
        const publicFailure = publicError(error);
        this.#notifyLifecycle(error instanceof RuntimeIdentityError ? "error" : "offline");
        this.#onBackgroundError?.(publicFailure);
        if (error instanceof RuntimeIdentityError) {
          this.#backgroundFatalError = publicFailure;
          void this.stop();
        }
      });
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #heartbeat(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("DSH connector is not running"));
    if (this.#heartbeatPromise !== undefined) return this.#heartbeatPromise;
    const current = this.#requireRuntime();
    this.#heartbeatPromise = (async () => {
      const refreshed = await this.#api.heartbeatRuntime(current.id);
      if (refreshed.id !== current.id) {
        throw new RuntimeIdentityError("GatherThread changed the DSH runtime identity during heartbeat");
      }
      try {
        this.#assertRuntime(refreshed);
      } catch {
        throw new RuntimeIdentityError("GatherThread returned incompatible DSH runtime heartbeat data");
      }
    })().finally(() => {
      this.#heartbeatPromise = undefined;
    });
    return this.#heartbeatPromise;
  }

  #requireState(): ConnectorState {
    if (this.#state === undefined) throw new Error("DSH connector state is unavailable");
    return this.#state;
  }

  #requireRuntime(): DshRegisteredRuntime {
    if (this.#runtime === undefined) throw new Error("DSH connector runtime is unavailable");
    return this.#runtime;
  }

  #notifyLifecycle(state: DshConnectorLifecycleState, synced = false): void {
    this.#visibleState = state;
    try {
      this.#onLifecycle?.({
        state,
        ...(this.#session === undefined ? {} : { session: this.#session }),
        ...(synced ? { synced: true } : {}),
      });
    } catch {
      // Status projection is observational and must never affect execution.
    }
  }
}

class RuntimeIdentityError extends Error {}

function turnSettlement(events: readonly DshSessionEventRecord[]): string | undefined {
  const event = events.findLast((candidate) => candidate.type === "turn/end");
  if (event === undefined) return undefined;
  const data = asObject(event.data);
  const reason = asObject(data?.reason);
  return typeof reason?.kind === "string" ? reason.kind : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error("DeepSeek Harness connector background operation failed");
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
