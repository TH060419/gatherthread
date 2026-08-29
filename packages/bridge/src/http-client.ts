import { createHash } from "node:crypto";
import type {
  AgentRequestClaim,
  AppendEventInput,
  CanonicalEvent,
  CollaborationApi,
  CompleteAgentRequestInput,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CurrentActor,
  ProjectSummary,
  ReadEventsResult,
  RegisteredRuntime,
  RuntimeProvenance,
  RuntimeRegistration,
  SessionSummary,
  SnapshotRequestStatus,
  SnapshotRequestSummary,
} from "./types.js";

export interface HttpCollaborationClientOptions {
  baseUrl: string;
  bearerToken: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export class CollaborationHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "CollaborationHttpError";
    this.status = status;
    this.code = code;
  }
}

export class HttpCollaborationClient implements CollaborationApi {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal: AbortSignal | undefined;
  readonly #requestTimeoutMs: number;

  constructor(options: HttpCollaborationClientOptions) {
    const parsedBaseUrl = validateBaseUrl(options.baseUrl);
    if (!options.bearerToken || /[\r\n]/.test(options.bearerToken)) {
      throw new Error("bearerToken must be a non-empty HTTP bearer token");
    }
    if (options.requestTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    this.#baseUrl = parsedBaseUrl;
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const body = await this.#request("/sessions");
    const sessions = isObject(body) && Array.isArray(body.sessions) ? body.sessions : body;
    if (!Array.isArray(sessions)) throw new Error("Collaboration API returned an invalid session list");
    return sessions.map(fromWireSession);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const body = await this.#request("/projects");
    const projects = isObject(body) && Array.isArray(body.projects) ? body.projects : body;
    if (!Array.isArray(projects)) throw new Error("Collaboration API returned an invalid project list");
    return projects.map(fromWireProject);
  }

  async listProjectSessions(projectId: string): Promise<SessionSummary[]> {
    const body = await this.#request(`/projects/${encodeURIComponent(projectId)}/sessions`);
    const sessions = isObject(body) && Array.isArray(body.sessions) ? body.sessions : body;
    if (!Array.isArray(sessions)) throw new Error("Collaboration API returned an invalid project session list");
    return sessions.map(fromWireSession);
  }

  async createSession(
    projectId: string,
    input: { title: string; mode: "solo" | "multi"; idempotencyKey: string },
  ): Promise<SessionSummary> {
    const body = requiredObject(await this.#request(`/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        mode: input.mode,
        idempotency_key: input.idempotencyKey,
      }),
    }));
    return fromWireSession(body.session ?? body);
  }

  async updateSession(
    sessionId: string,
    input: { title: string; idempotencyKey: string },
  ): Promise<SessionSummary> {
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: input.title,
        idempotency_key: input.idempotencyKey,
      }),
    }));
    return fromWireSession(body.session ?? body);
  }

  async getCurrentActor(): Promise<CurrentActor> {
    const body = requiredObject(await this.#request("/me"));
    return {
      id: requiredString(body.id, "actor.id"),
      displayName: requiredString(body.username, "actor.username"),
      deviceId: requiredString(body.device_id, "actor.device_id"),
    };
  }

  async readEvents(
    sessionId: string,
    afterSequence: number,
    limit = 200,
  ): Promise<ReadEventsResult> {
    const query = new URLSearchParams({
      after_sequence: String(afterSequence),
      limit: String(limit),
    });
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/events?${query}`));
    const events = requiredArray(body.events).map(fromWireEvent);
    return {
      events,
      nextSequence: requiredNumber(body.cursor, "cursor"),
      hasMore: body.has_more === true,
    };
  }

  async appendEvent(sessionId: string, event: AppendEventInput): Promise<CanonicalEvent> {
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify(toWireEvent(event)),
    }));
    return fromWireEvent(body.event ?? body);
  }

  async registerRuntime(runtime: RuntimeRegistration): Promise<RegisteredRuntime> {
    const body = requiredObject(await this.#request("/runtimes", {
      method: "POST",
      body: JSON.stringify(toSnakeCase(runtime as unknown as Record<string, unknown>)),
    }));
    return fromWireRuntime(body.runtime ?? body);
  }

  async heartbeatRuntime(runtimeId: string): Promise<RegisteredRuntime> {
    const body = requiredObject(await this.#request(`/runtimes/${encodeURIComponent(runtimeId)}/heartbeat`, {
      method: "POST",
      body: "{}",
    }));
    return fromWireRuntime(body.runtime ?? body);
  }

  async claimAgentRequest(
    sessionId: string,
    requestId: string,
    runtimeId: string,
  ): Promise<AgentRequestClaim> {
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/agent-requests/${encodeURIComponent(requestId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ runtime_id: runtimeId }),
    }));
    const status = body.status === "completed" ? "completed" : "claimed";
    return {
      claimed: status === "claimed",
      status,
      requestId: requiredString(body.request_event_id, "claim.request_event_id"),
      runtimeId: requiredString(body.runtime_id, "claim.runtime_id"),
    };
  }

  async completeAgentRequest(
    sessionId: string,
    requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<CanonicalEvent> {
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/agent-requests/${encodeURIComponent(requestId)}/complete`, {
      method: "POST",
      body: JSON.stringify({
        runtime_id: input.runtimeId,
        idempotency_key: input.idempotencyKey,
        payload: truncateJsonValue(input.payload, 160 * 1024),
        ...(input.observedModel === undefined ? {} : { observed_model: input.observedModel }),
        ...(input.observedReasoningEffort === undefined ? {} : { observed_reasoning_effort: input.observedReasoningEffort }),
      }),
    }));
    return fromWireEvent(body.event ?? body);
  }

  async commitLocalTurn(sessionId: string, input: CommitLocalTurnInput): Promise<CommitLocalTurnResult> {
    const toolEvents = (input.toolEvents ?? []).slice(0, 32).map(boundLocalToolEvent);
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/local-turns`, {
      method: "POST",
      body: JSON.stringify({
        local_turn_id: input.localTurnId,
        runtime_id: input.runtimeId,
        based_on_sequence: input.basedOnSequence,
        occurred_at: input.occurredAt,
        ...(input.observedModel === undefined ? {} : { observed_model: input.observedModel }),
        ...(input.observedReasoningEffort === undefined ? {} : { observed_reasoning_effort: input.observedReasoningEffort }),
        request_payload: truncateJsonValue(input.requestPayload, 32 * 1024),
        response_payload: truncateJsonValue(input.responsePayload, 112 * 1024),
        ...(input.toolEvents === undefined ? {} : { tool_events: toolEvents }),
      }),
    }));
    return {
      localTurnId: requiredString(body.local_turn_id, "local_turn.local_turn_id"),
      runtimeId: requiredString(body.runtime_id, "local_turn.runtime_id"),
      headBeforeCommit: requiredNumber(body.head_before_commit, "local_turn.head_before_commit"),
      reconciliationRequired: body.reconciliation_required === true,
      requestEvent: fromWireEvent(body.request_event),
      responseEvent: fromWireEvent(body.response_event),
      toolEvents: Array.isArray(body.tool_events) ? body.tool_events.map(fromWireEvent) : [],
    };
  }

  async getSnapshotRequest(requestId: string): Promise<SnapshotRequestSummary> {
    const body = requiredObject(await this.#request(`/snapshot-requests/${encodeURIComponent(requestId)}`));
    return fromWireSnapshotRequest(body.snapshot_request ?? body);
  }

  async createSnapshotRequest(sessionId: string): Promise<SnapshotRequestSummary> {
    const body = requiredObject(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/snapshot-requests`, {
      method: "POST",
      body: "{}",
    }));
    return fromWireSnapshotRequest(body.snapshot_request ?? body);
  }

  async listSnapshotRequests(status: SnapshotRequestStatus, limit = 20): Promise<SnapshotRequestSummary[]> {
    const query = new URLSearchParams({ status, limit: String(limit) });
    const body = await this.#request(`/snapshot-requests?${query}`);
    const requests = isObject(body) && Array.isArray(body.snapshot_requests) ? body.snapshot_requests : body;
    if (!Array.isArray(requests)) throw new Error("Collaboration API returned an invalid snapshot request list");
    return requests.map(fromWireSnapshotRequest);
  }

  async claimSnapshotRequest(requestId: string, runtimeId: string): Promise<SnapshotRequestSummary> {
    return this.#mutateSnapshotRequest(requestId, "claim", { runtime_id: runtimeId });
  }

  async completeSnapshotRequest(requestId: string, runtimeId: string, result: unknown): Promise<SnapshotRequestSummary> {
    return this.#mutateSnapshotRequest(requestId, "complete", { runtime_id: runtimeId, result });
  }

  async failSnapshotRequest(
    requestId: string,
    runtimeId: string,
    error: { code: string; message: string },
  ): Promise<SnapshotRequestSummary> {
    return this.#mutateSnapshotRequest(requestId, "fail", { runtime_id: runtimeId, error });
  }

  async #mutateSnapshotRequest(
    requestId: string,
    action: "claim" | "complete" | "fail",
    input: Record<string, unknown>,
  ): Promise<SnapshotRequestSummary> {
    const body = requiredObject(await this.#request(`/snapshot-requests/${encodeURIComponent(requestId)}/${action}`, {
      method: "POST",
      body: JSON.stringify(input),
    }));
    return fromWireSnapshotRequest(body.snapshot_request ?? body);
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const signal = combineSignals(
      init.signal ?? undefined,
      this.#signal,
      AbortSignal.timeout(this.#requestTimeoutMs),
    );
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#bearerToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      const detail = isObject(body) && typeof body.error === "string"
        ? body.error
        : isObject(body) && isObject(body.error) && typeof body.error.message === "string"
          ? body.error.message
          : response.statusText;
      const code = isObject(body) && isObject(body.error) && typeof body.error.code === "string"
        ? body.error.code
        : undefined;
      throw new CollaborationHttpError(
        response.status,
        `Collaboration API ${response.status}: ${redactCredential(detail, this.#bearerToken)}`,
        code,
      );
    }
    return isObject(body) && "data" in body ? body.data : body;
  }
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl cannot contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 1 ? present[0] as AbortSignal : AbortSignal.any(present);
}

