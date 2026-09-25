import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_NATIVE_CREDENTIAL_KEY,
  type DshNativeGrant,
} from "../src/native-connection.js";
import {
  apply,
  DSH_NATIVE_AGENT_PRESET,
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
  schemaVersion: 2,
  serverUrl: "https://gatherthread.example",
  apiUrl: "https://gatherthread.example/v1",
  deviceId: "dsh_device-1",
  deviceName: "DSH Mac",
  token: "gta_fixture-long-lived-secret",
};

const deepseekChatExecutionProfiles = async (provider: string) => [{
  provider,
  model: "deepseek-chat",
}];

test("native GatherThread Sessions use DSH's editable standard preset", () => {
  assert.equal(DSH_NATIVE_AGENT_PRESET, "standard");
});

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
  const advertisedProfiles: unknown[] = [];
  const validated: string[] = [];
  const resolvedModels: string[] = [];
  const makeController = () => new DshNativeHostController({
    context: {
      credentials: credentials.service,
      llm: {
        listProviders: () => [{ id: "deepseek-official", name: "DeepSeek" }],
        listModels: async (provider: string) => [{
          provider,
          id: "CaseSensitiveModel",
          name: "Case-sensitive model",
        }, {
          provider,
          id: "deepseek-chat",
          name: "DeepSeek Chat",
        }],
        resolveModelInfo: async (provider: string, model: string) => {
          resolvedModels.push(`${provider}/${model}`);
          return model === "CaseSensitiveModel"
            ? {
              provider,
              id: model,
              name: "Case-sensitive model",
              reasoning: {
                efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
                defaultEffort: "high",
              },
            }
            : { provider, id: model, name: "DeepSeek Chat" };
        },
      },
    },
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
    resolveWorkspace: async () => "/readonly/workspace",
    createOwner: async (_grant, binding, _signal, _status, _workspace, executionProfiles) => {
      ownerStarts.push(`${binding.projectId}/${binding.provider}/${binding.model}`);
      advertisedProfiles.push(structuredClone(executionProfiles));
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
  await assert.rejects(controller.configure({
    projectId: "project-1",
    provider: "deepseek-official",
    model: "CaseSensitiveModel",
  }), /refresh DSH and explicitly confirm/);
  const connected = await controller.configure({
    provider: "deepseek-official",
    model: "CaseSensitiveModel",
  });
  assert.equal(connected.route?.model, "CaseSensitiveModel");
  assert.deepEqual(connected.bindings?.map((binding) => binding.projectId), ["project-1"]);
  assert.equal(JSON.stringify(connected).includes(unboundGrant.token), false);
  assert.deepEqual(validated, ["deepseek-official/CaseSensitiveModel"]);
  assert.deepEqual(ownerStarts, ["project-1/deepseek-official/CaseSensitiveModel"]);
  assert.deepEqual(advertisedProfiles[0], [{
    provider: "deepseek-official",
    model: "CaseSensitiveModel",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  }, {
    provider: "deepseek-official",
    model: "deepseek-chat",
  }]);
  assert.deepEqual(resolvedModels, [
    "deepseek-official/CaseSensitiveModel",
    "deepseek-official/deepseek-chat",
  ]);
  assert.equal(credentials.calls.write, 2);
  await controller.dispose();
  assert.equal(ownerStops.length, 1);

  const reloaded = makeController();
  await reloaded.start();
  assert.equal(reloaded.publicState().bindings?.[0]?.projectId, "project-1");
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

test("native actions stay unavailable until credential restoration settles", async () => {
  const credentials = credentialsFixture(unboundGrant);
  const reading = deferred<void>();
  const releaseRead = deferred<void>();
  const originalRead = credentials.service.readRecord;
  credentials.service.readRecord = async (key) => {
    const captured = await originalRead(key);
    reading.resolve();
    await releaseRead.promise;
    return captured;
  };
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service }, status: status(), workspacePath: "/readonly/workspace",
  });
  const starting = controller.start();
  try {
    await reading.promise;
    await assert.rejects(controller.disconnect(), /unavailable/);
    await assert.rejects(controller.start(), /already started/);
    releaseRead.resolve();
    await starting;
    await controller.disconnect();
    assert.equal(controller.publicState().authorization, "unpaired");
    assert.equal(credentials.records.has(DSH_NATIVE_CREDENTIAL_KEY), false);
  } finally { releaseRead.resolve(); await starting; await controller.dispose(); }
});

