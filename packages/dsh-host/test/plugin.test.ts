import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveDshSessionId } from "../src/config.js";
import { apply } from "../src/plugin.js";

type Listener = (...args: unknown[]) => void;

test("disabled Cordis entry is inert and does not resolve Host services", async () => {
  const inaccessibleContext = new Proxy({}, {
    get() {
      throw new Error("disabled plugin touched its Host context");
    },
  });
  await apply(inaccessibleContext, undefined);
  await apply(inaccessibleContext, { enabled: false });
});

test("initialization failure unregisters an already-installed status route", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-plugin-failure-")));
  const workspacePath = path.join(root, "readonly-workspace");
  await mkdir(workspacePath, { mode: 0o700 });
  const tokenVariable = "GATHERTHREAD_DSH_FAILURE_TEST_TOKEN";
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    token: process.env[tokenVariable],
    telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED,
    telemetryMode: process.env.DSH_TELEMETRY_MODE,
    permissionMode: process.env.DSH_PERMISSION_MODE,
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    restoreEnvironment(tokenVariable, previousEnvironment.token);
    restoreEnvironment("DSH_TELEMETRY_DISABLED", previousEnvironment.telemetryDisabled);
    restoreEnvironment("DSH_TELEMETRY_MODE", previousEnvironment.telemetryMode);
    restoreEnvironment("DSH_PERMISSION_MODE", previousEnvironment.permissionMode);
  });
  process.env[tokenVariable] = "fixture-token-never-log";
  process.env.DSH_TELEMETRY_DISABLED = "1";
  process.env.DSH_TELEMETRY_MODE = "DISABLED";
  process.env.DSH_PERMISSION_MODE = "read-only";
  globalThis.fetch = async () => Response.json(
    { error: { code: "fixture_failure", message: "fixture unavailable" } },
    { status: 503 },
  );

  let route: unknown;
  let unregisters = 0;
  const effects: Array<() => void | Promise<void>> = [];
  const connection = {
    fetch: {
      register(value: unknown) {
        route = value;
        return async () => {
          unregisters += 1;
          route = undefined;
        };
      },
    },
  };
  const context = {
    connection,
    get(name: string) { return name === "connection" ? connection : undefined; },
    on() { return () => undefined; },
    effect(effect: () => () => void | Promise<void>) {
      effects.push(effect());
      return () => undefined;
    },
    inject(dependencies: readonly string[], callback: (child: unknown) => void) {
      assert.deepEqual(dependencies, ["connection"]);
      const childEffects: Array<() => void | Promise<void>> = [];
      callback({
        ...context,
        effect(effect: () => () => void | Promise<void>) {
          childEffects.push(effect());
          return () => undefined;
        },
      });
      let disposed = false;
      return {
        async dispose() {
          if (disposed) return;
          disposed = true;
          for (const dispose of childEffects.reverse()) await dispose();
        },
      };
    },
  };
  await assert.rejects(apply(context, {
    enabled: true,
    apiUrl: "https://gatherthread.example/v1",
    credentialReference: { kind: "environment", variable: tokenVariable },
    projectId: "project-1",
    sessionId: "session-1",
    deviceId: "device-1",
    workspacePath,
    statePath: path.join(root, "private-state", "connector.json"),
    provider: "deepseek-official",
    model: "DeepSeek-CustomCase",
  }), /fixture|request|503|unavailable/i);
  assert.equal(route, undefined);
  assert.equal(unregisters, 1);
  await bounded(effects[0]?.(), 500);
  assert.equal(unregisters, 1, "Cordis cleanup after failed apply must remain idempotent");
});

