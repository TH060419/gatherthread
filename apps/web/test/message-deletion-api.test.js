import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { translateUiText } from "../src/i18n.js";
import { normalizeExecutionRuntime } from "../src/dsh.js";
const wire = { id: "event-delete", session_id: "s1", sequence: 2, type: "message_deleted", visibility: "session",
  idempotency_key: "delete-key-0001", actor_user_id: "me", actor_display_name: "Me", created_at: "2026-10-12T00:00:00.000Z",
  reply_to_event_id: null, runtime_provenance: null, content_revision: 1,
  payload: { target_event_id: "event-original", content_revision: 1 } };
const receipt = { event: wire, target_event_id: "event-original", content_revision: 1,
  affected_event_ids: ["event-original"], affected_truncated: false };

test("deletion uses cookie-only encoded route, strict receipt and stable idempotency input", async () => {
  const api = new HttpCollaborationApi(), calls = []; let result = receipt;
  api.request = async (path, options) => { calls.push({ path, options }); return result; };
  const accepted = await api.deleteMessage("s1", "event-original", { idempotencyKey: "delete-key-0001" });
  assert.equal(calls[0].path, "/v1/sessions/s1/events/event-original/delete");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { idempotency_key: "delete-key-0001" });
  assert.equal(calls[0].options.headers?.Authorization, undefined);
  assert.equal(accepted.contentRevision, 1); assert.equal(accepted.event.sessionId, "s1");
  assert.deepEqual(accepted.affectedEventIds, ["event-original"]);
  for (const value of [{ ...receipt, old_content: "must not copy" }, { ...receipt, target_event_id: "other" },
    { ...receipt, event: { ...wire, session_id: "other" } }, { ...receipt, event: { ...wire, type: "human_chat" } }]) {
    result = value; await assert.rejects(api.deleteMessage("s1", "event-original", { idempotencyKey: "delete-key-0001" }), /response is invalid/);
  }
});

test("HTTP replay and session normalization retain content revision and sanitized tombstones", async () => {
  const api = new HttpCollaborationApi();
  api.request = async path => path.includes("/events?") ? { events: [{ ...wire, type: "human_chat", id: "event-original",
    payload: { content: "[Message deleted]" }, deleted: { deleted_at: wire.created_at, reason: "author" } }], cursor: 2, has_more: false, content_revision: 1 }
    : { session: { id: "s1", project_id: "p1", owner_user_id: "me", title: "Session", mode: "multi", content_revision: 1 }, role: "owner" };
  const page = await api.replayEvents("s1", { afterSequence: 0 });
  assert.equal(page.content_revision, 1); assert.equal(page.events[0].contentRevision, 1);
  assert.equal(page.events[0].deleted.reason, "author");
  assert.equal((await api.getSession("s1")).contentRevision, 1);
});

test("mock deletion changes actual source/read receipts, includes linked work and recursively invalidates summaries", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const source = await api.appendHumanChat("session-orbit", { content: "deletion source fixture", idempotencyKey: "source-0001" });
  const events = api.events.get("session-orbit"), actor = structuredClone(api.currentUser);
  const make = (id, type, payload, replyTo = null) => ({ id, type, sessionId: "session-orbit", actor, visibility: "session",
    sequence: events.at(-1).sequence + 1, createdAt: wire.created_at, payload, replyTo });
  events.push(make("summary-r1", "agent_request", { content: "summary input", history_summary: { source_event_ids: [source.id] } }));
  events.push(make("summary-a1", "agent_response", { content: "derived secret" }, "summary-r1"));
  events.push(make("summary-r2", "agent_request", { content: "nested input", history_summary: { source_event_ids: ["summary-a1"] } }));
  events.push(make("summary-a2", "agent_response", { content: "nested derived" }, "summary-r2"));
  const input = { idempotencyKey: "delete-source-0001" };
  const first = await api.deleteMessage("session-orbit", source.id, input);
  const repeated = await api.deleteMessage("session-orbit", source.id, input);
  assert.equal(first.event.id, repeated.event.id);
  const page = await api.replayEvents("session-orbit", { afterSequence: 0 });
  assert.equal(page.contentRevision, 1);
  assert.equal(JSON.stringify(page).includes("derived secret"), false);
  assert.equal(JSON.stringify(page).includes("deletion source fixture"), false);
  assert.equal(page.events.find(e => e.id === "summary-a2").deleted.reason, "summary_invalidated");
  assert.equal((await api.appendHumanChat("session-orbit", { content: "deletion source fixture", idempotencyKey: "source-0001" })).deleted.reason, "author");
  await assert.rejects(api.deleteMessage("session-orbit", "summary-a2", input), error => error.status === 409);
});

