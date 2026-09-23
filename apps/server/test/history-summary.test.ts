import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalEvent, JsonValue } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { startCollaborationServer, type ServerOptions } from "../src/server.js";

type ContextResult = { data: { view: string; through_sequence: number; items: Array<{
  kind: string; event_id: string; sequence: number; actor_user_id: string; content: string; source_event_ids?: string[];
}> } };
type EventResult = { data: { event: CanonicalEvent } };

async function fixture(options: Partial<ServerOptions> = {}) {
  const running = await startCollaborationServer({
    databasePath: ":memory:",
    authTokenPepper: "history-summary-tests-not-a-live-secret",
    allowedOrigins: ["http://summary-browser.example"],
    ...options,
  }, 0);
  const owner = running.database.bootstrapIdentity({ user_id: "summary-owner", display_name: "Owner", device_name: "Owner" });
  const member = running.database.createIdentity({ user_id: "summary-member", display_name: "Member", device_name: "Member" });
  const viewer = running.database.createIdentity({ user_id: "summary-viewer", display_name: "Viewer", device_name: "Viewer" });
  const outsider = running.database.createIdentity({ user_id: "summary-outsider", display_name: "Outsider", device_name: "Outsider" });
  const { session } = running.service.createSession(owner.actor, {
    session_id: "summary-session", title: "Summary session", mode: "multi", idempotency_key: "summary-session-create",
  });
  running.service.setMembership(owner.actor, session.id, member.actor.user_id, "participant", "summary-member-add");
  running.service.setMembership(owner.actor, session.id, viewer.actor.user_id, "viewer", "summary-viewer-add");
  const register = (identity: typeof owner, runtimeId: string) => running.service.registerRuntime(identity.actor, {
    runtime_id: runtimeId, session_id: session.id, device_id: identity.actor.device_id, harness: "deepseek-harness", provider: "test-provider",
    model: "test-model", local_session_id: `local-${runtimeId}`, capture_fidelity: "harness_transcript",
  });
  const ownerRuntime = register(owner, "summary-owner-runtime");
  const memberRuntime = register(member, "summary-member-runtime");
  let chatNumber = 0;
  const chat = (content: string, extra: Record<string, JsonValue> = {}) => running.service.appendEvent(owner.actor, session.id, {
    type: "human_chat", visibility: "session", idempotency_key: `summary-source-${++chatNumber}`, payload: { content, ...extra },
  });
  const profile = (runtimeId = ownerRuntime.id) => ({
    harness: "deepseek-harness", provider: "test-provider", model: "test-model", runtime_id: runtimeId,
  });
  async function request<T = unknown>(path: string, options: {
    method?: string; token?: string; cookie?: string; origin?: string; body?: unknown;
  } = {}) {
    const response = await fetch(`${running.origin}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token === "" ? {} : { authorization: `Bearer ${options.token ?? owner.token}` }),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const create = (sourceIds: string[], key: string, options: { token?: string; runtimeId?: string; instructions?: string } = {}) =>
    request<EventResult>(`/v1/sessions/${session.id}/history-summaries`, {
      method: "POST", ...(options.token === undefined ? {} : { token: options.token }),
      body: { idempotency_key: key, source_event_ids: sourceIds, execution_profile: profile(options.runtimeId),
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }) },
    });
  async function finish(event: CanonicalEvent, text: string, identity = owner, runtimeId = ownerRuntime.id, status?: string) {
    const base = `/v1/sessions/${session.id}/agent-requests/${event.id}`;
    const claim = await request(`${base}/claim`, { method: "POST", token: identity.token, body: { runtime_id: runtimeId } });
    assert.equal(claim.status, 200);
    return request<EventResult>(`${base}/complete`, { method: "POST", token: identity.token, body: {
      runtime_id: runtimeId, claim_attempt: 1, idempotency_key: `summary-complete-${event.id}`,
      payload: { text, ...(status === undefined ? {} : { status }) }, observed_model: "test-model",
    } });
  }
  return { ...running, owner, member, viewer, outsider, session, ownerRuntime, memberRuntime, chat, profile, request, create, finish };
}

test("manual summaries use canonical source text, the normal exact claim flow, and reversible context views", async () => {
  const f = await fixture();
  try {
    const first = f.chat("First public fact", { reasoning: "PRIVATE_REASONING", private_metadata: { hidden: "PRIVATE_METADATA" } });
    const middle = f.chat("UNSELECTED_MIDDLE");
    const last = f.chat("Last public fact");
    const created = await f.create([last.id, first.id], "summary-generation-one", { instructions: "Keep decisions and unresolved questions." });
    assert.equal(created.status, 201);
    const event = created.body.data.event;
    assert.equal(event.type, "agent_request");
    assert.equal(event.actor_user_id, f.owner.actor.user_id);
    assert.equal(event.runtime_provenance, null, "requesting generation is not a model-output provenance claim");
    const payload = event.payload as { content: string; execution_profile: unknown; history_summary: { version: number; source_event_ids: string[]; source_digest: string } };
    assert.deepEqual(payload.execution_profile, f.profile());
    assert.equal(payload.history_summary.version, 1);
    assert.deepEqual(payload.history_summary.source_event_ids, [first.id, last.id]);
    assert.match(payload.history_summary.source_digest, /^[a-f0-9]{64}$/u);
    assert.match(payload.content, /First public fact/u);
    assert.match(payload.content, /Last public fact/u);
    assert.match(payload.content, /Keep decisions/u);
    assert.doesNotMatch(payload.content, /PRIVATE_|UNSELECTED_MIDDLE/u);
    assert.ok(Buffer.byteLength(payload.content) < 32 * 1024);
    const pending = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=summary`);
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body.data.items.map((item) => item.event_id), [first.id, middle.id, last.id]);

    const completed = await f.finish(event, "A deliberately lossy recap");
    assert.equal(completed.status, 201);
    const original = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=original`, { token: f.viewer.token });
    assert.equal(original.status, 200);
    assert.deepEqual(original.body.data.items.map((item) => item.content), ["First public fact", "UNSELECTED_MIDDLE", "Last public fact"]);
    const summary = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=summary`, { token: f.member.token });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.through_sequence, completed.body.data.event.sequence);
    assert.equal(summary.body.data.items.length, 2);
    const recap = summary.body.data.items.find((item) => item.kind === "summary");
    assert.equal(recap?.content, "A deliberately lossy recap");
    assert.deepEqual(recap?.source_event_ids, [first.id, last.id]);
    assert.ok(summary.body.data.items.some((item) => item.event_id === middle.id));
    assert.doesNotMatch(JSON.stringify(summary.body), /PRIVATE_|local-summary/u);
    const raw = f.service.replay(f.viewer.actor, f.session.id, 0, 100);
    assert.ok(raw.events.some((entry) => entry.id === first.id));
    assert.ok(raw.events.some((entry) => entry.id === event.id));
  } finally { await f.close(); }
});

