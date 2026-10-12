import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { CanonicalEvent } from "@gatherthread/protocol";
import { startCollaborationServer } from "../src/server.js";
import { browserSessionFixture } from "./auth-fixtures.js";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { HttpCollaborationClient, LocalBridge, MemoryCursorStore, type CanonicalEvent as BridgeCanonicalEvent } from "@gatherthread/bridge";
import { CollaborationMcpService } from "@gatherthread/mcp";

async function fixture() {
  const running = await startCollaborationServer({ databasePath: ":memory:",
    authTokenPepper: "message-deletion-fixture-not-a-secret", allowedOrigins: ["http://delete.example"] }, 0);
  const owner = running.database.bootstrapIdentity({ user_id: "delete-owner", display_name: "Owner", device_name: "Owner" });
  const member = running.database.createIdentity({ user_id: "delete-member", display_name: "Member", device_name: "Member" });
  const viewer = running.database.createIdentity({ user_id: "delete-viewer", display_name: "Viewer", device_name: "Viewer" });
  const { session } = running.service.createSession(owner.actor, { session_id: "delete-session", title: "Delete test", mode: "multi", idempotency_key: "delete-session-create" });
  running.service.setMembership(owner.actor, session.id, member.actor.user_id, "participant", "delete-member-add");
  running.service.setMembership(owner.actor, session.id, viewer.actor.user_id, "viewer", "delete-viewer-add");
  const cookies = new Map([owner, member, viewer].map((identity) => [identity.actor.user_id,
    browserSessionFixture(running, { token: identity.token, origin: "http://delete.example" }).headers.get("set-cookie")!.split(";")[0]!]));
  async function request(path: string, method = "GET", body?: unknown, identity = owner, options: { origin?: string; native?: boolean } = {}) {
    const response = await fetch(`${running.origin}${path}`, { method, headers: {
      ...(options.native ? { authorization: `Bearer ${identity.token}` } : { cookie: cookies.get(identity.actor.user_id)! }),
      origin: options.origin ?? "http://delete.example", ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { data?: Record<string, unknown>; error?: { code: string } } };
  }
  const chat = (content: string, identity = owner) => running.service.appendEvent(identity.actor, session.id,
    { type: "human_chat", payload: { content }, visibility: "session", idempotency_key: randomUUID() });
  const remove = (event: CanonicalEvent, identity = owner, key = randomUUID()) => request(
    `/v1/sessions/${session.id}/events/${event.id}/delete`, "POST", { idempotency_key: key }, identity);
  return { ...running, owner, member, viewer, session, cookies, request, chat, remove };
}

test("author deletion scrubs replay and both old-head context policies without a sequence gap", async () => {
  const f = await fixture();
  try {
    const gone = f.chat("UNIQUE_DELETED_SOURCE"); const kept = f.chat("SURVIVING_SOURCE", f.member);
    const key = randomUUID(); const result = await f.remove(gone, f.owner, key);
    assert.equal(result.status, 200);
    assert.equal(result.body.data?.content_revision, 1);
    const deletion = result.body.data?.event as CanonicalEvent;
    assert.equal(deletion.type, "message_deleted");
    assert.equal((await f.remove(gone, f.owner, key)).body.data?.content_revision, 1);
    const replay = await f.request(`/v1/sessions/${f.session.id}/events`);
    assert.doesNotMatch(JSON.stringify(replay), /UNIQUE_DELETED_SOURCE/);
    const events = replay.body.data?.events as Array<CanonicalEvent & { deleted?: unknown }>;
    assert.equal(events.find((event) => event.id === gone.id)?.sequence, gone.sequence);
    assert.ok(events.find((event) => event.id === gone.id)?.deleted);
    assert.equal(events.find((event) => event.id === kept.id)?.payload && JSON.stringify(events.find((event) => event.id === kept.id)?.payload), '{"content":"SURVIVING_SOURCE"}');
    for (const view of ["summary", "original"]) {
      const context = await f.request(`/v1/sessions/${f.session.id}/context?view=${view}&through_sequence=${kept.sequence}`);
      assert.equal(context.body.data?.content_revision, 1);
      assert.doesNotMatch(JSON.stringify(context), /UNIQUE_DELETED_SOURCE|Message deleted/);
      assert.match(JSON.stringify(context), /SURVIVING_SOURCE/);
    }
    assert.equal(f.database.sqlite.prepare("SELECT payload_json FROM events WHERE id=?").get(gone.id)?.payload_json, '{"content":"[Message deleted]"}');
  } finally { await f.close(); }
});

test("only a current author writer in an admitted browser can delete; owner has no other-author override", async () => {
  const f = await fixture();
  try {
    const own = f.chat("OWNER_BODY"); const member = f.chat("MEMBER_BODY", f.member);
    assert.equal((await f.remove(member)).status, 403);
    assert.equal((await f.remove(own, f.viewer)).status, 403);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/events/${own.id}/delete`, "POST", { idempotency_key: randomUUID() }, f.owner, { native: true })).status, 403);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/events/${own.id}/delete`, "POST", { idempotency_key: randomUUID() }, f.owner, { origin: "http://foreign.example" })).status, 403);
    assert.equal((await f.request(`/v1/sessions/${f.session.id}/events/${own.id}/delete`, "POST", { idempotency_key: randomUUID(), actor_user_id: f.member.actor.user_id })).status, 400);
    const key = randomUUID(); assert.equal((await f.remove(own, f.owner, key)).status, 200);
    assert.equal((await f.remove(member, f.member, key)).status, 409);
    assert.throws(() => f.service.appendEvent(f.owner.actor, f.session.id, { type: "message_deleted" as never,
      payload: { target_event_id: member.id }, visibility: "session", idempotency_key: randomUUID() }));
  } finally { await f.close(); }
});

