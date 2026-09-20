import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_COMPATIBILITY,
  DSH_COMPATIBILITY_MATRIX,
  DSH_NPM_COMPATIBILITY,
  createDshHostFacade,
  registerDshNativeWorkspace,
  registerDshPluginDisposer,
} from "../src/dsh-compat.js";

type Listener = (...args: unknown[]) => void;

function fixture(
  stored: boolean,
  fixtureOptions: {
    openGate?: Promise<void>;
    persistenceProbe?: "stat" | "list";
    agentPreset?: string;
    workspaceSnapshots?: boolean;
    exposeLiveSession?: boolean;
    exposeLiveAgent?: boolean;
    persistenceReadApi?: "inspect" | "readFrom" | "handle";
    /** Gates only the post-marker rebuild, so a test can dispose mid-rebuild. */
    rebuildGate?: Promise<void>;
    /** Gates workspace creation, so a test can dispose during workspace setup. */
    workspaceGate?: Promise<void>;
    /** Gates Session attachment, so a test can dispose during that mutation. */
    attachGate?: Promise<void>;
    /** Gates Session title persistence, so a test can dispose during rename. */
    renameGate?: Promise<void>;
    /** Gates Session flushing, so a test can dispose before a rebuild. */
    flushGate?: Promise<void>;
    initialTitle?: string;
  } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  const listenerOptions: Array<{ name: string; options: unknown }> = [];
  const effects: Array<() => void | Promise<void>> = [];
  const events: Array<{ type: string; seq: number; time: number; data: unknown }> = [];
  const calls = {
    create: 0,
    resume: 0,
    followup: 0,
    flush: 0,
    dispose: 0,
    order: [] as string[],
    detached: [] as string[],
    openSignals: [] as AbortSignal[],
    persistenceOpen: 0,
    persistenceRead: 0,
    persistenceClose: 0,
    queryRead: 0,
  };
  const openStarted = deferred<void>();
  const workspaceSessionIds: string[] = [];
  let title = fixtureOptions.initialTitle;
  let status = "idle";
  let waiting: (() => void) | undefined;
  let pendingMessage: unknown;
  const session = {
    id: "dsh-session-1",
    header: { version: 2, cwd: "/readonly/workspace" },
    get seq() { return events.length; },
    snapshotEvents(from = 0) { return events.slice(from); },
    append(type: string, data: unknown, options?: unknown) {
      const event = {
        type,
        seq: events.length,
        time: 1_700_000_000_000,
        data,
        ...(options === undefined ? {} : options as object),
      };
      events.push(event);
      emit("session/event", session, event);
      return event;
    },
  };
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };
  const agent = {
    id: "dsh-session-1",
    session,
    get status() { return status; },
    followup(message: unknown) {
      calls.followup += 1;
      pendingMessage = message;
      status = "running";
      emit("agent/status", { agent, status });
    },
    async whenIdle() {
      if (waiting !== undefined) await new Promise<void>((resolve) => { waiting = resolve; });
      events.push({
        type: "assistant/message",
        seq: events.length,
        time: 1_700_000_000_000,
        data: {
          message: {
            content: [
              { type: "reasoning", text: "private" },
              { type: "text", text: "public" },
            ],
          },
        },
      });
      emit("session/event", session, events.at(-1));
      status = "idle";
      emit("agent/status", { agent, status });
    },
  };
  const handle = {
    agent,
    async dispose() {
      calls.dispose += 1;
      const resolve = waiting;
      waiting = undefined;
      resolve?.();
    },
  };
  const persistence = fixtureOptions.persistenceProbe === "list"
    ? {
      async list(options?: { signal?: AbortSignal }) {
        assert.equal(this, persistence);
        if (options?.signal !== undefined) assert.ok(options.signal instanceof AbortSignal);
        const headers = [
          { id: "another-session", cwd: "/elsewhere" },
          ...(stored || workspaceSessionIds.includes("dsh-session-1")
            ? [{ id: "dsh-session-1", cwd: "/readonly/workspace" }]
            : []),
        ];
        return fixtureOptions.persistenceReadApi === "handle"
          ? headers.map((header, index) => ({ header, revision: `fixture:${String(index)}` }))
          : headers;
      },
      ...(fixtureOptions.persistenceReadApi === "handle" ? { async open(
        sessionId: string,
        access: string,
        options?: { signal?: AbortSignal },
      ) {
        assert.equal(this, persistence);
        assert.equal(sessionId, "dsh-session-1");
        assert.equal(access, "read");
        if (options?.signal !== undefined) assert.ok(options.signal instanceof AbortSignal);
        calls.persistenceOpen += 1;
        return {
          id: sessionId,
          access: "read" as const,
          async read(offset = 0) {
            calls.persistenceRead += 1;
            return structuredClone(events.slice(offset));
          },
          async close() { calls.persistenceClose += 1; },
        };
      } } : fixtureOptions.persistenceReadApi === "readFrom"
        ? { async readFrom(sessionId: string, fromSequence: number, signal?: AbortSignal) {
        assert.equal(this, persistence);
        assert.equal(sessionId, "dsh-session-1");
        assert.equal(fromSequence, 0);
        if (signal !== undefined) assert.ok(signal instanceof AbortSignal);
        calls.persistenceRead += 1;
        return { events: structuredClone(events) };
      } }
        : { async inspect(sessionId: string, signal?: AbortSignal) {
          assert.equal(this, persistence);
          assert.equal(sessionId, "dsh-session-1");
          if (signal !== undefined) assert.ok(signal instanceof AbortSignal);
          calls.persistenceRead += 1;
          return { events: structuredClone(events) };
        } }),
    }
    : {
      async stat(_sessionId: string, options?: { signal?: AbortSignal }) {
        assert.equal(this, persistence);
        if (options?.signal !== undefined) assert.ok(options.signal instanceof AbortSignal);
        return stored ? { header: { id: "dsh-session-1" } } : undefined;
      },
      async open(sessionId: string, access: string, options?: { signal?: AbortSignal }) {
        assert.equal(this, persistence);
        assert.equal(sessionId, "dsh-session-1");
        assert.equal(access, "read");
        if (options?.signal !== undefined) assert.ok(options.signal instanceof AbortSignal);
        calls.persistenceOpen += 1;
        return {
          id: sessionId,
          access: "read" as const,
          async read(offset = 0) {
            calls.persistenceRead += 1;
            return structuredClone(events.slice(offset));
          },
          async close() { calls.persistenceClose += 1; },
        };
      },
    };
  const services = {
    agents: {
      get(sessionId: string) {
        return fixtureOptions.exposeLiveAgent === true && sessionId === session.id
          ? agent
          : undefined;
      },
      async create(options: unknown) {
        calls.create += 1;
        const signal = (options as { signal?: unknown }).signal;
        assert.ok(signal instanceof AbortSignal);
        calls.openSignals.push(signal);
        assert.deepEqual(options, {
          sessionId: "dsh-session-1",
          meta: {
            cwd: "/readonly/workspace",
            ...(fixtureOptions.agentPreset === undefined
              ? {}
              : { agentPreset: fixtureOptions.agentPreset }),
          },
          agentOptions: { provider: "deepseek-official", model: "deepseek-v4-flash" },
          signal,
        });
        openStarted.resolve();
        await fixtureOptions.openGate;
        return handle;
      },
      async resume(options: unknown) {
        calls.resume += 1;
        const signal = (options as { signal?: unknown }).signal;
        assert.ok(signal instanceof AbortSignal);
        calls.openSignals.push(signal);
        assert.deepEqual(options, {
          resumeSessionId: "dsh-session-1",
          agentOptions: { provider: "deepseek-official", model: "deepseek-v4-flash" },
          signal,
        });
        openStarted.resolve();
        // Gate only the post-marker rebuild, so a test can dispose the facade
        // while the replacement Agent is still being acquired. The first
        // acquisition is `create` on a new Session and `resume` on a stored one.
        if (calls.resume + calls.create > 1 && fixtureOptions.rebuildGate !== undefined) {
          await fixtureOptions.rebuildGate;
        }
        await fixtureOptions.openGate;
        return handle;
      },
    },
    sessionPersistence: persistence,
    sessionQuery: {
      async readSession(sessionId: string) {
        assert.equal(sessionId, "dsh-session-1");
        calls.queryRead += 1;
        return {
          header: structuredClone(session.header),
          events: structuredClone(events),
        };
      },
    },
    sessions: {
      get(sessionId: string) {
        return fixtureOptions.exposeLiveSession === false || sessionId !== session.id
          ? undefined
          : session;
      },
      async flush(candidate: unknown) {
        assert.equal(candidate, session);
        calls.flush += 1;
        calls.order.push("flush");
        if (fixtureOptions.flushGate !== undefined) await fixtureOptions.flushGate;
      },
    },
    sessionTitle: {
      get() { return title === undefined ? undefined : { title }; },
      async rename(candidate: unknown, nextTitle: string) {
        assert.equal(candidate, session);
        assert.equal(nextTitle, "Canonical Session Title");
        title = nextTitle;
        calls.order.push("rename");
        if (fixtureOptions.renameGate !== undefined) await fixtureOptions.renameGate;
      },
    },
    workspaceRegistry: {
      async create(workspacePath: string, title: string) {
        assert.equal(workspacePath, "/readonly/workspace");
        assert.equal(title, "Project One");
        calls.order.push("workspace:create");
        if (fixtureOptions.workspaceGate !== undefined) await fixtureOptions.workspaceGate;
        return {
          path: workspacePath,
          sessionIds: fixtureOptions.workspaceSnapshots ? [...workspaceSessionIds] : workspaceSessionIds,
          async attachSession(sessionId: string) {
            assert.equal(sessionId, "dsh-session-1");
            calls.order.push("workspace:attach");
            if (fixtureOptions.attachGate !== undefined) await fixtureOptions.attachGate;
            if (!workspaceSessionIds.includes(sessionId)) workspaceSessionIds.unshift(sessionId);
          },
          async detachSession(sessionId: string) {
            calls.detached.push(sessionId);
            const index = workspaceSessionIds.indexOf(sessionId);
            if (index >= 0) workspaceSessionIds.splice(index, 1);
            calls.order.push("workspace:detach");
          },
        };
      },
    },
  };
  const context = {
    get(name: string) { return services[name as keyof typeof services]; },
    on(name: string, listener: Listener, options?: unknown) {
      listenerOptions.push({ name, options });
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(name, set);
      return () => { set.delete(listener); };
    },
    effect(effect: () => () => void | Promise<void>) {
      const disposer = effect();
      effects.push(disposer);
      return () => undefined;
    },
  };
  return {
    context,
    calls,
    events,
    workspaceSessionIds,
    get title() { return title; },
    renameLocally(value: string) { title = value; },
    effects,
    openStarted: openStarted.promise,
    get pendingMessage() { return pendingMessage; },
    holdIdle() { waiting = () => undefined; },
    releaseIdle() { const resolve = waiting; waiting = undefined; resolve?.(); },
    appendEvent(type: string, data: unknown) { session.append(type, data); },
    listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
    listenerOptions,
  };
}

