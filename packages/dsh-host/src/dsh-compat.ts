import type {
  DshAgentStatus,
  DshCanonicalProjection,
  DshHostFacade,
  DshPromptResult,
  DshSessionEventRecord,
  DshLocalSessionCandidate,
} from "./types.js";
import { hasCompletedDshLocalTurn } from "./connector.js";

/** Exact upstream surface verified by the isolated Host and SDK PoCs. */
export const DSH_COMPATIBILITY = Object.freeze({
  tag: "dsh-v0.1.3-alpha.1",
  version: "0.1.3-alpha.1",
  commit: "d347e703908d0406b7a7ef80e3a0e594d86b2215",
  profile: "headless",
});

/** Published CLI package used by the mainstream `npx @deepseek-ai/dsh web` path. */
export const DSH_NPM_COMPATIBILITY = Object.freeze({
  package: "@deepseek-ai/dsh",
  version: "0.1.2-rc.1",
  profile: "web",
  persistenceProbe: "list",
});

export const DSH_COMPATIBILITY_MATRIX = Object.freeze([
  Object.freeze({
    distribution: "npm",
    version: DSH_NPM_COMPATIBILITY.version,
    profile: DSH_NPM_COMPATIBILITY.profile,
    persistenceProbe: DSH_NPM_COMPATIBILITY.persistenceProbe,
  }),
  Object.freeze({
    distribution: "source",
    version: DSH_COMPATIBILITY.version,
    profile: DSH_COMPATIBILITY.profile,
    persistenceProbe: "stat",
  }),
]);

const USER_MESSAGE_MODULE = "@deepseek-ai/dsh-llm";

interface DshContextLike {
  get(name: string): unknown;
  on(
    name: string,
    listener: (...args: unknown[]) => void,
    options?: { readonly global?: boolean },
  ): () => void;
  effect(effect: () => (() => void | Promise<void>), label?: string): () => void;
}

interface DshSessionLike {
  readonly id: string;
  readonly seq: number;
  readonly header?: { readonly version?: number; readonly cwd?: string };
  snapshotEvents(fromSequence?: number): readonly unknown[];
  append(type: string, data: unknown, options?: unknown): unknown;
}

