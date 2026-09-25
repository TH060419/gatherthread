import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createDshHostFacade } from "../src/dsh-compat.js";
import type { DshContextExecutionInput } from "../src/types.js";

// Optional isolated compatibility proof against the pinned public Session API.
// This loads code only; no model, user's DSH home, or running service is used.
const nativeModule = process.env.GATHERTHREAD_TEST_DSH_SESSION_MODULE;
const publicSession = nativeModule ? await import(nativeModule) : undefined;

function fixture(options: { preset?: boolean; workspacePath?: string } = {}) {
  const stored = new Map<string, any>();
  const live = new Map<string, any>();
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const modelInputs: Array<{ sessionId: string; messages: any[] }> = [];
  const routes: Array<{ scope: unknown; selection: unknown }> = [];
  let creates = 0;
  let disposals = 0;
  let routeDisposals = 0;
  let failFlush = false;
  let failPrompt = false;
  const presetByContext = new WeakMap<object, string>();
  const presetCalls: Array<{ kind: string; id: string | undefined }> = [];
  const presets = {
    roots: [{}],
    async mount(ctx: any, id?: string) { presetByContext.set(ctx, id ?? "standard"); presetCalls.push({ kind: "mount", id }); return { id: id ?? "standard" }; },
    composeFrom(child: object, parent: object) { const id = presetByContext.get(parent); if (id) presetByContext.set(child, id); presetCalls.push({ kind: "inherit", id }); return id; },
    composedPreset: (ctx: object) => presetByContext.get(ctx),
  };
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };
  const createSession = (id: string, meta: object) => {
    const header = { version: publicSession?.SESSION_FORMAT_VERSION ?? 2, id, createdAt: 1, isSeeded: false, ...meta };
    // A new public Session has no seed. Passing [] is a replay operation and
    // deliberately appends session/end-seed in the pinned implementation.
    const native = publicSession?.Session.create(id, undefined, header);
    const events: any[] = [];
    let nodes: number[] = [];
    const session = {
      id, header,
      get seq() { return native?.seq ?? events.length; },
      get surface() { return native?.surface ?? { nodes }; },
      snapshotEvents(from = 0): any[] { return native?.snapshotEvents(from) ?? events.slice(from); },
      deriveMessages(): any[] { return native?.deriveMessages() ?? nodes.map((seq) => events[seq].data); },
      append(type: string, data: unknown, options?: any) {
        let event;
        if (native) event = native.append(type, data, options);
        else {
          event = { type, seq: events.length, time: 1, data, ...options };
          if (options?.surfaceOp === "append") nodes.push(event.seq);
          else if (options?.surfaceOp?.op === "replace") {
            const start = nodes.indexOf(options.surfaceOp.start);
            const end = nodes.indexOf(options.surfaceOp.end);
            assert.ok(start >= 0 && end >= start);
            assert.deepEqual(options.sourceEventSeqs, nodes.slice(start, end + 1));
            nodes.splice(start, end - start + 1, event.seq);
          }
          events.push(event);
        }
        emit("session/event", session, event);
        return event;
      },
    };
    stored.set(id, session);
    return session;
  };
  const acquire = (session: any) => {
    const agent = {
      id: session.id, session, ctx: { sessionId: session.id } as any, status: "idle",
      followup(message: unknown) {
        this.status = "running";
        emit("agent/status", { agent, status: "running" });
        session.append("user/message", message, { surfaceOp: "append" });
        modelInputs.push({ sessionId: session.id, messages: structuredClone(session.deriveMessages()) });
      },
      async whenIdle() {
        this.status = "idle";
        emit("agent/status", { agent, status: "idle" });
        if (failPrompt) { failPrompt = false; throw new Error("simulated model failure"); }
      },
    };
    Object.defineProperty(agent.ctx, "agent", { value: agent });
    live.set(session.id, agent);
    return { agent, async dispose() { disposals += 1; live.delete(session.id); } };
  };
  const services = {
    agents: {
      get: (id: string) => live.get(id),
      async create(input: any) { creates += 1; const handle = acquire(createSession(input.sessionId, input.meta)); await input.setup?.(handle.agent.ctx); return handle; },
      async resume(input: any) {
        const session = stored.get(input.resumeSessionId);
        if (!session) throw new Error("missing persisted session");
        const handle = acquire(session); await input.setup?.(handle.agent.ctx); return handle;
      },
    },
    sessionPersistence: { async stat(id: string) { return stored.has(id) ? { header: stored.get(id).header } : undefined; } },
    sessions: {
      get: (id: string) => live.get(id)?.session,
      async flush() { if (failFlush) { failFlush = false; throw new Error("simulated flush failure"); } },
    },
    llm: { async resolveModelInfo(provider: string, model: string) { return { provider, id: model, reasoning: { efforts: [{ id: "high", name: "High" }] } }; } },
    ...(options.preset ? { agentPresets: presets, sessionProjections: { stateOf(session: any) {
      return session.snapshotEvents().filter((event: any) => event.type === "agent-preset/selected").at(-1)?.data.agentPreset ?? session.header.agentPreset;
    } } } : {}),
  };
  const context = {
    get(name: keyof typeof services) { return services[name]; },
    on(name: string, listener: (...args: any[]) => void) {
      const registered = listeners.get(name) ?? new Set();
      registered.add(listener); listeners.set(name, registered);
      return () => registered.delete(listener);
    },
    effect() { return () => undefined; },
  };
  const newFacade = (cloudSessionId = "cloud-session") => createDshHostFacade({
    context, sessionId: "native-session", workspacePath: options.workspacePath ?? "/fixture/workspace", provider: "deepseek-official", model: "deepseek-v4-flash",
    contextBinding: { apiUrl: "https://fixture.invalid/v1", projectId: "fixture-project", sessionId: cloudSessionId },
    ...(options.preset ? { agentPreset: "standard" } : {}),
    moduleImporter: async () => ({ freezeMessage: (message: unknown) => structuredClone(message) }),
    modelSelectionInstaller(scope, selection) {
      routes.push({ scope, selection: structuredClone(selection.current) });
      return () => { routeDisposals += 1; };
    },
  });
  return {
    facade: newFacade(), newFacade, stored, live, modelInputs, routes, presets, presetCalls,
    get creates() { return creates; }, get disposals() { return disposals; }, get routeDisposals() { return routeDisposals; },
    failNextFlush() { failFlush = true; }, failNextPrompt() { failPrompt = true; },
  };
}

