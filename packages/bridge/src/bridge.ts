import { createHash, randomUUID } from "node:crypto";
import {
  ClaudeCodeProjectAdapter,
  CodexRolloutAdapter,
  discoverJsonlTranscripts,
  redactText,
  redactValue,
  redactTranscriptEvent,
  resolveAuthorizedPath,
  tailJsonlTranscript,
  type HarnessName,
  type RedactionOptions,
  type TranscriptAdapter,
  type TranscriptEvent,
  type TranscriptFile,
} from "@gatherthread/adapters";
import type { CursorStore } from "./cursors.js";
import type {
  AppendEventInput,
  CanonicalEvent,
  CollaborationApi,
  ContextSnapshot,
  HarnessExecutionResult,
  HarnessExecutor,
  RegisteredRuntime,
  RuntimeProvenance,
  RuntimeRegistration,
} from "./types.js";
import { CollaborationHttpError } from "./http-client.js";
import { createAgentExecutionWatch, isDefinitiveAgentExecutionRejection } from "./agent-execution-control.js";
import { recoverNativeExecutionReceipts, flushNativeExecutionReceipts } from "./native-stop-receipts.js";

export class HarnessExecutionTerminatedError extends Error {
  readonly failureCode: string;
  readonly publicMessage: string;

  constructor(failureCode: string, message: string, options?: ErrorOptions) {
    const safeCode = /^[a-z0-9_]{1,64}$/.test(failureCode) ? failureCode : "harness_execution_failed";
    const safeMessage = redactText(message).replace(/[\r\n]+/g, " ").slice(0, 400) || "The local harness ended without a response";
    super(safeMessage, options);
    this.name = "HarnessExecutionTerminatedError";
    this.failureCode = safeCode;
    this.publicMessage = safeMessage;
  }
}

/** Refusing a competing or indeterminate native writer is not an exit receipt. */
export class HarnessExecutionUnconfirmedError extends Error {
  constructor(message: string) { super(message); this.name = "HarnessExecutionUnconfirmedError"; }
}

export interface LocalBridgeOptions {
  api: CollaborationApi;
  cursorStore: CursorStore;
  runtime: RuntimeRegistration;
  transcriptRoots: Partial<Record<HarnessName, readonly string[]>>;
  redaction?: RedactionOptions;
  allowProviderRequestCapture?: boolean;
}

export interface TranscriptImportResult {
  appended: CanonicalEvent[];
  malformedLines: number;
}

export class LocalBridge {
  readonly #api: CollaborationApi;
  readonly #cursorStore: CursorStore;
  readonly #runtimeConfig: RuntimeRegistration;
  readonly #transcriptRoots: Partial<Record<HarnessName, readonly string[]>>;
  readonly #redaction: RedactionOptions;
  readonly #allowProviderRequestCapture: boolean;
  readonly #adapters: Record<HarnessName, TranscriptAdapter>;
  #runtime?: RegisteredRuntime;