interface DshAgentLike {
  readonly id: string;
  readonly session: DshSessionLike;
  readonly status: string;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

interface DshAgentHandleLike {
  readonly agent: DshAgentLike;
  dispose(): Promise<void>;
}

interface DshAgentsServiceLike {
  get?(sessionId: string): DshAgentLike | undefined;
  create(options: {
    sessionId: string;
    meta: { cwd: string; agentPreset?: string };
    agentOptions: { provider: string; model: string };
    signal: AbortSignal;
  }): Promise<DshAgentHandleLike>;
  resume(options: {
    resumeSessionId: string;
    agentOptions: { provider: string; model: string };
    signal: AbortSignal;
  }): Promise<DshAgentHandleLike>;
}

interface DshPersistenceServiceLike {
  stat?: (
    sessionId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown | undefined>;
  /** 0.1.2 accepts an AbortSignal; 0.1.3 accepts an options object. No-arg is common. */
  list?: (options?: unknown) => Promise<readonly unknown[]>;
}

interface DshSessionQueryServiceLike {
  readSession(sessionId: string): Promise<{
    readonly header: unknown;
    readonly events: readonly unknown[];
  }>;
}

interface DshSessionsServiceLike {
  flush(session: DshSessionLike): Promise<void>;
  get(sessionId: string): DshSessionLike | undefined;
}

interface DshSessionTitleServiceLike {
  rename(session: DshSessionLike, title: string): Promise<void> | void;
  get(session: DshSessionLike): { readonly title?: string } | undefined;
}

interface DshWorkspaceLike {
  readonly path: string;
  readonly sessionIds: readonly string[];
  attachSession(sessionId: string): Promise<void> | void;
  detachSession?(sessionId: string): Promise<void> | void;
}

interface DshWorkspaceRegistryLike {
  create(workspacePath: string, title: string): Promise<DshWorkspaceLike> | DshWorkspaceLike;
}

interface DshMessageModuleLike {
  createUserMessage(input: {
    content: Array<{ type: "text"; text: string }>;
    source: { kind: "user" };
  }): unknown;
  freezeMessage(input: {
    id: string;
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string }>;
    source: { kind: "user" } | {
      kind: "plugin";
      plugin: "gatherthread";
      form: "relay";
    } | {
      kind: "model";
      provider: string;
      model: string;
    };
  }): unknown;
}

export interface DshCompatibilityOptions {
  context: unknown;
  sessionId: string;
  workspacePath: string;
  provider: string;
  model: string;
  /** Canonical GatherThread Session label shown in DSH's native sidebar. */
  sessionTitle?: string;
  /** Canonical GatherThread Project label shown as a DSH native workspace. */
  workspaceTitle?: string;
  /** Optional per-Agent DSH permission preset. Omitted for legacy connectors. */
  agentPreset?: string;
  /** Previous generated Session to remove from this workspace after migration. */
  supersededSessionId?: string;
  moduleImporter?: (specifier: string) => Promise<unknown>;
  messageFactory?: (text: string) => unknown;
}

export interface DshNativeWorkspaceBinding {
  listCompletedLocalSessions(): Promise<readonly DshLocalSessionCandidate[]>;
  onLocalSessionSettled(listener: () => void): () => void;
}

/**
 * The only file that knows DSH service shapes. No private persistence artifact
 * is opened, scanned, or modified; create/resume/stat/flush are the upstream
 * Host services verified at the pinned commit.
 */
export function createDshHostFacade(options: DshCompatibilityOptions): DshHostFacade {
  const context = requireContext(options.context);
  const agents = requireService<DshAgentsServiceLike>(context, "agents", ["create", "resume"]);
  const persistence = requirePersistenceService(context);
  const sessions = requireService<DshSessionsServiceLike>(context, "sessions", ["flush"]);
  if ((options.sessionTitle === undefined) !== (options.workspaceTitle === undefined)) {
    throw new Error("DSH native workspace integration requires both Session and workspace titles");
  }
  const sessionTitle = options.sessionTitle === undefined
    ? undefined
    : requireService<DshSessionTitleServiceLike>(context, "sessionTitle", ["rename"]);
  const workspaceRegistry = options.workspaceTitle === undefined
    ? undefined
    : requireService<DshWorkspaceRegistryLike>(context, "workspaceRegistry", ["create"]);
  const eventSubscribers = new Set<(event: DshSessionEventRecord) => void>();
  const statusSubscribers = new Set<(status: DshAgentStatus) => void>();
  const listenerDisposers: Array<() => void> = [];
  const lifecycleAbort = new AbortController();
  let handle: DshAgentHandleLike | undefined;
  let openPromise: Promise<"created" | "resumed"> | undefined;
  let promptActive = false;
  let projectionActive = false;
  let knownProjectionMessageIds: Set<string> | undefined;
  let disposePromise: Promise<void> | undefined;
  let disposed = false;

  listenerDisposers.push(context.on("session/event", (...args) => {
    const session = asSession(args[0]);
    const event = asSessionEvent(args[1]);
    if (session?.id !== options.sessionId || event === undefined) return;
    for (const subscriber of eventSubscribers) subscriber(event);
  }, { global: true }));
  listenerDisposers.push(context.on("agent/status", (...args) => {
    const payload = asObject(args[0]);
    const agent = payload ? asAgent(payload.agent) : undefined;
    const status = payload?.status;
    if (agent?.session.id !== options.sessionId || (status !== "running" && status !== "idle")) return;
    for (const subscriber of statusSubscribers) subscriber(status);
  }, { global: true }));

  /**
   * Adopt one acquired Agent handle, releasing it when this open can no longer
   * proceed. Every acquisition path must pass through here — including the
   * post-marker rebuild: a handle assigned after disposal would otherwise never
   * be released, because the facade only owns whatever `handle` already holds.
   */
  const adoptHandle = async (acquired: DshAgentHandleLike): Promise<DshAgentHandleLike> => {
    if (disposed || lifecycleAbort.signal.aborted) {
      await acquired.dispose();
      throw new Error("DSH host facade was disposed during open");
    }
    if (acquired.agent.session.id !== options.sessionId) {
      await acquired.dispose();
      throw new Error("DSH Host returned an agent for an unexpected Session identity");
    }
    return acquired;
  };

  /**
   * Release the Agent this facade currently owns. The slot is cleared
   * synchronously before the release awaits, so a concurrent `dispose()` or a
   * failing `open()` can never release the same handle twice.
   */
  const releaseHandle = async (): Promise<void> => {
    const owned = handle;
    handle = undefined;
    await owned?.dispose();
  };

  const open = (): Promise<"created" | "resumed"> => {
    if (disposed) return Promise.reject(new Error("DSH host facade is disposed"));
    if (openPromise !== undefined) return openPromise;
    openPromise = (async () => {
      const liveCandidate = agents.get?.(options.sessionId);
      const liveAgent = liveCandidate === undefined ? undefined : asAgent(liveCandidate);
      if (liveCandidate !== undefined && liveAgent === undefined) {
        throw new Error("Pinned DSH Agent registry returned an incompatible live Agent");
      }
      const stored = liveAgent === undefined
        ? await hasPersistedSession(
          persistence,
          options.sessionId,
          lifecycleAbort.signal,
        )
        : true;
      throwIfDisposed(disposed, lifecycleAbort.signal, "open");
      const mode = stored ? "resumed" : "created";
      // Publish each accepted Agent into `handle` as soon as it is adopted, so
      // `dispose()` can always release it. Everything after this point awaits —
      // marker flush and workspace setup — and a handle kept only local would
      // survive a disposal that had no way to reach it.
      try {
        handle = await adoptHandle(
          liveAgent !== undefined
            ? { agent: liveAgent, dispose: async () => undefined }
            : stored
            ? await agents.resume({
              resumeSessionId: options.sessionId,
              agentOptions: { provider: options.provider, model: options.model },
              signal: lifecycleAbort.signal,
            })
            : await agents.create({
              sessionId: options.sessionId,
              meta: {
                cwd: options.workspacePath,
                ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
              },
              agentOptions: { provider: options.provider, model: options.model },
              signal: lifecycleAbort.signal,
            }),
        );
      } catch (error) {
        throwIfDisposed(disposed, lifecycleAbort.signal, "open");
        throw error;
      }
      if (sessionTitle !== undefined && workspaceRegistry !== undefined
        && options.sessionTitle !== undefined && options.workspaceTitle !== undefined) {
        try {
          const session = requireAgent(handle).session;
          await sessionTitle.rename(session, options.sessionTitle);
          // Only mark a Session whose Agent this open owns. A marker is safe only
          // when the Agent is rebuilt afterwards, and the facade may neither
          // dispose nor resume an Agent the DSH UI owns; a borrowed live Agent
          // captured its starting turn before any marker, so marking its Session
          // would put that loop back on turn 1.
          const markerWritten = liveAgent === undefined
            && ensureNativeSessionListVisibility(session);
          await sessions.flush(session);
          if (markerWritten) {
            // The Agent captured its starting turn from the turnBoundary
            // projection before the marker existed, so its loop would number the
            // first real turn 1 and collide with the marker. Rebuild it from the
            // log the marker was just committed to; the loop then starts after
            // turn 1 and DSH's consecutive-turn invariant holds.
            await releaseHandle();
            handle = await adoptHandle(await agents.resume({
              resumeSessionId: options.sessionId,
              agentOptions: { provider: options.provider, model: options.model },
              signal: lifecycleAbort.signal,
            }));
          }
          throwIfDisposed(disposed, lifecycleAbort.signal, "open");
          const workspace = await workspaceRegistry.create(options.workspacePath, options.workspaceTitle);
          if (workspace === null || typeof workspace !== "object"
            || typeof workspace.attachSession !== "function") {
            throw new Error("Pinned DSH workspace registry returned an incompatible Workspace");
          }
          throwIfDisposed(disposed, lifecycleAbort.signal, "open");
          await workspace.attachSession(options.sessionId);
          if (options.supersededSessionId !== undefined
            && options.supersededSessionId !== options.sessionId
            && workspace.sessionIds.includes(options.supersededSessionId)) {
            if (typeof workspace.detachSession !== "function") {
              throw new Error("Pinned DSH Workspace detachSession API is unavailable or incompatible");
            }
            await workspace.detachSession(options.supersededSessionId);
          }
        } catch (error) {
          // `releaseHandle` clears the slot before releasing, and `adoptHandle`
          // releases a replacement it refuses, so this never double-releases.
          await releaseHandle();
          throwIfDisposed(disposed, lifecycleAbort.signal, "open");
          throw error;
        }
      }
      return mode;
    })();
    return openPromise;
  };

  const snapshotFrom = (sequence: number): readonly DshSessionEventRecord[] => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("DSH snapshot sequence must be a non-negative integer");
    }
    const agent = requireAgent(handle);
    return agent.session.snapshotEvents(sequence).map((event) => {
      const parsed = asSessionEvent(event);
      if (parsed === undefined) throw new Error("DSH Host returned an invalid durable SessionEvent");
      return parsed;
    });
  };

  const prompt = async (text: string): Promise<DshPromptResult> => {
    if (disposed) throw new Error("DSH host facade is disposed");
    if (!text.trim()) throw new Error("DSH prompt must not be empty");
    if (Buffer.byteLength(text, "utf8") > 256 * 1_024) {
      throw new Error("DSH prompt exceeds the 256 KiB connector limit");
    }
    if (promptActive) throw new Error("DSH host facade permits only one active prompt");
    if (projectionActive) throw new Error("DSH host facade permits only one active write");
    promptActive = true;
    try {
      await open();
      throwIfDisposed(disposed, lifecycleAbort.signal, "prompt");
      const agent = requireAgent(handle);
      if (agent.status !== "idle") throw new Error("DSH Agent must be idle before a GatherThread prompt");
      const fromSequence = agent.session.seq;
      const message = await createUserMessage(text, options);
      throwIfDisposed(disposed, lifecycleAbort.signal, "prompt");
      agent.followup(message);
      await agent.whenIdle();
      throwIfDisposed(disposed, lifecycleAbort.signal, "prompt");
      await sessions.flush(agent.session);
      throwIfDisposed(disposed, lifecycleAbort.signal, "prompt");
      const toSequence = agent.session.seq;
      return {
        fromSequence,
        toSequence,
        events: snapshotFrom(fromSequence),
      };
    } finally {
      promptActive = false;
    }
  };

  const flush = async (): Promise<void> => {
    if (disposed) throw new Error("DSH host facade is disposed");
    await open();
    throwIfDisposed(disposed, lifecycleAbort.signal, "projection");
    await sessions.flush(requireAgent(handle).session);
    throwIfDisposed(disposed, lifecycleAbort.signal, "projection");
  };

  const projectCanonicalEvents = async (
    projections: readonly DshCanonicalProjection[],
  ): Promise<void> => {
    if (disposed) throw new Error("DSH host facade is disposed");
    if (promptActive || projectionActive) throw new Error("DSH host facade permits only one active write");
    if (projections.length === 0) return;
    projectionActive = true;
    try {
      await open();
      throwIfDisposed(disposed, lifecycleAbort.signal, "projection");
      const agent = requireAgent(handle);
      if (agent.status !== "idle") {
        throw new Error("DSH Agent must be idle before canonical history projection");
      }
      const knownIds = knownProjectionMessageIds
        ??= nativeMessageIds(agent.session.snapshotEvents(0));
      for (const projection of projections) {
        const messageId = canonicalMessageId(projection.eventId);
        if (knownIds.has(messageId)) continue;
        // Do not permit an injectable message factory here: the deterministic
        // canonical id is the crash-replay idempotency boundary.
        const message = await createProjectionMessage(projection, options);
        if (projection.role === "user") {
          agent.session.append("user/message", message, { surfaceOp: "append" });
        } else {
          // DSH admits assistant history only inside a balanced turn and step.
          // Keeping the canonical reply in assistant role prevents a remote
          // Agent's output from being reclassified as a new user instruction.
          const turn = nextDshTurn(agent.session.snapshotEvents(0));
          agent.session.append("turn/start", { turn });
          agent.session.append("step/start", { turn, step: 1 });
          agent.session.append("assistant/message", {
            turn,
            step: 1,
            message,
            stream: [],
          }, { surfaceOp: "append" });
          agent.session.append("step/end", { turn, step: 1 });
          agent.session.append("turn/end", { turn, reason: { kind: "completed" } });
        }
        knownIds.add(messageId);
      }
      await sessions.flush(agent.session);
      throwIfDisposed(disposed, lifecycleAbort.signal, "projection");
    } finally {
      projectionActive = false;
    }
  };

  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise;
    disposed = true;
    lifecycleAbort.abort(new Error("DSH host facade disposed"));
    eventSubscribers.clear();
    statusSubscribers.clear();
    for (const stop of listenerDisposers.splice(0)) stop();
    // Take ownership the moment disposal starts. `open()` may still be awaiting
    // workspace setup, so whatever it has already accepted must be reachable
    // through this slot by the time `disposed` is observable.
    disposePromise = releaseHandle();
    return disposePromise;
  };

  return {
    sessionId: options.sessionId,
    open,
    currentSequence() {
      return requireAgent(handle).session.seq;
    },
    snapshotFrom,
    projectCanonicalEvents,
    flush,
    prompt,
    onSessionEvent(listener) {
      if (disposed) throw new Error("DSH host facade is disposed");
      eventSubscribers.add(listener);
      return () => eventSubscribers.delete(listener);
    },
    onStatus(listener) {
      if (disposed) throw new Error("DSH host facade is disposed");
      statusSubscribers.add(listener);
      return () => statusSubscribers.delete(listener);
    },
    dispose,
  };
}