function facadeFixture(
  stored: boolean,
  fixtureOptions: {
    openGate?: Promise<void>;
    persistenceProbe?: "stat" | "list";
    agentPreset?: string;
    supersededSessionId?: string;
    nativeWorkspace?: boolean;
  } = {},
) {
  const f = fixture(stored, fixtureOptions);
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    ...(fixtureOptions.agentPreset === undefined
      ? {}
      : { agentPreset: fixtureOptions.agentPreset }),
    ...(fixtureOptions.supersededSessionId === undefined
      ? {}
      : { supersededSessionId: fixtureOptions.supersededSessionId }),
    ...(fixtureOptions.nativeWorkspace === true
      ? { sessionTitle: "Canonical Session Title", workspaceTitle: "Project One" }
      : {}),
    messageFactory: (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }),
    moduleImporter: async () => ({ freezeMessage: (message: unknown) => structuredClone(message) }),
  });
  return { f, facade };
}

test("compatibility boundary pins the Host surface verified by the PoC", () => {
  assert.deepEqual(DSH_COMPATIBILITY, {
    tag: "dsh-v0.1.3-alpha.1",
    version: "0.1.3-alpha.1",
    commit: "d347e703908d0406b7a7ef80e3a0e594d86b2215",
    profile: "headless",
  });
  assert.deepEqual(DSH_NPM_COMPATIBILITY, {
    package: "@deepseek-ai/dsh",
    version: "0.1.2-rc.1",
    profile: "web",
    persistenceProbe: "list",
  });
  assert.deepEqual(DSH_COMPATIBILITY_MATRIX.map((entry) => ({ ...entry })), [
    {
      distribution: "npm",
      version: "0.1.2-rc.1",
      profile: "web",
      persistenceProbe: "list",
    },
    {
      distribution: "source",
      version: "0.1.3-alpha.1",
      profile: "headless",
      persistenceProbe: "stat",
    },
  ]);
});