test("writers may retain overlapping summary versions using their own Agent while viewers remain read-only", async () => {
  const f = await fixture();
  try {
    const sources = [f.chat("Fact A"), f.chat("Fact B"), f.chat("Fact C")];
    const old = await f.create(sources.slice(0, 2).map((event) => event.id), "summary-overlap-old");
    assert.equal(old.status, 201);
    assert.equal((await f.finish(old.body.data.event, "AB recap")).status, 201);
    const next = await f.create(sources.slice(1).map((event) => event.id), "summary-overlap-new", {
      token: f.member.token, runtimeId: f.memberRuntime.id,
    });
    assert.equal(next.status, 201);
    assert.equal((await f.finish(next.body.data.event, "BC recap", f.member, f.memberRuntime.id)).status, 201);
    const view = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=summary`, { token: f.viewer.token });
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.data.items.map((item) => item.content), ["Fact A", "BC recap"]);
    assert.equal((await f.create([sources[0]!.id], "summary-viewer-denied", { token: f.viewer.token })).status, 403);
    assert.equal((await f.create([sources[0]!.id], "summary-foreign-runtime", { token: f.member.token })).status, 409);
    assert.equal((await f.create([sources[0]!.id], "summary-outsider-denied", { token: f.outsider.token })).status, 404);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/context`, { token: f.outsider.token })).status, 404);
    const solo = f.service.createSession(f.member.actor, { project_id: f.session.project_id, title: "Member Solo", mode: "solo", idempotency_key: "summary-solo-create" }).session;
    assert.equal((await f.request(`/v1/sessions/${solo.id}/history-summaries`, { method: "POST", body: {
      source_event_ids: [sources[0]!.id], idempotency_key: "summary-solo-denied", execution_profile: f.profile(),
    } })).status, 403);
    assert.equal((await f.request(`/v1/sessions/${solo.id}/context?view=original`, { token: f.viewer.token })).status, 200);
  } finally { await f.close(); }
});