test("request deletion removes linked work and replies; response deletion keeps its request", async () => {
  const f = await fixture();
  try {
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "delete-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "delete-native", capture_fidelity: "harness_transcript", context_deletion_version: 1 });
    const make = (body: string, revision = 0) => f.service.appendEvent(f.owner.actor, f.session.id, { type: "agent_request", visibility: "session",
      idempotency_key: randomUUID(), content_revision: revision, payload: { content: body, execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } } });
    const request = make("DELETED_REQUEST"); f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id);
    const response = f.service.completeAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id, randomUUID(), { content: "DELETED_RESPONSE" }, undefined, undefined, 1);
    assert.equal((await f.remove(request)).status, 200);
    const replay = await f.request(`/v1/sessions/${f.session.id}/events`);
    assert.doesNotMatch(JSON.stringify(replay), /DELETED_REQUEST|DELETED_RESPONSE/);
    assert.ok((replay.body.data?.events as Array<CanonicalEvent & { deleted?: unknown }>).find((event) => event.id === response.id)?.deleted);
    const second = make("KEEP_REQUEST", 1); f.service.claimAgentRequest(f.owner.actor, f.session.id, second.id, runtime.id);
    const secondResponse = f.service.completeAgentRequest(f.owner.actor, f.session.id, second.id, runtime.id, randomUUID(), { content: "DELETE_ONLY_REPLY" }, undefined, undefined, 1);
    assert.equal((await f.remove(secondResponse)).status, 200);
    const context = await f.request(`/v1/sessions/${f.session.id}/context`);
    assert.match(JSON.stringify(context), /KEEP_REQUEST/); assert.doesNotMatch(JSON.stringify(context), /DELETE_ONLY_REPLY/);
  } finally { await f.close(); }
});