function contextInput(requestSequence = 6, view: "summary" | "original" = "summary"): DshContextExecutionInput {
  return {
    requestId: `request-${requestSequence}`, requestSequence, selectedOnly: false,
    historyContext: { view, through_sequence: requestSequence - 1, items: view === "summary" ? [
      { kind: "summary", event_id: "summary-4", sequence: 1, actor_user_id: "user-1", content: "Decision A; next action B.", source_event_ids: ["event-1", "event-3"] },
      { kind: "original", event_id: "event-5", sequence: 5, actor_user_id: "user-2", content: "uncovered recent text" },
    ] : [
      { kind: "original", event_id: "event-1", sequence: 1, actor_user_id: "user-1", content: "OLD_PUBLIC_TEXT ".repeat(1000) },
      { kind: "original", event_id: "event-3", sequence: 3, actor_user_id: "user-1", content: "SECOND_OLD_PUBLIC_TEXT" },
      { kind: "original", event_id: "event-5", sequence: 5, actor_user_id: "user-2", content: "uncovered recent text" },
    ] },
  };
}

test("isolated DSH context replaces noncontiguous old input across modes without changing native history", async () => {
  const f = fixture();
  await f.facade.open();
  const native = f.stored.get("native-session");
  native.append("user/message", { id: "local-human", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "PRIVATE_NATIVE_TURN" }] }, { surfaceOp: "append" });
  const nativeBefore = structuredClone(native.snapshotEvents());
  const original = await f.facade.prepareContextExecution!(contextInput(6, "original"));
  await f.facade.prompt("first GT request", undefined, original.sessionId);
  const originalBytes = JSON.stringify(f.modelInputs.at(-1)).length;
  const execution = f.stored.get(original.sessionId);
  execution.append("session/title", { title: "Fixture gap" });
  const priorSurface = [...execution.surface.nodes];
  const summarized = await f.facade.prepareContextExecution!(contextInput(7));
  assert.equal(summarized.sessionId, original.sessionId);
  assert.deepEqual(execution.snapshotEvents().at(-1).sourceEventSeqs, priorSurface);
  await f.facade.prompt("second GT request", { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" }, summarized.sessionId);
  const visible = JSON.stringify(f.modelInputs.at(-1));
  assert.match(visible, /Decision A; next action B|uncovered recent text/);
  assert.doesNotMatch(visible, /OLD_PUBLIC_TEXT|first GT request|PRIVATE_NATIVE_TURN/);
  assert.ok(visible.length < originalBytes / 4);
  assert.deepEqual(native.snapshotEvents(), nativeBefore);
  assert.equal(f.creates, 2, "one native Session and one reusable isolated Session");
  assert.equal(execution.header.origin, "subagent");
  assert.equal(execution.header.parentSession, "native-session");
  assert.deepEqual(f.routes[0]?.scope, { sessionId: original.sessionId });
  assert.equal(f.routeDisposals, 1);
  await f.facade.prepareContextExecution!(contextInput(8, "original"));
  assert.match(JSON.stringify(execution.deriveMessages()), /OLD_PUBLIC_TEXT/);
  assert.doesNotMatch(JSON.stringify(execution.deriveMessages()), /Decision A/);
  await f.facade.dispose();
  assert.equal(f.live.size, 0);
});

