import type { SessionSummary } from "@gatherthread/bridge";

export const DSH_STATUS_PATH = "/api/gatherthread.status";
export const DSH_STATUS_MAX_SESSIONS = 100;
export const DSH_STATUS_MAX_ID_LENGTH = 128;
export const DSH_STATUS_MAX_LABEL_LENGTH = 160;

export type DshPublicConnectionState =
  | "connecting"
  | "connected"
  | "offline"
  | "error"
  | "stopped";

export type DshPublicSessionState =
  | "connecting"
  | "idle"
  | "running"
  | "offline"
  | "error";

export interface DshPublicSessionStatus {
  readonly sessionId: string;
  readonly title: string;
  readonly state: DshPublicSessionState;
  readonly lastSyncedAt?: string;
}

export interface DshPublicStatusSnapshot {
  readonly schemaVersion: 1;
  readonly integration: "gatherthread";
  readonly connection: DshPublicConnectionState;
  readonly bindingMode: "single" | "project";
  readonly projectName: string;
  readonly activeSessionCount: number;
  readonly sessions: readonly DshPublicSessionStatus[];
  readonly updatedAt: string;
}

interface DshStatusControllerOptions {
  readonly bindingMode: "single" | "project";
  readonly projectName: string;
  readonly now?: () => Date;
}

interface SessionStatusInput {
  readonly sessionId: string;
  readonly title: string;
  readonly state: DshPublicSessionState;
  readonly synced?: boolean;
}

interface DshStatusConnectionLike {
  readonly fetch: {
    register(route: {
      readonly path: string;
      readonly methods: readonly ("GET" | "HEAD")[];
      readonly requestBody: "buffered";
      readonly fetch: (request: Request) => Promise<Response>;
    }): () => Promise<void>;
  };
}

interface DshOptionalStatusContextLike {
  inject(
    dependencies: readonly string[],
    callback: (context: unknown) => void,
  ): { dispose(): void | Promise<void> };
}

/**
 * Host-only public projection. Callers can only set enumerated state and
 * bounded labels; secrets, headers, filesystem paths and Error objects have
 * no representation in this contract.
 */
export class DshStatusController {
  readonly #bindingMode: "single" | "project";
  #projectName: string;
  readonly #now: () => Date;
  readonly #sessions = new Map<string, DshPublicSessionStatus>();
  #connection: DshPublicConnectionState = "connecting";
  #updatedAt: string;

