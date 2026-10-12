import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { CanonicalEvent } from "@gatherthread/protocol";
import { startCollaborationServer } from "../src/server.js";
import { browserSessionFixture } from "./auth-fixtures.js";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { HttpCollaborationClient } from "@gatherthread/bridge";
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
    const make = (body: string) => f.service.appendEvent(f.owner.actor, f.session.id, { type: "agent_request", visibility: "session",
      idempotency_key: randomUUID(), payload: { content: body, execution_profile: { harness: "codex", provider: "test", model: "test", runtime_id: runtime.id } } });
    const request = make("DELETED_REQUEST"); f.service.claimAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id);
    const response = f.service.completeAgentRequest(f.owner.actor, f.session.id, request.id, runtime.id, randomUUID(), { content: "DELETED_RESPONSE" }, undefined, undefined, 1);
    assert.equal((await f.remove(request)).status, 200);
    const replay = await f.request(`/v1/sessions/${f.session.id}/events`);
    assert.doesNotMatch(JSON.stringify(replay), /DELETED_REQUEST|DELETED_RESPONSE/);
    assert.ok((replay.body.data?.events as Array<CanonicalEvent & { deleted?: unknown }>).find((event) => event.id === response.id)?.deleted);
    const second = make("KEEP_REQUEST"); f.service.claimAgentRequest(f.owner.actor, f.session.id, second.id, runtime.id);
    const secondResponse = f.service.completeAgentRequest(f.owner.actor, f.session.id, second.id, runtime.id, randomUUID(), { content: "DELETE_ONLY_REPLY" }, undefined, undefined, 1);
    assert.equal((await f.remove(secondResponse)).status, 200);
    const context = await f.request(`/v1/sessions/${f.session.id}/context`);
    assert.match(JSON.stringify(context), /KEEP_REQUEST/); assert.doesNotMatch(JSON.stringify(context), /DELETE_ONLY_REPLY/);
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

test("stale native outboxes and old connectors cannot accept, publish or execute after deletion", async () => {
  const f = await fixture();
  try {
    const source = f.chat("NATIVE_OLD_SOURCE");
    const runtime = f.service.registerRuntime(f.owner.actor, { runtime_id: "legacy-runtime", session_id: f.session.id,
      device_id: f.owner.actor.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "legacy-native", capture_fidelity: "harness_transcript" });
    await f.remove(source);
    const newInput = { type: "agent_request" as const, visibility: "session" as const, idempotency_key: randomUUID(),
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
    const delayed = f.service.presentEvent(f.member.actor, source);
    assert.equal(delayed.content_revision, 1); assert.ok(delayed.deleted);
    assert.doesNotMatch(JSON.stringify(delayed), /DELETED_MCP_SOURCE/);
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