test("reply-only deletion erases same-request streams and tools from SQL, old heads, MCP and canonical projection", async () => {
  const f = await fixture();
  try {
    const sentinel = "REPLY_DELETE_PRIVATE_BODY";
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "reply-delete-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "reply-delete-native",
      capture_fidelity: "harness_transcript", context_deletion_version: 1 });
    const makeRequest = (content: string, identity = f.owner, selectedRuntime = runtime) => f.service.appendEvent(identity.actor, f.session.id, { type: "agent_request",
      visibility: "session", idempotency_key: randomUUID(), payload: { content,
        execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: selectedRuntime.id } } });
    const preceding = makeRequest("EARLIER_REQUEST_SURVIVES");
    f.service.claimAgentRequest(f.owner.actor, f.session.id, preceding.id, runtime.id);
    const earlierAnswer = f.service.completeAgentRequest(f.owner.actor, f.session.id, preceding.id, runtime.id, randomUUID(),
      { content: "EARLIER_INDEPENDENT_ANSWER_SURVIVES" }, undefined, undefined, 1);
    const request = makeRequest("ORIGINAL_QUESTION_SURVIVES");
    f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id);
    const streams = ["answer", "reasoning", "tool", "plan"].map((kind) => f.service.appendAgentProgress(f.owner.actor,
      f.session.id, request.id, runtime.id, randomUUID(), { content: sentinel, phase: "stream", stream_id: randomUUID(),
        stream_mode: "snapshot", stream_kind: kind, stream_revision: 1, stream_state: "completed",
        ...(kind === "plan" ? { plan: [{ step: sentinel, status: "completed" }] } : {}) }, undefined, undefined, 1));
    const tools = ["tool_call", "tool_result"].map((type) => f.service.appendEvent(f.owner.actor, f.session.id,
      { type: type as "tool_call" | "tool_result", visibility: "session", idempotency_key: randomUUID(), runtime_id: runtime.id,
        claim_attempt: 1, reply_to_event_id: request.id, payload: { content: sentinel } }));
    const snapshot = f.service.appendEvent(f.owner.actor, f.session.id, { type: "context_snapshot", visibility: "session",
      idempotency_key: randomUUID(), runtime_id: runtime.id, payload: { capture_fidelity: "canonical_history",
        covers_through_sequence: tools.at(-1)!.sequence, content: sentinel } });
    const peerRuntime = f.service.registerRuntime(f.member.actor, { runtime_id: "reply-delete-peer-runtime", session_id: f.session.id,
      device_id: f.member.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "reply-delete-peer-native",
      capture_fidelity: "harness_transcript", context_deletion_version: 1 });
    const copied = makeRequest("QUESTION_BETWEEN_STREAM_AND_FINAL_SURVIVES", f.member, peerRuntime);
    f.service.claimAgentRequest(f.member.actor, f.session.id, copied.id, peerRuntime.id);
    const copiedAnswer = f.service.completeAgentRequest(f.member.actor, f.session.id, copied.id, peerRuntime.id, randomUUID(),
      { content: sentinel }, undefined, undefined, 1);
    const answer = f.service.completeAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id, randomUUID(),
      { content: sentinel }, undefined, undefined, 1);
    const chat = f.chat("OTHER_MEMBER_CHAT_SURVIVES", f.member);
    assert.match(JSON.stringify(f.service.replay(f.owner.actor, f.session.id, 0, 100)), new RegExp(sentinel));
    assert.ok(streams.every((event) => event.sequence < answer.sequence));
    assert.ok(snapshot.sequence < answer.sequence && copied.sequence < answer.sequence);
    const deletionKey = randomUUID(); const removed = await f.remove(answer, f.owner, deletionKey);
    assert.equal(removed.status, 200);
    for (const output of [...streams, ...tools, snapshot, copiedAnswer, answer]) {
      const row = f.database.sqlite.prepare("SELECT deleted_at,payload_json,runtime_provenance_json FROM events WHERE id=?").get(output.id)!;
      assert.ok(row.deleted_at, `${output.type} #${output.sequence} must not retain a readable reply copy`);
      assert.equal(row.payload_json, '{"content":"[Message deleted]"}'); assert.equal(row.runtime_provenance_json, null);
    }
    for (const independent of [preceding, earlierAnswer, request, copied, chat]) {
      assert.equal(f.database.getEvent(f.session.id, independent.id).deleted, undefined);
      assert.deepEqual(f.database.getEvent(f.session.id, independent.id).payload, independent.payload);
    }
    const replay = await f.request(`/v1/sessions/${f.session.id}/events`);
    assert.doesNotMatch(JSON.stringify(replay), new RegExp(sentinel));
    const envelopes = replay.body.data?.events as CanonicalEvent[];
    assert.deepEqual(envelopes.map(event => event.sequence), Array.from({ length: envelopes.at(-1)!.sequence }, (_, index) => index + 1));
    for (const view of ["original", "summary"]) {
      const context = await f.request(`/v1/sessions/${f.session.id}/context?view=${view}&through_sequence=${snapshot.sequence}`);
      assert.doesNotMatch(JSON.stringify(context), new RegExp(sentinel));
      assert.match(JSON.stringify(context), /ORIGINAL_QUESTION_SURVIVES|EARLIER_INDEPENDENT_ANSWER_SURVIVES/);
    }
    const api = new HttpCollaborationClient({ baseUrl: `${f.origin}/v1`, bearerToken: f.member.token });
    const mcp = new CollaborationMcpService({ api });
    for (const name of ["collaboration_read_context", "collaboration_read_history"]) {
      const result = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { session_id: f.session.id } } });
      assert.ok(result && "result" in result); assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
      assert.match(JSON.stringify(result), /ORIGINAL_QUESTION_SURVIVES/);
    }
    const projected: BridgeCanonicalEvent[] = [];
    const bridge = new LocalBridge({ api: new HttpCollaborationClient({ baseUrl: `${f.origin}/v1`, bearerToken: f.owner.token }),
      cursorStore: new MemoryCursorStore(), transcriptRoots: {}, runtime: { runtimeId: "reply-delete-new-projection",
        sessionId: f.session.id, deviceId: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test",
        localSessionId: "fresh-reply-delete-native", captureFidelity: "canonical_history", purpose: "snapshot_connector", contextDeletionVersion: 1 } });
    await bridge.connect();
    assert.equal(await bridge.materializeAuthoritativeHistory({ async execute() { throw new Error("No model execution in this fixture"); },
      async projectCanonicalEvents(events) { projected.push(...events); } }, snapshot.sequence, 2), snapshot.sequence);
    assert.doesNotMatch(JSON.stringify(projected), new RegExp(sentinel));
    assert.match(JSON.stringify(projected), /ORIGINAL_QUESTION_SURVIVES/);
    assert.equal((await f.remove(answer, f.owner, deletionKey)).status, 200);
  } finally { await f.close(); }
});

test("recursive summaries containing deleted sources are invalidated and surviving originals return", async () => {
  const f = await fixture();
  try {
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "delete-summary-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "summary-native", capture_fidelity: "harness_transcript" });
    const gone = f.chat("DELETED_SUMMARY_SOURCE"); const kept = f.chat("SURVIVING_SUMMARY_SOURCE");
    const summarize = (ids: string[], text: string) => {
      const request = f.service.createHistorySummary(f.owner.actor, f.session.id, { idempotency_key: randomUUID(), source_event_ids: ids,
        execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } });
      f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id);
      return f.service.completeAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id, randomUUID(), { content: text }, undefined, undefined, 1);
    };
    const first = summarize([gone.id, kept.id], "FIRST_DERIVED_SECRET"); summarize([first.id], "NESTED_DERIVED_SECRET");
    assert.equal((await f.remove(gone)).status, 200);
    const context = await f.request(`/v1/sessions/${f.session.id}/context`);
    assert.doesNotMatch(JSON.stringify(context), /DELETED_SUMMARY_SOURCE|FIRST_DERIVED_SECRET|NESTED_DERIVED_SECRET/);
    assert.match(JSON.stringify(context), /SURVIVING_SUMMARY_SOURCE/);
    assert.throws(() => f.service.createHistorySummary(f.owner.actor, f.session.id, { idempotency_key: randomUUID(), source_event_ids: [first.id],
      execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } }));
  } finally { await f.close(); }
});

