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
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    assert.equal((await api.authenticate("secret-token")).username, "Alice");
    const sessions = await api.listSessions();
    assert.deepEqual({ name: sessions[0].name, memberCount: sessions[0].memberCount }, { name: "Shared", memberCount: 1 });
    assert.equal((await api.listMembers("s1"))[0].runtime.model, "gpt-5.6-sol");
    const replay = await api.replayEvents("s1", { afterSequence: 0 });
    assert.equal(replay.events[0].actor.username, "Alice");
    assert.equal(replay.events[0].provenance.fidelity, "harness_transcript");
    assert.equal(replay.next_after_sequence, 2);
    assert.equal(requests[0].url, "https://gatherthread.example/v1/me");
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret-token");
    api.clearCredential();
    assert.equal(api.token, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP invitation API uses exact routes, keeps secrets out of list records, and adopts claimed credentials in memory", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const record = {
    id: "i1",
    session_id: "s1",
    inviter_user_id: "owner",
    role: "participant",
    created_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-26T00:00:00.000Z",
    revoked_at: null,
    expired_at: null,
    claimed_at: null,
    claimed_by_user_id: null,
    claimed_by_device_id: null,
  };
  const responses = [
    { data: { invitation: record, invite_token: "invite-secret-value-that-is-long-enough" } },
    { data: { invitations: [record] } },
    { data: { invitation: { ...record, revoked_at: "2026-08-25T01:00:00.000Z" } } },
    { data: { actor: { user_id: "existing", display_name: "Existing", device_id: "d1" }, invitation: { ...record, claimed_at: "2026-08-25T01:00:00.000Z" }, event: {} } },
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example", token: "member-token" });
    const created = await api.createInvitation("s1", { role: "participant", ttl: "7d" });
    assert.equal(created.inviteToken, "invite-secret-value-that-is-long-enough");
    assert.equal((await api.listInvitations("s1"))[0].status, "pending");
    assert.equal((await api.revokeInvitation("s1", "i1")).status, "revoked");
    assert.equal((await api.acceptInvitation("existing-secret")).invitation.sessionId, "s1");

    assert.deepEqual(requests.map((request) => [request.options.method ?? "GET", request.url]), [
      ["POST", "https://gatherthread.example/v1/sessions/s1/invitations"],
      ["GET", "https://gatherthread.example/v1/sessions/s1/invitations"],
      ["DELETE", "https://gatherthread.example/v1/sessions/s1/invitations/i1"],
      ["POST", "https://gatherthread.example/v1/invitations/accept"],
    ]);
    assert.deepEqual(JSON.parse(requests[0].options.body), { role: "participant", ttl: "7d" });
    assert.deepEqual(JSON.parse(requests[3].options.body), { invite_token: "existing-secret" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new-user invitation claim is unauthenticated and stores only the returned device credential", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ data: {
      actor: { user_id: "new-user", display_name: "New User", device_id: "new-device" },
      token: "new-device-token",
      invitation: {
        id: "i1",
        session_id: "s1",
        inviter_user_id: "owner",
        role: "viewer",
        created_at: "2026-08-25T00:00:00.000Z",
        expires_at: "2026-08-26T00:00:00.000Z",
        revoked_at: null,
        expired_at: null,
        claimed_at: "2026-08-25T01:00:00.000Z",
        claimed_by_user_id: "new-user",
        claimed_by_device_id: "new-device",
      },
    } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    const claimed = await api.claimInvitation({
      inviteToken: "one-use-invitation-secret-that-is-long",
      displayName: "New User",
      deviceName: "Work laptop",
    });
    assert.equal(claimed.actor.username, "New User");
    assert.equal(claimed.invitation.status, "claimed");
    assert.equal(api.token, "new-device-token");
    assert.equal(captured.url, "https://gatherthread.example/v1/invitations/claim");
    assert.equal(captured.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(captured.options.body), {
      invite_token: "one-use-invitation-secret-that-is-long",
      display_name: "New User",
      device_name: "Work laptop",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime ticket is carried by WebSocket subprotocol and never placed in the URL", async () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const sockets = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {
    ticket: "one-use-ticket-secret",
    websocket_url: "/v1/ws",
    expires_at: "2026-08-25T00:00:30.000Z",
  } }), { status: 201, headers: { "content-type": "application/json" } });
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    close() {}
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example", token: "member-token" });
    await api.openRealtime({
      sessionId: "s1",
      afterSequence: 0,
      onEvent() {},
      onState() {},
    });
    assert.equal(sockets[0].url, "wss://gatherthread.example/v1/ws");
    assert.equal(new URL(sockets[0].url).search, "");
    assert.deepEqual(sockets[0].protocols, ["gatherthread-v1", "gatherthread-ticket.one-use-ticket-secret"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});