test("summary retries are exact, actor-bound and independent from later runtime presence", async () => {
  const f = await fixture();
  try {
    const source = f.chat("Retry source");
    const other = f.chat("Different source");
    const first = await f.create([source.id], "summary-retry-operation", { instructions: "Preserve constraints." });
    assert.equal(first.status, 201);
    const before = f.database.requireSession(f.session.id).next_sequence;
    f.database.sqlite.prepare("UPDATE runtimes SET status = 'offline' WHERE id = ?").run(f.ownerRuntime.id);
    const retry = await f.create([source.id], "summary-retry-operation", { instructions: "Preserve constraints." });
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body, first.body);
    for (const response of [
      await f.create([other.id], "summary-retry-operation", { instructions: "Preserve constraints." }),
      await f.create([source.id], "summary-retry-operation", { instructions: "Different instructions." }),
      await f.create([source.id], "summary-retry-operation", { token: f.member.token, runtimeId: f.memberRuntime.id }),
    ]) assert.equal(response.status, 409);
    assert.equal((await f.create([source.id], source.idempotency_key)).status, 409);
    assert.equal((await f.create([source.id], "summary-offline-new")).status, 409);
    assert.equal(f.database.requireSession(f.session.id).next_sequence, before);
    f.service.revokeDevice(f.owner.actor, f.owner.actor.device_id);
    assert.equal((await f.create([source.id], "summary-retry-operation", { instructions: "Preserve constraints." })).status, 401);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/context`)).status, 401);
  } finally { await f.close(); }
});

test("summary sources exclude unfinished requests, private events, failed answers and summary control requests", async () => {
  const f = await fixture();
  try {
    const pending = f.service.appendEvent(f.owner.actor, f.session.id, {
      type: "agent_request", visibility: "session", idempotency_key: "summary-pending-source", payload: { content: "Pending source", execution_profile: f.profile() },
    });
    assert.equal((await f.create([pending.id], "summary-pending-rejected")).status, 409);
    const failed = await f.finish(pending, "Request failed", f.owner, f.ownerRuntime.id, "failed");
    assert.equal(failed.status, 201);
    assert.equal((await f.create([failed.body.data.event.id], "summary-failed-rejected")).status, 400);
    const empty = f.service.appendEvent(f.owner.actor, f.session.id, {
      type: "human_chat", visibility: "session", idempotency_key: "summary-empty-source", payload: { reasoning: "PRIVATE_ONLY" },
    });
    const privateEvent = f.service.appendEvent(f.owner.actor, f.session.id, {
      type: "human_chat", visibility: "owner_only", idempotency_key: "summary-private-source", payload: { content: "OWNER_ONLY_SECRET" },
    });
    for (const source of [empty, privateEvent]) assert.equal((await f.create([source.id], `summary-reject-${source.id}`)).status, 400);
    const secondSession = f.service.createSession(f.owner.actor, { title: "Other", mode: "multi", idempotency_key: "summary-other-session" }).session;
    const foreign = f.service.appendEvent(f.owner.actor, secondSession.id, { type: "human_chat", visibility: "session", idempotency_key: "summary-foreign-source", payload: { content: "FOREIGN_SESSION_SECRET" } });
    assert.equal((await f.create([foreign.id], "summary-foreign-rejected")).status, 404);
    const source = f.chat("Safe fact");
    const summary = await f.create([source.id], "summary-control-source");
    assert.equal(summary.status, 201);
    assert.equal((await f.create([summary.body.data.event.id], "summary-request-rejected")).status, 400);
    const summaryReply = await f.finish(summary.body.data.event, "Summary output");
    assert.equal((await f.create([summaryReply.body.data.event.id], "summary-output-reselected")).status, 201);
    const original = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=original`);
    assert.doesNotMatch(JSON.stringify(original.body), /OWNER_ONLY_SECRET|PRIVATE_ONLY|FOREIGN_SESSION_SECRET|Summary output/u);
  } finally { await f.close(); }
});