function redactCredential(value: string, credential: string): string {
  return value.replaceAll(credential, "[REDACTED]").replace(/[\r\n]+/g, " ");
}

function toWireEvent(event: AppendEventInput): Record<string, unknown> {
  return {
    type: event.type,
    idempotency_key: event.idempotencyKey,
    payload: event.payload,
    reply_to_event_id: event.replyTo,
    visibility: event.visibility ?? "session",
    runtime_id: event.runtimeId ?? event.runtime?.runtimeId,
    observed_model: event.observedModel,
    observed_reasoning_effort: event.observedReasoningEffort,
  };
}

function toSnakeCase(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    item,
  ]));
}

function fromWireEvent(value: unknown): CanonicalEvent {
  const input = requiredObject(value);
  const actorDisplayName = optionalWireString(input.actor_display_name) ?? optionalWireString(input.actor_username);
  const runtime = input.runtime_provenance === null || input.runtime_provenance === undefined
    ? undefined
    : fromWireProvenance(input.runtime_provenance);
  return {
    id: requiredString(input.id, "event.id"),
    sessionId: requiredString(input.session_id, "event.session_id"),
    sequence: requiredNumber(input.sequence, "event.sequence"),
    type: requiredString(input.type, "event.type") as CanonicalEvent["type"],
    actorId: requiredString(input.actor_user_id, "event.actor_user_id"),
    ...(actorDisplayName === undefined ? {} : { actorDisplayName }),
    timestamp: requiredString(input.created_at, "event.created_at"),
    payload: input.payload,
    ...(runtime === undefined ? {} : { runtime }),
  };
}