test("legacy single-mode Solo owner uses /me and unload cleanly supports a second load", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-plugin-")));
  const workspacePath = path.join(root, "readonly-workspace");
  const statePath = path.join(root, "private-state", "connector.json");
  const dshSessionId = deriveDshSessionId("project-1", "session-1", workspacePath);
  const token = "fixture-token-never-log";
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    token: process.env.GATHERTHREAD_DSH_TEST_TOKEN,
    telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED,
    telemetryMode: process.env.DSH_TELEMETRY_MODE,
    permissionMode: process.env.DSH_PERMISSION_MODE,
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    restoreEnvironment("GATHERTHREAD_DSH_TEST_TOKEN", previousEnvironment.token);
    restoreEnvironment("DSH_TELEMETRY_DISABLED", previousEnvironment.telemetryDisabled);
    restoreEnvironment("DSH_TELEMETRY_MODE", previousEnvironment.telemetryMode);
    restoreEnvironment("DSH_PERMISSION_MODE", previousEnvironment.permissionMode);
  });
  process.env.GATHERTHREAD_DSH_TEST_TOKEN = token;
  process.env.DSH_TELEMETRY_DISABLED = "1";
  process.env.DSH_TELEMETRY_MODE = "DISABLED";
  process.env.DSH_PERMISSION_MODE = "read-only";

  const requests: Array<{ url: string; init: RequestInit }> = [];
  let eventReads = 0;
  let abortedReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/me")) {
      return Response.json({ data: {
        id: "user-1",
        username: "Fixture User",
        device_id: "device-1",
      } });
    }
    if (url.endsWith("/projects/project-1/sessions")) {
      return Response.json({ data: { sessions: [{
        id: "session-1",
        project_id: "project-1",
        title: "General",
        mode: "solo",
        state: "active",
        role: "participant",
        owner_user_id: "user-1",
        current_sequence: 0,
      }] } });
    }
    if (url.endsWith("/runtimes")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ data: { runtime: {
        id: "runtime-stable",
        user_id: "user-1",
        session_id: body.session_id,
        device_id: body.device_id,
        harness: body.harness,
        provider: body.provider,
        model: body.model,
        local_session_id: body.local_session_id,
        capture_fidelity: body.capture_fidelity,
        purpose: body.purpose,
      } } });
    }
    if (url.includes("/sessions/session-1/events?")) {
      eventReads += 1;
      if (eventReads % 2 === 1) {
        return Response.json({ data: { events: [], cursor: 0, has_more: false } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          abortedReads += 1;
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => {
          abortedReads += 1;
          reject(signal.reason);
        }, { once: true });
      });
    }
    throw new Error(`unexpected fixture request: ${url}`);
  };

  const fixture = hostFixture(dshSessionId);
  const rawConfig = {
    enabled: true,
    apiUrl: "https://gatherthread.example/v1",
    credentialReference: {
      kind: "environment",
      variable: "GATHERTHREAD_DSH_TEST_TOKEN",
    },
    projectId: "project-1",
    sessionId: "session-1",
    deviceId: "device-1",
    workspacePath,
    statePath,
    provider: "deepseek-official",
    model: "DeepSeek-CustomCase",
    pollIntervalMs: 50,
    pollLimit: 20,
    shareToolEvents: false,
  };

  await apply(fixture.context, rawConfig);
  assert.equal(fixture.activeHandles, 1);
  assert.equal(fixture.listenerCount(), 2);
  await waitFor(() => eventReads === 2);
  await bounded(fixture.effects[0]?.(), 500);
  assert.equal(abortedReads, 1);
  assert.equal(fixture.activeHandles, 0);
  assert.equal(fixture.listenerCount(), 0);

  await apply(fixture.context, rawConfig);
  assert.equal(fixture.createCount, 1);
  assert.equal(fixture.resumeCount, 1);
  assert.equal(fixture.activeHandles, 1);
  assert.equal(fixture.listenerCount(), 2);
  await waitFor(() => eventReads === 4);
  await bounded(fixture.effects[1]?.(), 500);
  await bounded(fixture.effects[1]?.(), 500);
  assert.equal(abortedReads, 2);
  assert.equal(fixture.disposeCount, 2);
  assert.equal(fixture.activeHandles, 0);
  assert.equal(fixture.maximumActiveHandles, 1, "HMR must never retain two DSH write owners");
  assert.equal(fixture.listenerCount(), 0);

  const readsAfterUnload = eventReads;
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(eventReads, readsAfterUnload, "unload must clear every poll timer");
  assert.equal(requests.filter((request) => request.url.endsWith("/runtimes")).length, 2);
  assert.equal(requests.every((request) => !request.url.includes(token)), true);
  assert.equal(requests.every((request) => !String(request.init.body ?? "").includes(token)), true);
  assert.equal(requests.every((request) => {
    return new Headers(request.init.headers).get("authorization") === `Bearer ${token}`;
  }), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(statePath))).mode & 0o777, 0o700);
  }
});

