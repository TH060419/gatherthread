import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpCollaborationClient,
  type RuntimeRegistration,
} from "../src/index.js";

test("HTTP client matches the collaboration server v1 wire contract", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const responses: unknown[] = [
    { data: { sessions: [{ id: "s1", title: "Demo", mode: "multi", state: "active", role: "owner", current_sequence: 2, updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { events: [wireEvent("e1", 1)], cursor: 1, has_more: false } },
    { data: { event: wireEvent("e2", 2) } },
    { data: { runtime: wireRuntime() } },
    { data: { request_event_id: "request-1", runtime_id: "runtime-1", status: "claimed" } },
    { data: { event: wireEvent("response-1", 3, wireProvenance()) } },
  ];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return Response.json(responses.shift());
  };
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1/",
    bearerToken: "secret-token",
    fetch,
  });

  assert.equal((await client.listSessions())[0]?.latestSequence, 2);
  assert.equal((await client.readEvents("s1", 0)).events[0]?.sessionId, "s1");
  await client.appendEvent("s1", {
    type: "human_chat",
    idempotencyKey: "chat-key-0001",
    payload: { text: "hello" },
  });
  const runtime = await client.registerRuntime(runtimeRegistration());
  assert.equal(runtime.id, "runtime-1");
  assert.equal((await client.claimAgentRequest("s1", "request-1", runtime.id)).claimed, true);
  const completed = await client.completeAgentRequest("s1", "request-1", {
    runtimeId: runtime.id,
    idempotencyKey: "complete-key-0001",
    payload: { text: "done" },
  });
  assert.equal(completed.runtime?.captureFidelity, "harness_transcript");

  assert.deepEqual(requests.map((item) => item.url), [
    "https://collab.example/v1/sessions",
    "https://collab.example/v1/sessions/s1/events?after_sequence=0&limit=200",
    "https://collab.example/v1/sessions/s1/events",
    "https://collab.example/v1/runtimes",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/claim",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/complete",
  ]);
  assert.deepEqual(JSON.parse(String(requests[2]?.init.body)), {
    type: "human_chat",
    idempotency_key: "chat-key-0001",
    payload: { text: "hello" },
    visibility: "session",
  });
  assert.equal(JSON.parse(String(requests[3]?.init.body)).capture_fidelity, "harness_transcript");
  assert.equal(requests[0]?.init.headers && new Headers(requests[0].init.headers).get("authorization"), "Bearer secret-token");
});

function runtimeRegistration(): RuntimeRegistration {
  return {
    sessionId: "s1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    localSessionId: "local-1",
    captureFidelity: "harness_transcript",
  };
}

function wireRuntime() {
  return {
    id: "runtime-1",
    session_id: "s1",
    user_id: "u1",
    device_id: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    local_session_id: "local-1",
    capture_fidelity: "harness_transcript",
  };
}

function wireProvenance() {
  return {
    user_id: "u1",
    device_id: "device-1",
    runtime_id: "runtime-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    local_session_id: "local-1",
    capture_fidelity: "harness_transcript",
  };
}

function wireEvent(id: string, sequence: number, runtime: unknown = null) {
  return {
    id,
    session_id: "s1",
    sequence,
    idempotency_key: `event-key-${sequence}`,
    type: "human_chat",
    actor_user_id: "u1",
    created_at: "2026-08-25T00:00:00.000Z",
    visibility: "session",
    reply_to_event_id: null,
    payload: { text: "hello" },
    runtime_provenance: runtime,
  };
}