function fromWireSnapshotRequest(value: unknown): SnapshotRequestSummary {
  const input = requiredObject(value);
  const status = requiredString(input.status, "snapshot_request.status");
  if (status !== "pending" && status !== "claimed" && status !== "completed" && status !== "failed") {
    throw new Error("Collaboration API returned an invalid snapshot request status");
  }
  const failureInput = isObject(input.failure) ? input.failure : isObject(input.error) ? input.error : undefined;
  const failure = failureInput
    ? {
        code: requiredString(failureInput.code, "snapshot_request.failure.code"),
        message: requiredString(failureInput.message, "snapshot_request.failure.message"),
      }
    : undefined;
  const createdAt = optionalWireString(input.created_at) ?? optionalWireString(input.requested_at);
  return {
    id: requiredString(input.id, "snapshot_request.id"),
    sessionId: requiredString(input.session_id, "snapshot_request.session_id"),
    throughSequence: requiredNumber(input.through_sequence, "snapshot_request.through_sequence"),
    status,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...("result" in input ? { result: input.result } : {}),
    ...(failure === undefined ? {} : { failure }),
  };
}

function fromWireSession(value: unknown): SessionSummary {
  const input = requiredObject(value);
  const name = optionalWireString(input.title) ?? optionalWireString(input.name);
  const role = optionalWireString(input.role) as SessionSummary["role"];
  const latestSequence = typeof input.current_sequence === "number"
    ? input.current_sequence
    : typeof input.next_sequence === "number"
      ? input.next_sequence
      : undefined;
  return {
    id: requiredString(input.id, "session.id"),
    ...(typeof input.project_id === "string" ? { projectId: input.project_id } : {}),
    ...(typeof input.owner_user_id === "string" ? { ownerUserId: input.owner_user_id } : {}),
    mode: requiredString(input.mode, "session.mode") as SessionSummary["mode"],
    ...(input.state === "active" || input.state === "archived" ? { state: input.state } : {}),
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role }),
    ...(latestSequence === undefined ? {} : { latestSequence }),
  };
}