/**
 * DSH hides every Session whose list metadata has never observed a `turn/start`
 * (`applySessionListMetadata` only clears `blank` for that event type), so a
 * canonical Session attached before its first local turn would not appear in the
 * workspace list. Write the same balanced, content-free turn DSH's own Agent loop
 * emits when it has no messages. This makes the Session discoverable without
 * invoking a model or fabricating an assistant response, and is idempotent
 * across reloads.
 *
 * The caller must rebuild the Agent afterwards: the loop captures its starting
 * turn from the `turnBoundary` projection when it is constructed, so a loop built
 * before this marker would number its first real turn 1 and collide with it. The
 * turn-outline fold drops a turn that does not increase (`turn <= last.turn`) along
 * with every message inside it, which is what hid Web agent turns from DSH.
 *
 * @returns whether a marker was written and the Agent must be rebuilt.
 */
function ensureNativeSessionListVisibility(session: DshSessionLike): boolean {
  const events = session.snapshotEvents(0);
  if (events.some((event) => asSessionEvent(event)?.type === "turn/start")) return false;
  session.append("turn/start", { turn: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return true;
}

/** Register a Project workspace even when it has no locally writable Sessions. */
export async function registerDshNativeWorkspace(
  contextValue: unknown,
  workspacePath: string,
  workspaceTitle: string,
): Promise<DshNativeWorkspaceBinding> {
  const context = requireContext(contextValue);
  const registry = requireService<DshWorkspaceRegistryLike>(context, "workspaceRegistry", ["create"]);
  const workspace = await registry.create(workspacePath, workspaceTitle);
  if (workspace === null || typeof workspace !== "object"
    || typeof workspace.path !== "string"
    || typeof workspace.attachSession !== "function"
    || !Array.isArray(workspace.sessionIds)) {
    throw new Error("Pinned DSH workspace registry returned an incompatible Workspace");
  }
  const sessions = requireService<DshSessionsServiceLike>(context, "sessions", ["flush", "get"]);
  const persistence = requirePersistenceService(context);
  if (persistence.list === undefined) {
    throw new Error("Pinned DSH persistence list API is unavailable or incompatible");
  }
  const sessionQuery = requireService<DshSessionQueryServiceLike>(
    context,
    "sessionQuery",
    ["readSession"],
  );
  const sessionTitle = requireService<DshSessionTitleServiceLike>(context, "sessionTitle", ["rename", "get"]);
  const completed = new Map<string, DshLocalSessionCandidate>();
  return {
    async listCompletedLocalSessions() {
      // A globally observed turn/end is authoritative for this process. DSH can
      // publish that event just before its persistence listing catches up, so
      // retain the live snapshot instead of briefly dropping it and attempting
      // a conflicting cold read of a still-active Session.
      const candidates = new Map<string, DshLocalSessionCandidate>(completed);
      const snapshots = await persistence.list!();
      if (!Array.isArray(snapshots)) {
        throw new Error("Pinned DSH persistence list returned an invalid Session collection");
      }
      const currentIds = new Set<string>();
      for (const value of snapshots) {
        const header = persistenceHeader(value);
        if (header === undefined || typeof header.id !== "string") {
          throw new Error("Pinned DSH persistence list returned an invalid Session snapshot");
        }
        if (header.cwd === workspace.path) currentIds.add(header.id);
      }
      for (const localSessionId of [...currentIds]) {
        if (!isUserCreatedDshSessionId(localSessionId)) continue;
        const cached = completed.get(localSessionId);
        if (cached !== undefined) continue;
        const live = sessions.get(localSessionId);
        const rawEvents = live === undefined
          ? (await sessionQuery.readSession(localSessionId)).events
          : live.snapshotEvents(0);
        if (!Array.isArray(rawEvents)) {
          throw new Error("Pinned DSH Session reader returned an invalid event collection");
        }
        const events = rawEvents.map((event) => {
          const parsed = asSessionEvent(event);
          if (parsed === undefined) throw new Error("Pinned DSH Session reader returned an invalid event");
          return parsed;
        });
        if (!hasCompletedDshLocalTurn(events, localSessionId)) continue;
        const title = live === undefined
          ? titleFromEvents(events)
          : normalizedLocalSessionTitle(sessionTitle.get(live)?.title) ?? titleFromEvents(events);
        const candidate = { localSessionId, title };
        completed.set(localSessionId, candidate);
        candidates.set(localSessionId, candidate);
      }
      return [...candidates.values()]
        .sort((left, right) => left.localSessionId.localeCompare(right.localSessionId));
    },
    onLocalSessionSettled(listener) {
      return context.on("session/event", (...args) => {
        const session = asSession(args[0]);
        const event = asSessionEvent(args[1]);
        if (session === undefined || event?.type !== "turn/end") return;
        if (!isUserCreatedDshSessionId(session.id)) return;
        if (session.header?.cwd !== workspace.path) return;
        const events: DshSessionEventRecord[] = [];
        for (const value of session.snapshotEvents(0)) {
          const parsed = asSessionEvent(value);
          if (parsed === undefined) return;
          events.push(parsed);
        }
        if (!hasCompletedDshLocalTurn(events, session.id)) return;
        completed.set(session.id, {
          localSessionId: session.id,
          title: normalizedLocalSessionTitle(sessionTitle.get(session)?.title) ?? titleFromEvents(events),
        });
        listener();
      }, { global: true });
    },
  };
}

function isUserCreatedDshSessionId(sessionId: string): boolean {
  return sessionId.length > 0
    && sessionId.length <= 128
    && /^[A-Za-z0-9._:-]+$/u.test(sessionId)
    && !sessionId.startsWith("gatherthread-");
}

function titleFromEvents(events: readonly DshSessionEventRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = asObject(event?.data);
    if (event?.type === "session/title") {
      const title = normalizedLocalSessionTitle(data?.title);
      if (title !== undefined) return title;
    }
  }
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const data = asObject(event.data);
    const message = asObject(data?.message) ?? data;
    const source = asObject(message?.source);
    if (source?.kind !== "user") continue;
    const content = Array.isArray(message?.content) ? message.content : [];
    const title = normalizedLocalSessionTitle(content.flatMap((block) => {
      const item = asObject(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join(" "));
    if (title !== undefined) return title;
  }
  return "DeepSeek Harness 会话";
}

function normalizedLocalSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  return [...normalized].slice(0, 200).join("");
}

function throwIfDisposed(
  disposed: boolean,
  signal: AbortSignal,
  operation: "open" | "prompt" | "projection",
): void {
  if (disposed || signal.aborted) {
    throw new Error(`DSH host facade was disposed during ${operation}`);
  }
}

async function createProjectionMessage(
  projection: DshCanonicalProjection,
  options: DshCompatibilityOptions,
): Promise<unknown> {
  const importer = options.moduleImporter ?? ((specifier: string) => import(specifier));
  const imported = asObject(await importer(USER_MESSAGE_MODULE));
  if (imported === undefined || typeof imported.freezeMessage !== "function") {
    throw new Error("Pinned DSH freezeMessage API is unavailable");
  }
  const factory = imported.freezeMessage as DshMessageModuleLike["freezeMessage"];
  return factory({
    id: canonicalMessageId(projection.eventId),
    role: projection.role,
    content: [{ type: "text", text: formatProjectionText(projection) }],
    source: projection.role === "user"
      ? { kind: "user" }
      : {
        kind: "model",
        provider: projection.provider ?? "gatherthread",
        model: projection.model ?? "canonical-relay",
      },
  });
}

function formatProjectionText(projection: DshCanonicalProjection): string {
  if (projection.role === "user") return projection.content;
  const route = [projection.provider, projection.model].filter(Boolean).join(" / ");
  const attribution = [projection.actorDisplayName, route].filter(Boolean).join(" · ");
  return `[GatherThread Agent reply${attribution ? ` · ${attribution}` : ""}]\n\n${projection.content}`;
}

function canonicalMessageId(eventId: string): string {
  return `gatherthread:${eventId}`;
}

function nextDshTurn(events: readonly unknown[]): number {
  let next = 1;
  for (const eventValue of events) {
    const event = asSessionEvent(eventValue);
    if (event?.type !== "turn/start") continue;
    const data = asObject(event.data);
    const turn = data?.turn;
    if (typeof turn === "number" && Number.isSafeInteger(turn) && turn >= next) {
      next = turn + 1;
    }
  }
  return next;
}

function nativeMessageIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const eventValue of events) {
    const event = asObject(eventValue);
    const data = asObject(event?.data);
    const message = event?.type === "assistant/message" ? asObject(data?.message) : data;
    if (typeof message?.id === "string") ids.add(message.id);
  }
  return ids;
}