test("deleting any source fences already claimed turns even when another account asked", async () => {
  const f = await fixture();
  try {
    const source = f.chat("DELETE_WHILE_OTHER_MEMBER_WORKS");
    const runtime = f.service.registerRuntime(f.member.actor, { runtime_id: "other-active-runtime", session_id: f.session.id,
      device_id: f.member.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "other-native", capture_fidelity: "harness_transcript" });
    const request = f.service.appendEvent(f.member.actor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: randomUUID(),
      payload: { content: "Read shared context", execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } } });
    f.service.claimAgentRequest(f.member.actor, f.session.id, request.id, runtime.id);
    await f.remove(source);
    assert.throws(() => f.service.completeAgentRequest(f.member.actor, f.session.id, request.id, runtime.id, randomUUID(), { content: "LATE_OLD_CONTEXT_ANSWER" }, undefined, undefined, 1),
      (error: unknown) => (error as { code?: string }).code === "context_changed");
    assert.throws(() => f.service.claimAgentRequest(f.member.actor, f.session.id, request.id, runtime.id),
      (error: unknown) => (error as { code?: string }).code === "context_changed");
    const replay = await f.request(`/v1/sessions/${f.session.id}/events`);
    assert.match(JSON.stringify(replay), /context_changed/); assert.doesNotMatch(JSON.stringify(replay), /LATE_OLD_CONTEXT_ANSWER/);
  } finally { await f.close(); }
});

for (const native of [false, true]) for (const captured of [0, undefined]) {
  test(`${native ? "native" : "browser"} requests with ${captured === undefined ? "missing" : "stale"} history pins cannot reintroduce erased instructions`, async () => {
    const f = await fixture();
    try {
      const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "pin-aware-native", session_id: f.session.id,
        device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "pin-aware-native",
        capture_fidelity: "harness_transcript", context_deletion_version: 1 });
      const input = { type: "agent_request" as const, visibility: "session" as const, idempotency_key: randomUUID(),
        payload: { content: "NATIVE_REQUEST_ERASED_BODY", execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } } };
      const original = f.service.appendEvent(f.owner.actor, f.session.id, input);
      assert.equal(original.content_revision, 0, "pristine legacy omission must remain compatible");
      assert.equal((await f.remove(original)).status, 200);
      const exactRetry = f.service.appendEvent(f.owner.actor, f.session.id, { ...input, content_revision: 0 });
      assert.ok(exactRetry.deleted); assert.doesNotMatch(JSON.stringify(exactRetry), /NATIVE_REQUEST_ERASED_BODY/);
      const before = f.service.replay(f.owner.actor, f.session.id, 0, 100).events;
      const beforeClaims = f.database.sqlite.prepare("SELECT count(*) AS n FROM agent_request_claims").get()?.n;
      const retryKey = randomUUID();
      const reply = await f.request(`/v1/sessions/${f.session.id}/events`, "POST", { ...input,
        idempotency_key: retryKey, ...(captured === undefined ? {} : { content_revision: captured }) }, f.owner, { native });
      assert.equal(reply.status, 409); assert.equal(reply.body.error?.code, "context_changed");
      assert.deepEqual(f.service.replay(f.owner.actor, f.session.id, 0, 100).events, before);
      assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM events WHERE idempotency_key=?").get(retryKey)?.n, 0);
      assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM agent_request_claims").get()?.n, beforeClaims);
      const human = f.chat("Independently authored human chat needs no execution pin");
      assert.equal(human.type, "human_chat"); assert.equal(human.content_revision, 1);
      const current = await f.request(`/v1/sessions/${f.session.id}/events`, "POST", { ...input, idempotency_key: randomUUID(),
        content_revision: 1, payload: { ...input.payload, content: "New native question at current revision" } }, f.owner, { native });
      assert.equal(current.status, 201);
      const accepted = current.body.data?.event as CanonicalEvent;
      assert.equal(accepted.content_revision, 1);
      assert.equal(f.service.claimAgentRequest(f.owner.actor, f.session.id, accepted.id, runtime.id).status, "claimed");
      assert.doesNotMatch(JSON.stringify(f.service.readHistoryContext(f.owner.actor, f.session.id)), /NATIVE_REQUEST_ERASED_BODY/);
    } finally { await f.close(); }
  });
}