test("disconnect invalidates in-flight configuration before it can restore a saved pairing", async () => {
  const credentials = credentialsFixture(unboundGrant);
  const validating = deferred<void>();
  const releaseValidation = deferred<void>();
  let ownerStarts = 0;
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service }, status: status(), workspacePath: "/readonly/workspace",
    listProjects: async () => [{ id: "project-1", name: "Project One", role: "owner", state: "active", sessionCount: 0 }],
    validateModel: async () => { validating.resolve(); await releaseValidation.promise; },
    resolveWorkspace: async () => "/readonly/workspace",
    createOwner: async () => { ownerStarts += 1; return { async stop() {} }; },
  });
  await controller.start();
  try {
    const configuring = controller.configure({ provider: "custom-provider", model: "model-one" });
    const rejected = assert.rejects(configuring, /cancel|disconnect|unavailable|abort/iu);
    await validating.promise;
    const disconnecting = controller.disconnect();
    releaseValidation.resolve();
    await Promise.all([rejected, disconnecting]);
    assert.equal(controller.publicState().authorization, "unpaired");
    assert.equal(credentials.records.has(DSH_NATIVE_CREDENTIAL_KEY), false);
    assert.equal(ownerStarts, 0);
  } finally { releaseValidation.resolve(); await controller.dispose(); }
});

test("pairing startup reserves its slot before the first network response", async () => {
  const credentials = credentialsFixture();
  const firstRequest = deferred<void>();
  const releaseRequest = deferred<void>();
  const pairing = pairingFetch();
  let requests = 0;
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service }, status: status(), workspacePath: "/readonly/workspace",
    fetch: (async (input, init) => {
      if (String(input).endsWith("/dsh-pairings")) {
        requests += 1;
        firstRequest.resolve();
        await releaseRequest.promise;
      }
      return pairing.run(input, init);
    }) as typeof fetch,
  });
  await controller.start();
  try {
    const input = { serverUrl: "https://gatherthread.example", deviceName: "DSH Mac" };
    const first = controller.startPairing(input);
    await firstRequest.promise;
    const second = controller.startPairing(input);
    const rejected = assert.rejects(second, /already active/);
    releaseRequest.resolve();
    await Promise.all([first, rejected]);
    await controller.whenPairingSettled();
    assert.equal(requests, 1);
    assert.equal(credentials.calls.write, 1);
  } finally { releaseRequest.resolve(); await controller.dispose(); }
});

test("project role changes restart only the affected owner to refresh native write capabilities", async () => {
  const credentials = credentialsFixture({
    ...unboundGrant, route: { provider: "custom-provider", model: "model-one" },
  });
  let role: "viewer" | "participant" = "viewer";
  const starts: string[] = [];
  const stops: string[] = [];
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service }, status: status(), workspacePath: "/readonly/workspace",
    listProjects: async () => [
      { id: "changing", name: "Changing", role, state: "active", sessionCount: 1 },
      { id: "stable", name: "Stable", role: "owner", state: "active", sessionCount: 1 },
    ],
    validateModel: async () => undefined,
    resolveWorkspace: async () => "/readonly/workspace",
    createOwner: async (_grant, binding) => {
      starts.push(binding.projectId);
      return { async stop() { stops.push(binding.projectId); } };
    },
  });
  await controller.start();
  try {
    assert.deepEqual(starts, ["changing", "stable"]);
    await controller.refreshProjects();
    assert.equal(starts.length, 2, "an unchanged role must not restart a running project");
    role = "participant";
    await controller.refreshProjects();
    assert.deepEqual(starts, ["changing", "stable", "changing"]);
    assert.deepEqual(stops, ["changing"]);
    role = "viewer";
    await controller.refreshProjects();
    assert.deepEqual(starts, ["changing", "stable", "changing", "changing"]);
    assert.deepEqual(stops, ["changing", "changing"]);
  } finally { await controller.dispose(); }
});