test("selected-only DSH summaries exclude all prior public and native context and restore no old policy", async () => {
  const f = fixture();
  const prepared = await f.facade.prepareContextExecution!(contextInput());
  await f.facade.prompt("unrelated prior GT work", undefined, prepared.sessionId);
  const selected = { ...contextInput(7), selectedOnly: true, historyContext: { view: "original" as const, through_sequence: 6, items: [] } };
  const next = await f.facade.prepareContextExecution!(selected);
  await f.facade.prompt("Summarize ONLY SELECTED_TEXT", undefined, next.sessionId);
  const visible = JSON.stringify(f.modelInputs.at(-1));
  assert.match(visible, /SELECTED_TEXT/);
  assert.doesNotMatch(visible, /Decision A|uncovered recent text|unrelated prior GT work/);
  await assert.rejects(f.facade.prepareContextExecution!({ ...contextInput(8), selectedOnly: true }), /other shared history/);
  await f.facade.dispose();
});

test("DSH isolated context flush retry and restart recovery reuse the marker, but reject stale or missing ownership", async () => {
  const f = fixture();
  f.failNextFlush();
  await assert.rejects(f.facade.prepareContextExecution!(contextInput()), /flush failure/);
  const prepared = await f.facade.prepareContextExecution!(contextInput());
  const execution = f.stored.get(prepared.sessionId);
  const before = execution.seq;
  await f.facade.prepareContextExecution!(contextInput());
  assert.equal(execution.seq, before);
  await f.facade.dispose();
  const resumed = f.newFacade();
  assert.equal((await resumed.prepareContextExecution!({ ...contextInput(), resume: true })).sessionId, prepared.sessionId);
  assert.equal(execution.seq, before);
  await assert.rejects(resumed.prepareContextExecution!({ ...contextInput(7), resume: true }), /latest durable request/);
  await resumed.dispose();
  f.stored.delete(prepared.sessionId);
  const missing = f.newFacade();
  await assert.rejects(missing.prepareContextExecution!({ ...contextInput(), resume: true }), /missing during recovery/);
  await missing.dispose();
});

