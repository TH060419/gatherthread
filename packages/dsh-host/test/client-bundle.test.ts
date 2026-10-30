import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  locale?: string;
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
      // Message rendering has its own hook-state tests; this harness exercises workspace navigation.
      if (typeof type === 'function' && type.name === 'WorkspaceMessageBody') return { type: 'message-body', props, children: [(props as any).item.content] };
      if (typeof type === 'function' && type.name === 'WorkspaceDialog') return type({ ...props as object, children });
      return { type, props, children };
    },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value: Handoff) { handoff = value; } } },
    navigator: options.locale ? { language: options.locale } : undefined,
    fetch: options.fetch ?? globalThis.fetch,
    setTimeout: options.setTimeout ?? globalThis.setTimeout,
    clearTimeout: options.clearTimeout ?? globalThis.clearTimeout,
    AbortController,
    crypto: globalThis.crypto,
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
  vm.runInContext(source, context, { filename: pathToFileURL(path.join(packageRoot, "client", "client.js")).href });
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

/** Find the first rendered element whose props satisfy a predicate, depth-first. */
function findElement(
  node: unknown,
  predicate: (element: { readonly type: unknown; readonly props: Record<string, any>; readonly children?: unknown }) => boolean,
): { readonly type: unknown; readonly props: Record<string, any>; readonly children?: unknown } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const match = findElement(child, predicate); if (match) return match; }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const element = node as { type?: unknown; props?: Record<string, any>; children?: unknown };
  if (element.type !== undefined && element.props !== null && typeof element.props === "object"
    && predicate({ type: element.type, props: element.props, children: element.children })) {
    return { type: element.type, props: element.props, children: element.children };
  }
  for (const child of Array.isArray(element.children) ? element.children : []) {
    const found = findElement(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

test("dsh.client bundle registers the official settings Slot without credential material", async () => {
  const loaded = await loadClient();
  assert.equal(loaded.handoff.id, "@gatherthread/dsh-host");
  assert.deepEqual(Array.from(loaded.plugin.inject), ["slots", "connection", "sessions"]);
  const registeredSlots: string[] = [];
  let registration: { options: Record<string, unknown>; component: () => unknown } | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    slots: {
      inject(name: string, create: () => unknown) {
        registeredSlots.push(name);
        assert.ok(["main", "sidebar.panellist", "settings.section"].includes(name));
        create();
      },
      register(options: Record<string, unknown>, component: () => unknown) {
        registration = { options, component };
        return () => undefined;
      },
    },
  });
  assert.deepEqual(registeredSlots, ["main", "sidebar.panellist", "settings.section"]);
  const markLiteral = loaded.source.match(/^const WORKSPACE_MARK = (".*");$/m)?.[1];
  assert.ok(markLiteral);
  const mark = JSON.parse(markLiteral) as string;
  const approved = await readFile(path.join(packageRoot, "../../logo/svg/mark-color-transparent-light.svg"));
  assert.deepEqual(Buffer.from(mark.split(",")[1]!, "base64"), approved);
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
            compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
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

test("Client asks for a new selection after DSH drops the model the connection ran", async () => {
  // A dropped route lands in the same route-less branch as a fresh pairing, so the
  // copy has to tell them apart: an operator whose model was retired must not be
  // told they never chose one, and must be able to pick a replacement.
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
            compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
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
            // No `route`: DSH stopped offering the model this connection ran.
            recoverableError: "route_unavailable",
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
    /DSH 当前已不再提供此前为该连接选择的模型/u,
    `a dropped route must say the previous model is gone; rendered: ${rendered}`,
  );
  assert.doesNotMatch(
    rendered,
    /尚未选择 DSH Provider 与 Model/u,
    "a dropped route must not be reported as a connection that never chose a model",
  );
  assert.match(rendered, /选择 DSH 模型/u, "the replacement selection must stay reachable");
});

test("Client clears revoked selections again when a replacement route also disappears", async () => {
  // The transition, not the fresh panel: a connection that already configured a
  // model must not keep offering it, or keep it selected, after the harness drops
  // it. Both halves matter — a cleared catalog alone leaves the previous
  // provider/model in state, and the next submission would re-send the retired
  // model, which DSH accepts because it resolves any identifier.
  const RETIRED_MODEL = "deepseek-v4-flash-vision-exp";
  const currentCatalog = {
    schemaVersion: 1,
    projects: [{ id: "project-a", name: "Project A", role: "owner", state: "active", sessionCount: 1 }],
    providers: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "Flash" }] }],
  };
  const staleCatalog = {
    ...currentCatalog,
    providers: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: RETIRED_MODEL, name: "Retired" }] }],
  };
  const newestCatalog = {
    ...currentCatalog,
    providers: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-v4-pro", name: "Pro" }] }],
  };
  const configuredPayloads: Array<{ provider: string; model: string }> = [];
  let configured = false;
  let catalogReads = 0;
  const nativeState = () => ({
    schemaVersion: 2,
    integration: "gatherthread",
    authorization: "paired",
    serverUrl: "http://127.0.0.1:8787",
    deviceName: "DeepSeek Harness",
    compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
    runtime: {
      schemaVersion: 1, integration: "gatherthread", connection: "stopped", bindingMode: "project",
      projectName: "GatherThread / 共序", activeSessionCount: 0, sessions: [],
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
    ...(configured ? { recoverableError: "route_unavailable" } : {}),
  });
  const timers: Array<() => void> = [];
  const loaded = await loadClient({
    setTimeout: ((callback: () => void) => { timers.push(callback); return timers.length; }) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    connection: {
      rpc: {
        async call(_channel: string, endpoint: string, payload: { provider: string; model: string }) {
          if (endpoint === "catalog/get") {
            catalogReads += 1;
            return { ok: true, value: catalogReads === 1 ? staleCatalog : catalogReads === 2 ? currentCatalog : newestCatalog };
          }
          if (endpoint === "connection/configure") {
            configuredPayloads.push({ provider: payload.provider, model: payload.model });
            configured = true;
            return { ok: true, value: nativeState() };
          }
          return { ok: true, value: nativeState() };
        },
      },
    },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  assert.equal(typeof component, "function");
  const settle = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const render = () => loaded.render(component as () => unknown);
  const clickLoadCatalog = async () => {
    findElement(render(), (element) => element.props.key === "load-catalog")?.props.onClick();
    await settle();
  };
  const submitBinding = async () => {
    findElement(render(), (element) => element.props.key === "binding-form")
      ?.props.onSubmit({ preventDefault() {} });
    await settle();
  };
  render();
  const cleanup = loaded.getEffect()?.();
  await settle();

  // Paired with no route, then configured against the catalog that names the
  // model the harness is about to drop.
  assert.match(collectedText(render()), /选择 DSH 模型/u);
  await clickLoadCatalog();
  await submitBinding();
  assert.deepEqual(configuredPayloads, [{ provider: "deepseek-official", model: RETIRED_MODEL }]);

  // The harness revokes the route. The next poll must discard both the catalog
  // and the selection made from it, not merely re-render the notice.
  const poll = timers.pop();
  assert.equal(typeof poll, "function", "the panel must have scheduled its status poll");
  poll?.();
  await settle();
  const revoked = collectedText(render());
  assert.doesNotMatch(revoked, new RegExp(RETIRED_MODEL, "u"),
    `a revoked route must stop offering the model it named; rendered: ${revoked}`);
  assert.doesNotMatch(revoked, /连接全部可访问项目/u,
    "the stale catalog's form must not stay submittable");
  assert.match(revoked, /DSH 当前已不再提供/u, "the panel must explain why the selection was dropped");

  // Re-selecting reads the harness's current catalog, and the submission must
  // name a model from it rather than the retired one still held in state.
  await clickLoadCatalog();
  const steadyPoll = timers.pop();
  steadyPoll?.();
  await settle();
  assert.match(collectedText(render()), /连接全部可访问项目/u,
    "steady revoked-status polls must not erase the operator's replacement choice");
  await submitBinding();
  assert.equal(configuredPayloads.length, 2);
  assert.deepEqual(configuredPayloads[1], { provider: "deepseek-official", model: "deepseek-flash" },
    "the replacement selection must come from the current catalog, never the revoked one");

  // The replacement was withdrawn before configure could register it. This
  // response repeats the same recovery code; it must invalidate that choice
  // even though the poll already observed route_unavailable before this attempt.
  await clickLoadCatalog();
  await submitBinding();
  assert.equal(configuredPayloads.length, 3);
  assert.deepEqual(configuredPayloads[2], { provider: "deepseek-official", model: "deepseek-v4-pro" },
    "a second failed selection must not leave the previous replacement in the next submission");
  cleanup?.();
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

test("Client renders separate project code consent, manual actions and disabled-by-default automatic upload", async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = [];
  const loaded = await loadClient({
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    connection: { rpc: { async call(_channel: string, endpoint: string, payload: unknown) { calls.push({ endpoint, payload }); return { ok: true, value: {
      schemaVersion: 2, integration: "gatherthread", authorization: "paired",
      serverUrl: "http://127.0.0.1:18787", deviceName: "DSH",
      compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
      runtime: { schemaVersion: 1, integration: "gatherthread", connection: "connected", bindingMode: "project",
        projectName: "Test", activeSessionCount: 0, sessions: [], updatedAt: "2026-09-22T00:00:00.000Z" },
      route: { provider: "deepseek", model: "deepseek-chat" }, projectCount: 1,
      bindings: [{ projectId: "project-code", projectName: "Code project", provider: "deepseek", model: "deepseek-chat" }],
      localSync: [], codeSync: [{ projectId: "project-code", projectName: "Code project", authorized: true,
        status: { enabled: true, automatic_upload: false, local_changes: 1, file_count: 2, excluded_count: 3,
          base_commit: null, cloud_commit: null, branch_id: null, needs_download: false,
          recovery_directory: "project-recovered-20260922", local_status_unknown: true } }],
      githubSync: [{ projectId: "project-code", projectName: "Code project", authorized: false,
        connection: { repository: "example/source", base_branch: "development", enabled: true, revision: "revision-1" },
        branch: "gatherthread/project/user" }],
    } }; } } },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  loaded.render(component as () => unknown);
  const cleanup = loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const tree = loaded.render(component as () => unknown);
  const text = collectedText(tree);
  for (const label of ["项目代码 · GatherThread 云端", "项目代码 · GitHub（推荐）", "example/source", "development",
    "连接 GitHub · 打开浏览器", "允许此 DSH 同步该项目代码", "上传代码", "下载更新", "恢复到新目录", "项目成员均可读取代码"]) {
    assert.ok(text.includes(label), `${label}: ${text}`);
  }
  assert.match(text, /project-recovered-20260922/u);
  assert.match(text, /原工作区状态未知/u);
  assert.doesNotMatch(text, /2 个源文件/u);
  const checkedValues: boolean[] = [];
  const toggles: Array<(event: { target: { checked: boolean } }) => void> = [];
  function collect(node: unknown): void {
    if (Array.isArray(node)) { for (const child of node) collect(child); return; }
    if (!node || typeof node !== "object") return;
    const item = node as { props?: { type?: string; checked?: boolean; onChange?: (event: { target: { checked: boolean } }) => void }; children?: unknown };
    if (item.props?.type === "checkbox") {
      checkedValues.push(item.props.checked === true);
      if (item.props.onChange) toggles.push(item.props.onChange);
    }
    collect(item.children);
  }
  collect(tree);
  assert.deepEqual(checkedValues, [false, true, false], "GitHub consent does not inherit cloud permission");
  toggles[0]!({ target: { checked: true } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find((call) => call.endpoint === "github/authorize"))), {
    endpoint: "github/authorize", payload: {
      projectId: "project-code", enabled: true, repository: "example/source", base_branch: "development", revision: "revision-1",
    },
  });
  cleanup?.();
});

test("Client renders GitHub sync actions in English when DSH uses an English locale", async () => {
  const loaded = await loadClient({
    locale: "en-US",
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    connection: { rpc: { async call() { return { ok: true, value: {
      schemaVersion: 2, integration: "gatherthread", authorization: "paired",
      serverUrl: "http://127.0.0.1:18787", deviceName: "DSH",
      compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
      runtime: { schemaVersion: 1, integration: "gatherthread", connection: "connected", bindingMode: "project",
        projectName: "Test", activeSessionCount: 0, sessions: [], updatedAt: "2026-09-22T00:00:00.000Z" },
      route: { provider: "deepseek", model: "deepseek-chat" }, projectCount: 1,
      bindings: [{ projectId: "project-code", projectName: "Code project", provider: "deepseek", model: "deepseek-chat" }],
      localSync: [], codeSync: [],
      githubSync: [{ projectId: "project-code", projectName: "Code project", authorized: true,
        connection: { repository: "example/source", base_branch: "main", enabled: true, revision: "revision-1" },
        branch: "gatherthread/project/user", error: "code_sync_dirty",
        status: { enabled: true, automatic_upload: false, local_changes: 1, file_count: 2, excluded_count: 0,
          base_commit: null, cloud_commit: null, branch_id: null, needs_download: false,
          local_status_unknown: false } }],
    } }; } } },
    slots: {
      inject(_name: string, create: () => unknown) { create(); },
      register(_options: unknown, value: () => unknown) { component = value; return () => undefined; },
    },
  });
  loaded.render(component as () => unknown);
  const cleanup = loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const text = collectedText(loaded.render(component as () => unknown));
  for (const label of ["Project code · GitHub (recommended)", "Connect GitHub · Open browser",
    "Upload code", "Download updates", "Recover to a new folder", "Local changes are not uploaded."]) {
    assert.ok(text.includes(label), `${label}: ${text}`);
  }
  assert.doesNotMatch(text, /上传代码|本地有未上传修改/u);
  cleanup?.();
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
            compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
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

test("Client paints the model dropdown and its option rows with an opaque themed pair", async () => {
  // A native <select> owns a popup it does not inherit: the list surface is painted
  // from the control's own background and each row from its option, while the option
  // text still follows the panel foreground. `background: transparent` with
  // `color: inherit` therefore rendered the DSH model names white on the popup's
  // white surface as soon as the harness theme was dark. Covering the control alone
  // is not enough either — which of the two paints the row differs per engine — so
  // both must name an opaque pair that the UA resolves against the used color scheme.
  const catalog = {
    schemaVersion: 1,
    projects: [{ id: "project-a", name: "Project A", role: "owner", state: "active", sessionCount: 1 }],
    providers: [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [{ id: "deepseek-flash", name: "Flash" }, { id: "deepseek-pro", name: "Pro" }],
    }],
  };
  const loaded = await loadClient({
    fetch: (async () => { throw new Error("native Client must not use the legacy Fetch route"); }) as typeof fetch,
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  });
  let component: (() => unknown) | undefined;
  loaded.plugin.apply({
    sessions: { async refresh() {} },
    connection: {
      rpc: {
        async call(_channel: string, endpoint: string) {
          return { ok: true, value: endpoint === "catalog/get" ? catalog : {
            schemaVersion: 2,
            integration: "gatherthread",
            authorization: "paired",
            serverUrl: "http://127.0.0.1:8787",
            deviceName: "DeepSeek Harness",
            compatibility: { package: "@deepseek-ai/dsh", version: "0.1.7-rc.2", profile: "web" },
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

  interface RenderedElement { readonly type: unknown; readonly props: Record<string, any>; readonly children?: unknown }
  const flatten = (node: unknown, collected: RenderedElement[] = []): RenderedElement[] => {
    if (Array.isArray(node)) {
      for (const child of node) flatten(child, collected);
      return collected;
    }
    if (node === null || typeof node !== "object") return collected;
    const element = node as RenderedElement;
    if (element.props !== undefined && element.props !== null) collected.push(element);
    flatten(element.children, collected);
    return collected;
  };
  const elementsOf = (node: unknown, type: string) =>
    flatten(node).filter((element) => element.type === type);
  const assertOpaquePair = (element: RenderedElement, what: string) => {
    const style = element.props.style as Record<string, unknown> | undefined;
    const background = style?.background ?? style?.backgroundColor;
    const foreground = style?.color;
    assert.equal(typeof background, "string", `${what} must paint its own surface; a popup surface is not inherited`);
    assert.doesNotMatch(String(background), /^(?:transparent|inherit|currentColor)$/iu,
      `${what} must not leave its surface to the UA default while its text keeps the panel color`);
    assert.doesNotMatch(String(background), /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/iu, `${what} must be opaque`);
    assert.equal(typeof foreground, "string", `${what} must name its own text color`);
    assert.doesNotMatch(String(foreground), /^(?:inherit|currentColor)$/iu,
      `${what} must not inherit a foreground that may match its surface`);
    assert.notEqual(foreground, background, `${what} must not paint its text in its own surface color`);
  };

  const settle = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const render = () => loaded.render(component as () => unknown);
  render();
  const cleanup = loaded.getEffect()?.();
  await settle();
  // The route-less panel only offers the dropdowns once the catalog is read.
  flatten(render()).find((element) => element.props.key === "load-catalog")?.props.onClick();
  await settle();

  const tree = render();
  const dropdowns = elementsOf(tree, "select");
  const modelDropdown = dropdowns.find((dropdown) => elementsOf(dropdown, "option")
    .some((option) => option.props.value === "deepseek-flash"));
  assert.notEqual(modelDropdown, undefined,
    "the model dropdown must be the one listing the catalog's models; the harness state was not reached");
  assert.equal(dropdowns.length, 2, "the catalog must offer one provider and one model dropdown");

  for (const dropdown of dropdowns) {
    assertOpaquePair(dropdown, "each dropdown control");
    const options = elementsOf(dropdown, "option");
    assert.ok(options.length > 0, "each dropdown must offer at least one entry");
    for (const option of options) assertOpaquePair(option, "each option row");
  }
  cleanup?.();
});

/** Render the settings Slot against one native `status/get` value. */
async function renderNativeState(compatibility: Record<string, unknown>): Promise<string> {
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
            compatibility,
            runtime: {
              schemaVersion: 1,
              integration: "gatherthread",
              connection: "stopped",
              bindingMode: "project",
              projectName: "GatherThread / 共序",
              activeSessionCount: 0,
              sessions: [],
              updatedAt: "2026-10-18T00:00:00.000Z",
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
  assert.equal(typeof component, "function");
  loaded.render(component as () => unknown);
  const cleanup = loaded.getEffect()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rendered = collectedText(loaded.render(component as () => unknown));
  cleanup?.();
  return rendered;
}

test("Client renders a desktop 0.2.x Host and names the target it runs", async () => {
  // DSH 0.2.1-rc.2 renamed Connection's trust service, so this build ships a
  // different profile layer than the 0.1.x artifact. Reporting one release while
  // running another is what the compatibility block must stop doing, and a
  // desktop pair must not be rejected for not being the pinned npm Web pair.
  const rendered = await renderNativeState({
    package: "@deepseek-ai/dsh",
    version: "0.2.1-rc.2",
    profile: "desktop",
    targets: [
      { version: "0.2.1-rc.2", profile: "desktop" },
      { version: "0.2.1-rc.2", profile: "web" },
    ],
  });
  assert.match(rendered, /@deepseek-ai\/dsh@0\.2\.1-rc\.2 · desktop/u, `desktop panel rendered: ${rendered}`);
});

test("Client still renders a Host that predates the verified-target list", async () => {
  // The frozen `0.1.0-beta.2` artifact sends only the scalar pair. Rejecting it
  // would break an installed Host that is correct for its own release.
  const rendered = await renderNativeState({
    package: "@deepseek-ai/dsh",
    version: "0.1.7-rc.2",
    profile: "web",
  });
  assert.match(rendered, /@deepseek-ai\/dsh@0\.1\.7-rc\.2 · web/u, `legacy panel rendered: ${rendered}`);
});

test("Client refuses a Host whose running pair is absent from its own target list", async () => {
  const rendered = await renderNativeState({
    package: "@deepseek-ai/dsh",
    version: "0.2.1-rc.2",
    profile: "desktop",
    targets: [{ version: "0.2.1-rc.2", profile: "web" }],
  });
  assert.match(rendered, /状态暂不可用/u, `inconsistent claim must fail closed; rendered: ${rendered}`);
  assert.doesNotMatch(rendered, /已验证兼容/u);
});

async function workspaceClient(options: { failFirstSend?: boolean; lateRead?: Promise<unknown>; requestState?: 'paused' | 'running' | 'completed'; failFirstCreate?: boolean; limitFirstRead?: boolean } = {}) {
  const timers: Array<() => void> = [], delays: number[] = [], sent: any[] = []; let reads = 0;
  const loaded = await loadClient({ setTimeout: ((callback: () => void, delay: number) => { timers.push(callback); delays.push(delay); return timers.length; }) as unknown as typeof setTimeout, clearTimeout: (() => {}) as typeof clearTimeout });
  let component!: () => unknown;
  const page = (input: any) => ({ connectionId: 'connection-a', projectId: 'project-a', sessionId: input.sessionId,
    cursor: 3, contentRevision: 0, reset: false, hasMore: false, canWrite: true, canManage: true,
    members: [{ name: '参与者 B', role: 'participant', online: true }], target: { runtimeId: 'runtime-a', provider: 'deepseek', model: 'fixture' },
    messages: [{ id: 'event-1', sequence: 1, type: 'human_chat', actorId: 'user-b', author: '参与者 B', timestamp: '2026-10-29T12:00:00Z', content: input.sessionId === 'session-a' ? '蓝色按钮' : '独立会话信息', status: null, deleted: false, truncated: false },
      ...(options.requestState ? [{ id: 'request-2', sequence: 2, type: 'agent_request', controllable: true, actorId: 'user-a', author: 'A', timestamp: '2026-10-29T12:00:00Z', content: '原任务', status: null },
        { id: 'progress-3', sequence: 3, type: options.requestState === 'completed' ? 'agent_response' : 'agent_progress', replyTo: 'request-2', actorId: 'user-a', author: 'A', timestamp: '2026-10-29T12:00:00Z', content: '进度', status: options.requestState === 'paused' ? 'paused' : null }] : [])] });
  loaded.plugin.apply({ sessions: {}, slots: { inject(_name: string, create: () => void) { create(); },
    register(input: any, render: () => unknown) { if (input.name === 'main') component = render; } },
    connection: { rpc: { async call(_channel: string, endpoint: string, input: any) {
      assert.equal(endpoint, 'workspace/action');
      if (input.action === 'list') return { ok: true, value: { connectionId: 'connection-a', webUrl: 'https://workspace.example/app/', actor: { id: 'user-a', name: '参与者 A' }, projects: [{ id: 'project-a', name: '项目', role: 'owner' }] } };
      if (input.action === 'sessions') return { ok: true, value: { connectionId: 'connection-a', projectId: 'project-a', sessions: [{ id: 'session-a', name: '多人', mode: 'multi' }, { id: 'session-b', name: '独立', mode: 'solo' }] } };
      if (input.action === 'read') {
        if (options.limitFirstRead && reads++ === 0) return { ok: false, error: { code: 'workspace_rate_limited' } };
        return options.lateRead && input.sessionId === 'session-a' ? options.lateRead : { ok: true, value: page(input) };
      }
      if (input.action === 'send') { sent.push(structuredClone(input)); return options.failFirstSend && sent.length === 1 ? { ok: false, error: { code: 'workspace_unavailable' } } : { ok: true, value: { connectionId: input.connectionId, projectId: input.projectId, sessionId: input.sessionId } }; }
      if (['pause', 'resume', 'createSession', 'renameSession'].includes(input.action)) {
        sent.push(structuredClone(input));
        return options.failFirstCreate && sent.length === 1 ? { ok: false, error: { code: 'workspace_unavailable' } }
          : { ok: true, value: { connectionId: input.connectionId, projectId: input.projectId, sessionId: input.sessionId || 'session-new',
            ...(['createSession', 'renameSession'].includes(input.action) ? { session: { id: input.sessionId || 'session-new', name: input.title, mode: input.mode || 'multi' } } : {}) } };
      }
      throw new Error('Unexpected action');
    } } } });
  let cleanup: (() => void) | undefined;
  const render = () => loaded.render(component);
  const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); return render(); };
  const restart = async () => { cleanup?.(); render(); cleanup = loaded.getEffect()?.(); return settle(); };
  await restart();
  let tree = render();
  findElement(tree, e => e.type === 'select')!.props.onChange({ target: { value: 'project-a' } });
  await settle();
  await restart(); tree = render();
  const selectSession = async (id: string) => {
    findElement(render(), e => e.type === 'button' && e.props['data-session-id'] === id)!.props.onClick();
    await settle();
    return restart();
  };
  await selectSession('session-a');
  return { render, settle, selectSession, sent, delays, retry: () => { timers.at(-1)?.(); return settle(); }, cleanup: () => cleanup?.() };
}

test('workspace renders participant attribution and keeps chat/Agent actions separate', async () => {
  const fixture = await workspaceClient();
  try {
    const tree = fixture.render();
    assert.match(collectedText(tree), /参与者 B/);
    assert.match(collectedText(tree), /蓝色按钮/);
    assert.match(collectedText(tree), /发送聊天/);
    assert.match(collectedText(tree), /请求本机 DSH/);
    assert.equal(findElement(tree, e => e.type === 'textarea')!.props.maxLength, 8000);
  } finally { fixture.cleanup(); }
});

test('workspace retry reuses the immutable send identity and disables concurrent sends', async () => {
  const fixture = await workspaceClient({ failFirstSend: true });
  try {
    findElement(fixture.render(), e => e.type === 'textarea')!.props.onChange({ target: { value: '根据共享信息总结' } });
    const tree = fixture.render();
    const button = findElement(tree, e => e.type === 'button' && e.props.className === 'gtw-primary')!;
    button.props.onClick(); button.props.onClick();
    await fixture.settle();
    assert.equal(fixture.sent.length, 1);
    const retryTree = fixture.render();
    const retry = findElement(retryTree, e => e.type === 'button' && String(e.props.onClick).includes('attempt.kind'))!;
    assert.ok(retry); retry.props.onClick();
    await fixture.settle();
    assert.equal(fixture.sent.length, 2);
    assert.deepEqual(fixture.sent[0], fixture.sent[1]);
    assert.equal(findElement(fixture.render(), e => e.type === 'textarea')!.props.value, '');
  } finally { fixture.cleanup(); }
});

test('workspace ignores a late response from a conversation that was left', async () => {
  let resolve!: (value: unknown) => void;
  const lateRead = new Promise<unknown>(done => { resolve = done; });
  const fixture = await workspaceClient({ lateRead });
  try {
    await fixture.selectSession('session-b');
    resolve({ ok: true, value: { connectionId: 'connection-a', projectId: 'project-a', sessionId: 'session-a', messages: [{ id: 'stale', content: 'DO_NOT_SHOW_OLD_SESSION' }] } });
    const tree = await fixture.settle();
    assert.match(collectedText(tree), /独立会话信息/);
    assert.doesNotMatch(collectedText(tree), /DO_NOT_SHOW_OLD_SESSION/);
  } finally { fixture.cleanup(); }
});

test('workspace replies use a canonical reference and selected model, without copying quote text into the prompt', async () => {
  const f = await workspaceClient();
  try {
    findElement(f.render(), e => e.type === 'button' && collectedText(e) === '引用')!.props.onClick();
    findElement(f.render(), e => e.type === 'textarea')!.props.onChange({ target: { value: '请总结' } });
    findElement(f.render(), e => e.type === 'button' && e.props.className === 'gtw-primary')!.props.onClick();
    await f.settle();
    assert.equal(f.sent[0].replyTo, 'event-1'); assert.equal(f.sent[0].content, '请总结');
    assert.deepEqual(f.sent[0].selection, { provider: 'deepseek', model: 'fixture' });
  } finally { f.cleanup(); }
});
for (const state of ['paused', 'running', 'completed'] as const) {
  test(`workspace controls reflect canonical ${state} state and preserve the draft`, async () => {
    const f = await workspaceClient({ requestState: state });
    try {
      findElement(f.render(), e => e.type === 'textarea')!.props.onChange({ target: { value: '尚未发送的聊天草稿' } });
      const button = findElement(f.render(), e => e.type === 'button' && e.props.className === 'gtw-primary')!;
      assert.equal(collectedText(button), state === 'paused' ? '继续 Agent' : state === 'running' ? '暂停 Agent' : '请求本机 DSH');
      if (state !== 'completed') {
        button.props.onClick(); button.props.onClick(); await f.settle();
        assert.equal(f.sent.length, 1); assert.equal(f.sent[0].action, state === 'paused' ? 'resume' : 'pause');
        assert.equal(f.sent[0].requestId, 'request-2');
        assert.equal(findElement(f.render(), e => e.type === 'textarea')!.props.value, '尚未发送的聊天草稿');
      }
    } finally { f.cleanup(); }
  });
}
test('workspace session save retry keeps an immutable operation identity', async () => {
  const f = await workspaceClient({ failFirstCreate: true });
  try {
    findElement(f.render(), e => e.type === 'button' && e.props['aria-label'] === '＋ 新建会话')!.props.onClick();
    findElement(f.render(), e => e.type === 'input' && e.props.type !== 'search')!.props.onChange({ target: { value: '新讨论' } });
    const save = findElement(f.render(), e => e.type === 'button' && collectedText(e) === '保存')!;
    save.props.onClick(); save.props.onClick(); await f.settle();
    assert.equal(f.sent.length, 1);
    assert.equal(findElement(f.render(), e => e.type === 'input' && e.props.type !== 'search')!.props.disabled, true);
    findElement(f.render(), e => e.type === 'button' && collectedText(e) === '重试保存')!.props.onClick();
    await f.settle(); assert.deepEqual(f.sent[0], f.sent[1]);
  } finally { f.cleanup(); }
});
test('workspace rate limiting backs off, then recovers without clearing the draft', async () => {
  const f = await workspaceClient({ limitFirstRead: true });
  try {
    assert.match(collectedText(f.render()), /请求过于频繁/);
    assert.equal(f.delays.at(-1), 30000);
    const recovered = await f.retry();
    assert.doesNotMatch(collectedText(recovered), /请求过于频繁/);
    assert.match(collectedText(recovered), /蓝色按钮/);
    assert.equal(f.delays.at(-1), 5000);
  } finally { f.cleanup(); }
});
test('workspace session search does not change the active conversation or its draft', async () => {
  const f = await workspaceClient();
  try {
    findElement(f.render(), e => e.type === 'textarea')!.props.onChange({ target: { value: '保留在多人会话的草稿' } });
    findElement(f.render(), e => e.type === 'input' && e.props.type === 'search')!.props.onChange({ target: { value: '独立' } });
    assert.equal(findElement(f.render(), e => e.props['data-session-id'] === 'session-a'), undefined);
    assert.ok(findElement(f.render(), e => e.props['data-session-id'] === 'session-b'));
    findElement(f.render(), e => e.type === 'button' && collectedText(e) === '发送聊天')!.props.onClick();
    await f.settle();
    assert.equal(f.sent[0].sessionId, 'session-a');
    assert.equal(f.sent[0].content, '保留在多人会话的草稿');
  } finally { f.cleanup(); }
});
test('workspace compact model dialog preserves selection and Web management stays on the paired server', async () => {
  const f = await workspaceClient();
  try {
    findElement(f.render(), e => e.type === 'button' && e.props.className === 'gtw-profile-trigger')!.props.onClick();
    const chooser = findElement(f.render(), e => e.type === 'dialog' && e.props['aria-label'] === 'Agent、模型与推理强度')!;
    assert.ok(findElement(chooser, e => e.type === 'select' && String(e.props.value).includes('fixture')));
    findElement(chooser, e => e.type === 'button' && collectedText(e) === '完成')!.props.onClick();
    assert.equal(findElement(f.render(), e => e.type === 'dialog'), undefined);
    findElement(f.render(), e => e.type === 'button' && e.props.className === 'gtw-manage-trigger')!.props.onClick();
    const menu = findElement(f.render(), e => e.type === 'dialog')!;
    const link = findElement(menu, e => e.type === 'a' && collectedText(e).includes('共享我的 Agent'))!;
    assert.equal(link.props.href, 'https://workspace.example/app/#project=project-a&session=session-a');
    assert.equal(link.props.rel, 'noopener noreferrer');
    assert.match(collectedText(menu), /前往网页版/);
    assert.equal(link.props.target, '_blank');
    link.props.onClick();
    assert.match(collectedText(f.render()), /管理我的 Agent → 共享我的 Agent/);
    const address = findElement(f.render(), e => e.props['aria-label'] === '项目网页地址')!;
    assert.equal(address.props.value, link.props.href);
    assert.equal(address.props.readOnly, true);
    const team = findElement(f.render(), e => e.type === 'a' && collectedText(e).includes('Agent 团队'))!;
    team.props.onClick();
    assert.match(collectedText(f.render()), /管理我的 Agent → Agent 团队/);
    await findElement(f.render(), e => e.type === 'button' && collectedText(e) === '复制地址')!.props.onClick();
    assert.match(collectedText(f.render()), /无法自动复制/);
  } finally { f.cleanup(); }
});