test("a shared completed summary can be summarized again with recursive originals preserved", async () => {
  const f = await fixture();
  try {
    const a = f.chat("Original A");
    const b = f.chat("Original B");
    const first = await f.create([a.id, b.id], "summary-nested-first");
    const firstReply = await f.finish(first.body.data.event, "First recap AB");
    const c = f.chat("Original C");
    const second = await f.create([firstReply.body.data.event.id, c.id], "summary-nested-second", {
      token: f.member.token, runtimeId: f.memberRuntime.id,
    });
    assert.equal(second.status, 201);
    const prompt = (second.body.data.event.payload as { content: string }).content;
    assert.match(prompt, /First recap AB/u);
    assert.match(prompt, /Original C/u);
    assert.doesNotMatch(prompt, /Original A|Original B/u, "selected summary text, not hidden expanded text, is sent to the Agent");
    const secondReply = await f.finish(second.body.data.event, "Second recap ABC", f.member, f.memberRuntime.id);
    const third = await f.create([firstReply.body.data.event.id, secondReply.body.data.event.id], "summary-nested-third");
    assert.equal(third.status, 201);
    assert.equal((await f.finish(third.body.data.event, "Latest recap ABC")).status, 201);
    const context = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context`);
    assert.deepEqual(context.body.data.items.map((item) => item.content), ["Latest recap ABC"]);
    assert.deepEqual(context.body.data.items[0]?.source_event_ids, [a.id, b.id, c.id]);
    assert.deepEqual((third.body.data.event.payload as { history_summary: { source_event_ids: string[] } }).history_summary.source_event_ids,
      [firstReply.body.data.event.id, secondReply.body.data.event.id], "the canonical request keeps the exact selected versions");
    const originals = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=original`);
    assert.deepEqual(originals.body.data.items.map((item) => item.event_id), [a.id, b.id, c.id]);
  } finally { await f.close(); }
});