  constructor(options: LocalBridgeOptions) {
    this.#api = options.api;
    this.#cursorStore = options.cursorStore;
    this.#runtimeConfig = options.runtime;
    this.#transcriptRoots = options.transcriptRoots;
    this.#redaction = options.redaction ?? {};
    this.#allowProviderRequestCapture = options.allowProviderRequestCapture === true;
    this.#adapters = {
      codex: new CodexRolloutAdapter(),
      "claude-code": new ClaudeCodeProjectAdapter(),
    };
  }

  get runtime(): RegisteredRuntime | undefined {
    return this.#runtime;
  }

  async connect(executor?: HarnessExecutor): Promise<RegisteredRuntime> {
    await recoverNativeExecutionReceipts(this.#api, this.#cursorStore, executor);
    this.#runtime = await this.#api.registerRuntime(this.#runtimeConfig);
    return this.#runtime;
  }

  async heartbeat(): Promise<RegisteredRuntime> {
    const runtime = this.#requireRuntime();
    if (!this.#api.heartbeatRuntime) return runtime;
    this.#runtime = await this.#api.heartbeatRuntime(runtime.id);
    return this.#runtime;
  }

  async discoverTranscripts(harness: HarnessName, maxFiles?: number): Promise<TranscriptFile[]> {
    return discoverJsonlTranscripts(
      harness,
      this.#transcriptRoots[harness] ?? [],
      maxFiles === undefined ? {} : { maxFiles },
    );
  }

  async readServerIncrement(sessionId: string, limit = 200): Promise<CanonicalEvent[]> {
    this.#assertRuntimeSession(sessionId);
    const state = await this.#cursorStore.load();
    const afterSequence = state.server[sessionId] ?? 0;
    const page = await this.#api.readEvents(sessionId, afterSequence, limit);
    const nextSequence = Math.max(afterSequence, page.nextSequence);
    await this.#saveServerCursor(sessionId, nextSequence);
    return page.events;
  }

  async processPendingAgentRequests(
    executor: HarnessExecutor,
    limit = 200,
  ): Promise<{ examined: number; claimed: number; completed: number }> {
    const runtime = this.#requireRuntime();
    const state = await this.#cursorStore.load();
    const afterSequence = state.server[runtime.sessionId] ?? 0;
    const page = await this.#api.readEvents(runtime.sessionId, afterSequence, limit);
    let cursor = afterSequence;
    let claimed = 0;
    let completed = 0;
    for (const event of page.events) {
      if (event.sequence <= cursor) continue;
      if (event.sessionId !== runtime.sessionId) {
        throw new Error("Collaboration API returned an event for a different session");
      }
      if (event.type === "agent_request" && !event.deleted
        && !(event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) && "shared_agent" in event.payload)) {
        const shouldExecute = event.actorId === runtime.userId
          && (executor.shouldExecute === undefined || await executor.shouldExecute(event, runtime));
        if (shouldExecute) {
          try {
            const result = await this.processAgentRequest(event, executor);
            if (result.claimed) {
              claimed += 1;
              completed += result.completed.length;
            }
          } catch (error) {
            if (!isTerminalAgentRequestClaimConflict(error)) throw error;
            const canonicallyClosed = error instanceof CollaborationHttpError
              && (error.code === "agent_request_failed" || error.code === "agent_request_already_completed");
            if (!executor.projectCanonicalEvents && !canonicallyClosed) {
              throw new Error("Agent request was claimed by another runtime but this executor cannot project the canonical request safely");
            }
            await executor.projectCanonicalEvents?.([event], runtime);
          }
        } else if (executor.projectCanonicalEvents) {
          await executor.projectCanonicalEvents([event], runtime);
        }
      } else if (executor.projectCanonicalEvents) {
        await executor.projectCanonicalEvents([event], runtime);
      }
      cursor = event.sequence;
      await this.#saveServerCursor(runtime.sessionId, cursor);
    }
    const nextCursor = Math.max(cursor, page.nextSequence);
    if (nextCursor !== cursor) {
      await this.#saveServerCursor(runtime.sessionId, nextCursor);
    }
    return { examined: page.events.length, claimed, completed };
  }

  async materializeAuthoritativeHistory(
    executor: HarnessExecutor,
    throughSequence: number,
    limit = 200,
  ): Promise<number> {
    const runtime = this.#requireRuntime();
    if (!executor.projectCanonicalEvents) return 0;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("Authoritative materialization cursor must be a non-negative safe integer");
    }
    const state = await this.#cursorStore.load();
    let cursor = state.server[runtime.sessionId] ?? 0;
    if (executor.prepareCanonicalProjection) {
      const nativeCursor = await executor.prepareCanonicalProjection(runtime);
      if (!Number.isSafeInteger(nativeCursor) || nativeCursor < 0) {
        throw new Error("Harness native projection cursor must be a non-negative safe integer");
      }
      if (nativeCursor < cursor) {
        cursor = nativeCursor;
        await this.#saveServerCursor(runtime.sessionId, cursor, false);
      }
    }
    while (cursor < throughSequence) {
      const page = await this.#api.readEvents(runtime.sessionId, cursor, limit);
      const events = page.events.filter((event) => event.sequence > cursor && event.sequence <= throughSequence);
      for (const event of events) {
        if (event.sessionId !== runtime.sessionId) {
          throw new Error("Collaboration API returned an event for a different session");
        }
        await executor.projectCanonicalEvents([event], runtime);
        cursor = event.sequence;
        await this.#saveServerCursor(runtime.sessionId, cursor);
      }
      const coveredThrough = Math.min(throughSequence, page.nextSequence);
      if (coveredThrough > cursor && (!page.hasMore || events.length === 0)) {
        cursor = coveredThrough;
        await this.#saveServerCursor(runtime.sessionId, cursor);
      }
      if (events.length === 0 && coveredThrough <= cursor) {
        throw new Error("Collaboration API did not advance authoritative history materialization");
      }
    }
    return cursor;
  }

  async importTranscript(
    sessionId: string,
    harness: HarnessName,
    transcriptPath: string,
  ): Promise<TranscriptImportResult> {
    const runtime = this.#requireRuntime();
    this.#assertRuntimeSession(sessionId);
    this.#assertRuntimeFidelity("harness_transcript");
    const roots = this.#transcriptRoots[harness] ?? [];
    const authorizedPath = await resolveAuthorizedPath(transcriptPath, roots);
    const state = await this.#cursorStore.load();
    const cursorKey = localCursorKey(harness, authorizedPath);
    const tail = await tailJsonlTranscript(
      this.#adapters[harness],
      authorizedPath,
      state.local[cursorKey],
      { authorizedRoots: roots },
    );

    const appended: CanonicalEvent[] = [];
    for (const rawEvent of tail.events) {
      const event = redactTranscriptEvent(rawEvent, this.#redaction);
      appended.push(await this.#api.appendEvent(
        sessionId,
        toAppendEvent(event, runtime, authorizedPath),
      ));
    }

    const latest = await this.#cursorStore.load();
    await this.#cursorStore.save({ ...latest, local: { ...latest.local, [cursorKey]: tail.cursor } });
    return { appended, malformedLines: tail.malformedLines };
  }

  async uploadContextSnapshot(
    sessionId: string,
    snapshot: ContextSnapshot,
    idempotencyKey = randomUUID(),
  ): Promise<CanonicalEvent> {
    const runtime = this.#requireRuntime();
    this.#assertRuntimeSession(sessionId);
    if (snapshot.captureFidelity === "provider_request") {
      if (!this.#allowProviderRequestCapture || snapshot.exactProviderRequest !== true) {
        throw new Error(
          "provider_request uploads require explicit bridge authorization and an exact hook/proxy observation",
        );
      }
    }
    this.#assertRuntimeFidelity(snapshot.captureFidelity);

    const payload = snapshot.captureFidelity === "canonical_history"
      ? {
        capture_fidelity: snapshot.captureFidelity,
        content: snapshot.content,
        covers_through_sequence: snapshot.coversThroughSequence,
      }
      : snapshot.captureFidelity === "harness_transcript"
        ? {
          capture_fidelity: snapshot.captureFidelity,
          content: snapshot.content,
          local_session_id: snapshot.localSessionId,
        }
        : {
          capture_fidelity: snapshot.captureFidelity,
          content: snapshot.content,
          exact_provider_request: snapshot.exactProviderRequest,
          observed_by: snapshot.observedBy,
        };
    return this.#api.appendEvent(sessionId, {
      type: "context_snapshot",
      idempotencyKey,
      payload: redactValue(payload, this.#redaction),
      runtimeId: runtime.id,
      runtime: provenance(runtime, snapshot.captureFidelity),
    });
  }

  async processAgentRequest(
    request: CanonicalEvent,
    executor: HarnessExecutor,
  ): Promise<{ claimed: boolean; completed: CanonicalEvent[] }> {
    if (request.type !== "agent_request") throw new Error("Expected an agent_request event");
    const runtime = this.#requireRuntime();
    this.#assertRuntimeSession(request.sessionId);
    this.#assertRuntimeFidelity("harness_transcript");
    const team = request.payload !== null && typeof request.payload === "object" && "agent_team" in request.payload;
    const executionControlVersion = team ? executor.executionControlVersion : undefined;
    if (team && (executionControlVersion !== 1 || !this.#api.readAgentExecution || !this.#api.acknowledgeAgentExecutionStopped)) {
      throw new CollaborationHttpError(409, "This executor cannot safely run native Teams; update its execution control and recovery support", "connector_update_required");
    }
    await recoverNativeExecutionReceipts(this.#api, this.#cursorStore, executor);
    const claim = await this.#api.claimAgentRequest(request.sessionId, request.id, runtime.id, executionControlVersion);
    if (!claim.claimed) {
      if (claim.status === "completed" || claim.status === "paused") await executor.acknowledgeCanonicalCompletion?.(request, runtime, claim.attemptCount ?? 1);
      return { claimed: false, completed: [] };
    }
    const claimAttempt = claim.attemptCount ?? 1;
    let watch: ReturnType<typeof setInterval> | undefined;
    let executionWatch: ReturnType<typeof createAgentExecutionWatch> | undefined;
    const controller = new AbortController();
    let executionStopped = false;
    // Only Team claims reserve the separate native-execution capacity hold.
    try {
    const canonicalHistory = await this.#readCanonicalHistory(request.sessionId, request.sequence);
    const authoritativeRequest = canonicalHistory.find((event) => event.id === request.id);
    if (request.deleted || authoritativeRequest?.deleted) throw new CollaborationHttpError(409, "Shared history changed; the request was deleted", "context_changed");
    request = authoritativeRequest ?? request;
    // Freeze derived context before the current request. Summary generation is
    // still an explicitly claimed normal local-Agent turn; no other member's
    // runtime is ever borrowed. Older servers without summary records retain
    // their old raw-history behavior, but a marked session must never silently
    // inject originals when its derived-context capability is unavailable.
    const summaryGeneration = request.payload !== null && typeof request.payload === "object"
      && "history_summary" in request.payload;
    const hasSummaryHistory = canonicalHistory.some((event) => event.type === "agent_request"
      && event.payload !== null && typeof event.payload === "object" && "history_summary" in event.payload);
    const deletionAware = (claim.contentRevision ?? request.contentRevision ?? 0) > 0
      || canonicalHistory.some((event) => event.deleted || event.type === "message_deleted");
    if ((hasSummaryHistory || deletionAware) && !this.#api.readContext) {
      throw new Error("This connector cannot read GatherThread's summarized context; update the connector before continuing.");
    }
    const readContext = this.#api.readContext
      ? await this.#api.readContext(request.sessionId, undefined, request.sequence - 1) : undefined;
    const revision = claim.contentRevision ?? request.contentRevision ?? 0;
    if (readContext && (readContext.content_revision ?? 0) !== revision) throw new CollaborationHttpError(409,
      "Shared history changed after this request was claimed; start a new request", "context_changed");
    const historyContext = summaryGeneration
      ? { view: "summary" as const, through_sequence: request.sequence - 1, items: [], content_revision: readContext?.content_revision ?? revision }
      : readContext;
    let controlTerminated = false;
    let controlCheck: Promise<void> | undefined;
    const contextChanged = () => new CollaborationHttpError(409, "Shared history changed; start a new request with current history", "context_changed");
    // Claim re-reads observe the ordinary author's Pause control. Presence alone
    // does not renew the claim; only accepted work progress does that on the server.
    const checkControl = (): Promise<void> => {
      // Team execution has its own exact-attempt observer below. Re-claiming it
      // through the ordinary compatibility path would omit its control version.
      if (team) return Promise.resolve();
      if (controlCheck || controller.signal.aborted) return controlCheck ?? Promise.resolve();
      controlCheck = (async () => {
        try {
          const current = await this.#api.claimAgentRequest(request.sessionId, request.id, runtime.id);
          if (current.requestId !== request.id || current.runtimeId !== runtime.id
            || (current.attemptCount ?? 1) !== claimAttempt) { controller.abort(contextChanged()); return; }
          if (current.status === "paused" || current.status === "completed") {
            controlTerminated = true;
            controller.abort(new Error("The author stopped this Agent request"));
          }
        } catch (error) {
          if (error instanceof CollaborationHttpError && [401, 403, 404, 409].includes(error.status)) controller.abort(contextChanged());
          // A transient read failure does not grant a new claim or fabricate a pause.
        }
      })().finally(() => { controlCheck = undefined; });
      return controlCheck;
    };
    let checking = false;
    const checkRevision = async () => {
      if (!this.#api.readContext || checking || controller.signal.aborted) return;
      checking = true;
      try {
        const page = await this.#api.readEvents(request.sessionId, request.sequence, 1);
        const current = page.contentRevision ?? (await this.#api.readContext(request.sessionId, undefined, request.sequence - 1)).content_revision ?? 0;
        if (current !== revision) controller.abort(contextChanged());
      } catch (error) {
        if (error instanceof CollaborationHttpError && [401, 403, 404].includes(error.status)) controller.abort(contextChanged());
      } finally { checking = false; }
    };
    watch = setInterval(() => { void checkRevision(); void checkControl(); }, 1000);
    watch?.unref();
    if (team && !this.#api.acknowledgeAgentExecutionStopped) throw new CollaborationHttpError(409,
      "Update the connector to support native Team cancellation", "connector_update_required");
    executionWatch = createAgentExecutionWatch({ controller, required: team,
      ...(this.#api.readAgentExecution === undefined ? {} : {
        read: () => this.#api.readAgentExecution!(request.sessionId, request.id, runtime.id, claimAttempt),
      }),
    });
    await executionWatch.check(); executionWatch.assertReady();
    await this.#appendProgressFailSoft(request, runtime, claimAttempt, {
      idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:${claimAttempt}:progress:start`,
      payload: {
        content: "Agent started processing the request.",
        phase: "lifecycle",
        status: "started",
        capture_fidelity: "harness_transcript",
        source_harness: runtime.harness,
      },
    });
    let execution: HarnessExecutionResult;
    try {
      execution = await executor.execute({
        request,
        canonicalHistory,
        ...(historyContext === undefined ? {} : { historyContext }),
        runtime,
        claimAttempt,
        signal: controller.signal,
        ...(this.#api.appendAgentProgress === undefined ? {} : {
          publishProgress: async (update) => {
            controller.signal.throwIfAborted();
            const redacted = redactText(update.content);
            if (!redacted.trim() && update.plan === undefined) return false;
            // A streamed fragment is one slice of a longer message. Trimming it
            // would delete the whitespace that joins it to its neighbours and
            // silently corrupt the reader's merged view, so it travels verbatim.
            const content = update.phase === "stream" ? redacted : redacted.trim();
            try { return await this.#appendProgressFailSoft(request, runtime, claimAttempt, {
              idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:${claimAttempt}:progress:${hash(update.id)}`,
              payload: redactValue({
                content,
                phase: update.phase ?? "commentary",
                ...(update.status === undefined ? {} : { status: update.status }),
                ...(update.streamId === undefined ? {} : { stream_id: update.streamId }),
                ...(update.streamMode === undefined ? {} : { stream_mode: update.streamMode }),
                ...(update.streamKind === undefined ? {} : { stream_kind: update.streamKind }),
                ...(update.streamRevision === undefined ? {} : { stream_revision: update.streamRevision }),
                ...(update.streamState === undefined ? {} : { stream_state: update.streamState }),
                ...(update.title === undefined ? {} : { title: update.title }),
                ...(update.plan === undefined ? {} : { plan: update.plan }),
                ...(update.occurredAt === undefined ? {} : { occurred_at: update.occurredAt }),
                capture_fidelity: "harness_transcript",
                source_harness: runtime.harness,
              }, this.#redaction),
            }); } catch (error) {
              if (isDefinitiveAgentExecutionRejection(error)) controller.abort(error);
              throw error;
            }
          },
        }),
      });
      executionStopped = true;
    } catch (error) {
      // Preparation/transport refusal alone cannot prove that an earlier
      // owner of this idempotent claim has stopped its native turn.
      executionStopped = error instanceof HarnessExecutionTerminatedError;
      if (controlTerminated) return { claimed: true, completed: [] };
      controller.signal.throwIfAborted();
      if (!(error instanceof HarnessExecutionTerminatedError)) throw error;
      const failure = await this.#api.completeAgentRequest(request.sessionId, request.id, {
        runtimeId: runtime.id,
        claimAttempt,
        contentRevision: revision,
        idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:complete`,
        payload: {
          text: `Agent execution failed: ${error.publicMessage}`,
          status: "failed",
          error: { code: error.failureCode, message: error.publicMessage },
          capture_fidelity: "harness_transcript",
          source_harness: runtime.harness,
        },
      });
      await executor.acknowledgeCanonicalCompletion?.(request, runtime, claimAttempt);
      return { claimed: true, completed: [failure] };
    }
    await checkControl();
    if (controlTerminated) return { claimed: true, completed: [] };
    if (this.#api.readContext) {
      const finalContext = await this.#api.readContext(request.sessionId, undefined, request.sequence - 1);
      if ((finalContext.content_revision ?? 0) !== revision) controller.abort(contextChanged());
    }
    await executionWatch.check(); controller.signal.throwIfAborted();
    const events = execution.events.map((event) => {
      if (event.captureFidelity !== "harness_transcript") {
        throw new Error("Harness execution output must be labelled harness_transcript");
      }
      if (event.kind === "user") {
        throw new Error("Harness execution output cannot append a user-authored event");
      }
      return toAppendEvent(redactTranscriptEvent(event, this.#redaction), {
        ...runtime,
        localSessionId: execution.localSessionId ?? runtime.localSessionId,
      }, request.id, execution, { requestId: request.id, claimAttempt, contentRevision: revision });
    });
    const responseEvents = events.filter((event) => event.type === "agent_response");
    if (responseEvents.length === 0) throw new Error("Harness execution did not produce an assistant response");
    const completed: CanonicalEvent[] = [];
    for (const event of events.filter((item) => item.type !== "agent_response")) {
      completed.push(await this.#api.appendEvent(request.sessionId, event));
    }
    const responsePayload = responseEvents.length === 1
      ? responseEvents[0]?.payload
      : { transcript_events: responseEvents.map((event) => event.payload) };
    completed.push(await this.#api.completeAgentRequest(request.sessionId, request.id, {
      runtimeId: runtime.id,
      claimAttempt,
      contentRevision: revision,
      idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:complete`,
      payload: responsePayload,
      ...(execution.observedModel === undefined ? {} : { observedModel: execution.observedModel }),
      ...(execution.observedReasoningEffort === undefined ? {} : { observedReasoningEffort: execution.observedReasoningEffort }),
    }));
    await executor.acknowledgeCanonicalCompletion?.(request, runtime, claimAttempt);
    return { claimed: true, completed };
    } finally {
      if (watch) clearInterval(watch);
      await executionWatch?.close();
      // execute() is required to settle only after its owned native execution
      // has exited. Publication rejection alone must never free native capacity.
      if (executionStopped && team && this.#api.acknowledgeAgentExecutionStopped && (!executionWatch || executionWatch.supported())) {
        const state = await this.#cursorStore.load();
        const receipt = { sessionId: request.sessionId, requestId: request.id, runtimeId: runtime.id, claimAttempt };
        const receipts = state.stoppedExecutions ?? [];
        if (!receipts.some((item) => JSON.stringify(item) === JSON.stringify(receipt))) receipts.push(receipt);
        if (receipts.length > 1000) throw new Error("Native execution stop receipt capacity exhausted");
        await this.#cursorStore.save({ ...state, stoppedExecutions: receipts });
        await flushNativeExecutionReceipts(this.#api, this.#cursorStore, executor);
      }
    }
  }

  async #saveServerCursor(sessionId: string, sequence: number, monotonic = true): Promise<void> {
    // Native exit receipts can change while canonical transport/projection is
    // awaiting I/O. Persist only this cursor over the latest private state.
    const latest = await this.#cursorStore.load();
    await this.#cursorStore.save({ ...latest, server: { ...latest.server,
      [sessionId]: monotonic ? Math.max(latest.server[sessionId] ?? 0, sequence) : sequence } });
  }

  async #appendProgressFailSoft(
    request: CanonicalEvent,
    runtime: RegisteredRuntime,
    claimAttempt: number,
    input: { idempotencyKey: string; payload: unknown },
  ): Promise<boolean> {
    if (this.#api.appendAgentProgress === undefined) return false;
    try {
      await this.#api.appendAgentProgress(request.sessionId, request.id, {
        runtimeId: runtime.id,
        claimAttempt,
        contentRevision: request.contentRevision ?? 0,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      });
      return true;
    } catch (error) {
      if (isDefinitiveAgentExecutionRejection(error)) throw error;
      // Progress is supplementary. A transient progress upload failure must not
      // strand an already-claimed request before its canonical final response.
      return false;
    }
  }

  async #readCanonicalHistory(sessionId: string, throughSequence: number): Promise<CanonicalEvent[]> {
    const history: CanonicalEvent[] = [];
    let cursor = 0;
    do {
      const page = await this.#api.readEvents(sessionId, cursor, 500);
      const relevant = page.events.filter((event) => event.sequence <= throughSequence);
      history.push(...relevant);
      if (relevant.length < page.events.length || !page.hasMore) break;
      const next = Math.min(page.nextSequence, throughSequence);
      if (next <= cursor) break;
      cursor = next;
    } while (cursor < throughSequence);
    return history;
  }

  #requireRuntime(): RegisteredRuntime {
    if (!this.#runtime) throw new Error("Bridge is not connected; call connect() first");
    return this.#runtime;
  }

  #assertRuntimeSession(sessionId: string): void {
    const runtime = this.#requireRuntime();
    if (runtime.sessionId !== sessionId) {
      throw new Error(`Runtime ${runtime.id} is registered for a different session`);
    }
  }

  #assertRuntimeFidelity(captureFidelity: RuntimeProvenance["captureFidelity"]): void {
    const runtime = this.#requireRuntime();
    if (runtime.captureFidelity !== captureFidelity) {
      throw new Error(
        `Runtime ${runtime.id} is registered as ${runtime.captureFidelity}, not ${captureFidelity}`,
      );
    }
  }
}