/** Register one exact async disposer with the Cordis owner scope. */
export function registerDshPluginDisposer(contextValue: unknown, dispose: () => Promise<void>): void {
  const context = requireContext(contextValue);
  context.effect(() => dispose, "gatherthread-dsh-host.connector");
}

async function createUserMessage(text: string, options: DshCompatibilityOptions): Promise<unknown> {
  if (options.messageFactory !== undefined) return options.messageFactory(text);
  const importer = options.moduleImporter ?? ((specifier: string) => import(specifier));
  const imported = asObject(await importer(USER_MESSAGE_MODULE));
  if (imported === undefined || typeof imported.createUserMessage !== "function") {
    throw new Error("Pinned DSH createUserMessage API is unavailable");
  }
  const factory = imported.createUserMessage as DshMessageModuleLike["createUserMessage"];
  return factory({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function requireContext(value: unknown): DshContextLike {
  const context = asObject(value);
  if (context === undefined
    || typeof context.get !== "function"
    || typeof context.on !== "function"
    || typeof context.effect !== "function") {
    throw new Error("Unsupported DeepSeek Harness Host context");
  }
  return context as unknown as DshContextLike;
}

function requireService<T>(
  context: DshContextLike,
  name: string,
  methods: readonly string[],
): T {
  const service = asObject(context.get(name));
  if (service === undefined || methods.some((method) => typeof service[method] !== "function")) {
    throw new Error(`Pinned DSH Host service ${name} is unavailable or incompatible`);
  }
  return service as unknown as T;
}

function requirePersistenceService(context: DshContextLike): DshPersistenceServiceLike {
  const service = asObject(context.get("sessionPersistence"));
  if (service === undefined
    || (typeof service.stat !== "function" && typeof service.list !== "function")) {
    throw new Error("Pinned DSH Host service sessionPersistence is unavailable or incompatible");
  }
  return service as DshPersistenceServiceLike;
}

async function hasPersistedSession(
  persistence: DshPersistenceServiceLike,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (persistence.stat !== undefined) {
    return (await persistence.stat(sessionId, { signal })) !== undefined;
  }
  if (persistence.list === undefined) {
    throw new Error("Pinned DSH persistence probe is unavailable");
  }
  // Both supported DSH APIs accept a no-argument list. Their cancellation
  // parameter changed shape between 0.1.2 and 0.1.3, so do not guess it.
  const listed = await persistence.list();
  if (!Array.isArray(listed)) {
    throw new Error("Pinned DSH persistence list returned an invalid Session collection");
  }
  for (const value of listed) {
    const header = persistenceHeader(value);
    if (header === undefined || typeof header.id !== "string") {
      throw new Error("Pinned DSH persistence list returned an invalid Session snapshot");
    }
    if (header.id === sessionId) return true;
  }
  return false;
}

function persistenceHeader(value: unknown): Record<string, unknown> | undefined {
  const item = asObject(value);
  // Published 0.1.2 list() returns SessionHeader directly. DSH 0.1.3 list()
  // returns SessionPersistenceSnapshot with its header nested one level down.
  return asObject(item?.header) ?? item;
}

function requireAgent(handle: DshAgentHandleLike | undefined): DshAgentLike {
  if (handle === undefined) throw new Error("DSH Agent is not open");
  return handle.agent;
}

function asAgent(value: unknown): DshAgentLike | undefined {
  const candidate = asObject(value);
  const session = candidate ? asSession(candidate.session) : undefined;
  if (candidate === undefined || session === undefined || typeof candidate.id !== "string") return undefined;
  return candidate as unknown as DshAgentLike;
}

function asSession(value: unknown): DshSessionLike | undefined {
  const candidate = asObject(value);
  if (candidate === undefined
    || typeof candidate.id !== "string"
    || !Number.isSafeInteger(candidate.seq)
    || typeof candidate.snapshotEvents !== "function"
    || typeof candidate.append !== "function") return undefined;
  return candidate as unknown as DshSessionLike;
}

function asSessionEvent(value: unknown): DshSessionEventRecord | undefined {
  const candidate = asObject(value);
  if (candidate === undefined
    || typeof candidate.type !== "string"
    || !Number.isSafeInteger(candidate.seq)
    || Number(candidate.seq) < 0
    || !Number.isSafeInteger(candidate.time)
    || !("data" in candidate)) return undefined;
  return {
    type: candidate.type,
    seq: Number(candidate.seq),
    time: Number(candidate.time),
    data: candidate.data,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