test("Host facade creates, prompts, flushes durable events, and releases all resources", async () => {
  const { f, facade } = facadeFixture(false);
  const observedEvents: string[] = [];
  const observedStatuses: string[] = [];
  facade.onSessionEvent((event) => observedEvents.push(`${event.type}:${event.seq}`));
  facade.onStatus((status) => observedStatuses.push(status));

  assert.equal(await facade.open(), "created");
  const result = await facade.prompt("public request");
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.resume, 0);
  assert.equal(f.calls.flush, 1);
  assert.deepEqual(result.events.map((event) => `${event.type}:${event.seq}`), ["assistant/message:0"]);
  assert.deepEqual(observedEvents, ["assistant/message:0"]);
  assert.deepEqual(observedStatuses, ["running", "idle"]);
  assert.deepEqual(f.pendingMessage, {
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "public request" }],
  });

  await facade.dispose();
  await facade.dispose();
  assert.equal(f.calls.dispose, 1);
  assert.equal(f.listenerCount(), 0);
});

test("native workspace integration names and persists a Session before attaching it", async () => {
  const f = fixture(false);
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(await facade.open(), "created");
  assert.deepEqual(f.calls.order, ["rename", "flush", "workspace:create", "workspace:attach"]);
  assert.equal(f.title, "Canonical Session Title");
  assert.deepEqual(f.events.map((event) => event.type), ["turn/start", "turn/end"]);
  await facade.dispose();
});

