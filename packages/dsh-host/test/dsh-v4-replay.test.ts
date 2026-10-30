import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createDshHostFacade } from "../src/dsh-compat.js";

// Opt-in compatibility check against an isolated official DSH installation.
// No model, network, filesystem persistence, or user's DSH profile is used.
const modulePath = process.env.GATHERTHREAD_TEST_DSH_V4_MODULE;
test("V4 public Session restores imported, replaced and deleted shared context across reconnect", { skip: !modulePath }, async () => {
  const native = await import(modulePath!);
  const format = await import(new URL("../../dsh-session-format-v3-to-v4/lib/index.js", pathToFileURL(modulePath!)).href);
  assert.equal(native.SESSION_FORMAT_VERSION, 4);
  const stored = new Map<string, { header: any; events: any[] }>();
  const live = new Map<string, any>();
  const persist = (session: any) => {
    const record = structuredClone({ header: session.header, events: session.snapshotEvents() });
    format.assertReleasedV4Relationships({ ...record, inheritedEventCount: 0 }, new Set(native.KNOWN_SESSION_EVENT_TYPES));
    // Native replay validates protected heads and turn/step relationships.
    native.Session.fromRestore(session.id, record.events, record.header);
    stored.set(session.id, record);
  };
  const acquire = (session: any) => {
    const agent = { id: session.id, session, ctx: {}, status: "idle", followup() { assert.fail("no model calls"); }, async whenIdle() {} };
    live.set(session.id, agent);
    return { agent, async dispose() { persist(session); live.delete(session.id); } };
  };
  const services: Record<string, unknown> = {
    agents: {
      get: (id: string) => live.get(id),
      async create(input: any) {
        const session = native.Session.create(input.sessionId, undefined, { version: 4, id: input.sessionId, createdAt: 1, isSeeded: false, ...input.meta });
        session.append("permission/preset", { preset: "workspace-write" });
        session.append("sandbox/mode", { mode: "workspace-write" });
        session.append("approval/policy", { policy: "on-request" });
        session.append("agent-preset/selected", { agentPreset: "standard" });
        session.append("model/selection", { provider: "fixture", model: "fixture" });
        return acquire(session);
      },
      async resume(input: any) { const saved = stored.get(input.resumeSessionId)!; return acquire(native.Session.fromRestore(input.resumeSessionId, saved.events, saved.header)); },
    },
    sessions: { flush: async (session: any) => persist(session) },
    sessionPersistence: { stat: async (id: string) => stored.get(id) },
    llm: { async resolveModelInfo() { return {}; } },
  };
  const options = {
    context: { get: (name: string) => services[name], on: () => () => {}, effect: () => () => {} },
    sessionId: "native-v4", workspacePath: "/fixture/workspace", provider: "fixture", model: "fixture",
    contextBinding: { apiUrl: "https://fixture.invalid/v1", projectId: "project", sessionId: "shared" },
    moduleImporter: async () => ({
      freezeMessage: (message: unknown) => structuredClone(message),
      createSystemMessage: () => ({ id: "native-empty", role: "system", source: { kind: "system-prompt" }, content: [] }),
    }),
  };
  const first = createDshHostFacade(options);
  await first.projectCanonicalEvents([{ eventId: "b-chat", canonicalSequence: 1, role: "user", content: "Shared decision", occurredAt: "2026-10-29T00:00:00Z" }]);
  await first.projectCanonicalEvents([{ eventId: "b-agent", canonicalSequence: 2, role: "assistant", content: "Shared answer", occurredAt: "2026-10-29T00:00:01Z" }]);
  await first.dispose();
  const next = createDshHostFacade(options);
  await next.open();
  assert.match(JSON.stringify(live.get("native-v4").session.deriveMessages()), /Shared decision/);
  const input = (sequence: number) => ({ requestId: `request-${sequence}`, requestSequence: sequence, selectedOnly: true,
    historyContext: { view: "original" as const, through_sequence: sequence - 1, content_revision: 0, items: [] } });
  const execution = await next.prepareContextExecution!(input(2));
  const session = live.get(execution.sessionId).session;
  const head = session.surface.nodes[0];
  await next.prepareContextExecution!(input(3));
  assert.equal(session.surface.nodes[0], head, "replacing shared context must preserve the native system head");
  assert.equal(session.eventAt(head).type, "system/message");
  await next.dispose();
  const restarted = createDshHostFacade(options);
  assert.equal((await restarted.prepareContextExecution!({ ...input(3), resume: true })).sessionId, execution.sessionId);
  const clean = await restarted.resetCanonicalContext!(1);
  assert.notEqual(clean.sessionId, "native-v4");
  assert.doesNotMatch(JSON.stringify(live.get(clean.sessionId).session.deriveMessages()), /Shared decision/);
  await restarted.dispose();
  assert.equal(live.size, 0);
});
