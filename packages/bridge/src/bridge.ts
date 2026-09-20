import { createHash, randomUUID } from "node:crypto";
import {
  ClaudeCodeProjectAdapter,
  CodexRolloutAdapter,
  ZcodeStreamAdapter,
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

export class HarnessExecutionTerminatedError extends Error {
  readonly failureCode: string;
  readonly publicMessage: string;

  constructor(failureCode: string, message: string) {
    const safeCode = /^[a-z0-9_]{1,64}$/.test(failureCode) ? failureCode : "harness_execution_failed";
    const safeMessage = redactText(message).replace(/[\r\n]+/g, " ").slice(0, 400) || "The local harness ended without a response";
    super(safeMessage);
    this.name = "HarnessExecutionTerminatedError";
    this.failureCode = safeCode;
    this.publicMessage = safeMessage;
  }
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
      zcode: new ZcodeStreamAdapter(),
    };
  }

  get runtime(): RegisteredRuntime | undefined {
    return this.#runtime;
  }

  async connect(): Promise<RegisteredRuntime> {
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
    await this.#cursorStore.save({
      ...state,
      server: { ...state.server, [sessionId]: nextSequence },
    });
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
      if (event.type === "agent_request") {
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
            if (!executor.projectCanonicalEvents) {
              throw new Error("Agent request was claimed by another runtime but this executor cannot project the canonical request safely");
            }
            await executor.projectCanonicalEvents([event], runtime);
          }
        } else if (executor.projectCanonicalEvents) {
          await executor.projectCanonicalEvents([event], runtime);
        }
      } else if (executor.projectCanonicalEvents) {
        await executor.projectCanonicalEvents([event], runtime);
      }
      cursor = event.sequence;
      await this.#cursorStore.save({
        ...state,
        server: { ...state.server, [runtime.sessionId]: cursor },
      });
    }
    const nextCursor = Math.max(cursor, page.nextSequence);
    if (nextCursor !== cursor) {
      await this.#cursorStore.save({
        ...state,
        server: { ...state.server, [runtime.sessionId]: nextCursor },
      });
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
    let state = await this.#cursorStore.load();
    let cursor = state.server[runtime.sessionId] ?? 0;
    if (executor.prepareCanonicalProjection) {
      const nativeCursor = await executor.prepareCanonicalProjection(runtime);
      if (!Number.isSafeInteger(nativeCursor) || nativeCursor < 0) {
        throw new Error("Harness native projection cursor must be a non-negative safe integer");
      }
      if (nativeCursor < cursor) {
        cursor = nativeCursor;
        state = {
          ...state,
          server: { ...state.server, [runtime.sessionId]: cursor },
        };
        await this.#cursorStore.save(state);
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
        state = {
          ...state,
          server: { ...state.server, [runtime.sessionId]: cursor },
        };
        await this.#cursorStore.save(state);
      }
      const coveredThrough = Math.min(throughSequence, page.nextSequence);
      if (coveredThrough > cursor && (!page.hasMore || events.length === 0)) {
        cursor = coveredThrough;
        state = {
          ...state,
          server: { ...state.server, [runtime.sessionId]: cursor },
        };
        await this.#cursorStore.save(state);
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

    await this.#cursorStore.save({
      ...state,
      local: { ...state.local, [cursorKey]: tail.cursor },
    });
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
    const claim = await this.#api.claimAgentRequest(request.sessionId, request.id, runtime.id);
    if (!claim.claimed) return { claimed: false, completed: [] };

    const canonicalHistory = await this.#readCanonicalHistory(request.sessionId, request.sequence);
    await this.#appendProgressFailSoft(request, runtime, {
      idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:progress:start`,
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
        runtime,
        ...(this.#api.appendAgentProgress === undefined ? {} : {
          publishProgress: async (update) => {
            const content = redactText(update.content).trim();
            if (!content) return;
            await this.#appendProgressFailSoft(request, runtime, {
              idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:progress:${hash(update.id)}`,
              payload: redactValue({
                content,
                phase: "commentary",
                ...(update.occurredAt === undefined ? {} : { occurred_at: update.occurredAt }),
                capture_fidelity: "harness_transcript",
                source_harness: runtime.harness,
              }, this.#redaction),
            });
          },
        }),
      });
    } catch (error) {
      if (!(error instanceof HarnessExecutionTerminatedError)) throw error;
      const failure = await this.#api.completeAgentRequest(request.sessionId, request.id, {
        runtimeId: runtime.id,
        idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:complete`,
        payload: {
          text: `Agent execution failed: ${error.publicMessage}`,
          status: "failed",
          error: { code: error.failureCode, message: error.publicMessage },
          capture_fidelity: "harness_transcript",
          source_harness: runtime.harness,
        },
      });
      return { claimed: true, completed: [failure] };
    }
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
      }, request.id, execution);
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
      idempotencyKey: `${runtime.deviceId}:${hash(request.id)}:complete`,
      payload: responsePayload,
      ...(execution.observedModel === undefined ? {} : { observedModel: execution.observedModel }),
      ...(execution.observedReasoningEffort === undefined ? {} : { observedReasoningEffort: execution.observedReasoningEffort }),
    }));
    return { claimed: true, completed };
  }

  async #appendProgressFailSoft(
    request: CanonicalEvent,
    runtime: RegisteredRuntime,
    input: { idempotencyKey: string; payload: unknown },
  ): Promise<void> {
    if (this.#api.appendAgentProgress === undefined) return;
    try {
      await this.#api.appendAgentProgress(request.sessionId, request.id, {
        runtimeId: runtime.id,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      });
    } catch {
      // Progress is supplementary. A transient progress upload failure must not
      // strand an already-claimed request before its canonical final response.
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

function isTerminalAgentRequestClaimConflict(error: unknown): boolean {
  return error instanceof CollaborationHttpError
    && error.status === 409
    && (error.code === "agent_request_already_claimed"
      || error.code === "agent_request_already_completed");
}

function toAppendEvent(
  event: TranscriptEvent,
  runtime: RegisteredRuntime,
  source: string,
  execution?: Pick<HarnessExecutionResult, "observedModel" | "observedReasoningEffort">,
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