test("a resumed native Session keeps its locally edited title", async () => {
  const f = fixture(false, { persistenceProbe: "list" });
  const options = {
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  };
  const first = createDshHostFacade(options);
  assert.equal(await first.open(), "created");
  await first.dispose();
  f.renameLocally("My own DSH title");

  const restarted = createDshHostFacade(options);
  assert.equal(await restarted.open(), "resumed");
  assert.equal(f.title, "My own DSH title");
  assert.equal(f.calls.order.filter((operation) => operation === "rename").length, 1);
  assert.ok(f.calls.order.includes("workspace:attach"), "the resumed Session remains in the workspace");
  await restarted.dispose();
});

test("adopting an already-live DSH Session does not replace its local title", async () => {
  const f = fixture(true, { exposeLiveAgent: true, initialTitle: "My existing DSH title" });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(await facade.open(), "resumed");
  assert.equal(f.title, "My existing DSH title");
  assert.equal(f.calls.order.includes("rename"), false);
  assert.ok(f.calls.order.includes("workspace:attach"), "the adopted Session remains in the workspace");
  await facade.dispose();
});

test("native workspace integration does not duplicate its list-visibility turn", async () => {
  const f = fixture(true);
  f.events.push(
    { type: "turn/start", seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: "turn/end", seq: 1, time: 1_700_000_000_000, data: { turn: 1, reason: { kind: "completed" } } },
  );
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(await facade.open(), "resumed");
  assert.deepEqual(f.events.map((event) => event.type), ["turn/start", "turn/end"]);
  await facade.dispose();
});

test("Open lists a new Session and rebuilds the Agent so the marker is not collided with", async () => {
  const f = fixture(false);
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(await facade.open(), "created");
  // The list-visibility marker is required: DSH hides any Session whose list
  // metadata has never observed a turn/start. Dropping it removes the Session
  // from the workspace list, which is what the real DSH lifecycle test asserts.
  assert.deepEqual(
    f.events.map((event) => event.type),
    ["turn/start", "turn/end"],
    "a Session with no turns still needs its list-visibility turn",
  );
  // The Agent captured its starting turn from the turnBoundary projection
  // before that marker existed, so it must be rebuilt from the log the marker
  // was committed to. Otherwise the loop numbers its first real turn 1 and
  // collides with the marker, and the turn-outline fold drops that second turn
  // along with every message inside it.
  assert.equal(f.calls.dispose, 1, "the Agent that predates the marker is released");
  assert.equal(f.calls.resume, 1, "the Agent is rebuilt so its loop starts after the marker");
  await facade.dispose();
});

test("Open does not rebuild an Agent whose Session already has turns", async () => {
  const f = fixture(true);
  f.events.push(
    { type: "turn/start", seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: "turn/end", seq: 1, time: 1_700_000_000_000, data: { turn: 1, reason: { kind: "completed" } } },
  );
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(await facade.open(), "resumed");
  assert.equal(f.calls.dispose, 0, "an already-listable Session keeps its Agent");
  assert.equal(f.calls.resume, 1, "only the resume that open already performs");
  await facade.dispose();
});

test("Open does not mark a borrowed live Agent whose turn boundary it cannot refresh", async () => {
  // A borrowed Agent owns its loop and captured its starting turn before any
  // marker existed. Writing the marker anyway would put that loop back on turn
  // 1 and recreate the collision the marker exists to avoid, and the facade may
  // not dispose or resume an Agent the DSH UI owns.
  const f = fixture(true, { persistenceProbe: "list", exposeLiveAgent: true });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(await facade.open(), "resumed");
  assert.deepEqual(
    f.events,
    [],
    "a borrowed live Agent must not receive a marker the facade cannot rebuild",
  );
  assert.equal(f.calls.resume, 0, "a borrowed Agent is never resumed or replaced");
  assert.equal(f.calls.dispose, 0, "the DSH UI remains the owner of its live Agent");
  await facade.dispose();
});