test("summary source, prompt and context resource limits reject rather than truncate", async () => {
  const f = await fixture();
  try {
    const oversized = f.chat(`BEGIN_${"x".repeat(21 * 1024)}_TAIL`);
    const before = f.database.requireSession(f.session.id).next_sequence;
    assert.equal((await f.create([oversized.id], "summary-oversized-source")).status, 413);
    assert.equal((await f.create([oversized.id], "summary-invalid-instructions", { instructions: "x".repeat(4001) })).status, 400);
    assert.equal(f.database.requireSession(f.session.id).next_sequence, before);
    const bounded = f.chat("s".repeat(19 * 1024));
    assert.equal((await f.create([bounded.id], "summary-oversized-prompt", { instructions: "界".repeat(4_000) })).status, 413);
    const escaped = f.chat("\\".repeat(9_000));
    assert.equal((await f.create([escaped.id], "summary-serialized-prompt")).status, 413, "nested JSON escaping must fit the transport boundary too");
    for (let index = 0; index < 3; index += 1) f.chat(`${index}:${"public".repeat(17_000)}`);
    for (const view of ["summary", "original"]) {
      const response = await f.request(`/v1/sessions/${f.session.id}/context?view=${view}`);
      assert.equal(response.status, 413);
      assert.doesNotMatch(JSON.stringify(response.body), /BEGIN_|publicpublic/u);
    }
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/context?view=unknown`)).status, 400);
  } finally { await f.close(); }
});

test("generic writes and local-turn payloads cannot forge server-owned summary metadata", async () => {
  const f = await fixture();
  try {
    const source = f.chat("Public source");
    const marker = { version: 1, source_event_ids: [source.id], source_digest: "0".repeat(64) };
    const before = f.database.requireSession(f.session.id).next_sequence;
    for (const markerValue of [marker, null, false]) {
      const response = await f.request(`/v1/sessions/${f.session.id}/events`, { method: "POST", body: {
        type: "agent_request", visibility: "session", idempotency_key: `summary-forge-${String(markerValue)}`,
        payload: { content: "Spoof", execution_profile: f.profile(), history_summary: markerValue },
      } });
      assert.equal(response.status, 403);
    }
    for (const field of ["request_payload", "response_payload", "tool_events"]) {
      const response = await f.request(`/v1/sessions/${f.session.id}/local-turns`, { method: "POST", body: {
        local_turn_id: `summary-forge-${field}`, runtime_id: f.ownerRuntime.id, based_on_sequence: before,
        occurred_at: "2026-09-22T00:00:00.000Z", request_payload: { content: "Local request" }, response_payload: { text: "Local response" },
        [field]: field === "tool_events" ? [{ type: "tool_result", payload: { history_summary: marker } }] : { content: "Spoof", history_summary: marker },
      } });
      assert.equal(response.status, 403);
    }
    assert.equal(f.database.requireSession(f.session.id).next_sequence, before);
  } finally { await f.close(); }
});

test("summary creation uses existing browser Origin checks and authenticated context reads", async () => {
  const f = await fixture();
  try {
    const source = f.chat("Browser-selected source");
    const login = await f.request("/v1/browser-sessions", { method: "POST", origin: "http://summary-browser.example", body: {} });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const body = { source_event_ids: [source.id], idempotency_key: "summary-cookie-operation", execution_profile: f.profile() };
    for (const origin of [undefined, "http://hostile.example"]) {
      assert.equal((await f.request(`/v1/sessions/${f.session.id}/history-summaries`, { method: "POST", token: "", cookie, ...(origin === undefined ? {} : { origin }), body })).status, 403);
    }
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/history-summaries`, { method: "POST", token: "", cookie, origin: "http://summary-browser.example", body })).status, 201);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/context`, { token: "", cookie })).status, 200);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/context`, { token: "" })).status, 401);
  } finally { await f.close(); }
});