test("native settings RPC controls automatic and manual upload for one DSH conversation", async () => {
  const routedGrant: DshNativeGrant = {
    ...unboundGrant,
    route: { provider: "deepseek-official", model: "deepseek-chat" },
  };
  const credentials = credentialsFixture(routedGrant);
  const publicStatus = status();
  publicStatus.upsertSession({
    sessionId: "session-1",
    title: "Local conversation",
    state: "idle",
  });
  let automaticUpload = true;
  let uploadCalls = 0;
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  const context = {
    credentials: credentials.service,
    connection: { rpc: { handle(channel: string, value: typeof handler) {
      assert.equal(channel, "/gatherthread");
      handler = value;
      return async () => undefined;
    } } },
  };
  const syncStatus = () => ({
    sessionId: "session-1",
    localSessionId: "dsh-session-1",
    automaticUpload,
    pendingLocalTurns: automaticUpload ? 0 : 1,
    uploadableLocalTurns: automaticUpload ? 0 : 1,
  });
  const controller = new DshNativeHostController({
    context,
    status: publicStatus,
    workspacePath: "/readonly/workspace",
    listExecutionProfiles: deepseekChatExecutionProfiles,
    listProjects: async () => [{
      id: "project-1",
      name: "Project One",
      role: "owner",
      state: "active",
      sessionCount: 1,
    }],
    resolveWorkspace: async () => "/readonly/workspace",
    createOwner: async () => ({
      localSyncStatuses: () => [syncStatus()],
      async setLocalAutoUpload(sessionId: string, enabled: boolean) {
        assert.equal(sessionId, "session-1");
        automaticUpload = enabled;
        return syncStatus();
      },
      async uploadLocalTurns(sessionId: string) {
        assert.equal(sessionId, "session-1");
        uploadCalls += 1;
        return { ...syncStatus(), discoveredLocalTurns: 1, uploadedLocalTurns: 1 };
      },
      async stop() {},
    }),
  });
  await controller.start();
  const disposeRpc = registerNativeDshRpc(context, controller);
  const signal = new AbortController().signal;

  const initial = await handler?.("status/get", {}, signal) as {
    ok: boolean;
    value?: { localSync?: Array<{ title: string; automaticUpload: boolean }> };
  };
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.value?.localSync, [{
    ...syncStatus(),
    projectId: "project-1",
    projectName: "Project One",
    title: "session-1",
  }]);

  const disabled = await handler?.("sync/set-auto-upload", {
    projectId: "project-1",
    sessionId: "session-1",
    enabled: false,
  }, signal) as { ok: boolean; value?: { localSync?: Array<{ automaticUpload: boolean }> } };
  assert.equal(disabled.ok, true);
  assert.equal(disabled.value?.localSync?.[0]?.automaticUpload, false);

  const uploaded = await handler?.("sync/upload", {
    projectId: "project-1",
    sessionId: "session-1",
  }, signal) as { ok: boolean };
  assert.equal(uploaded.ok, true);
  assert.equal(uploadCalls, 1);
  assert.equal(automaticUpload, false, "manual recovery must not change the automatic-upload preference");

  await disposeRpc();
  await controller.dispose();
});