test("MCP requests preserve the context pin through real HTTP acceptance and cannot restamp erased instructions", async () => {
  const f = await fixture();
  try {
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "mcp-pin-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "mcp-pin-native",
      capture_fidelity: "harness_transcript", context_deletion_version: 1 });
    const api = new HttpCollaborationClient({ baseUrl: `${f.origin}/v1`, bearerToken: f.owner.token });
    const mcp = new CollaborationMcpService({ api });
    const original = await api.appendEvent(f.session.id, { type: "agent_request", idempotencyKey: randomUUID(),
      contentRevision: 0, payload: { text: "MCP_NATIVE_ERASED_REQUEST" } });
    assert.equal((await f.remove(f.database.getEvent(f.session.id, original.id))).status, 200);
    const before = f.service.replay(f.owner.actor, f.session.id, 0, 100).events.length;
    const call = (content: string, revision?: number) => mcp.handle({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: {
      name: "collaboration_request_agent", arguments: { session_id: f.session.id, content, idempotency_key: randomUUID(),
        ...(revision === undefined ? {} : { content_revision: revision }) },
    } });
    for (const captured of [0, undefined]) {
      const refused = await call("MCP_NATIVE_ERASED_REQUEST", captured);
      assert.ok(refused && "error" in refused);
      assert.equal(f.service.replay(f.owner.actor, f.session.id, 0, 100).events.length, before);
    }
    const fresh = await call("New explicit MCP request", 1);
    assert.ok(fresh && "result" in fresh);
    const request = f.service.replay(f.owner.actor, f.session.id, 0, 100).events.at(-1)!;
    assert.equal(request.content_revision, 1); assert.match(JSON.stringify(request.payload), /New explicit MCP request/);
    assert.equal(f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id).status, "claimed");
    assert.doesNotMatch(JSON.stringify(await api.readEvents(f.session.id, 0, 100)), /MCP_NATIVE_ERASED_REQUEST/);
  } finally { await f.close(); }
});

test("stale native outboxes and old connectors cannot accept, publish or execute after deletion", async () => {
  const f = await fixture();
  try {
    const source = f.chat("NATIVE_OLD_SOURCE");
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "legacy-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "legacy-native", capture_fidelity: "harness_transcript" });
    await f.remove(source);
    const newInput = { type: "agent_request" as const, visibility: "session" as const, idempotency_key: randomUUID(), content_revision: 1,
      payload: { content: "New prompt", execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } } };
    assert.throws(() => f.service.appendEvent(f.owner.actor, f.session.id, newInput),
      (error: unknown) => (error as { code?: string }).code === "connector_update_required");
    const upgraded = f.service.registerRuntime(f.owner.actor, { ...runtime, runtime_id: runtime.id, context_deletion_version: 1 });
    const request = f.service.appendEvent(f.owner.actor, f.session.id, newInput);
    f.service.registerRuntime(f.owner.actor, { ...runtime, runtime_id: upgraded.id, context_deletion_version: undefined });
    assert.throws(() => f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id),
      (error: unknown) => (error as { code?: string }).code === "connector_update_required");
    assert.throws(() => f.service.commitLocalTurn(f.owner.actor, f.session.id, { local_turn_id: "old-native-turn", runtime_id: runtime.id,
      based_on_sequence: source.sequence, occurred_at: new Date().toISOString(), request_payload: { content: "stale" }, response_payload: { content: "NATIVE_OLD_SOURCE" } }),
      (error: unknown) => ["connector_update_required", "context_changed"].includes((error as { code?: string }).code ?? ""));
  } finally { await f.close(); }
});

test("canonical snapshots, quoted deleted bodies and mentions cannot bypass deletion-aware model reads", async () => {
  const f = await fixture();
  try {
    const source = f.service.appendEvent(f.owner.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "mention-source",
      payload: { content: "@Member DELETED_MCP_SOURCE", mentions: [{ user_id: f.member.actor.user_id, start: 0, end: 7 }] } });
    const quote = f.service.appendEvent(f.member.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "quote-survives",
      reply_to_event_id: source.id, payload: { content: "INDEPENDENT_REPLY_SURVIVES" } });
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "delete-snapshot-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "snapshot-native", capture_fidelity: "canonical_history" });
    const snapshot = f.service.appendEvent(f.owner.actor, f.session.id, { type: "context_snapshot", visibility: "session", idempotency_key: "derived-snapshot",
      runtime_id: runtime.id, payload: { content: "DELETED_MCP_SOURCE", capture_fidelity: "canonical_history", covers_through_sequence: source.sequence } });
    await f.remove(source);
    assert.ok(f.database.getEvent(f.session.id, snapshot.id).deleted);
    assert.throws(() => f.service.appendEvent(f.member.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "late-quote",
      reply_to_event_id: source.id, payload: { content: "New quote" } }), (error: unknown) => (error as { code?: string }).code === "message_deleted");
    assert.equal(f.service.listProjectMentions(f.member.actor, f.session.project_id).mentions.length, 0);
    assert.equal(f.database.getEvent(f.session.id, quote.id).payload && JSON.stringify(f.database.getEvent(f.session.id, quote.id).payload), '{"content":"INDEPENDENT_REPLY_SURVIVES"}');
    const api = new HttpCollaborationClient({ baseUrl: `${f.origin}/v1`, bearerToken: f.member.token });
    const mcp = new CollaborationMcpService({ api });
    for (const name of ["collaboration_read_context", "collaboration_read_history"]) {
      const result = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { session_id: f.session.id } } });
      assert.doesNotMatch(JSON.stringify(result), /DELETED_MCP_SOURCE/);
      assert.match(JSON.stringify(result), /INDEPENDENT_REPLY_SURVIVES/);
      assert.match(JSON.stringify(result), /content_revision|contentRevision/);
    }
    const resource = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "resources/read", params: {
      uri: `collaboration://sessions/${f.session.id}/events?after_sequence=0&limit=100`,
    } });
    assert.ok(resource && "result" in resource);
    assert.doesNotMatch(JSON.stringify(resource), /DELETED_MCP_SOURCE/);
    assert.match(JSON.stringify(resource), /INDEPENDENT_REPLY_SURVIVES/);
    const contents = (resource as { result: { contents: Array<{ text: string }> } }).result.contents;
    assert.equal(JSON.parse(contents[0]!.text).contentRevision, 1);
    const delayed = f.service.presentEvent(f.member.actor, source);
    assert.equal(delayed.content_revision, 1); assert.ok(delayed.deleted);
    assert.doesNotMatch(JSON.stringify(delayed), /DELETED_MCP_SOURCE/);
  } finally { await f.close(); }
});