test("Open releases a rebuilt Agent when the facade is disposed during the rebuild", async () => {
  const rebuildGate = deferred<void>();
  const f = fixture(false, { persistenceProbe: "list", rebuildGate: rebuildGate.promise });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  const settled = facade.open().then(
    () => undefined,
    (error: unknown) => error,
  );
  await f.openStarted;
  await bounded((async () => {
    while (f.calls.resume + f.calls.create < 2) await new Promise((resolve) => setImmediate(resolve));
  })(), 2_000);
  // The original Agent is released and the replacement is still being acquired.
  const disposing = facade.dispose();
  await assertPending(disposing, "dispose must wait for the in-flight Agent rebuild");
  rebuildGate.resolve();
  await disposing;
  const outcome = await settled;
  assert.ok(outcome instanceof Error, "open must reject once the facade is disposed");
  assert.match(outcome.message, /disposed during open/u);
  assert.equal(
    f.calls.dispose,
    2,
    "the original Agent and the replacement acquired after disposal are both released",
  );
});

test("Open releases the accepted Agent when the facade is disposed during workspace setup", async () => {
  // The Agent is accepted as soon as adoptHandle resolves, but the marker flush
  // and workspace setup await afterwards. Disposal during those awaits must
  // still release it, and must stop the remaining workspace mutation.
  const workspaceGate = deferred<void>();
  const f = fixture(false, { persistenceProbe: "list", workspaceGate: workspaceGate.promise });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  const settled = facade.open().then(
    () => undefined,
    (error: unknown) => error,
  );
  await f.openStarted;
  await bounded((async () => {
    while (!f.calls.order.includes("workspace:create")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })(), 2_000);
  const disposing = facade.dispose();
  await assertPending(disposing, "dispose must wait for in-flight workspace setup");
  workspaceGate.resolve();
  await disposing;
  const outcome = await settled;
  assert.ok(outcome instanceof Error, "open must reject once the facade is disposed");
  assert.equal(
    f.calls.dispose,
    2,
    "the pre-marker Agent (rebuilt) and the accepted Agent are both released",
  );
  assert.equal(
    f.calls.order.includes("workspace:attach"),
    false,
    "workspace mutation must stop once the facade is disposed",
  );
});

test("Open rejects and stops mutating when the facade is disposed during Session attachment", async () => {
  const attachGate = deferred<void>();
  const f = fixture(false, { persistenceProbe: "list", attachGate: attachGate.promise });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    supersededSessionId: "gatherthread-legacy-read-only",
  });
  f.workspaceSessionIds.push("gatherthread-legacy-read-only");
  const settled = facade.open().then(
    () => undefined,
    (error: unknown) => error,
  );
  await bounded((async () => {
    while (!f.calls.order.includes("workspace:attach")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })(), 2_000);
  const disposing = facade.dispose();
  await assertPending(disposing, "dispose must wait for in-flight Session attachment");
  attachGate.resolve();
  await disposing;
  const outcome = await settled;
  assert.ok(outcome instanceof Error, "open must reject once the facade is disposed");
  assert.equal(f.calls.dispose, 2, "the pre-marker Agent and the accepted Agent are released");
  assert.deepEqual(
    f.calls.detached,
    [],
    "no workspace mutation may follow teardown",
  );
});

test("Open releases an Agent acquired while the facade is being disposed", async () => {
  // No native-workspace options on purpose: the acquisition path alone must not
  // let an Agent escape a disposal, and it must not publish one afterwards.
  const openGate = deferred<void>();
  const f = fixture(false, { persistenceProbe: "list", openGate: openGate.promise });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  const settled = facade.open().then(
    () => undefined,
    (error: unknown) => error,
  );
  await f.openStarted;
  const disposing = facade.dispose();
  await assertPending(disposing, "dispose must wait for an in-flight Agent acquisition");
  openGate.resolve();
  await disposing;
  const outcome = await settled;
  assert.ok(outcome instanceof Error, "open must reject once the facade is disposed");
  assert.equal(f.calls.dispose, 1, "the acquired Agent is released rather than published");
});

test("Open does not write a visibility marker after disposal during Session rename", async () => {
  const renameGate = deferred<void>();
  const f = fixture(false, { persistenceProbe: "list", renameGate: renameGate.promise });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  const opening = facade.open();
  await bounded((async () => {
    while (!f.calls.order.includes("rename")) await new Promise((resolve) => setImmediate(resolve));
  })(), 2_000);
  const disposing = facade.dispose();
  await assertPending(disposing, "dispose must wait for in-flight Session rename");
  renameGate.resolve();
  await disposing;
  await assert.rejects(opening, /disposed during open/u);
  assert.deepEqual(f.events, [], "teardown must prevent a late visibility marker");
  assert.equal(f.calls.flush, 0, "teardown must prevent a late Session flush");
  assert.equal(f.calls.resume, 0, "teardown must prevent a late Agent rebuild");
});