test("native code RPC requires project opt-in, rejects arbitrary paths and hides viewer controls", async () => {
  const credentials = credentialsFixture({
    ...unboundGrant, route: { provider: "deepseek-official", model: "deepseek-chat" },
  });
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  const context = {
    credentials: credentials.service,
    connection: { rpc: { handle(_channel: string, value: typeof handler) {
      handler = value;
      return async () => undefined;
    } } },
  };
  const invoked: string[] = [];
  const consent = new Map<string, boolean>();
  const controller = new DshNativeHostController({
    context, status: status(), workspacePath: "/readonly/workspace",
    listExecutionProfiles: deepseekChatExecutionProfiles,
    listProjects: async () => [
      { id: "project-own", name: "Own", role: "owner", state: "active", sessionCount: 1 },
      { id: "project-read", name: "Read", role: "viewer", state: "active", sessionCount: 1 },
    ],
    resolveWorkspace: async () => "/readonly/workspace",
    createOwner: async (_grant, binding) => {
      const view = () => ({ authorized: consent.get(binding.projectId) === true });
      return {
        codeSyncView: view,
        async authorizeCodeSync(enabled: boolean) {
          consent.set(binding.projectId, enabled);
          invoked.push(`consent:${binding.projectId}:${enabled}`);
          return view();
        },
        async executeCodeSync(action: string) {
          invoked.push(`action:${binding.projectId}:${action}`);
          return view();
        },
        async stop() {},
      };
    },
  });
  await controller.start();
  const disposeRpc = registerNativeDshRpc(context, controller);
  const invoke = async (endpoint: string, payload: unknown) => await handler!(endpoint, payload, new AbortController().signal) as { ok: boolean };
  try {
    assert.deepEqual(controller.publicState().codeSync, [{ projectId: "project-own", projectName: "Own", authorized: false }]);
    assert.equal((await invoke("code/authorize", { projectId: "project-own", enabled: true })).ok, true);
    assert.equal((await invoke("code/action", { projectId: "project-own", action: "code_upload" })).ok, true);
    for (const payload of [
      { projectId: "project-read", action: "code_upload" },
      { projectId: "unknown-project", action: "code_upload" },
      { projectId: "project-own", action: "code_upload", workspace: "/arbitrary" },
      { projectId: "project-own", action: "shell" },
    ]) assert.equal((await invoke("code/action", payload)).ok, false);
    assert.equal((await invoke("code/authorize", { projectId: "project-read", enabled: true })).ok, false);
    assert.equal((await invoke("code/authorize", { projectId: "project-own", enabled: "true" })).ok, false);
    assert.deepEqual(invoked, ["consent:project-own:true", "action:project-own:code_upload"]);
    assert.doesNotMatch(JSON.stringify(controller.publicState()), /gta_fixture|\/readonly/u);
  } finally { await disposeRpc(); await controller.dispose(); }
});

test("one paired route reconciles every active accessible project and isolates project failure", async () => {
  const credentials = credentialsFixture(unboundGrant);
  let projects: Array<{
    id: string;
    name: string;
    role: "owner" | "participant" | "viewer";
    state: "active";
    sessionCount: number;
  }> = [
    { id: "project-a", name: "Project A", role: "owner", state: "active", sessionCount: 2 },
    { id: "project-b", name: "Project B", role: "viewer", state: "active", sessionCount: 3 },
  ];
  const starts: string[] = [];
  const stops: string[] = [];
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service },
    status: status(),
    workspacePath: "/readonly/workspace",
    listExecutionProfiles: deepseekChatExecutionProfiles,
    listProjects: async () => projects.map((project) => ({ ...project })),
    validateModel: async () => undefined,
    resolveWorkspace: async () => "/readonly/workspace",
    createOwner: async (_grant, binding) => {
      starts.push(binding.projectId);
      if (binding.projectId === "project-b") throw new Error("isolated viewer workspace failure");
      return { async stop() { stops.push(binding.projectId); } };
    },
  });
  await controller.start();
  const connected = await controller.configure({
    provider: "deepseek-official",
    model: "deepseek-chat",
  });
  assert.deepEqual(connected.bindings?.map((binding) => binding.projectId), ["project-a", "project-b"]);
  assert.deepEqual(starts, ["project-a", "project-b"]);
  assert.equal(connected.runtime.connection, "connected", "one Project failure does not stop a healthy peer");

  projects = [
    { id: "project-b", name: "Project B", role: "viewer", state: "active", sessionCount: 3 },
    { id: "project-c", name: "Project C", role: "participant", state: "active", sessionCount: 1 },
  ];
  await controller.refreshProjects();
  assert.deepEqual(stops, ["project-a"], "inaccessible Project owner stops without deleting its workspace");
  assert.deepEqual(starts, ["project-a", "project-b", "project-b", "project-c"]);
  assert.deepEqual(controller.publicState().bindings?.map((binding) => binding.projectId), ["project-b", "project-c"]);
  await controller.dispose();
});

