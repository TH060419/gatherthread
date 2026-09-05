import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_COMPATIBILITY,
  DSH_COMPATIBILITY_MATRIX,
  DSH_NPM_COMPATIBILITY,
  createDshHostFacade,
  registerDshPluginDisposer,
} from "../src/dsh-compat.js";

type Listener = (...args: unknown[]) => void;

function fixture(
  stored: boolean,
  fixtureOptions: {
    openGate?: Promise<void>;
    persistenceProbe?: "stat" | "list";
    agentPreset?: string;
  } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  const effects: Array<() => void | Promise<void>> = [];
  const events: Array<{ type: string; seq: number; time: number; data: unknown }> = [];
  const calls = {
    create: 0,
    resume: 0,
    followup: 0,
    flush: 0,
    dispose: 0,
    openSignals: [] as AbortSignal[],
  };
  const openStarted = deferred<void>();
  let status = "idle";
  let waiting: (() => void) | undefined;
  let pendingMessage: unknown;
  const session = {
    id: "dsh-session-1",
    get seq() { return events.length; },
    snapshotEvents(from = 0) { return events.slice(from); },
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
      async list(signal?: AbortSignal) {
        assert.ok(signal instanceof AbortSignal);
        return stored ? [{ id: "another-session" }, { id: "dsh-session-1" }] : [{ id: "another-session" }];
      },
    }
    : {
      async stat() { return stored ? { header: { id: "dsh-session-1" } } : undefined; },
    };
  const services = {
    agents: {
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
        await fixtureOptions.openGate;
        return handle;
      },
    },
    sessionPersistence: persistence,
    sessions: {
      async flush(candidate: unknown) {
        assert.equal(candidate, session);
        calls.flush += 1;
      },
    },
  };
  const context = {
    get(name: string) { return services[name as keyof typeof services]; },
    on(name: string, listener: Listener) {
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
    effects,
    openStarted: openStarted.promise,
    get pendingMessage() { return pendingMessage; },
    holdIdle() { waiting = () => undefined; },
    releaseIdle() { const resolve = waiting; waiting = undefined; resolve?.(); },
    listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

function facadeFixture(
  stored: boolean,
  fixtureOptions: {
    openGate?: Promise<void>;
    persistenceProbe?: "stat" | "list";
    agentPreset?: string;
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
    messageFactory: (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }),
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
  await assert.rejects(facade.open(), /invalid Session header/);
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

    await bounded(facade.dispose(), 500);
    assert.equal(f.calls.openSignals[0]?.aborted, true);
    gate.resolve();

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