test("DSH isolated execution refuses another live writer and any manual input without deleting it", async () => {
  const f = fixture();
  const prepared = await f.facade.prepareContextExecution!(contextInput());
  const competitor = f.newFacade();
  await assert.rejects(competitor.prepareContextExecution!(contextInput(7)), /another live owner/);
  await competitor.dispose();
  const execution = f.stored.get(prepared.sessionId);
  execution.append("user/message", { id: "manual", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DO_NOT_DELETE" }] }, { surfaceOp: "append" });
  const before = structuredClone(execution.snapshotEvents());
  await assert.rejects(f.facade.prepareContextExecution!(contextInput(7)), /local manual input/);
  await assert.rejects(f.facade.prompt("not allowed", undefined, prepared.sessionId), /local manual input/);
  assert.deepEqual(execution.snapshotEvents(), before);
  assert.equal(f.modelInputs.length, 0);
  await f.facade.dispose();
});

test("DSH isolated model failure disposes per-request model selection and keeps native contents unchanged", async () => {
  const f = fixture();
  await f.facade.open();
  const nativeBefore = structuredClone(f.stored.get("native-session").snapshotEvents());
  const prepared = await f.facade.prepareContextExecution!(contextInput());
  f.failNextPrompt();
  await assert.rejects(f.facade.prompt("fail this fixture", { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" }, prepared.sessionId), /model failure/);
  assert.equal(f.routeDisposals, 1);
  assert.deepEqual(f.stored.get("native-session").snapshotEvents(), nativeBefore);
  await f.facade.dispose();
});

test("DSH isolated identity binds the cloud server/Project/Session and never reuses another binding's history", async () => {
  const f = fixture();
  const first = await f.facade.prepareContextExecution!(contextInput());
  await f.facade.prompt("OLD_BINDING_ONLY", undefined, first.sessionId);
  await f.facade.dispose();
  const rebound = f.newFacade("another-cloud-session");
  await assert.rejects(rebound.prepareContextExecution!({ ...contextInput(), resume: true }), /missing during recovery/);
  const second = await rebound.prepareContextExecution!(contextInput());
  assert.notEqual(first.sessionId, second.sessionId);
  assert.doesNotMatch(JSON.stringify(f.stored.get(second.sessionId).deriveMessages()), /OLD_BINDING_ONLY/);
  await rebound.dispose();
});

test("DSH owned native preset setup respects persisted selection and isolated Agents inherit it without changing a borrowed Agent", async () => {
  const f = fixture({ preset: true });
  await f.facade.open();
  assert.deepEqual(f.presetCalls, [{ kind: "mount", id: "standard" }]);
  const native = f.stored.get("native-session");
  native.append("agent-preset/selected", { agentPreset: "readonly-custom" });
  await f.facade.dispose();
  const resumed = f.newFacade();
  await resumed.open();
  assert.deepEqual(f.presetCalls.at(-1), { kind: "mount", id: "readonly-custom" });
  const prepared = await resumed.prepareContextExecution!(contextInput());
  assert.equal(f.stored.get(prepared.sessionId).header.agentPreset, "readonly-custom");
  assert.deepEqual(f.presetCalls.at(-1), { kind: "inherit", id: "readonly-custom" });
  const calls = f.presetCalls.length;
  const borrowed = f.newFacade(); await borrowed.open();
  assert.equal(f.presetCalls.length, calls, "borrowing a UI-owned live Agent never mounts or changes its preset");
  await borrowed.dispose();
  assert.ok(f.live.has("native-session"));
  await resumed.dispose();
});

test("DSH missing preset inheritance fails closed before creating or executing an auxiliary Agent", async () => {
  const f = fixture({ preset: true });
  await f.facade.open();
  (f.presets as any).composeFrom = undefined;
  await assert.rejects(f.facade.prepareContextExecution!(contextInput()), /inheritance API is unavailable/);
  assert.equal(f.creates, 1);
  assert.equal(f.modelInputs.length, 0);
  await f.facade.dispose();
});

test("concurrent DSH context preparation cannot replace the teardown barrier", async () => {
  const f = fixture();
  const first = f.facade.prepareContextExecution!(contextInput());
  const canceled = assert.rejects(first, /disposed|active write/);
  await assert.rejects(f.facade.prepareContextExecution!(contextInput(7)), /one active context preparation/);
  await f.facade.dispose(); await canceled;
  assert.equal(f.live.size, 0);
  assert.equal(f.modelInputs.length, 0);
});

test("DSH isolated context refuses a busy original native Agent at preparation and again before prompt", async () => {
  const f = fixture(); await f.facade.open();
  const native = f.live.get("native-session"); native.status = "running";
  await assert.rejects(f.facade.prepareContextExecution!(contextInput()), /Native DSH Agent must be idle/);
  assert.equal(f.creates, 1);
  native.status = "idle";
  const prepared = await f.facade.prepareContextExecution!(contextInput());
  native.status = "running";
  await assert.rejects(f.facade.prompt("not concurrent", undefined, prepared.sessionId), /Native DSH Agent must be idle/);
  assert.equal(f.modelInputs.length, 0);
  native.status = "idle"; await f.facade.dispose();
});

test("pinned public DSH passive assistant projection restores without exposing selected summary controls", { skip: !publicSession }, async () => {
  const f = fixture(); await f.facade.open();
  await f.facade.projectCanonicalEvents([
    { eventId: "cloud-user", canonicalSequence: 1, role: "user", content: "public question", occurredAt: "2026-09-23T00:00:00Z" },
    { eventId: "cloud-answer", canonicalSequence: 2, role: "assistant", content: "public summary answer", occurredAt: "2026-09-23T00:00:00Z" },
  ]);
  const session = f.stored.get("native-session");
  const restored = publicSession.Session.fromRestore(session.id, structuredClone(session.snapshotEvents()), structuredClone(session.header));
  assert.match(JSON.stringify(restored.deriveMessages()), /public question/);
  assert.match(JSON.stringify(restored.deriveMessages()), /public summary answer/);
  assert.equal(f.modelInputs.length, 0);
  await f.facade.dispose();
});

test("pinned DSH Chat classifies the remote reply as visible context, not current-user input or local model output", { skip: !publicSession }, async () => {
  const f = fixture(); await f.facade.open();
  await f.facade.projectCanonicalEvents([{ eventId: "remote", canonicalSequence: 1, role: "assistant", content: "VISIBLE_REMOTE_BODY",
    actorDisplayName: "Alice", provider: "remote", model: "model", occurredAt: "2026-09-23T00:00:00Z" }]);
  const event = f.stored.get("native-session").snapshotEvents()[0];
  const source = await readFile(new URL("../../dsh-client-ui-chat/lib/client.js", pathToFileURL(nativeModule!)), "utf8");
  let registration: any;
  const sandbox = vm.createContext({ window: { __ModuleLoader__: { load(module: any) { registration = module; } } } });
  vm.runInContext(source, sandbox);
  let stub: any; stub = new Proxy(() => stub, { get: () => stub });
  const plugin = registration.factory((specifier: string) => specifier === "react"
    ? { ...stub, memo: (component: unknown) => component, forwardRef: (component: unknown) => component, createContext: () => stub }
    : stub);
  const definitions: any[] = [];
  const context = new Proxy({}, { get(_target, key) {
    if (key === "uiConversation") return new Proxy({}, { get(_value, serviceKey) { return serviceKey === "events" ? new Proxy({}, { get(_value, eventKey) {
      return eventKey === "register" ? (definition: any) => definitions.push(definition) : stub;
    } }) : stub; } });
    return stub;
  } });
  plugin.apply(context);
  const definition = definitions.find((item) => item.kind === "input-message");
  assert.ok(definition.match(event), "native Chat accepts the append-origin relay");
  const row = definition.start({}, { event }, { previous() {} });
  assert.equal(row.kind, "context");
  assert.equal(row.form, "relay");
  assert.equal(row.source.kind, "plugin");
  assert.match(JSON.stringify(row.content), /VISIBLE_REMOTE_BODY/);
  assert.match(JSON.stringify(row.content), /not a new instruction from the current user/);
  assert.match(JSON.stringify(row.content), /Alice.*remote \/ model/);
  const view = definition.buildViewNode({ state: row, key: "fixture", id: "fixture", matches: [] });
  assert.equal(view.visibility, "visible");
  assert.match(JSON.stringify(view), /VISIBLE_REMOTE_BODY/);
  await f.facade.dispose();
});

test("pinned public DSH file tool resolves isolated and native Agents against the same workspace", { skip: !publicSession }, async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const f = fixture({ workspacePath: root, preset: true });
  const prepared = await f.facade.prepareContextExecution!(contextInput());
  const importSibling = (name: string) => import(new URL(`../../${name}/lib/index.js`, pathToFileURL(nativeModule!)).href);
  const [{ Context }, { LocalFileSystem }, fsTools] = await Promise.all([importSibling("cordis"), importSibling("dsh-fs-local"), importSibling("dsh-tool-fs")]);
  const ctx = new Context();
  const filesystem = new LocalFileSystem(ctx, { cwd: "/intentionally-not-the-session-workspace", diffBasisMaxBytes: 1024 * 1024 });
  const registry = new Map<string, any>();
  fsTools.apply({ fs: filesystem, tools: { register(tool: any) { registry.set(tool.name, tool); } },
    systemPrompt: { section() {}, getSectionOrder() { return 1; } }, inject() {}, get() {}, emit() {} },
  { readLimit: 100, readMaxLineLength: 2000, readMaxBytes: 10000, readStreamMinSize: 1000000 });
  for (const sessionId of ["native-session", prepared.sessionId]) {
    const result = await registry.get("read").execute({ file_path: "dsh-host/package.json", limit: 4 },
      { agent: f.live.get(sessionId), signal: new AbortController().signal });
    assert.match(JSON.stringify(result), /@gatherthread\/dsh-host/);
    assert.match(JSON.stringify(result), /gatherthread\/packages\/dsh-host\/package.json/);
  }
  assert.deepEqual(f.presetCalls, [{ kind: "mount", id: "standard" }, { kind: "inherit", id: "standard" }]);
  await f.facade.dispose();
  await ctx.fiber.dispose();
});

test("pinned live DSH Agent continues ordinary local turns after passive remote answers without duplicate turn numbers", { skip: !publicSession }, async () => {
  const importSibling = (name: string) => import(new URL(`../../${name}/lib/index.js`, pathToFileURL(nativeModule!)).href);
  const { Context } = await importSibling("cordis"); const ctx = new Context();
  let facade: ReturnType<typeof createDshHostFacade> | undefined;
  try {
    for (const name of ["dsh-agent", "dsh-session", "dsh-session-projection", "dsh-tools", "dsh-system-prompt", "dsh-llm", "dsh-agent-loop"]) {
      const module = await importSibling(name); await ctx.plugin(module.default, {}).await();
    }
    // No adapter is installed. The native loop runs only far enough to prove
    // numbering/ownership, then settles its local unavailable-provider error.
    facade = createDshHostFacade({
      context: { get(name: string) { return name === "sessionPersistence" ? { async stat() { return undefined; } } : ctx.get(name); },
        on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx) },
      sessionId: "numbering-native", workspacePath: "/private/tmp", provider: "fixture-unregistered", model: "fixture-unregistered",
      moduleImporter: () => importSibling("dsh-llm"),
    });
    await facade.open();
    const agent = ctx.get("agents").get("numbering-native");
    await facade.projectCanonicalEvents([{ eventId: "remote-answer", canonicalSequence: 1, role: "assistant", content: "REMOTE_ANSWER_BODY",
      actorDisplayName: "Alice", provider: "remote-provider", model: "remote-model", occurredAt: "2026-09-23T00:00:00Z" }]);
    assert.equal(agent.session.snapshotEvents().filter((event: any) => event.type === "turn/start").length, 0,
      "passive remote output cannot create a local-model turn behind the live Agent's back");
    assert.match(JSON.stringify(agent.session.deriveMessages()), /REMOTE_ANSWER_BODY/);
    await facade.prompt("ordinary local fixture one");
    await facade.prompt("ordinary local fixture two");
    assert.deepEqual(agent.session.snapshotEvents().filter((event: any) => event.type === "turn/start").map((event: any) => event.data.turn), [1, 2]);
    assert.equal(ctx.get("agents").get("numbering-native"), agent, "no live-Agent replacement is needed");
  } finally { await facade?.dispose(); await ctx.fiber.dispose(); }
});