test("Open does not rebuild an Agent after disposal during Session flush", async () => {
  const flushGate = deferred<void>();
  const f = fixture(false, { persistenceProbe: "list", flushGate: flushGate.promise });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    sessionTitle: "Canonical Session Title",
    workspaceTitle: "Project One",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  const opening = facade.open();
  await bounded((async () => {
    while (!f.calls.order.includes("flush")) await new Promise((resolve) => setImmediate(resolve));
  })(), 2_000);
  const disposing = facade.dispose();
  await assertPending(disposing, "dispose must wait for the in-flight Session flush");
  flushGate.resolve();
  await disposing;
  await assert.rejects(opening, /disposed during open/u);
  assert.equal(f.calls.resume, 0, "teardown must prevent a post-flush Agent rebuild");
});

test("Host facade appends canonical history through the native model-visible surface and deduplicates by id", async () => {
  const { f, facade } = facadeFixture(false);
  await facade.open();
  const projection = {
    eventId: "event-7",
    canonicalSequence: 7,
    role: "assistant" as const,
    content: "public answer",
    occurredAt: "2026-09-05T00:00:00.000Z",
    actorDisplayName: "Collaborator",
    provider: "openai",
    model: "gpt-test",
  };
  await facade.projectCanonicalEvents([projection]);
  await facade.projectCanonicalEvents([projection]);
  assert.equal(f.calls.flush, 2, "each successful projection batch is durably flushed");
  assert.deepEqual(f.events.map((event) => event.type), [
    "turn/start",
    "step/start",
    "assistant/message",
    "step/end",
    "turn/end",
  ], "stable message ids suppress replay after cursor-save crashes");
  assert.deepEqual(f.events[2]?.data, {
    turn: 1,
    step: 1,
    message: {
      id: "gatherthread:event-7",
      role: "assistant",
      content: [{
        type: "text",
        text: "[GatherThread Agent reply · Collaborator · openai / gpt-test]\n\npublic answer",
      }],
      source: { kind: "model", provider: "openai", model: "gpt-test" },
    },
    stream: [],
  });
  assert.equal((f.events[2] as { surfaceOp?: unknown } | undefined)?.surfaceOp, "append");
  await facade.dispose();
});

test("Host facade resumes only through the official registry service", async () => {
  const { f, facade } = facadeFixture(true);
  assert.equal(await facade.open(), "resumed");
  assert.equal(f.calls.resume, 1);
  assert.equal(f.calls.create, 0);
  await facade.dispose();
});

test("published 0.1.2 Host resumes through its public persistence list", async () => {
  const { f, facade } = facadeFixture(true, { persistenceProbe: "list" });
  assert.equal(await facade.open(), "resumed");
  assert.equal(f.calls.resume, 1);
  assert.equal(f.calls.create, 0);
  await facade.dispose();

  const created = facadeFixture(false, { persistenceProbe: "list" });
  assert.equal(await created.facade.open(), "created");
  assert.equal(created.f.calls.resume, 0);
  assert.equal(created.f.calls.create, 1);
  await created.facade.dispose();
});

test("Host facade applies a native per-Agent permission preset only when creating", async () => {
  const created = facadeFixture(false, {
    persistenceProbe: "list",
    agentPreset: "read-only",
  });
  assert.equal(await created.facade.open(), "created");
  assert.equal(created.f.calls.create, 1);
  await created.facade.dispose();

  const resumed = facadeFixture(true, {
    persistenceProbe: "list",
    agentPreset: "read-only",
  });
  assert.equal(await resumed.facade.open(), "resumed");
  assert.equal(resumed.f.calls.resume, 1);
  await resumed.facade.dispose();
});

test("Host facade borrows an already-live native Agent without resuming or owning it", async () => {
  const f = fixture(true, {
    persistenceProbe: "list",
    exposeLiveAgent: true,
  });
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    messageFactory: (text) => ({ role: "user", content: [{ type: "text", text }] }),
  });

  assert.equal(await facade.open(), "resumed");
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.resume, 0);
  await facade.dispose();
  assert.equal(f.calls.dispose, 0, "the DSH UI remains the owner of its live Agent");
});

test("native writable projection detaches its superseded read-only Session after replacement", async () => {
  const { f, facade } = facadeFixture(false, {
    persistenceProbe: "list",
    agentPreset: "standard",
    supersededSessionId: "gatherthread-legacy-read-only",
    nativeWorkspace: true,
  });
  f.workspaceSessionIds.push("gatherthread-legacy-read-only");
  await facade.open();
  assert.deepEqual(f.calls.detached, ["gatherthread-legacy-read-only"]);
  assert.deepEqual(f.workspaceSessionIds, ["dsh-session-1"]);
  await facade.dispose();
});

