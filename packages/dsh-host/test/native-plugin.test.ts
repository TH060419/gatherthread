import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_NATIVE_CREDENTIAL_KEY,
  type DshNativeGrant,
} from "../src/native-connection.js";
import {
  apply,
  DshNativeHostController,
  parseNativePluginConfig,
  registerNativeDshRpc,
} from "../src/native-plugin.js";
import { DshStatusController } from "../src/status.js";

function credentialsFixture(initial?: DshNativeGrant) {
  const records = new Map<string, unknown>();
  if (initial !== undefined) {
    records.set(DSH_NATIVE_CREDENTIAL_KEY, { kind: "grant", payload: structuredClone(initial) });
  }
  const calls = { read: 0, write: 0, clear: 0 };
  return {
    records,
    calls,
    service: {
      async readRecord(key: string) {
        calls.read += 1;
        return records.get(key);
      },
      async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) {
        calls.write += 1;
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, structuredClone(next));
        return records.get(key);
      },
      async deleteRecord(key: string) {
        calls.clear += 1;
        records.delete(key);
      },
    },
  };
}

function status() {
  return new DshStatusController({
    bindingMode: "project",
    projectName: "GatherThread / 共序",
    now: () => new Date("2026-09-06T00:00:00.000Z"),
  });
}

const unboundGrant: DshNativeGrant = {
  schemaVersion: 1,
  serverUrl: "https://gatherthread.example",
  apiUrl: "https://gatherthread.example/v1",
  deviceId: "dsh_device-1",
  deviceName: "DSH Mac",
  token: "gta_fixture-long-lived-secret",
};

function pairingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const run = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/dsh-pairings")) {
      return Response.json({ data: {
        pairing_id: "dshp_1",
        poll_token: "gtp_fixture-short-secret",
        user_code: "ABCD-2345",
        verification_path: "/#dsh-pair=ABCD-2345",
        expires_at: "2099-09-06T01:05:00.000Z",
        interval_seconds: 2,
      } }, { status: 201 });
    }
    return Response.json({ data: {
      status: "paired",
      device_id: "dsh_device-1",
      token: unboundGrant.token,
    } }, { status: 201 });
  }) as typeof fetch;
  return { calls, run };
}

test("native controller pairs, configures one project owner, and resumes it after reload", async () => {
  const credentials = credentialsFixture();
  const pairing = pairingFetch();
  const ownerStops: number[] = [];
  const ownerStarts: string[] = [];
  const validated: string[] = [];
  const makeController = () => new DshNativeHostController({
    context: { credentials: credentials.service },
    status: status(),
    workspacePath: "/readonly/workspace",
    fetch: pairing.run,
    listProjects: async () => [{
      id: "project-1",
      name: "Project One",
      role: "owner",
      state: "active",
      sessionCount: 2,
    }],
    listCatalog: async () => [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [{ id: "CaseSensitiveModel", name: "Case-sensitive model" }],
    }],
    validateModel: async (provider, model) => {
      validated.push(`${provider}/${model}`);
    },
    createOwner: async (_grant, binding) => {
      ownerStarts.push(`${binding.projectId}/${binding.provider}/${binding.model}`);
      let stopped = false;
      return { async stop() { if (!stopped) ownerStops.push(1); stopped = true; } };
    },
  });

  const controller = makeController();
  await controller.start();
  assert.equal(controller.publicState().authorization, "unpaired");
  const view = await controller.startPairing({
    serverUrl: "https://gatherthread.example",
    deviceName: "DSH Mac",
  });
  assert.deepEqual(Object.keys(view).sort(), [
    "expiresAt", "intervalSeconds", "schemaVersion", "status", "userCode", "verificationUrl",
  ]);
  assert.equal(JSON.stringify(view).includes("gtp_"), false);
  assert.equal(JSON.stringify(view).includes("gta_"), false);
  await controller.whenPairingSettled();
  assert.equal(controller.publicState().authorization, "paired");
  assert.equal(credentials.calls.write, 1);

  const catalog = await controller.catalog();
  assert.equal(catalog.projects[0]?.name, "Project One");
  assert.equal(catalog.providers[0]?.models[0]?.id, "CaseSensitiveModel");
  const connected = await controller.configure({
    projectId: "project-1",
    provider: "deepseek-official",
    model: "CaseSensitiveModel",
  });
  assert.equal(connected.binding?.model, "CaseSensitiveModel");
  assert.equal(JSON.stringify(connected).includes(unboundGrant.token), false);
  assert.deepEqual(validated, ["deepseek-official/CaseSensitiveModel"]);
  assert.deepEqual(ownerStarts, ["project-1/deepseek-official/CaseSensitiveModel"]);
  assert.equal(credentials.calls.write, 2);
  await controller.dispose();
  assert.equal(ownerStops.length, 1);

  const reloaded = makeController();
  await reloaded.start();
  assert.equal(reloaded.publicState().binding?.projectId, "project-1");
  assert.deepEqual(ownerStarts, [
    "project-1/deepseek-official/CaseSensitiveModel",
    "project-1/deepseek-official/CaseSensitiveModel",
  ]);
  await reloaded.disconnect();
  assert.equal(credentials.records.has(DSH_NATIVE_CREDENTIAL_KEY), false);
  assert.equal(reloaded.publicState().authorization, "unpaired");
  await reloaded.dispose();
  assert.equal(ownerStops.length, 2);
});

