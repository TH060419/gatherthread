import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

interface Handoff {
  id: string;
  factory(require: (specifier: string) => unknown): {
    inject: string[];
    apply(context: unknown): void;
  };
}

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

async function loadClient(options: {
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
} = {}) {
  const source = await readFile(path.join(packageRoot, "client", "client.js"), "utf8");
  let handoff: Handoff | undefined;
  let effect: (() => (() => void)) | undefined;
  const stateWrites: unknown[] = [];
  // Hook state survives a re-render so a test can drive the panel to a specific
  // state and assert on what it actually renders, instead of only matching
  // bundle source text. The cursor resets per render, the way React numbers
  // hooks by call order.
  const hookState = new Map<number, unknown>();
  let hookCursor = 0;
  const React = {
    useState(initial: unknown) {
      const index = hookCursor++;
      if (!hookState.has(index)) hookState.set(index, initial);
      return [hookState.get(index), (value: unknown) => {
        const next = typeof value === "function"
          ? (value as (previous: unknown) => unknown)(hookState.get(index))
          : value;
        hookState.set(index, next);
        stateWrites.push(value);
      }];
    },
    useEffect(callback: () => () => void) { effect = callback; },
    useRef(initial: unknown) {
      const index = hookCursor++;
      if (!hookState.has(index)) hookState.set(index, { current: initial });
      return hookState.get(index) as { current: unknown };
    },
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      return { type, props, children };
    },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value: Handoff) { handoff = value; } } },
    fetch: options.fetch ?? globalThis.fetch,
    setTimeout: options.setTimeout ?? globalThis.setTimeout,
    clearTimeout: options.clearTimeout ?? globalThis.clearTimeout,
    AbortController,
    Date,
    Number,
    JSON,
    Set,
    Object,
    String,
    // `URL` is a host global, not a language intrinsic, so a bare vm context
    // does not have it. The Client parses grant URLs with it, which only a
    // paired native state reaches.
    URL,
    URLSearchParams,
  });
  vm.runInContext(source, context, { filename: "gatherthread-dsh-client.js" });
  if (handoff === undefined) throw new Error("client bundle did not register");
  const plugin = handoff.factory((specifier) => {
    if (specifier !== "react") throw new Error(`unexpected client external: ${specifier}`);
    return React;
  });
  return {
    source,
    handoff,
    plugin,
    stateWrites,
    getEffect: () => effect,
    /** Render a registered component with persistent hooks, as React would. */
    render<T>(component: () => T): T {
      hookCursor = 0;
      return component();
    },
  };
}

/** Collect every string a fake-element tree would put on screen. */
function collectedText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectedText).join("");
  if (node === null || typeof node !== "object") return "";
  return collectedText((node as { children?: unknown }).children);
}

test("dsh.client bundle registers the official settings Slot without credential material", async () => {
  const loaded = await loadClient();
  assert.equal(loaded.handoff.id, "@gatherthread/dsh-host");
  assert.deepEqual(Array.from(loaded.plugin.inject), ["slots", "connection", "sessions"]);
  let registration: { options: Record<string, unknown>; component: () => unknown } | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    slots: {
      inject(name: string, create: () => unknown) {
        assert.equal(name, "settings.section");
        create();
      },
      register(options: Record<string, unknown>, component: () => unknown) {
        registration = { options, component };
        return () => undefined;
      },
    },
  });
  assert.equal(registration?.options.id, "gatherthread");
  assert.equal(typeof registration?.component, "function");
  assert.doesNotMatch(loaded.source, /GATHERTHREAD_DSH_TOKEN|GATHERTHREAD_TOKEN|Authorization|localStorage|sessionStorage/);
  assert.doesNotMatch(loaded.source, /\/Users\/|[A-Za-z]:\\\\/);
  assert.doesNotMatch(loaded.source, /#[0-9a-f]{3,8}\b/iu, "Client surfaces must not hard-code light-theme colors");
  assert.match(loaded.source, /已验证兼容：[\s\S]*state\.compatibility\.version/);
  assert.match(loaded.source, /"自动上传"/u);
  assert.match(loaded.source, /"sync\/set-auto-upload"/u);
  assert.match(loaded.source, /"sync\/upload"/u);
  assert.match(loaded.source, /手动上传/u);
});

