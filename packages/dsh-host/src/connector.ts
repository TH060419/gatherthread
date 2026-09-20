import { createHash } from "node:crypto";
import { redactText, redactValue } from "@gatherthread/adapters";
import { isSessionWritableBy } from "@gatherthread/bridge";
import {
  buildDshCanonicalPrompt,
  buildDshRequestPrompt,
  extractPublicText,
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
  DshCanonicalProjection,
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
import type {
  LocalConversationSyncStatus,
  LocalConversationUploadResult,
} from "@gatherthread/bridge";

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
  /** Adopt a completed DSH-native Session whose canonical Session was just created. */
  adoptExistingLocalSession?: boolean;
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
  readonly #adoptExistingLocalSession: boolean;
  #state: ConnectorState | undefined;
  #runtime: DshRegisteredRuntime | undefined;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #pollPromise: Promise<DshPollResult> | undefined;
  #localSyncControlPromise: Promise<void> | undefined;
  #heartbeatPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #backgroundFatalError: Error | undefined;
  readonly #lifecycleAbort = new AbortController();
  #listenerDisposers: Array<() => void> = [];
  #activeStatuses: DshAgentStatus[] = [];
  #liveEventSequences = new Set<number>();
  #session: SessionSummary | undefined;
  #visibleState: DshConnectorLifecycleState = "connecting";
  #automaticPolling = false;

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
    this.#adoptExistingLocalSession = options.adoptExistingLocalSession === true;
    if (options.heartbeatIntervalMs !== undefined
      && (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 1)) {
      throw new Error("DSH connector heartbeat interval must be a positive integer");
    }
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  localSyncStatus(): LocalConversationSyncStatus {
    const state = this.#requireState();
    const pendingOperations = state.outbox.filter((operation) => operation.kind === "local_turn");
    const pending = pendingOperations.length;
    const discoverFrom = pendingOperations.reduce(
      (sequence, operation) => Math.max(sequence, operation.dshToSequence),
      state.publishedDshSequence,
    );
    const discoverable = state.activeRequest === undefined
      ? captureCompletedLocalTurns(
        this.#host.snapshotFrom(discoverFrom),
        discoverFrom,
        this.#config.dshSessionId,
      ).turns.length
      : 0;
    return {
      sessionId: this.#config.sessionId,
      localSessionId: this.#config.dshSessionId,
      automaticUpload: state.automaticUpload,
      pendingLocalTurns: pending,
      uploadableLocalTurns: pending + discoverable,
    };
  }

  async setLocalAutoUpload(enabled: boolean): Promise<LocalConversationSyncStatus> {
    const status = await this.#withLocalSyncControl(async () => {
      const state = this.#requireState();
      state.automaticUpload = enabled;
      await this.#stateStore.save(state);
      return this.localSyncStatus();
    });
    if (enabled) await this.pollOnce();
    return enabled ? this.localSyncStatus() : status;
  }

  uploadLocalTurns(): Promise<LocalConversationUploadResult> {
    return this.#withLocalSyncControl(async () => {
      const before = this.localSyncStatus();
      // Retry already-durable operations first, then scan beyond their native
      // sequence so one explicit action uploads every currently eligible turn.
      await this.#flushOutbox(true);
      // A manually recovered turn may have happened before cloud history that
      // arrived while automatic upload was disabled. Its exact base is unknown.
      await this.#captureLocalTurns(0);
      const discoveredLocalTurns = this.localSyncStatus().pendingLocalTurns;
      const pendingBefore = this.localSyncStatus().pendingLocalTurns;
      await this.#flushOutbox(true);
      const after = this.localSyncStatus();
      return {
        ...after,
        discoveredLocalTurns,
        uploadedLocalTurns: Math.max(0, before.pendingLocalTurns + pendingBefore - after.pendingLocalTurns),
      };
    });
  }

  async start(options: DshConnectorStartOptions = {}): Promise<void> {
    if (this.#started) throw new Error("DSH connector is already started");
    if (this.#stopped) throw new Error("DSH connector cannot restart after disposal");
    this.#started = true;
    this.#automaticPolling = options.schedule !== false;
    this.#notifyLifecycle("connecting");
    this.#listenerDisposers.push(this.#host.onSessionEvent((event) => {
      const active = this.#state?.activeRequest;
      if (active !== undefined && event.seq >= active.dshFromSequence) {
        this.#liveEventSequences.add(event.seq);
      }
      if (active === undefined
        && event.type === "turn/end"
        && turnSettlement([event]) === "completed"
        && this.#automaticPolling) {
        queueMicrotask(() => {
          if (this.#started && !this.#stopped) {
            void this.pollOnce().catch((error: unknown) => {
              this.#onBackgroundError?.(publicError(error));
            });
          }
        });
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
          "canonical_history_projection",
          "bidirectional_local_turns",
        ],
        purpose: "execution",
      });
      this.#assertRuntime(this.#runtime);
      this.#notifyLifecycle("idle");
      if (options.schedule !== false) this.#scheduleHeartbeat();
      await this.#flushOutbox(this.#requireState().automaticUpload);
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
    const localSyncControl = this.#localSyncControlPromise;
    if (localSyncControl !== undefined) {
      return localSyncControl.then(() => this.pollOnce());
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

  async #withLocalSyncControl<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#localSyncControlPromise;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const current = (previous ?? Promise.resolve()).then(() => barrier);
    this.#localSyncControlPromise = current;
    try {
      await previous;
      const poll = this.#pollPromise;
      if (poll !== undefined) await poll;
      if (!this.#started || this.#stopped) throw new Error("DSH connector is not running");
      return await operation();
    } finally {
      release();
      if (this.#localSyncControlPromise === current) this.#localSyncControlPromise = undefined;
    }
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
    await this.#flushOutbox(state.automaticUpload);
    await this.#finalizeDeliveredRequest();
    if (state.activeRequest !== undefined) {
      await this.#withExecutionPermit(() => this.#recoverActiveRequest());
      return { scanned: 0, claimed: 0, completed: 1 };
    }

    if (state.automaticUpload) {
      await this.#captureLocalTurns();
      await this.#flushOutbox(true);
    }
    const manualUploadRequired = !state.automaticUpload
      && this.localSyncStatus().uploadableLocalTurns > 0;

    let scanCursor = state.projectionCursor;
    let scanned = 0;
    while (!this.#stopped) {
      const page = await this.#api.readEvents(
        this.#config.sessionId,
        scanCursor,
        this.#config.pollLimit,
      );
      this.#validatePage(page.events, scanCursor);
      const passive: DshCanonicalEvent[] = [];
      for (const event of page.events) {
        scanCursor = Math.max(scanCursor, event.sequence);
        scanned += 1;
        const profile = requestedDshProfile(event);
        if (profile === undefined
          || event.actorId !== this.#requireRuntime().userId
          || (profile.runtimeId !== undefined && profile.runtimeId !== this.#requireRuntime().id)) {
          passive.push(event);
          continue;
        }
        await this.#projectCanonicalBatch(
          passive,
          passive.at(-1)?.sequence ?? state.projectionCursor,
        );
        // Do not run a later cloud request across an unpublished native turn:
        // finalizing that request would advance the native cursor past the
        // private turn and make the user's explicit manual recovery impossible.
        if (manualUploadRequired) {
          return { scanned, claimed: 0, completed: 0 };
        }
        if (profile.provider !== undefined && profile.provider !== this.#config.provider) {
          throw new Error("DeepSeek Harness Agent request provider does not match the configured Host binding");
        }
        if (profile.model !== this.#config.model) {
          throw new Error("DeepSeek Harness Agent request model does not match the configured Host binding");
        }
        // Capacity and this connector's lifecycle gate the entire
        // claim -> prompt -> durable settlement transaction. A lease now bounds
        // how long a request stays ours if this process stops making progress.
        const outcome = await this.#withExecutionPermit(
          () => this.#executeRequest(event),
        );
        return {
          scanned,
          claimed: outcome.claimed ? 1 : 0,
          completed: outcome.completed ? 1 : 0,
        };
      }

      await this.#projectCanonicalBatch(
        passive,
        Math.max(scanCursor, page.hasMore ? scanCursor : page.nextSequence),
      );

      if (!page.hasMore) {
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
      await this.#projectCanonicalBatch([request], request.sequence);
      return { claimed: false, completed: false };
    }
    if (!claim.claimed || claim.status === "completed") {
      await this.#projectCanonicalBatch([request], request.sequence);
      return { claimed: false, completed: false };
    }

    const prompt = buildDshRequestPrompt(request);
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
    const prompt = buildDshRequestPrompt(request);
    const legacyPrompt = buildDshCanonicalPrompt(history, request, this.#requireRuntime().id);
    if (digest(prompt) !== active.promptDigest && digest(legacyPrompt) !== active.promptDigest) {
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

  async #projectCanonicalBatch(
    events: readonly DshCanonicalEvent[],
    throughSequence: number,
  ): Promise<void> {
    const state = this.#requireState();
    if (throughSequence <= state.projectionCursor) return;
    const runtime = this.#requireRuntime();
    const projections: DshCanonicalProjection[] = [];
    for (const event of events) {
      if (event.sequence > throughSequence || event.runtime?.runtimeId === runtime.id) continue;
      const content = boundedPublicText(extractPublicText(event.payload));
      if (!content) continue;
      if (event.type === "human_chat" || event.type === "agent_request") {
        projections.push({
          eventId: event.id,
          canonicalSequence: event.sequence,
          role: "user",
          content,
          occurredAt: event.timestamp,
          ...(event.actorDisplayName === undefined ? {} : {
            actorDisplayName: event.actorDisplayName,
          }),
        });
      } else if (event.type === "agent_response") {
        projections.push({
          eventId: event.id,
          canonicalSequence: event.sequence,
          role: "assistant",
          content,
          occurredAt: event.timestamp,
          ...(event.actorDisplayName === undefined ? {} : {
            actorDisplayName: event.actorDisplayName,
          }),
          ...(event.runtime?.provider === undefined ? {} : { provider: event.runtime.provider }),
          ...(event.runtime?.model === undefined ? {} : { model: event.runtime.model }),
        });
      }
    }
    if (projections.length > 0) {
      // The facade does not resolve until official Session.append() values have
      // been flushed. Cursor advancement therefore proves native durability.
      await this.#host.projectCanonicalEvents(projections);
    }
    state.projectionCursor = Math.max(state.projectionCursor, throughSequence);
    state.serverCursor = Math.max(state.serverCursor, throughSequence);
    await this.#stateStore.save(state);
  }

  async #captureLocalTurns(basedOnSequence?: number): Promise<void> {
    const state = this.#requireState();
    if (state.activeRequest !== undefined || state.outbox.length > 0) return;
    const current = this.#host.currentSequence();
    if (current <= state.publishedDshSequence) return;
    await this.#host.flush();
    const snapshot = this.#host.snapshotFrom(state.publishedDshSequence);
    const capture = captureCompletedLocalTurns(
      snapshot,
      state.publishedDshSequence,
      this.#config.dshSessionId,
    );
    const runtime = this.#requireRuntime();
    state.outbox = capture.turns.map((turn) => ({
      id: turn.localTurnId,
      kind: "local_turn" as const,
      dshToSequence: turn.dshToSequence,
      input: {
        localTurnId: turn.localTurnId,
        runtimeId: runtime.id,
        basedOnSequence: basedOnSequence ?? state.serverCursor,
        occurredAt: turn.occurredAt,
        observedModel: this.#config.model,
        requestPayload: {
          content: turn.request,
          capture_fidelity: "harness_transcript",
          source_harness: "deepseek-harness",
        },
        responsePayload: {
          text: turn.response,
          capture_fidelity: "harness_transcript",
          source_harness: "deepseek-harness",
        },
      },
    }));
    if (state.outbox.length === 0) {
      state.publishedDshSequence = Math.max(
        state.publishedDshSequence,
        capture.safeThroughSequence,
      );
    }
    await this.#stateStore.save(state);
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

  async #flushOutbox(includeLocalTurns = true): Promise<void> {
    const state = this.#requireState();
    const runtime = this.#requireRuntime();
    while (state.outbox.length > 0) {
      const operation = state.outbox[0];
      if (operation === undefined) break;
      if (operation.kind === "local_turn" && !includeLocalTurns) break;
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
      } else if (operation.kind === "complete") {
        await this.#api.completeAgentRequest(
          this.#config.sessionId,
          operation.requestId,
          operation.input,
        );
      } else {
        const result = await this.#api.commitLocalTurn(
          this.#config.sessionId,
          operation.input,
        );
        if (result.localTurnId !== operation.input.localTurnId
          || result.runtimeId !== runtime.id) {
          throw new Error("GatherThread returned an incompatible local-turn acknowledgement");
        }
        state.publishedDshSequence = Math.max(
          state.publishedDshSequence,
          operation.dshToSequence,
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
    state.projectionCursor = Math.max(state.projectionCursor, active.requestSequence);
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
    let cursor = state.projectionCursor;
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
      if (mode === "resumed" && !this.#adoptExistingLocalSession) {
        throw new Error("Persisted DSH Session exists without connector state; refusing ambiguous resume");
      }
      return {
        version: 3,
        binding: {
          projectId: this.#config.projectId,
          sessionId: this.#config.sessionId,
          dshSessionId: this.#config.dshSessionId,
        },
        serverCursor: 0,
        projectionCursor: 0,
        publishedDshSequence: 0,
        automaticUpload: true,
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
    if (stored.publishedDshSequence > this.#host.currentSequence()) {
      throw new Error("Persisted DSH publication cursor exceeds the native Session head");
    }
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

interface CapturedLocalTurn {
  readonly localTurnId: string;
  readonly dshToSequence: number;
  readonly occurredAt: string;
  readonly request: string;
  readonly response: string;
}

function captureCompletedLocalTurns(
  events: readonly DshSessionEventRecord[],
  fromSequence: number,
  dshSessionId: string,
): { turns: CapturedLocalTurn[]; safeThroughSequence: number } {
  const turns: CapturedLocalTurn[] = [];
  let safeThroughSequence = fromSequence;
  let openTurn: DshSessionEventRecord[] | undefined;
  let pendingUser: DshSessionEventRecord | undefined;
  for (const event of events) {
    if (openTurn === undefined) {
      if (event.type === "user/message" && isDirectLocalUserMessage(event)) {
        pendingUser = event;
        continue;
      }
      if (event.type === "turn/start") {
        openTurn = pendingUser === undefined ? [event] : [pendingUser, event];
        continue;
      }
      safeThroughSequence = Math.max(safeThroughSequence, event.seq + 1);
      continue;
    }
    openTurn.push(event);
    if (event.type !== "turn/end") continue;
    if (turnSettlement(openTurn) === "completed") {
      const userEvents = openTurn.filter(isDirectLocalUserMessage);
      const request = boundedPublicText(userEvents
        .map(publicMessageText)
        .filter(Boolean)
        .join("\n\n"));
      const responseEvent = openTurn.findLast(isNativeAssistantMessage);
      const response = responseEvent === undefined
        ? ""
        : boundedPublicText(publicAssistantText(responseEvent));
      if (request && response && userEvents[0] !== undefined) {
        const identity = `${dshSessionId}:${userEvents[0].seq}:${event.seq}`;
        turns.push({
          localTurnId: `dsh:${digest(identity)}`,
          dshToSequence: event.seq + 1,
          occurredAt: sessionTimestamp(event.time),
          request,
          response,
        });
      }
    }
    safeThroughSequence = Math.max(safeThroughSequence, event.seq + 1);
    openTurn = undefined;
    pendingUser = undefined;
  }
  return { turns, safeThroughSequence };
}

/** True only after DSH durably closes a local human/assistant turn successfully. */
export function hasCompletedDshLocalTurn(
  events: readonly DshSessionEventRecord[],
  dshSessionId: string,
): boolean {
  return captureCompletedLocalTurns(events, 0, dshSessionId).turns.length > 0;
}

function isDirectLocalUserMessage(event: DshSessionEventRecord): boolean {
  if (event.type !== "user/message") return false;
  const message = messageObject(event.data);
  const source = asObject(message?.source);
  return source?.kind === "user"
    && typeof message?.id === "string"
    && !message.id.startsWith("gatherthread:");
}

function isNativeAssistantMessage(event: DshSessionEventRecord): boolean {
  if (event.type !== "assistant/message") return false;
  const data = asObject(event.data);
  const message = asObject(data?.message);
  return typeof message?.id !== "string" || !message.id.startsWith("gatherthread:");
}

function publicMessageText(value: DshSessionEventRecord): string {
  return publicContentText(messageObject(value.data)?.content);
}

function publicAssistantText(value: DshSessionEventRecord): string {
  const data = asObject(value.data);
  return publicContentText(asObject(data?.message)?.content);
}

function messageObject(value: unknown): Record<string, unknown> | undefined {
  const data = asObject(value);
  return asObject(data?.message) ?? data;
}

function publicContentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    const item = asObject(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
}

function boundedPublicText(value: string): string {
  const redacted = redactText(value).trim();
  const maximumBytes = 64 * 1_024;
  if (Buffer.byteLength(redacted, "utf8") <= maximumBytes) return redacted;
  const suffix = "\n[TRUNCATED]";
  const target = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = redacted.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(redacted.slice(0, middle), "utf8") <= target) low = middle;
    else high = middle - 1;
  }
  return `${redacted.slice(0, low)}${suffix}`;
}

function sessionTimestamp(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("DSH local turn has an invalid timestamp");
  return date.toISOString();
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