test("explicit project mode loads independent Sessions and releases every Host owner on HMR", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-project-plugin-")));
  const workspacePath = path.join(root, "readonly-workspace");
  const stateRoot = path.join(root, "private-project-state");
  const token = "project-fixture-token-never-log";
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    token: process.env.GATHERTHREAD_DSH_PROJECT_TEST_TOKEN,
    telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED,
    telemetryMode: process.env.DSH_TELEMETRY_MODE,
    permissionMode: process.env.DSH_PERMISSION_MODE,
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    restoreEnvironment("GATHERTHREAD_DSH_PROJECT_TEST_TOKEN", previousEnvironment.token);
    restoreEnvironment("DSH_TELEMETRY_DISABLED", previousEnvironment.telemetryDisabled);
    restoreEnvironment("DSH_TELEMETRY_MODE", previousEnvironment.telemetryMode);
    restoreEnvironment("DSH_PERMISSION_MODE", previousEnvironment.permissionMode);
  });
  process.env.GATHERTHREAD_DSH_PROJECT_TEST_TOKEN = token;
  process.env.DSH_TELEMETRY_DISABLED = "1";
  process.env.DSH_TELEMETRY_MODE = "DISABLED";
  process.env.DSH_PERMISSION_MODE = "read-only";

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const runtimeRegistrations: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/me")) {
      return Response.json({ data: {
        id: "user-1",
        username: "Fixture User",
        device_id: "device-1",
      } });
    }
    if (url.endsWith("/projects/project-1/sessions")) {
      return Response.json({ data: { sessions: [
        {
          id: "session-a",
          project_id: "project-1",
          title: "A",
          mode: "multi",
          state: "active",
          role: "participant",
          current_sequence: 0,
        },
        {
          id: "session-b",
          project_id: "project-1",
          owner_user_id: "user-1",
          title: "B",
          mode: "solo",
          state: "active",
          role: "participant",
          current_sequence: 0,
        },
      ] } });
    }
    if (url.endsWith("/runtimes")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      runtimeRegistrations.push(body);
      return Response.json({ data: { runtime: {
        id: `runtime-${String(body.session_id)}`,
        user_id: "user-1",
        session_id: body.session_id,
        device_id: body.device_id,
        harness: body.harness,
        provider: body.provider,
        model: body.model,
        local_session_id: body.local_session_id,
        capture_fidelity: body.capture_fidelity,
        purpose: body.purpose,
      } } });
    }
    if (/\/sessions\/session-[ab]\/events\?/.test(url)) {
      return Response.json({ data: { events: [], cursor: 0, has_more: false } });
    }
    throw new Error(`unexpected project fixture request: ${url}`);
  };

  const fixture = dynamicHostFixture();
  const rawConfig = {
    enabled: true,
    bindingMode: "project",
    apiUrl: "https://gatherthread.example/v1",
    credentialReference: {
      kind: "environment",
      variable: "GATHERTHREAD_DSH_PROJECT_TEST_TOKEN",
    },
    projectId: "project-1",
    deviceId: "device-1",
    workspacePath,
    stateRoot,
    provider: "deepseek-official",
    model: "DeepSeek-CustomCase",
    pollIntervalMs: 60_000,
    pollLimit: 20,
    shareToolEvents: false,
    refreshIntervalMs: 60_000,
    maxConcurrentSessions: 2,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
  };

  await apply(fixture.context, rawConfig);
  assert.equal(fixture.activeHandles, 2);
  assert.equal(fixture.listenerCount(), 4);
  assert.equal(fixture.createCount, 2);
  await bounded(fixture.effects[0]?.(), 500);
  assert.equal(fixture.activeHandles, 0);
  assert.equal(fixture.listenerCount(), 0);

  await apply(fixture.context, rawConfig);
  assert.equal(fixture.activeHandles, 2);
  assert.equal(fixture.resumeCount, 2);
  assert.equal(fixture.maximumActiveHandles, 2, "project HMR must retain at most one owner per Session");
  await bounded(fixture.effects[1]?.(), 500);
  assert.equal(fixture.activeHandles, 0);
  assert.equal(fixture.listenerCount(), 0);

  const stateFiles = (await readdir(stateRoot)).filter((entry) => entry.endsWith(".json"));
  assert.equal(stateFiles.length, 2);
  assert.equal(runtimeRegistrations.length, 4);
  const runtimeIdentities = runtimeRegistrations.map((entry) => String(entry.local_session_id));
  assert.equal(new Set(runtimeIdentities).size, 2);
  assert.deepEqual(
    [...new Set(runtimeIdentities)].map((identity) => runtimeIdentities.filter((item) => item === identity).length).sort(),
    [2, 2],
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
    for (const stateFile of stateFiles) {
      assert.equal((await stat(path.join(stateRoot, stateFile))).mode & 0o777, 0o600);
    }
  }
  assert.equal(requests.every((request) => !request.url.includes(token)), true);
  assert.equal(requests.every((request) => !String(request.init.body ?? "").includes(token)), true);
  assert.equal(requests.every((request) => {
    return new Headers(request.init.headers).get("authorization") === `Bearer ${token}`;
  }), true);
});

