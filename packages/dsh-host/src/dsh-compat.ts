import type {
  DshAgentStatus,
  DshHostFacade,
  DshPromptResult,
  DshSessionEventRecord,
} from "./types.js";

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
  on(name: string, listener: (...args: unknown[]) => void): () => void;
  effect(effect: () => (() => void | Promise<void>), label?: string): () => void;
}

interface DshSessionLike {
  readonly id: string;
  readonly seq: number;
  snapshotEvents(fromSequence?: number): readonly unknown[];
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
  stat?: (sessionId: string) => Promise<unknown | undefined>;
  list?: (signal?: AbortSignal) => Promise<readonly unknown[]>;
}

interface DshSessionsServiceLike {
  flush(session: DshSessionLike): Promise<void>;
}

interface DshMessageModuleLike {
  createUserMessage(input: {
    content: Array<{ type: "text"; text: string }>;
    source: { kind: "user" };
  }): unknown;
}

export interface DshCompatibilityOptions {
  context: unknown;
  sessionId: string;
  workspacePath: string;
  provider: string;
  model: string;
  /** Optional per-Agent DSH permission preset. Omitted for legacy connectors. */
  agentPreset?: string;
  moduleImporter?: (specifier: string) => Promise<unknown>;
  messageFactory?: (text: string) => unknown;
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
  const eventSubscribers = new Set<(event: DshSessionEventRecord) => void>();
  const statusSubscribers = new Set<(status: DshAgentStatus) => void>();
  const listenerDisposers: Array<() => void> = [];
  const lifecycleAbort = new AbortController();
  let handle: DshAgentHandleLike | undefined;
  let openPromise: Promise<"created" | "resumed"> | undefined;
  let promptActive = false;
  let disposePromise: Promise<void> | undefined;
  let disposed = false;

  listenerDisposers.push(context.on("session/event", (...args) => {
    const session = asSession(args[0]);
    const event = asSessionEvent(args[1]);
    if (session?.id !== options.sessionId || event === undefined) return;
    for (const subscriber of eventSubscribers) subscriber(event);
  }));
  listenerDisposers.push(context.on("agent/status", (...args) => {
    const payload = asObject(args[0]);
    const agent = payload ? asAgent(payload.agent) : undefined;
    const status = payload?.status;
    if (agent?.session.id !== options.sessionId || (status !== "running" && status !== "idle")) return;
    for (const subscriber of statusSubscribers) subscriber(status);
  }));

  const open = (): Promise<"created" | "resumed"> => {
    if (disposed) return Promise.reject(new Error("DSH host facade is disposed"));
    if (openPromise !== undefined) return openPromise;
    openPromise = (async () => {
      const stored = await hasPersistedSession(
        persistence,
        options.sessionId,
        lifecycleAbort.signal,
      );
      throwIfDisposed(disposed, lifecycleAbort.signal, "open");
      const mode = stored ? "resumed" : "created";
      let openedHandle: DshAgentHandleLike;
      try {
        openedHandle = stored
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
          });
      } catch (error) {
        throwIfDisposed(disposed, lifecycleAbort.signal, "open");
        throw error;
      }
      if (disposed || lifecycleAbort.signal.aborted) {
        await openedHandle.dispose();
        throw new Error("DSH host facade was disposed during open");
      }
      if (openedHandle.agent.session.id !== options.sessionId) {
        await openedHandle.dispose();
        throw new Error("DSH Host returned an agent for an unexpected Session identity");
      }
      handle = openedHandle;
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

  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      disposed = true;
      lifecycleAbort.abort(new Error("DSH host facade disposed"));
      eventSubscribers.clear();
      statusSubscribers.clear();
      for (const stop of listenerDisposers.splice(0)) stop();
      try {
        await handle?.dispose();
      } finally {
        handle = undefined;
      }
    })();
    return disposePromise;
  };

  return {
    sessionId: options.sessionId,
    open,
    currentSequence() {
      return requireAgent(handle).session.seq;
    },
    snapshotFrom,
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

function throwIfDisposed(disposed: boolean, signal: AbortSignal, operation: "open" | "prompt"): void {
  if (disposed || signal.aborted) {
    throw new Error(`DSH host facade was disposed during ${operation}`);
  }
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
    return (await persistence.stat(sessionId)) !== undefined;
  }
  if (persistence.list === undefined) {
    throw new Error("Pinned DSH persistence probe is unavailable");
  }
  const listed = await persistence.list(signal);
  if (!Array.isArray(listed)) {
    throw new Error("Pinned DSH persistence list returned an invalid Session collection");
  }
  for (const value of listed) {
    const header = asObject(value);
    if (header === undefined || typeof header.id !== "string") {
      throw new Error("Pinned DSH persistence list returned an invalid Session header");
    }
    if (header.id === sessionId) return true;
  }
  return false;
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
    || typeof candidate.snapshotEvents !== "function") return undefined;
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