  constructor(options: DshStatusControllerOptions) {
    this.#bindingMode = options.bindingMode;
    this.#projectName = publicText(
      options.projectName,
      "projectName",
      DSH_STATUS_MAX_LABEL_LENGTH,
    );
    this.#now = options.now ?? (() => new Date());
    this.#updatedAt = timestamp(this.#now());
  }

  setConnection(state: DshPublicConnectionState): void {
    this.#connection = state;
    this.#touch();
  }

  setProjectName(value: string): void {
    this.#projectName = publicText(value, "projectName", DSH_STATUS_MAX_LABEL_LENGTH);
    this.#touch();
  }

  upsertSession(input: SessionStatusInput): void {
    const sessionId = publicText(input.sessionId, "sessionId", DSH_STATUS_MAX_ID_LENGTH);
    const existing = this.#sessions.get(sessionId);
    if (existing === undefined && this.#sessions.size >= DSH_STATUS_MAX_SESSIONS) {
      throw new Error(`DSH public status supports at most ${String(DSH_STATUS_MAX_SESSIONS)} Sessions`);
    }
    const next: DshPublicSessionStatus = {
      sessionId,
      title: publicText(input.title, "session title", DSH_STATUS_MAX_LABEL_LENGTH),
      state: input.state,
      ...(input.synced === true
        ? { lastSyncedAt: timestamp(this.#now()) }
        : existing?.lastSyncedAt === undefined ? {} : { lastSyncedAt: existing.lastSyncedAt }),
    };
    this.#sessions.set(sessionId, next);
    this.#touch();
  }

  removeSession(sessionIdValue: string): void {
    const sessionId = publicText(sessionIdValue, "sessionId", DSH_STATUS_MAX_ID_LENGTH);
    if (this.#sessions.delete(sessionId)) this.#touch();
  }

  reconcileProjectSessions(
    sessions: readonly SessionSummary[],
    activeSessionIds: readonly string[],
  ): void {
    const visibleSessions = sessions.slice(0, DSH_STATUS_MAX_SESSIONS);
    const visibleIds = new Set(visibleSessions.map((session) => session.id));
    const activeIds = new Set(activeSessionIds);
    for (const sessionId of this.#sessions.keys()) {
      if (!visibleIds.has(sessionId)) this.#sessions.delete(sessionId);
    }
    for (const session of visibleSessions) {
      const existing = this.#sessions.get(session.id);
      const state = activeIds.has(session.id)
        ? existing?.state === "running" ? "running" : "idle"
        : existing?.state === "error" || existing?.state === "offline"
          ? existing.state
          : "connecting";
      this.upsertSession({
        sessionId: session.id,
        title: session.name ?? session.id,
        state,
      });
    }
    this.#touch();
  }

  markSessionsOffline(): void {
    for (const [sessionId, session] of this.#sessions) {
      this.#sessions.set(sessionId, { ...session, state: "offline" });
    }
    this.#touch();
  }

  snapshot(): DshPublicStatusSnapshot {
    const sessions = [...this.#sessions.values()]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .slice(0, DSH_STATUS_MAX_SESSIONS)
      .map((session) => ({ ...session }));
    return {
      schemaVersion: 1,
      integration: "gatherthread",
      connection: this.#connection,
      bindingMode: this.#bindingMode,
      projectName: this.#projectName,
      activeSessionCount: sessions.filter((session) => (
        session.state === "idle" || session.state === "running"
      )).length,
      sessions,
      updatedAt: this.#updatedAt,
    };
  }

  #touch(): void {
    this.#updatedAt = timestamp(this.#now());
  }
}

/**
 * Register one exact, read-only route on DSH Connection's authenticated `/api`
 * carrier. Connection itself applies the Host/Origin fence and signed browser
 * Cookie before this handler is reachable.
 */
export function registerDshStatusRoute(
  contextValue: unknown,
  controller: DshStatusController,
): (() => Promise<void>) | undefined {
  const context = asObject(contextValue);
  if (context === undefined) throw new Error("Unsupported DeepSeek Harness Host context");
  // DSH services are Fiber-bound properties. Context#get returns the raw
  // service and would register the route under the Connection plugin itself,
  // allowing it to outlive this plugin's Loader entry.
  const connection = asConnection(Reflect.get(context, "connection"));
  if (connection === undefined) return undefined;
  let active = true;
  const unregister = connection.fetch.register({
    path: DSH_STATUS_PATH,
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: async (request) => {
      if (!active) return new Response("not found", { status: 404 });
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD", "cache-control": "no-store" },
        });
      }
      const url = new URL(request.url);
      if (url.pathname !== DSH_STATUS_PATH || url.search !== "") {
        return minimalResponse("invalid request", 400);
      }
      const body = JSON.stringify(controller.snapshot());
      const headers = statusHeaders();
      headers.set("content-length", String(Buffer.byteLength(body, "utf8")));
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers,
      });
    },
  });
  let disposePromise: Promise<void> | undefined;
  return () => {
    disposePromise ??= (async () => {
      active = false;
      await unregister();
    })();
    return disposePromise;
  };
}

/**
 * Bind the browser route only while DSH's optional Connection service exists.
 * `Context#inject` creates a child Fiber, so the route effect belongs to this
 * plugin rather than to the raw Connection provider. Headless profiles keep a
 * parked child Fiber and never attempt a `ctx.connection` property read.
 */
export function bindOptionalDshStatusRoute(
  contextValue: unknown,
  controller: DshStatusController,
): () => Promise<void> {
  const context = asObject(contextValue);
  if (context === undefined || typeof context.inject !== "function") {
    throw new Error("Unsupported DeepSeek Harness optional service context");
  }
  const fiber = (context as unknown as DshOptionalStatusContextLike).inject(
    ["connection"],
    (connectionContextValue) => {
      const connectionContext = asObject(connectionContextValue);
      if (connectionContext === undefined || typeof connectionContext.effect !== "function") {
        throw new Error("Unsupported DeepSeek Harness Connection context");
      }
      const dispose = registerDshStatusRoute(connectionContextValue, controller);
      if (dispose === undefined) {
        throw new Error("Injected DeepSeek Harness Connection service is unavailable");
      }
      (connectionContext.effect as (
        effect: () => () => Promise<void>,
        label?: string,
      ) => unknown)(
        () => dispose,
        "gatherthread-dsh-host.status-route",
      );
    },
  );
  let disposePromise: Promise<void> | undefined;
  return () => {
    disposePromise ??= Promise.resolve(fiber.dispose()).then(() => undefined);
    return disposePromise;
  };
}

function statusHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function minimalResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function asConnection(value: unknown): DshStatusConnectionLike | undefined {
  const connection = asObject(value);
  const fetch = asObject(connection?.fetch);
  return typeof fetch?.register === "function"
    ? value as DshStatusConnectionLike
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function publicText(value: string, label: string, maximum: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || hasControlCharacter(trimmed) || looksLikeAbsolutePath(trimmed)) {
    throw new Error(`${label} is not safe bounded display text`);
  }
  return trimmed;
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("\\\\")
    || /^[A-Za-z]:[\\/]/u.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("DSH status clock returned an invalid date");
  return value.toISOString();
}