function hostFixture(sessionId: string) {
  const listeners = new Map<string, Set<Listener>>();
  const effects: Array<() => void | Promise<void>> = [];
  const events: unknown[] = [];
  let persisted = false;
  let activeHandles = 0;
  let maximumActiveHandles = 0;
  let createCount = 0;
  let resumeCount = 0;
  let disposeCount = 0;
  const session = {
    id: sessionId,
    get seq() { return events.length; },
    snapshotEvents(from = 0) { return events.slice(from); },
  };
  const createHandle = () => {
    activeHandles += 1;
    maximumActiveHandles = Math.max(maximumActiveHandles, activeHandles);
    let disposed = false;
    return {
      agent: {
        id: sessionId,
        session,
        status: "idle",
        followup() { throw new Error("fixture did not expect a prompt"); },
        async whenIdle() {},
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        activeHandles -= 1;
        disposeCount += 1;
      },
    };
  };
  const services = {
    agents: {
      async create(options: { sessionId: string }) {
        assert.equal(options.sessionId, sessionId);
        assert.equal(persisted, false);
        persisted = true;
        createCount += 1;
        return createHandle();
      },
      async resume(options: { resumeSessionId: string }) {
        assert.equal(options.resumeSessionId, sessionId);
        assert.equal(persisted, true);
        resumeCount += 1;
        return createHandle();
      },
    },
    sessionPersistence: {
      async stat(candidate: string) {
        assert.equal(candidate, sessionId);
        return persisted ? { header: { id: sessionId } } : undefined;
      },
    },
    sessions: { async flush() {} },
    llm: {},
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
      effects.push(effect());
      return () => undefined;
    },
    inject() {
      return { async dispose() {} };
    },
  };
  return {
    context,
    effects,
    listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
    get activeHandles() { return activeHandles; },
    get maximumActiveHandles() { return maximumActiveHandles; },
    get createCount() { return createCount; },
    get resumeCount() { return resumeCount; },
    get disposeCount() { return disposeCount; },
  };
}

function dynamicHostFixture() {
  const listeners = new Map<string, Set<Listener>>();
  const effects: Array<() => void | Promise<void>> = [];
  const persisted = new Set<string>();
  let activeHandles = 0;
  let maximumActiveHandles = 0;
  let createCount = 0;
  let resumeCount = 0;
  const createHandle = (sessionId: string) => {
    const events: unknown[] = [];
    activeHandles += 1;
    maximumActiveHandles = Math.max(maximumActiveHandles, activeHandles);
    let disposed = false;
    const session = {
      id: sessionId,
      get seq() { return events.length; },
      snapshotEvents(from = 0) { return events.slice(from); },
    };
    return {
      agent: {
        id: sessionId,
        session,
        status: "idle",
        followup() { throw new Error("fixture did not expect a prompt"); },
        async whenIdle() {},
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        activeHandles -= 1;
      },
    };
  };
  const services = {
    agents: {
      async create(options: { sessionId: string }) {
        assert.equal(persisted.has(options.sessionId), false);
        persisted.add(options.sessionId);
        createCount += 1;
        return createHandle(options.sessionId);
      },
      async resume(options: { resumeSessionId: string }) {
        assert.equal(persisted.has(options.resumeSessionId), true);
        resumeCount += 1;
        return createHandle(options.resumeSessionId);
      },
    },
    sessionPersistence: {
      async stat(sessionId: string) {
        return persisted.has(sessionId) ? { header: { id: sessionId } } : undefined;
      },
    },
    sessions: { async flush() {} },
    llm: {},
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
      effects.push(effect());
      return () => undefined;
    },
    inject() {
      return { async dispose() {} };
    },
  };
  return {
    context,
    effects,
    listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
    get activeHandles() { return activeHandles; },
    get maximumActiveHandles() { return maximumActiveHandles; },
    get createCount() { return createCount; },
    get resumeCount() { return resumeCount; },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function bounded(value: void | Promise<void> | undefined, milliseconds: number): Promise<void> {
  await Promise.race([
    Promise.resolve(value),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("plugin disposer exceeded its time bound")), milliseconds).unref?.();
    }),
  ]);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