test("mock deletion refuses other authors, viewers and another creator's Solo", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const source = await api.appendHumanChat("session-orbit", { content: "own", idempotencyKey: "source-own-0001" });
  const owner = api.currentUser;
  api.currentUser = { id: "other" }; await assert.rejects(api.deleteMessage("session-orbit", source.id, { idempotencyKey: "other-0001" }), error => error.status === 403);
  api.currentUser = owner; const session = api.sessions.find(s => s.id === "session-orbit"), member = session.members.find(m => m.userId === owner.id);
  const role = member.role; member.role = "viewer";
  await assert.rejects(api.deleteMessage("session-orbit", source.id, { idempotencyKey: "viewer-0001" }), error => error.status === 403);
  member.role = role; session.mode = "solo"; session.ownerUserId = "other";
  await assert.rejects(api.deleteMessage("session-orbit", source.id, { idempotencyKey: "solo-0001" }), error => error.status === 403);
});

test("mock refuses a fresh quote of a deleted source without blocking an accepted append retry", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const source = await api.appendHumanChat("session-orbit", { content: "source", idempotencyKey: "quote-source-0001" });
  const accepted = await api.appendHumanChat("session-orbit", { content: "existing quote", replyTo: source.id,
    idempotencyKey: "quote-existing-0001" });
  await api.deleteMessage("session-orbit", source.id, { idempotencyKey: "quote-delete-0001" });
  await assert.rejects(api.appendHumanChat("session-orbit", { content: "new quote", replyTo: source.id,
    idempotencyKey: "quote-fresh-0001" }), error => error.status === 409 && error.code === "message_deleted");
  assert.equal((await api.appendHumanChat("session-orbit", { content: "existing quote", replyTo: source.id,
    idempotencyKey: "quote-existing-0001" })).id, accepted.id);
});

test("mock source deletion invalidates later generated work without deleting independent human requests", async () => {
  const api = new MockCollaborationApi({ latency: 0 }), sessionId = "session-orbit";
  const source = await api.appendHumanChat(sessionId, { content: "remove later work", idempotencyKey: "later-source-0001" });
  const events = api.events.get(sessionId), actor = api.currentUser;
  const add = (id, type, content, replyTo = null) => events.push({ id, type, sessionId, sequence: events.at(-1).sequence + 1,
    createdAt: wire.created_at, actor, visibility: "session", replyTo, payload: { content } });
  add("later-request", "agent_request", "Human request remains");
  add("later-response", "agent_response", "Old derived work disappears", "later-request");
  add("pending-request", "agent_request", "Pending human request remains");
  add("pending-work", "agent_progress", "Old pending work disappears", "pending-request");
  await api.deleteMessage(sessionId, source.id, { idempotencyKey: "later-delete-0001" });
  const replay = await api.replayEvents(sessionId, { afterSequence: 0 });
  assert.equal(replay.events.find(item => item.id === "later-request").deleted, undefined);
  assert.equal(replay.events.find(item => item.id === "later-response").deleted?.reason, "request");
  assert.equal(replay.events.find(item => item.id === "pending-work").deleted?.reason, "request");
  assert.ok(replay.events.some(item => item.replyTo === "pending-request" && item.payload?.error?.code === "context_changed"));
});