test("context policies belong to the current member, default to summary and cannot grant generation permission", async () => {
  const f = await fixture();
  try {
    const path = `/v1/projects/${f.session.project_id}/context-policy`;
    const source = f.chat("Original policy text");
    const summary = await f.create([source.id], "summary-policy-generation");
    assert.equal((await f.finish(summary.body.data.event, "Shared summary")).status, 201);
    assert.deepEqual((await f.request(path, { token: f.viewer.token })).body, { data: { mode: "summary" } });
    const before = f.database.requireSession(f.session.id).next_sequence;
    assert.deepEqual((await f.request(path, { method: "PUT", token: f.viewer.token, body: { mode: "original" } })).body, { data: { mode: "original" } });
    const viewer = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context`, { token: f.viewer.token });
    assert.equal(viewer.body.data.view, "original");
    assert.equal(viewer.body.data.items[0]?.content, "Original policy text");
    const owner = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context`);
    assert.equal(owner.body.data.view, "summary");
    assert.equal(owner.body.data.items[0]?.content, "Shared summary");
    const explicit = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?view=summary`, { token: f.viewer.token });
    assert.equal(explicit.body.data.view, "summary");
    assert.equal((await f.create([source.id], "summary-policy-viewer-denied", { token: f.viewer.token })).status, 403);
    for (const method of ["GET", "PUT"]) {
      assert.equal((await f.request(path, { method, token: f.outsider.token, ...(method === "PUT" ? { body: { mode: "original" } } : {}) })).status, 404);
    }
    for (const body of [{ mode: "all" }, { mode: "original", user_id: f.owner.actor.user_id }]) {
      assert.equal((await f.request(path, { method: "PUT", token: f.viewer.token, body })).status, 400);
    }
    assert.equal(f.database.requireSession(f.session.id).next_sequence, before);
    f.service.removeProjectMembership(f.owner.actor, f.session.project_id, f.viewer.actor.user_id);
    assert.equal((await f.request(path, { token: f.viewer.token })).status, 404);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/context`, { token: f.viewer.token })).status, 404);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS count FROM project_context_policies").get()?.count, 0);
  } finally { await f.close(); }
});

test("context snapshots honor an exact historical head including hidden events without future summary leakage", async () => {
  const f = await fixture();
  try {
    const first = f.chat("Fact before frozen head");
    const hidden = f.service.appendEvent(f.owner.actor, f.session.id, {
      type: "human_chat", visibility: "owner_only", idempotency_key: "summary-frozen-hidden", payload: { content: "HIDDEN_FROM_CONTEXT" },
    });
    const generated = await f.create([first.id], "summary-frozen-generation");
    const completed = await f.finish(generated.body.data.event, "Future summary");
    assert.equal(completed.status, 201);
    for (const through of [hidden.sequence, generated.body.data.event.sequence]) {
      const frozen = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?through_sequence=${through}`, { token: f.viewer.token });
      assert.equal(frozen.status, 200);
      assert.equal(frozen.body.data.through_sequence, through);
      assert.deepEqual(frozen.body.data.items.map((item) => item.content), ["Fact before frozen head"]);
      assert.doesNotMatch(JSON.stringify(frozen.body), /HIDDEN_FROM_CONTEXT|Future summary/u);
    }
    const zero = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?through_sequence=0`);
    assert.deepEqual(zero.body, { data: { view: "summary", through_sequence: 0, items: [] } });
    for (const value of ["", "-1", "1.5", "1e0", "NaN", "9007199254740992", String(completed.body.data.event.sequence + 1), "1&through_sequence=2"]) {
      assert.equal((await f.request(`/v1/sessions/${f.session.id}/context?through_sequence=${value}`)).status, 400);
    }
  } finally { await f.close(); }
});