test("native workspace discovery ignores empty Sessions and exposes completed local turns with their title", async () => {
  const f = fixture(false, {
    persistenceProbe: "list",
    workspaceSnapshots: true,
    exposeLiveSession: false,
  });
  f.workspaceSessionIds.push("dsh-session-1");
  const workspace = await registerDshNativeWorkspace(
    f.context,
    "/readonly/workspace",
    "Project One",
  );
  assert.deepEqual(await workspace.listCompletedLocalSessions(), []);

  f.events.push(
    {
      type: "user/message",
      seq: 0,
      time: 1_700_000_000_000,
      data: {
        id: "message-local-user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Build the native bridge" }],
      },
    },
    { type: "turn/start", seq: 1, time: 1_700_000_000_001, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 1_700_000_000_002,
      data: { message: { id: "message-local-assistant", content: [{ type: "text", text: "Done" }] } },
    },
    {
      type: "session/title",
      seq: 3,
      time: 1_700_000_000_003,
      data: { title: "Native DSH session", messageSeqs: [0], source: { kind: "fallback" } },
    },
    {
      type: "turn/end",
      seq: 4,
      time: 1_700_000_000_004,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  );
  assert.deepEqual(await workspace.listCompletedLocalSessions(), [{
    localSessionId: "dsh-session-1",
    title: "Native DSH session",
  }]);
  assert.equal(f.calls.queryRead, 2);
});

test("workspace discovery reads a completed cold Session through the live-preferred query service", async () => {
  const f = fixture(false, {
    persistenceProbe: "list",
    workspaceSnapshots: true,
    exposeLiveSession: false,
  });
  f.workspaceSessionIds.push("dsh-session-1");
  f.events.push(
    {
      type: "user/message",
      seq: 0,
      time: 1_700_000_000_000,
      data: {
        id: "message-local-user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Publish this DSH session" }],
      },
    },
    { type: "turn/start", seq: 1, time: 1_700_000_000_001, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 1_700_000_000_002,
      data: { message: { id: "message-local-assistant", content: [{ type: "text", text: "Published" }] } },
    },
    {
      type: "turn/end",
      seq: 3,
      time: 1_700_000_000_003,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  );
  const workspace = await registerDshNativeWorkspace(
    f.context,
    "/readonly/workspace",
    "Project One",
  );
  assert.deepEqual(await workspace.listCompletedLocalSessions(), [{
    localSessionId: "dsh-session-1",
    title: "Publish this DSH session",
  }]);
  assert.equal(f.calls.queryRead, 1);
});

test("native workspace caches the official live Session on turn settlement before cold inspection", async () => {
  const f = fixture(false, {
    persistenceProbe: "list",
    workspaceSnapshots: true,
    exposeLiveSession: false,
  });
  f.workspaceSessionIds.push("dsh-session-1");
  const workspace = await registerDshNativeWorkspace(
    f.context,
    "/readonly/workspace",
    "Project One",
  );
  let settlements = 0;
  const stop = workspace.onLocalSessionSettled(() => { settlements += 1; });
  assert.deepEqual(f.listenerOptions.at(-1), {
    name: "session/event",
    options: { global: true },
  });
  f.appendEvent("user/message", {
    id: "message-local-user",
    source: { kind: "user" },
    content: [{ type: "text", text: "Cache the live Session" }],
  });
  f.appendEvent("turn/start", { turn: 1 });
  f.appendEvent("assistant/message", {
    message: { id: "message-local-assistant", content: [{ type: "text", text: "Cached" }] },
  });
  f.appendEvent("turn/end", { turn: 1, reason: { kind: "completed" } });
  assert.equal(settlements, 1);
  assert.deepEqual(await workspace.listCompletedLocalSessions(), [{
    localSessionId: "dsh-session-1",
    title: "Cache the live Session",
  }]);
  assert.equal(f.calls.queryRead, 0);
  stop();
});

test("native workspace retains a settled live Session while persistence listing catches up", async () => {
  const f = fixture(false, {
    persistenceProbe: "list",
    workspaceSnapshots: true,
    exposeLiveSession: false,
  });
  const workspace = await registerDshNativeWorkspace(
    f.context,
    "/readonly/workspace",
    "Project One",
  );
  const stop = workspace.onLocalSessionSettled(() => undefined);
  f.appendEvent("user/message", {
    id: "message-local-user",
    source: { kind: "user" },
    content: [{ type: "text", text: "Persist after settlement" }],
  });
  f.appendEvent("turn/start", { turn: 1 });
  f.appendEvent("assistant/message", {
    message: { id: "message-local-assistant", content: [{ type: "text", text: "Persisted later" }] },
  });
  f.appendEvent("turn/end", { turn: 1, reason: { kind: "completed" } });

  assert.deepEqual(await workspace.listCompletedLocalSessions(), [{
    localSessionId: "dsh-session-1",
    title: "Persist after settlement",
  }]);
  assert.equal(f.calls.queryRead, 0);
  stop();
});