function fromWireProject(value: unknown): ProjectSummary {
  const input = requiredObject(value);
  return {
    id: requiredString(input.id, "project.id"),
    name: requiredString(input.title, "project.title"),
    role: requiredString(input.role, "project.role") as ProjectSummary["role"],
    state: requiredString(input.state, "project.state") as ProjectSummary["state"],
    sessionCount: requiredNumber(input.session_count, "project.session_count"),
  };
}

function fromWireRuntime(value: unknown): RegisteredRuntime {
  const input = requiredObject(value);
  const purpose = input.purpose === "snapshot_connector" ? "snapshot_connector" : "execution";
  return {
    id: requiredString(input.id, "runtime.id"),
    userId: requiredString(input.user_id, "runtime.user_id"),
    runtimeId: requiredString(input.id, "runtime.id"),
    sessionId: requiredString(input.session_id, "runtime.session_id"),
    deviceId: requiredString(input.device_id, "runtime.device_id"),
    harness: requiredString(input.harness, "runtime.harness") as RegisteredRuntime["harness"],
    provider: requiredString(input.provider, "runtime.provider"),
    model: requiredString(input.model, "runtime.model"),
    localSessionId: requiredString(input.local_session_id, "runtime.local_session_id"),
    captureFidelity: requiredString(input.capture_fidelity, "runtime.capture_fidelity") as RegisteredRuntime["captureFidelity"],
    purpose,
  };
}

function fromWireProvenance(value: unknown): RuntimeProvenance {
  const input = requiredObject(value);
  return {
    userId: requiredString(input.user_id, "runtime_provenance.user_id"),
    deviceId: requiredString(input.device_id, "runtime_provenance.device_id"),
    runtimeId: requiredString(input.runtime_id, "runtime_provenance.runtime_id"),
    harness: requiredString(input.harness, "runtime_provenance.harness") as RuntimeProvenance["harness"],
    provider: requiredString(input.provider, "runtime_provenance.provider"),
    model: requiredString(input.model, "runtime_provenance.model"),
    ...(typeof input.reasoning_effort === "string" ? { reasoningEffort: input.reasoning_effort } : {}),
    localSessionId: requiredString(input.local_session_id, "runtime_provenance.local_session_id"),
    captureFidelity: requiredString(input.capture_fidelity, "runtime_provenance.capture_fidelity") as RuntimeProvenance["captureFidelity"],
  };
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Collaboration API returned an invalid object");
  return value;
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Collaboration API returned an invalid array");
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Collaboration API omitted ${field}`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Collaboration API omitted ${field}`);
  return Number(value);
}

function optionalWireString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncateJsonValue(value: unknown, maxBytes: number): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = JSON.stringify("[unserializable]");
  }
  if (Buffer.byteLength(encoded) <= maxBytes) return value;
  const originalBytes = Buffer.byteLength(encoded);
  const sha256 = createHash("sha256").update(encoded).digest("hex");
  let end = Math.min(encoded.length, Math.max(0, maxBytes - 256));
  while (end > 0 && Buffer.byteLength(encoded.slice(0, end)) > maxBytes - 256) end -= 1;
  return { truncated: true, original_bytes: originalBytes, sha256, preview: encoded.slice(0, end) };
}

function boundLocalToolEvent(value: unknown): unknown {
  if (!isObject(value) || (value.type !== "tool_call" && value.type !== "tool_result")) {
    return { type: "tool_result", payload: truncateJsonValue(value, 768) };
  }
  return {
    type: value.type,
    payload: truncateJsonValue(value.payload, 768),
    ...(typeof value.occurred_at === "string" ? { occurred_at: value.occurred_at } : {}),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