test("mock local retry rejects an old captured revision before appending or replaying it", async () => {
  const api = new MockCollaborationApi({ latency: 0 }), sessionId = "session-orbit";
  const source = await api.appendHumanChat(sessionId, { content: "Delete this before the retry", idempotencyKey: "pin-source" });
  await api.deleteMessage(sessionId, source.id, { idempotencyKey: "pin-delete" });
  const before = api.events.get(sessionId).length;
  await assert.rejects(api.appendAgentRequest(sessionId, { content: "Captured old retry", idempotencyKey: "pin-retry", contentRevision: 0 }),
    error => error.status === 409 && error.code === "context_changed");
  assert.equal(api.events.get(sessionId).length, before);
  const accepted = await api.appendAgentRequest(sessionId, { content: "Explicit fresh retry", idempotencyKey: "pin-current", contentRevision: 1 });
  assert.equal(accepted.payload.content, "Explicit fresh retry");
});

test("mock final-answer deletion also removes its earlier stream without deleting the human request", async () => {
  const api = new MockCollaborationApi({ latency: 0 }), sessionId = "session-orbit";
  const events = api.events.get(sessionId), actor = api.currentUser;
  const add = (id, type, content, replyTo = null) => events.push({ id, type, sessionId, sequence: events.at(-1).sequence + 1,
    createdAt: wire.created_at, actor, visibility: "session", replyTo, payload: { content } });
  add("answer-request", "agent_request", "Human instruction remains");
  add("answer-stream", "agent_progress", "The same answer copy must disappear", "answer-request");
  add("answer-final", "agent_response", "The same answer copy must disappear", "answer-request");
  await api.deleteMessage(sessionId, "answer-final", { idempotencyKey: "answer-delete" });
  const page = await api.replayEvents(sessionId, { afterSequence: 0 });
  assert.equal(page.events.find(item => item.id === "answer-request").deleted, undefined);
  assert.equal(page.events.find(item => item.id === "answer-stream").deleted?.reason, "request");
  assert.equal(page.events.find(item => item.id === "answer-final").deleted?.reason, "author");
  assert.doesNotMatch(JSON.stringify(page), /same answer copy/);
});

test("mock revised native requests require a pin while accepted retries return a tombstone and fresh human chats remain writable", async () => {
  const api = new MockCollaborationApi({ latency: 0 }), sessionId = "session-orbit";
  const old = { content: "Accepted old native instructions", idempotencyKey: "accepted-native", contentRevision: 0 };
  const request = await api.appendAgentRequest(sessionId, old);
  await api.deleteMessage(sessionId, request.id, { idempotencyKey: "delete-native" });
  assert.equal((await api.appendAgentRequest(sessionId, old)).deleted?.reason, "author");
  await assert.rejects(api.appendAgentRequest(sessionId, { content: "Missing pin", idempotencyKey: "native-missing" }),
    error => error.status === 409 && error.code === "context_changed");
  const chat = await api.appendHumanChat(sessionId, { content: "A fresh independent human message", idempotencyKey: "chat-current" });
  assert.equal(chat.payload.content, "A fresh independent human message");
});

test("context-change errors give a bilingual reconnect action and runtime capability survives normalization", async () => {
  const api = new HttpCollaborationApi();
  api.request = async () => ({ runtimes: [{ id: "r1", device_id: "d1", harness: "codex", provider: "fixture",
    model: "fixture", status: "online", last_seen_at: wire.created_at, context_deletion_version: 1 }] });
  const [runtime] = await api.listSessionRuntimes("s1");
  assert.equal(runtime.contextDeletionVersion, 1);
  assert.equal(normalizeExecutionRuntime(runtime).contextDeletionVersion, 1);
  assert.equal(normalizeExecutionRuntime({ ...runtime, contextDeletionVersion: undefined }).contextDeletionVersion ?? 0, 0);
  for (const code of ["connector_update_required", "context_changed"]) {
    const error = new ApiError("Runtime-specific internal diagnostic", { status: 409, code });
    assert.doesNotMatch(error.message, /internal diagnostic/);
    assert.notEqual(translateUiText(error.message, "zh-CN"), error.message);
  }
});