test("native controller disposal prevents a delayed pairing poll from writing a late grant", async () => {
  const credentials = credentialsFixture();
  const poll = deferred<Response>();
  let requestCount = 0;
  const fakeFetch = (async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Response.json({ data: {
        pairing_id: "dshp_1",
        poll_token: "gtp_fixture-short-secret",
        user_code: "ABCD-2345",
        verification_path: "/#dsh-pair=ABCD-2345",
        expires_at: "2099-09-06T01:05:00.000Z",
        interval_seconds: 2,
      } }, { status: 201 });
    }
    return poll.promise;
  }) as typeof fetch;
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service },
    status: status(),
    workspacePath: "/readonly/workspace",
    fetch: fakeFetch,
  });
  await controller.start();
  await controller.startPairing({
    serverUrl: "https://gatherthread.example",
    deviceName: "DSH Mac",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const disposing = controller.dispose();
  poll.resolve(Response.json({ data: {
    status: "paired",
    device_id: "dsh_device-1",
    token: unboundGrant.token,
  } }, { status: 201 }));
  await bounded(disposing, 500);
  assert.equal(credentials.calls.write, 0);
  assert.equal(credentials.records.size, 0);
});

test("native RPC returns only fixed failures and becomes unreachable after disposal", async () => {
  const credentials = credentialsFixture(unboundGrant);
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  let removed = 0;
  const context = {
    credentials: credentials.service,
    connection: { rpc: { handle(channel: string, value: typeof handler) {
      assert.equal(channel, "/gatherthread");
      handler = value;
      return async () => { removed += 1; };
    } } },
  };
  const controller = new DshNativeHostController({
    context,
    status: status(),
    workspacePath: "/readonly/workspace",
  });
  await controller.start();
  const disposeRpc = registerNativeDshRpc(context, controller);
  const signal = new AbortController().signal;
  const state = await handler?.("status/get", {}, signal) as { ok: boolean; value?: unknown };
  assert.equal(state.ok, true);
  assert.equal(JSON.stringify(state.value).includes(unboundGrant.token), false);
  const failed = await handler?.("connection/configure", {
    projectId: "bad",
    provider: "bad",
    model: "gta_do-not-echo",
  }, signal) as { ok: boolean; error?: { message: string } };
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.message.includes("gta_do-not-echo"), false);
  await disposeRpc();
  await disposeRpc();
  assert.equal(removed, 1);
  const gone = await handler?.("status/get", {}, signal) as { ok: boolean; error?: { code: string } };
  assert.equal(gone.ok, false);
  assert.equal(gone.error?.code, "gatherthread/not-found");
  await controller.dispose();
});

test("native Cordis entry is inert by default and unload/HMR owns one route set", async () => {
  assert.deepEqual(parseNativePluginConfig(undefined), {
    enabled: false,
    workspacePath: process.cwd(),
  });
  assert.deepEqual(parseNativePluginConfig({
    enabled: true,
    workspacePath: "/readonly/workspace",
    officialServerUrl: "https://official.gatherthread.example/v1/",
  }), {
    enabled: true,
    workspacePath: "/readonly/workspace",
    officialServerUrl: "https://official.gatherthread.example",
  });
  assert.throws(() => parseNativePluginConfig({
    enabled: true,
    workspacePath: "/readonly/workspace",
    officialServerUrl: "http://lan.example",
  }), /HTTPS except on loopback/);
  await apply(new Proxy({}, {
    get() { throw new Error("disabled native plugin touched DSH services"); },
  }));

  const credentials = credentialsFixture();
  const effects: Array<() => void | Promise<void>> = [];
  const injectedEffects: Array<() => void | Promise<void>> = [];
  const routes = new Set<string>();
  const channels = new Set<string>();
  const context = {
    credentials: credentials.service,
    get(name: string) {
      if (name === "credentials") return credentials.service;
      return undefined;
    },
    on() { return () => undefined; },
    effect(effect: () => () => void | Promise<void>) {
      effects.push(effect());
      return () => undefined;
    },
    inject(dependencies: readonly string[], callback: (value: unknown) => void) {
      assert.deepEqual(dependencies, ["connection"]);
      const child = {
        credentials: credentials.service,
        connection: undefined as unknown,
        effect(effect: () => () => void | Promise<void>) {
          injectedEffects.push(effect());
          return () => undefined;
        },
      };
      child.connection = context.connection;
      callback(child);
      return {
        async dispose() {
          for (const dispose of injectedEffects.splice(0)) await dispose();
        },
      };
    },
    connection: {
      fetch: { register(route: { path: string }) {
        assert.equal(routes.has(route.path), false);
        routes.add(route.path);
        return async () => { routes.delete(route.path); };
      } },
      rpc: { handle(channel: string) {
        assert.equal(channels.has(channel), false);
        channels.add(channel);
        return async () => { channels.delete(channel); };
      } },
    },
  };

  await apply(context, { enabled: true, workspacePath: "/readonly/workspace" });
  assert.deepEqual([...routes], ["/api/gatherthread.status"]);
  assert.deepEqual([...channels], ["/gatherthread"]);
  assert.equal(effects.length, 1);
  await effects.shift()?.();
  assert.equal(routes.size, 0);
  assert.equal(channels.size, 0);

  await apply(context, { enabled: true, workspacePath: "/readonly/workspace" });
  assert.equal(routes.size, 1);
  assert.equal(channels.size, 1);
  await effects.shift()?.();
  assert.equal(routes.size, 0);
  assert.equal(channels.size, 0);
});

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("native plugin operation exceeded its time bound")), milliseconds).unref?.();
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