test("paired account periodically discovers newly accessible Projects", async () => {
  const routedGrant: DshNativeGrant = {
    ...unboundGrant,
    route: { provider: "deepseek-official", model: "deepseek-chat" },
  };
  const credentials = credentialsFixture(routedGrant);
  let projects = [{
    id: "project-a",
    name: "Project A",
    role: "owner" as const,
    state: "active" as const,
    sessionCount: 1,
  }];
  const starts: string[] = [];
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service },
    status: status(),
    workspacePath: "/readonly/workspace",
    listExecutionProfiles: deepseekChatExecutionProfiles,
    projectRefreshIntervalMs: 5,
    listProjects: async () => projects.map((project) => ({ ...project })),
    resolveWorkspace: async (_grant, binding) => `/managed/${binding.projectId}`,
    createOwner: async (_grant, binding, _signal, _status, workspacePath) => {
      assert.equal(workspacePath, `/managed/${binding.projectId}`);
      starts.push(binding.projectId);
      return { async stop() {} };
    },
  });
  await controller.start();
  assert.deepEqual(starts, ["project-a"]);
  projects = [...projects, {
    id: "project-b",
    name: "Project B",
    role: "owner",
    state: "active",
    sessionCount: 1,
  }];
  await eventually(() => starts.includes("project-b"));
  await controller.dispose();
});

test("paired account retries Project discovery after an initial startup failure", async () => {
  const routedGrant: DshNativeGrant = {
    ...unboundGrant,
    route: { provider: "deepseek-official", model: "deepseek-chat" },
  };
  const credentials = credentialsFixture(routedGrant);
  let attempts = 0;
  const starts: string[] = [];
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service },
    status: status(),
    workspacePath: "/readonly/workspace",
    listExecutionProfiles: deepseekChatExecutionProfiles,
    projectRefreshIntervalMs: 5,
    listProjects: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary Project catalog failure");
      return [{
        id: "project-recovered",
        name: "Recovered Project",
        role: "owner",
        state: "active",
        sessionCount: 1,
      }];
    },
    resolveWorkspace: async () => "/managed/project-recovered",
    createOwner: async (_grant, binding) => {
      starts.push(binding.projectId);
      return { async stop() {} };
    },
  });

  await controller.start();
  assert.equal(controller.publicState().runtime.connection, "error");
  await eventually(() => starts.includes("project-recovered"));
  assert.equal(controller.publicState().runtime.connection, "connected");
  await controller.dispose();
});

test("configuration cancellation reaches an in-flight Project activation", async () => {
  const credentials = credentialsFixture(unboundGrant);
  const activationStarted = deferred<AbortSignal>();
  const controller = new DshNativeHostController({
    context: { credentials: credentials.service },
    status: status(),
    workspacePath: "/readonly/workspace",
    listExecutionProfiles: deepseekChatExecutionProfiles,
    listProjects: async () => [{
      id: "project-cancelled",
      name: "Cancelled Project",
      role: "owner",
      state: "active",
      sessionCount: 1,
    }],
    validateModel: async () => undefined,
    resolveWorkspace: async (_grant, _binding, signal) => {
      activationStarted.resolve(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    createOwner: async () => {
      throw new Error("cancelled activation must not create an owner");
    },
  });
  await controller.start();
  const abort = new AbortController();
  const configuring = controller.configure({
    provider: "deepseek-official",
    model: "deepseek-chat",
  }, abort.signal);
  const activationSignal = await activationStarted.promise;
  abort.abort(new Error("cancel test"));
  await assert.rejects(bounded(configuring, 500), /cancel test/);
  assert.equal(activationSignal.aborted, true);
  await controller.dispose();
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

async function eventually(predicate: () => boolean, milliseconds = 500): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