test("completed public requests are valid sources and failed summary output never replaces originals", async () => {
  const f = await fixture();
  try {
    const original = f.service.appendEvent(f.owner.actor, f.session.id, {
      type: "agent_request", visibility: "session", idempotency_key: "summary-completed-source", payload: { content: "Original request", execution_profile: f.profile() },
    });
    const answer = await f.finish(original, "Original answer");
    const generated = await f.create([answer.body.data.event.id, original.id], "summary-completed-pair");
    assert.equal(generated.status, 201);
    assert.equal((await f.finish(generated.body.data.event, "Failed recap", f.owner, f.ownerRuntime.id, "failed")).status, 201);
    const context = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context`);
    assert.deepEqual(context.body.data.items.map((item) => item.content), ["Original request", "Original answer"]);
    const retry = await f.create([original.id, answer.body.data.event.id], "summary-completed-pair-retry");
    assert.equal(retry.status, 201, "failed or overlapping prior versions do not reserve sources");
  } finally { await f.close(); }
});

test("generation rejects unsupported profiles, stale and snapshot runtimes and accepts another active device of the same user", async () => {
  const f = await fixture();
  try {
    const source = f.chat("Exact runtime source");
    for (const override of [{ model: "different-model" }, { provider: "different-provider" }, { harness: "codex" }, { runtime_id: "missing-runtime" }]) {
      assert.equal((await f.request(`/v1/sessions/${f.session.id}/history-summaries`, { method: "POST", body: {
        idempotency_key: `summary-bad-profile-${Object.keys(override)[0]}`, source_event_ids: [source.id], execution_profile: { ...f.profile(), ...override },
      } })).status, 409);
    }
    const snapshot = f.service.registerRuntime(f.owner.actor, { runtime_id: "summary-snapshot-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, purpose: "snapshot_connector", harness: "deepseek-harness", provider: "test-provider",
      model: "test-model", local_session_id: "snapshot-local", capture_fidelity: "harness_transcript" });
    assert.equal((await f.create([source.id], "summary-snapshot-denied", { runtimeId: snapshot.id })).status, 409);
    const device = f.database.createDevice(f.owner.actor.user_id, "Other active owner device", "summary-other-device");
    assert.equal((await f.create([source.id], "summary-other-device-accepted", { token: device.token })).status, 201);
    const otherActor = { ...f.owner.actor, device_id: device.device_id };
    const expiredRuntime = f.service.registerRuntime(otherActor, { runtime_id: "summary-expired-device-runtime", session_id: f.session.id,
      device_id: device.device_id, harness: "deepseek-harness", provider: "test-provider", model: "test-model",
      local_session_id: "expired-device-local", capture_fidelity: "harness_transcript" });
    f.database.sqlite.prepare("UPDATE devices SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", device.device_id);
    assert.equal((await f.create([source.id], "summary-expired-device-denied", { runtimeId: expiredRuntime.id })).status, 409);
    f.database.sqlite.prepare("UPDATE runtimes SET last_seen_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", f.ownerRuntime.id);
    assert.equal((await f.create([source.id], "summary-stale-denied")).status, 409);
  } finally { await f.close(); }
});

test("progress, completion and forged reply payloads cannot create trusted summary metadata", async () => {
  const f = await fixture();
  try {
    const source = f.chat("Not yet summarized");
    const request = await f.create([source.id], "summary-protected-request");
    const event = request.body.data.event;
    const base = `/v1/sessions/${f.session.id}/agent-requests/${event.id}`;
    assert.equal((await f.request(`${base}/claim`, { method: "POST", body: { runtime_id: f.ownerRuntime.id } })).status, 200);
    const before = f.database.requireSession(f.session.id).next_sequence;
    for (const action of ["progress", "complete"]) {
      assert.equal((await f.request(`${base}/${action}`, { method: "POST", body: {
        runtime_id: f.ownerRuntime.id, claim_attempt: 1, idempotency_key: `summary-forged-${action}`,
        payload: { text: "Untrusted recap", history_summary: null },
      } })).status, 403);
    }
    assert.equal(f.database.requireSession(f.session.id).next_sequence, before);
    const forged = await f.request(`/v1/sessions/${f.session.id}/events`, { method: "POST", body: {
      type: "agent_response", visibility: "session", runtime_id: f.ownerRuntime.id, idempotency_key: "summary-forged-payload-parent",
      payload: { text: "Detached response", reply_to_event_id: event.id },
    } });
    assert.equal(forged.status, 201);
    const context = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context`);
    assert.ok(context.body.data.items.every((item) => item.kind === "original"));
    assert.ok(context.body.data.items.some((item) => item.event_id === source.id));
  } finally { await f.close(); }
});

