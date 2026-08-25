import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";

test("mock authentication derives the user from a token", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  await assert.rejects(() => api.authenticate("wrong"), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal((await api.authenticate("demo-token")).username, "Avery Chen");
});

test("append is idempotent and chat never fabricates an agent response", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const before = await api.replayEvents("session-orbit", { afterSequence: 0 });
  const input = { content: "One durable message", idempotencyKey: "same-key" };
  const first = await api.appendHumanChat("session-orbit", input);
  const repeated = await api.appendHumanChat("session-orbit", input);
  const after = await api.replayEvents("session-orbit", { afterSequence: 0 });

  assert.equal(first.id, repeated.id);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.events.at(-1).type, "human_chat");
});

test("solo viewers cannot append", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  await assert.rejects(
    () => api.appendHumanChat("session-notes", { content: "should fail", idempotencyKey: "forbidden" }),
    (error) => error.status === 403 && error.code === "forbidden",
  );
});

test("created sessions retain explicit solo or multi mode", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const created = await api.createSession({ name: "New multi", mode: "multi" });
  const detail = await api.getSession(created.id);
  assert.equal(detail.mode, "multi");
  assert.equal(detail.members[0].role, "owner");
});

test("HTTP client normalizes the production v1 envelope and canonical event shape", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { data: { id: "u1", username: "Alice", device_id: "d1" } },
    { data: { sessions: [{ id: "s1", title: "Shared", mode: "multi", state: "active", role: "owner", current_sequence: 2, member_count: 1, updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { members: [{ user_id: "u1", display_name: "Alice", role: "owner", runtime: { id: "r1", status: "online", harness: "Codex", provider: "OpenAI", model: "gpt-5.6-sol", capture_fidelity: "harness_transcript" } }] } },
    { data: { events: [{ id: "e2", session_id: "s1", sequence: 2, type: "agent_response", actor_user_id: "u1", created_at: "2026-08-25T00:00:01.000Z", payload: { content: "done" }, runtime_provenance: { harness: "Codex", provider: "OpenAI", model: "gpt-5.6-sol", capture_fidelity: "harness_transcript" } }], cursor: 2, has_more: false } },
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://relay.example" });
    assert.equal((await api.authenticate("secret-token")).username, "Alice");
    const sessions = await api.listSessions();
    assert.deepEqual({ name: sessions[0].name, memberCount: sessions[0].memberCount }, { name: "Shared", memberCount: 1 });
    assert.equal((await api.listMembers("s1"))[0].runtime.model, "gpt-5.6-sol");
    const replay = await api.replayEvents("s1", { afterSequence: 0 });
    assert.equal(replay.events[0].actor.username, "Alice");
    assert.equal(replay.events[0].provenance.fidelity, "harness_transcript");
    assert.equal(replay.next_after_sequence, 2);
    assert.equal(requests[0].url, "https://relay.example/v1/me");
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