/**
 * A claim conflict the server has already resolved. `agent_request_failed` means
 * the server exhausted its re-dispatch budget, so the request is finished as far
 * as this connector is concerned: projecting the canonical failure and moving on
 * is the only correct response, and retrying would spin on it every poll.
 */
function isTerminalAgentRequestClaimConflict(error: unknown): boolean {
  return error instanceof CollaborationHttpError
    && error.status === 409
    && (error.code === "agent_request_already_claimed"
      || error.code === "agent_request_already_completed"
      || error.code === "agent_request_failed");
}

function toAppendEvent(
  event: TranscriptEvent,
  runtime: RegisteredRuntime,
  source: string,
  execution?: Pick<HarnessExecutionResult, "observedModel" | "observedReasoningEffort">,
  claim?: { requestId: string; claimAttempt: number; contentRevision: number },
): AppendEventInput {
  const eventType = {
    user: "human_chat",
    assistant: "agent_response",
    tool_call: "tool_call",
    tool_result: "tool_result",
  }[event.kind] as AppendEventInput["type"];
  return {
    type: eventType,
    idempotencyKey: `${runtime.deviceId}:${hash(source)}:${event.localEventId}`,
    payload: compact({
      text: event.content,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      arguments: event.arguments,
      result: event.result,
      is_error: event.isError,
      imported: true,
      capture_fidelity: event.captureFidelity,
      source_harness: event.harness,
      source_timestamp: event.timestamp,
    }),
    runtime: provenance(runtime, event.captureFidelity),
    runtimeId: runtime.id,
    ...(claim === undefined ? {} : {
      replyTo: claim.requestId,
      claimAttempt: claim.claimAttempt,
      contentRevision: claim.contentRevision,
    }),
    ...(execution?.observedModel === undefined ? {} : { observedModel: execution.observedModel }),
    ...(execution?.observedReasoningEffort === undefined ? {} : { observedReasoningEffort: execution.observedReasoningEffort }),
  };
}

function provenance(
  runtime: RegisteredRuntime,
  captureFidelity: RuntimeProvenance["captureFidelity"],
): RuntimeProvenance {
  return {
    userId: runtime.userId,
    deviceId: runtime.deviceId,
    runtimeId: runtime.id,
    harness: runtime.harness,
    provider: runtime.provider,
    model: runtime.model,
    localSessionId: runtime.localSessionId,
    captureFidelity,
  };
}

function localCursorKey(harness: HarnessName, transcriptPath: string): string {
  return `${harness}:${hash(transcriptPath)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