test("published persistence list fails closed on malformed headers", async () => {
  const f = fixture(false, { persistenceProbe: "list" });
  const persistence = f.context.get("sessionPersistence") as { list: () => Promise<unknown[]> };
  persistence.list = async () => [{ id: "another-session" }, { privatePath: "/do/not/scan" }];
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    messageFactory: (text) => ({ role: "user", content: [{ type: "text", text }] }),
  });
  await assert.rejects(facade.open(), /invalid Session snapshot/);
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.resume, 0);
  await facade.dispose();
});

test("Host facade rejects concurrent prompts and unavailable pinned message APIs", async () => {
  const { f, facade } = facadeFixture(false);
  f.holdIdle();
  const first = facade.prompt("one");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(facade.prompt("two"), /only one active prompt/);
  f.releaseIdle();
  await first;
  await facade.dispose();

  const other = fixture(false);
  const incompatible = createDshHostFacade({
    context: other.context,
    sessionId: "dsh-session-1",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    moduleImporter: async () => ({}),
  });
  await assert.rejects(incompatible.prompt("one"), /createUserMessage API is unavailable/);
  await incompatible.dispose();
});

test("Host facade disposal interrupts an active prompt before flush or result publication", async () => {
  const { f, facade } = facadeFixture(false);
  f.holdIdle();
  const prompt = facade.prompt("one");
  await new Promise<void>((resolve) => setImmediate(resolve));

  await bounded(facade.dispose(), 500);
  await assert.rejects(bounded(prompt, 500), /disposed during prompt/);
  assert.equal(f.calls.dispose, 1);
  assert.equal(f.calls.flush, 0);
  assert.equal(f.listenerCount(), 0);
});

test("Host facade aborts delayed create and resume without retaining a late handle", async () => {
  for (const stored of [false, true]) {
    const gate = deferred<void>();
    const { f, facade } = facadeFixture(stored, { openGate: gate.promise });
    const opening = facade.open();
    await bounded(f.openStarted, 500);
    assert.equal(f.calls.openSignals.length, 1);
    assert.equal(f.calls.openSignals[0]?.aborted, false);

    const disposing = facade.dispose();
    await assertPending(disposing, "dispose must wait for delayed Agent acquisition");
    assert.equal(f.calls.openSignals[0]?.aborted, true);
    gate.resolve();

    await bounded(disposing, 500);
    await assert.rejects(bounded(opening, 500), /disposed during open/);
    assert.equal(f.calls.dispose, 1);
    assert.throws(() => facade.currentSequence(), /Agent is not open/);
    assert.equal(f.calls.create, stored ? 0 : 1);
    assert.equal(f.calls.resume, stored ? 1 : 0);
  }
});

test("Host facade disposal during delayed message creation prevents followup, flush, and publication", async () => {
  const f = fixture(false);
  const messageStarted = deferred<void>();
  const messageGate = deferred<unknown>();
  const facade = createDshHostFacade({
    context: f.context,
    sessionId: "dsh-session-1",
    workspacePath: "/readonly/workspace",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    messageFactory(text) {
      assert.equal(text, "one");
      messageStarted.resolve();
      return messageGate.promise;
    },
  });
  let publications = 0;
  facade.onSessionEvent(() => { publications += 1; });
  await facade.open();

  const prompt = facade.prompt("one");
  await bounded(messageStarted.promise, 500);
  await bounded(facade.dispose(), 500);
  messageGate.resolve({ role: "user", content: [{ type: "text", text: "one" }] });

  await assert.rejects(bounded(prompt, 500), /disposed during prompt/);
  assert.equal(f.calls.followup, 0);
  assert.equal(f.calls.flush, 0);
  assert.equal(f.calls.dispose, 1);
  assert.equal(f.pendingMessage, undefined);
  assert.equal(f.events.length, 0);
  assert.equal(publications, 0);
});

test("Cordis lifecycle registration owns the async connector disposer", async () => {
  const f = fixture(false);
  let disposed = 0;
  registerDshPluginDisposer(f.context, async () => { disposed += 1; });
  assert.equal(f.effects.length, 1);
  await f.effects[0]?.();
  assert.equal(disposed, 1);
});

async function bounded<T>(value: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("DSH facade operation exceeded its time bound")), milliseconds).unref?.();
    }),
  ]);
}

async function assertPending(value: Promise<unknown>, message: string): Promise<void> {
  let settled = false;
  void value.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, message);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