test("summary append quota failure rolls back sequence and usage with no accepted request", async () => {
  const f = await fixture({ maxEventBytes: 1_500 });
  try {
    const source = f.chat("Quota source");
    const before = f.database.requireSession(f.session.id).next_sequence;
    const usage = f.database.sqlite.prepare("SELECT sum(bytes) AS bytes FROM event_storage_usage").get();
    const response = await f.create([source.id], "summary-quota-denied");
    assert.equal(response.status, 507);
    assert.equal(f.database.requireSession(f.session.id).next_sequence, before);
    assert.deepEqual(f.database.sqlite.prepare("SELECT sum(bytes) AS bytes FROM event_storage_usage").get(), usage);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS count FROM events WHERE idempotency_key = ?").get("summary-quota-denied")?.count, 0);
  } finally { await f.close(); }
});

test("project context preferences persist across reopen and recheck device authentication", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-history-policy-"));
  const path = join(directory, "test.sqlite");
  const options = { authTokenPepper: "history-policy-test-not-live" };
  let database = new CollaborationDatabase(path, options);
  try {
    const identity = database.bootstrapIdentity({ user_id: "policy-owner", display_name: "Owner", device_name: "Test" });
    const project = database.createProject(identity.actor, { title: "Policy project", idempotency_key: "policy-project-create" });
    database.setProjectContextPolicy(identity.actor, project.id, "original");
    database.close();
    database = new CollaborationDatabase(path, options);
    assert.deepEqual(database.getProjectContextPolicy(identity.actor, project.id), { mode: "original" });
    database.revokeDevice(identity.actor, identity.actor.device_id);
    for (const operation of [() => database.getProjectContextPolicy(identity.actor, project.id), () => database.setProjectContextPolicy(identity.actor, project.id, "summary")]) {
      assert.throws(operation, (error: unknown) => error instanceof ApiError && error.status === 401);
    }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("context event scan cap returns no partial result while a bounded source selection still works", async () => {
  const f = await fixture();
  try {
    const source = f.chat("Bounded source before many control events");
    const before = f.database.requireSession(f.session.id).next_sequence;
    const insert = f.database.sqlite.prepare(`
      INSERT INTO events(id, session_id, sequence, idempotency_key, type, actor_user_id, actor_display_name,
        created_at, visibility, reply_to_event_id, payload_json, runtime_provenance_json)
      VALUES (?, ?, ?, ?, 'context_snapshot', ?, 'Owner', '2026-09-23T00:00:00.000Z', 'session', NULL, '{}', NULL)
    `);
    // Bulk-seed only this in-memory fixture; no live log or user database is used.
    f.database.sqlite.exec("BEGIN IMMEDIATE");
    for (let index = 1; index <= 10_001; index += 1) {
      insert.run(`summary-scan-event-${index}`, f.session.id, before + index, `summary-scan-key-${index}`, f.owner.actor.user_id);
    }
    f.database.sqlite.prepare("UPDATE sessions SET next_sequence = ? WHERE id = ?").run(before + 10_001, f.session.id);
    f.database.sqlite.exec("COMMIT");
    const response = await f.request(`/v1/sessions/${f.session.id}/context`);
    assert.equal(response.status, 413);
    assert.ok(!("data" in (response.body as Record<string, unknown>)));
    const frozen = await f.request<ContextResult>(`/v1/sessions/${f.session.id}/context?through_sequence=${source.sequence}`);
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.data.items[0]?.event_id, source.id);
    assert.equal((await f.create([source.id], "summary-scanned-selection")).status, 201);
  } finally { await f.close(); }
});

test("context scan byte cap rejects ignored control payloads instead of returning a deceptively complete view", async () => {
  const f = await fixture();
  try {
    f.chat("Public fact");
    for (let index = 0; index < 84; index += 1) {
      f.service.appendEvent(f.owner.actor, f.session.id, {
        type: "context_snapshot", visibility: "session", idempotency_key: `summary-byte-scan-${index}`,
        payload: { data: "x".repeat(200 * 1024) },
      });
    }
    const response = await f.request(`/v1/sessions/${f.session.id}/context?view=original`);
    assert.equal(response.status, 413);
    assert.ok(!("data" in (response.body as Record<string, unknown>)));
  } finally { await f.close(); }
});
