import type {
  AgentRequestClaim,
  AppendEventInput,
  CanonicalEvent,
  CollaborationApi,
  CompleteAgentRequestInput,
  ReadEventsResult,
  RegisteredRuntime,
  RuntimeProvenance,
  RuntimeRegistration,
  SessionSummary,
} from "./types.js";

export interface HttpCollaborationClientOptions {
  baseUrl: string;
  bearerToken: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
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
        payload: input.payload,
      }),
    }));
    return fromWireEvent(body.event ?? body);
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
      throw new Error(`Collaboration API ${response.status}: ${redactCredential(detail, this.#bearerToken)}`);
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
  const runtime = input.runtime_provenance === null || input.runtime_provenance === undefined
    ? undefined
    : fromWireProvenance(input.runtime_provenance);
  return {
    id: requiredString(input.id, "event.id"),
    sessionId: requiredString(input.session_id, "event.session_id"),
    sequence: requiredNumber(input.sequence, "event.sequence"),
    type: requiredString(input.type, "event.type") as CanonicalEvent["type"],
    actorId: requiredString(input.actor_user_id, "event.actor_user_id"),
    timestamp: requiredString(input.created_at, "event.created_at"),
    payload: input.payload,
    ...(runtime === undefined ? {} : { runtime }),
  };
}

function fromWireSession(value: unknown): SessionSummary {
  const input = requiredObject(value);
  const name = optionalWireString(input.title) ?? optionalWireString(input.name);
  const role = optionalWireString(input.role) as SessionSummary["role"];
  const latestSequence = typeof input.current_sequence === "number"
    ? input.current_sequence
    : typeof input.next_sequence === "number"
      ? Math.max(0, input.next_sequence - 1)
      : undefined;
  return {
    id: requiredString(input.id, "session.id"),
    mode: requiredString(input.mode, "session.mode") as SessionSummary["mode"],
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role }),
    ...(latestSequence === undefined ? {} : { latestSequence }),
  };
}

function fromWireRuntime(value: unknown): RegisteredRuntime {
  const input = requiredObject(value);
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