test("concurrent database handles commit one deletion receipt and preserve it across restart and paginated replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gt-deletion-race-"));
  const file = join(dir, "fixture.sqlite"); const pepper = "deletion-race-fixture-not-a-secret";
  let database = new CollaborationDatabase(file, { authTokenPepper: pepper });
  const workers: Worker[] = [];
  try {
    const actor = database.bootstrapIdentity({ display_name: "Author", device_name: "Browser" }).actor;
    const service = new CollaborationService(database);
    const session = service.createSession(actor, { title: "Race", mode: "multi", idempotency_key: "race-session" }).session;
    const original = { type: "human_chat" as const, visibility: "session" as const, idempotency_key: "original-receipt", payload: { content: "RACE_DELETED_SOURCE" } };
    const source = service.appendEvent(actor, session.id, original);
    service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "race-kept", payload: { content: "RACE_SURVIVING_SOURCE" } });
    const key = randomUUID();
    const script = `const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { CollaborationDatabase } = await import(workerData.moduleUrl);
        const db = new CollaborationDatabase(workerData.file, { authTokenPepper: workerData.pepper });
        parentPort.once("message", () => {
          try { const result = db.deleteMessage(workerData.actor,workerData.sessionId,workerData.eventId,workerData.key);
            parentPort.postMessage({ revision:result.content_revision, eventId:result.event.id });
          } catch(error) { parentPort.postMessage({ failure:error.code ?? error.message }); }
          finally { db.close(); }
        });
        parentPort.postMessage({ready:true});
      })().catch(error => { throw error; });`;
    for (let n = 0; n < 2; n++) workers.push(new Worker(script, { eval: true, workerData: {
      moduleUrl: new URL("../src/database.js", import.meta.url).href, file, pepper, actor, sessionId: session.id, eventId: source.id, key,
    } }));
    const next = (worker: Worker) => new Promise<any>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    await Promise.all(workers.map(next));
    const results = workers.map(next); for (const worker of workers) worker.postMessage("go");
    const receipts = await Promise.all(results);
    assert.equal(receipts[0].revision, 1); assert.deepEqual(receipts[1], receipts[0]);
    assert.equal(database.sqlite.prepare("SELECT count(*) AS n FROM message_deletions").get()?.n, 1);
    assert.equal(database.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type='message_deleted'").get()?.n, 1);
    database.close(); database = new CollaborationDatabase(file, { authTokenPepper: pepper });
    const reopened = new CollaborationService(database);
    assert.equal(database.deleteMessage(actor, session.id, source.id, key).event.id, receipts[0].eventId);
    const exact = reopened.appendEvent(actor, session.id, original);
    assert.ok(exact.deleted); assert.doesNotMatch(JSON.stringify(exact), /RACE_DELETED_SOURCE/);
    assert.throws(() => reopened.appendEvent(actor, session.id, { ...original, payload: { content: "changed retry" } }),
      (error: unknown) => (error as { code?: string }).code === "idempotency_conflict");
    const sequences: number[] = []; let cursor = 0;
    for (;;) {
      const page = reopened.replay(actor, session.id, cursor, 1);
      assert.equal(page.content_revision, 1); assert.doesNotMatch(JSON.stringify(page), /RACE_DELETED_SOURCE/);
      sequences.push(...page.events.map((event) => event.sequence)); cursor = page.cursor;
      if (!page.has_more) break;
    }
    assert.deepEqual(sequences, Array.from({ length: cursor }, (_, n) => n + 1));
    const context = reopened.readHistoryContext(actor, session.id, "original", source.sequence);
    assert.equal(context.content_revision, 1); assert.deepEqual(context.items, []);
    assert.deepEqual(database.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate())); database.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("migration from a pre-deletion database preserves canonical IDs, foreign keys and frozen-head erasure", () => {
  const dir = mkdtempSync(join(tmpdir(), "gt-deletion-migrate-")); const file = join(dir, "fixture.sqlite");
  const options = { authTokenPepper: "deletion-migration-fixture" };
  let database = new CollaborationDatabase(file, options);
  let open = true;
  try {
    const actor = database.bootstrapIdentity({ display_name: "Author", device_name: "Browser" }).actor;
    const service = new CollaborationService(database);
    const session = service.createSession(actor, { title: "Migration", mode: "multi", idempotency_key: "migration-session" }).session;
    const source = service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "migration-source", payload: { content: "MIGRATION_DELETED_SOURCE" } });
    database.close();
    open = false;
    const legacy = new DatabaseSync(file);
    try {
      for (const [table, column] of [["events", "deleted_at"], ["events", "deleted_reason"], ["events", "content_revision"],
        ["sessions", "content_revision"], ["runtimes", "context_deletion_version"], ["snapshot_requests", "content_revision"]]) {
        legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
      legacy.exec("DROP TABLE message_deletions; DROP TABLE deleted_event_receipts; PRAGMA foreign_keys=OFF");
      const sql = String(legacy.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get()?.sql);
      const oldSql = sql.replace(/CREATE TABLE (?:"events"|events)/u, "CREATE TABLE events_legacy").replace(",'message_deleted'", "");
      legacy.exec(`BEGIN IMMEDIATE; ${oldSql}; INSERT INTO events_legacy SELECT * FROM events;
        DROP TABLE events; ALTER TABLE events_legacy RENAME TO events; COMMIT; PRAGMA foreign_keys=ON`);
    } finally { legacy.close(); }
    database = new CollaborationDatabase(file, options);
    open = true;
    assert.equal(database.getEvent(session.id, source.id).sequence, source.sequence);
    database.deleteMessage(actor, session.id, source.id, "migration-delete");
    assert.equal(database.requireSession(session.id).content_revision, 1);
    assert.doesNotMatch(JSON.stringify(database.readHistoryContext(actor, session.id, "original", source.sequence)), /MIGRATION_DELETED_SOURCE/);
    assert.deepEqual(database.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { if (open) database.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("deleted live SQL content is zeroed and WAL truncation defers safely for a reader without claiming physical purge", () => {
  const dir = mkdtempSync(join(tmpdir(), "gt-deletion-storage-")), file = join(dir, "fixture.sqlite");
  let now = Date.parse("2026-10-12T00:00:00Z");
  const database = new CollaborationDatabase(file, { authTokenPepper: "deletion-storage-fixture", clock: () => new Date(now) });
  const reader = new DatabaseSync(file);
  try {
    assert.equal(database.sqlite.prepare("PRAGMA secure_delete").get()?.secure_delete, 1);
    const actor = database.bootstrapIdentity({ display_name: "Author", device_name: "Browser" }).actor;
    const session = database.createSession(actor, { title: "Storage", mode: "multi", idempotency_key: "storage-session" }).session;
    const source = database.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "storage-source",
      payload: { content: "PHYSICAL_DELETED_SENTINEL_123".repeat(500) } }, null);
    const surviving = database.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: "storage-surviving", payload: { content: "STORAGE_SURVIVING" } }, null);
    database.sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    reader.exec("BEGIN"); reader.prepare("SELECT payload_json FROM events WHERE id=?").get(source.id);
    database.deleteMessage(actor, session.id, source.id, "storage-delete");
    const started = Date.now();
    assert.deepEqual((database as any).purgeDeletedMessageStorage(), { pending: true, overdue: false });
    assert.ok(Date.now() - started < 1000, "a long reader cannot turn maintenance into a blocking lock wait");
    assert.equal(database.sqlite.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    now += 14 * 86400000;
    assert.deepEqual((database as any).purgeDeletedMessageStorage(), { pending: true, overdue: true });
    reader.exec("COMMIT");
    assert.deepEqual((database as any).purgeDeletedMessageStorage(), { pending: false, overdue: false });
    for (const path of [file, `${file}-wal`]) if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from("PHYSICAL_DELETED_SENTINEL_123")), false);
    assert.equal((database.getEvent(session.id, surviving.id).payload as { content: string }).content, "STORAGE_SURVIVING");
    assert.equal(database.sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally { if (reader.isTransaction) reader.exec("ROLLBACK"); reader.close(); database.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("deletion rechecks revoked device, viewer demotion, Solo and foreign-session authority", async () => {
  const f = await fixture();
  try {
    const own = f.chat("ROLE_RECHECK_SOURCE", f.member);
    f.service.setProjectMembership(f.owner.actor, f.session.project_id, f.member.actor.user_id, "viewer");
    assert.equal((await f.remove(own, f.member)).status, 403);
    f.service.setProjectMembership(f.owner.actor, f.session.project_id, f.member.actor.user_id, "participant");
    const foreign = f.service.createSession(f.owner.actor, { title: "Foreign", mode: "solo", idempotency_key: "foreign-session" }).session;
    assert.equal((await f.request(`/v1/sessions/${foreign.id}/events/${own.id}/delete`, "POST", { idempotency_key: randomUUID() })).status, 404);
    const solo = f.service.createSession(f.member.actor, { project_id: f.session.project_id, title: "Member Solo", mode: "solo", idempotency_key: "member-solo" }).session;
    const soloSource = f.service.appendEvent(f.member.actor, solo.id, { type: "human_chat", visibility: "session", idempotency_key: "solo-source", payload: { content: "SOLO_PRIVATE_SOURCE" } });
    assert.equal((await f.request(`/v1/sessions/${solo.id}/events/${soloSource.id}/delete`, "POST", { idempotency_key: randomUUID() }, f.owner)).status, 403);
    assert.equal((await f.request(`/v1/sessions/${solo.id}/events/${soloSource.id}/delete`, "POST", { idempotency_key: randomUUID() }, f.member)).status, 200);
    f.database.sqlite.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run(new Date().toISOString(), f.member.actor.device_id);
    assert.equal((await f.remove(own, f.member)).status, 401);
    assert.throws(() => f.database.deleteMessage(f.member.actor, f.session.id, own.id, randomUUID()));
    assert.doesNotMatch(JSON.stringify(await f.request(`/v1/sessions/${f.session.id}/events`, "GET", undefined, f.member)), /ROLE_RECHECK_SOURCE/);
  } finally { await f.close(); }
});

test("account and session deletion preserve prior message tombstones without dangling author receipts", async () => {
  const f = await fixture();
  try {
    const source = f.chat("MEMBER_REMOVED_CONTENT", f.member);
    await f.remove(source, f.member);
    const result = f.database.deleteAccount(f.member.actor);
    assert.ok(result.retained_shared_events >= 1);
    assert.equal(f.database.getEvent(f.session.id, source.id).actor_user_id, "deleted-account");
    assert.doesNotMatch(JSON.stringify(f.service.replay(f.owner.actor, f.session.id, 0, 100)), /MEMBER_REMOVED_CONTENT/);
    assert.deepEqual(f.database.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    f.service.deleteSession(f.owner.actor, f.session.id);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM message_deletions").get()?.n, 0);
    assert.equal(f.database.sqlite.prepare("SELECT count(*) AS n FROM deleted_event_receipts").get()?.n, 0);
  } finally { await f.close(); }
});

test("a deletion erases in-flight work derived from old context and invalidates frozen native imports", async () => {
  const f = await fixture();
  try {
    const source = f.chat("DERIVED_OLD_CONTEXT_SECRET");
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "delete-work-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "work-native", capture_fidelity: "harness_transcript", context_deletion_version: 1 });
    const snapshotRuntime = f.service.registerRuntime(f.owner.actor, { runtime_id: "delete-import-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "import-native", capture_fidelity: "canonical_history", purpose: "snapshot_connector", context_deletion_version: 1 });
    const completed = f.database.createSnapshotRequest(f.owner.actor, f.session.id);
    f.database.claimSnapshotRequest(f.owner.actor, completed.id, snapshotRuntime.id);
    f.database.completeSnapshotRequest(f.owner.actor, completed.id, snapshotRuntime.id, { imported_text: "DERIVED_OLD_CONTEXT_SECRET" });
    const pending = f.database.createSnapshotRequest(f.owner.actor, f.session.id);
    const request = f.service.appendEvent(f.owner.actor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: randomUUID(),
      payload: { content: "Use shared history", execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } } });
    f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id);
    const progress = f.service.appendAgentProgress(f.owner.actor, f.session.id, request.id, runtime.id, randomUUID(), { content: "DERIVED_OLD_CONTEXT_SECRET" }, undefined, undefined, 1);
    await f.remove(source);
    const replay = f.service.replay(f.owner.actor, f.session.id, 0, 100);
    assert.doesNotMatch(JSON.stringify(replay), /DERIVED_OLD_CONTEXT_SECRET/);
    assert.ok(replay.events.find((event) => event.id === progress.id)?.deleted);
    assert.doesNotMatch(JSON.stringify(f.database.getSnapshotRequest(f.owner.actor, completed.id)), /DERIVED_OLD_CONTEXT_SECRET/);
    assert.equal(f.database.getSnapshotRequest(f.owner.actor, pending.id).failure?.code, "context_changed");
    assert.throws(() => f.database.claimSnapshotRequest(f.owner.actor, pending.id, snapshotRuntime.id),
      (error: unknown) => (error as { code?: string }).code === "context_changed");
    assert.throws(() => f.service.appendEvent(f.owner.actor, f.session.id, { type: "tool_result", visibility: "session", idempotency_key: randomUUID(),
      reply_to_event_id: request.id, runtime_id: runtime.id, claim_attempt: 1, payload: { content: "LATE_TOOL_SECRET" } }),
      (error: unknown) => (error as { code?: string }).code === "context_changed");
  } finally { await f.close(); }
});