test("Client explains that a paired connection is inactive until a DSH model is selected", async () => {
  const loaded = await loadClient();
  // Reaching the route-less branch means authorization is already "paired":
  // "unpaired" and "pairing" are handled by earlier branches. The grant exists
  // but no runtime is registered yet, so the GatherThread workspace cannot
  // discover this DSH. The panel must say so instead of reporting a bare
  // stopped connection, which is indistinguishable from a fresh install.
  assert.match(
    loaded.source,
    /尚未选择 DSH Provider 与 Model/u,
    "a paired-but-unrouted connection must explain that a model selection is still required",
  );
  assert.match(
    loaded.source,
    /配对完成后/u,
    "the notice must state that pairing itself already succeeded",
  );
});

test("Client renders the model-selection notice for a paired but unrouted connection", async () => {
  // A source-text match only proves the copy ships. This drives the panel to the
  // paired-without-route state that pairing actually leaves behind and asserts
  // the notice reaches the rendered output.
  const loaded = await loadClient({
    fetch: (async () => { throw new Error("native Client must not use the legacy Fetch route"); }) as typeof fetch,
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    connection: {
      rpc: {
        async call() {
          return { ok: true, value: {
            schemaVersion: 2,
            integration: "gatherthread",
            authorization: "paired",
            serverUrl: "http://127.0.0.1:8787",
            deviceName: "DeepSeek Harness",
            compatibility: { package: "@deepseek-ai/dsh", version: "0.1.2-rc.1", profile: "web" },
            runtime: {
              schemaVersion: 1,
              integration: "gatherthread",
              connection: "stopped",
              bindingMode: "project",
              projectName: "GatherThread / 共序",
              activeSessionCount: 0,
              sessions: [],
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
            // No `route`: pairing succeeded, but no provider or model is chosen.
          } };
        },
      },
    },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  assert.equal(typeof component, "function");
  loaded.render(component as () => unknown);
  const cleanup = loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rendered = collectedText(loaded.render(component as () => unknown));
  cleanup?.();
  assert.match(
    rendered,
    /配对完成后，尚未选择 DSH Provider 与 Model/u,
    `the paired-without-route panel must tell the operator what is still missing; rendered: ${rendered}`,
  );
  assert.match(
    rendered,
    /选择 DSH 模型/u,
    "the action that completes the step must stay on screen",
  );
});

test("Client primary actions keep a visible system foreground in light, dark, and Safari themes", async () => {
  const loaded = await loadClient();
  assert.match(
    loaded.source,
    /primaryButton:\s*\{[^}]*background:\s*"Highlight"[^}]*color:\s*"HighlightText"[^}]*WebkitTextFillColor:\s*"HighlightText"/su,
  );
  assert.doesNotMatch(
    loaded.source,
    /background:\s*"currentColor",\s*color:\s*"Canvas"/u,
    "currentColor must not be derived from the foreground color used to paint the label",
  );
});

test("Client prefers the authenticated DSH RPC channel and accepts only the pinned native status shape", async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = [];
  let sessionListRefreshes = 0;
  const loaded = await loadClient({
    fetch: (async () => { throw new Error("native Client must not use the legacy Fetch route"); }) as typeof fetch,
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() { sessionListRefreshes += 1; } },
    connection: {
      rpc: {
        async call(channel: string, endpoint: string, payload: unknown) {
          calls.push({ channel, endpoint, payload });
          return { ok: true, value: {
            schemaVersion: 2,
            integration: "gatherthread",
            authorization: "unpaired",
            compatibility: { package: "@deepseek-ai/dsh", version: "0.1.2-rc.1", profile: "web" },
            runtime: {
              schemaVersion: 1,
              integration: "gatherthread",
              connection: "stopped",
              bindingMode: "project",
              projectName: "GatherThread / 共序",
              activeSessionCount: 1,
              sessions: [{ sessionId: "session-1", title: "General", state: "idle" }],
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
          } };
        },
      },
    },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  component?.();
  const cleanup = loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.channel, "/gatherthread");
  assert.equal(calls[0]?.endpoint, "status/get");
  assert.deepEqual(Object.keys(calls[0]?.payload as object), []);
  assert.equal(sessionListRefreshes, 1, "a newly attached native Session must refresh DSH's work-page list");
  assert.ok(loaded.stateWrites.some((value) => (
    value !== null && typeof value === "object" && Reflect.get(value, "authorization") === "unpaired"
  )));
  cleanup?.();
});

test("Client fails closed on malformed native RPC state instead of falling back to the legacy route", async () => {
  let fetchCount = 0;
  const callbacks: Array<() => void> = [];
  const loaded = await loadClient({
    fetch: (async () => {
      fetchCount += 1;
      return new Response("{}");
    }) as typeof fetch,
    setTimeout: ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    connection: { rpc: { async call() { return { ok: true, value: { schemaVersion: 999 } }; } } },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  component?.();
  loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 0);
  assert.equal(callbacks.length, 0, "an incompatible native contract must not retry or use another channel");
  assert.equal(loaded.stateWrites.includes(true), true);
});

test("Client status request is same-origin, cookie-based, bounded, and aborts on unmount", async () => {
  const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
  let scheduled: (() => void) | undefined;
  let cleared = 0;
  const snapshot = {
    schemaVersion: 1,
    integration: "gatherthread",
    connection: "connected",
    bindingMode: "project",
    projectName: "Project One",
    activeSessionCount: 1,
    sessions: [{ sessionId: "session-1", title: "General", state: "idle" }],
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
  const loaded = await loadClient({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(snapshot), {
        headers: { "content-length": String(JSON.stringify(snapshot).length) },
      });
    }) as typeof fetch,
    setTimeout: ((callback: () => void) => {
      scheduled = callback;
      return 7 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => { cleared += 1; }) as typeof clearTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  component?.();
  const cleanup = loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/gatherthread.status");
  assert.deepEqual({
    method: calls[0]?.init?.method,
    credentials: calls[0]?.init?.credentials,
    cache: calls[0]?.init?.cache,
    redirect: calls[0]?.init?.redirect,
  }, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  assert.equal(new Headers(calls[0]?.init?.headers).has("authorization"), false);
  assert.equal(typeof scheduled, "function");
  const signal = calls[0]?.init?.signal;
  cleanup?.();
  assert.equal(signal?.aborted, true);
  assert.equal(cleared, 1);
  assert.ok(loaded.stateWrites.some((value) => (
    value !== null && typeof value === "object" && Reflect.get(value, "integration") === "gatherthread"
  )));
});

test("Client clears stale details and stops polling after a permanent Host status failure", async () => {
  const callbacks: Array<() => void> = [];
  const loaded = await loadClient({
    fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
    setTimeout: ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  component?.();
  loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 0, "a permanent 4xx must not retain a retry timer");
  assert.equal(loaded.stateWrites.includes(undefined), true, "stale public status must be cleared");
  assert.equal(loaded.stateWrites.includes(true), true, "the panel must enter its generic unavailable state");
});

test("Client transient retries are bounded", async () => {
  const callbacks: Array<() => void> = [];
  const loaded = await loadClient({
    fetch: (async () => { throw new Error("offline"); }) as typeof fetch,
    setTimeout: ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  component?.();
  loaded.getEffect()?.();
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    callbacks[index]?.();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 3, "transient status failure must stop after three retries");
});
