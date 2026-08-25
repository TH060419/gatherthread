import { createHash, randomUUID } from "node:crypto";
import {
  ClaudeCodeProjectAdapter,
  CodexRolloutAdapter,
  discoverJsonlTranscripts,
  redactValue,
  redactTranscriptEvent,
  resolveAuthorizedPath,
  tailJsonlTranscript,
  type HarnessName,
  type RedactionOptions,
  type TranscriptAdapter,
  type TranscriptEvent,
  type TranscriptFile,
} from "@agent-cooperation/adapters";
import type { CursorStore } from "./cursors.js";
import type {
  AppendEventInput,
  CanonicalEvent,
  CollaborationApi,
  ContextSnapshot,
  HarnessExecutor,
  RegisteredRuntime,
  RuntimeProvenance,
  RuntimeRegistration,
} from "./types.js";

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

  async connect(): Promise<RegisteredRuntime> {
    this.#runtime = await this.#api.registerRuntime(this.#runtimeConfig);
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
    const nextSequence = page.events.reduce(
      (highest, item) => Math.max(highest, item.sequence),
      afterSequence,
    );
    await this.#cursorStore.save({
      ...state,
      server: { ...state.server, [sessionId]: nextSequence },
    });
    return page.events;
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
    const execution = await executor.execute({ request, canonicalHistory, runtime });
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
      }, request.id);
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
    }));
    return { claimed: true, completed };
  }

  async #readCanonicalHistory(sessionId: string, throughSequence: number): Promise<CanonicalEvent[]> {
    const history: CanonicalEvent[] = [];
    let cursor = 0;
    do {
      const page = await this.#api.readEvents(sessionId, cursor, 500);
      const relevant = page.events.filter((event) => event.sequence <= throughSequence);
      history.push(...relevant);
      if (relevant.length < page.events.length || !page.hasMore) break;
      const next = relevant.at(-1)?.sequence ?? cursor;
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

function toAppendEvent(
  event: TranscriptEvent,
  runtime: RegisteredRuntime,
  source: string,
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
