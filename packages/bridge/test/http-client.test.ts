import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpCollaborationClient,
  CollaborationHttpError,
  type RuntimeRegistration,
} from "../src/index.js";

test("HTTP client matches the collaboration server v1 wire contract", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const responses: unknown[] = [
    { data: { id: "u1", username: "Alice", device_id: "device-1" } },
    { data: { projects: [{ id: "p1", title: "Demo project", state: "active", role: "owner", session_count: 1, created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { sessions: [{ id: "s1", project_id: "p1", title: "Demo", mode: "multi", state: "active", role: "owner", current_sequence: 2, updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { sessions: [{ id: "s1", project_id: "p1", title: "Demo", mode: "multi", state: "active", role: "owner", current_sequence: 2, updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { session: { id: "s1", project_id: "p1", title: "Renamed", mode: "multi", state: "active", role: "owner", current_sequence: 3 } } },
    { data: { events: [wireEvent("e1", 1)], cursor: 1, has_more: false } },
    { data: { event: wireEvent("e2", 2) } },
    { data: { runtime: wireRuntime() } },
    { data: { runtime: wireRuntime() } },
    { data: { request_event_id: "request-1", runtime_id: "runtime-1", status: "claimed" } },
    { data: { event: wireEvent("response-1", 3, wireProvenance()) } },
    { data: {
      local_turn_id: "codex-local-1",
      runtime_id: "runtime-1",
      head_before_commit: 3,
      reconciliation_required: false,
      request_event: wireEvent("local-request-1", 4, wireProvenance()),
      response_event: wireEvent("local-response-1", 5, wireProvenance()),
      tool_events: [],
    } },
    { data: { snapshot_request: wireSnapshotRequest("snapshot-created") } },
    { data: { snapshot_request: wireSnapshotRequest("snapshot-1") } },
    { data: { snapshot_requests: [wireSnapshotRequest("snapshot-1")] } },
    { data: { snapshot_request: wireSnapshotRequest("snapshot-1", "claimed") } },
    { data: { snapshot_request: wireSnapshotRequest("snapshot-1", "completed") } },
    { data: { snapshot_request: wireSnapshotRequest("snapshot-1", "failed") } },
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

  assert.deepEqual(await client.getCurrentActor(), {
    id: "u1",
    displayName: "Alice",
    deviceId: "device-1",
  });
  assert.equal((await client.listProjects())[0]?.name, "Demo project");
  assert.equal((await client.listProjectSessions("p1"))[0]?.projectId, "p1");
  assert.equal((await client.listSessions())[0]?.latestSequence, 2);
  assert.equal((await client.updateSession("s1", { title: "Renamed", idempotencyKey: "rename-key-0001" })).name, "Renamed");
  assert.equal((await client.readEvents("s1", 0)).events[0]?.sessionId, "s1");
  await client.appendEvent("s1", {
    type: "human_chat",
    idempotencyKey: "chat-key-0001",
    payload: { text: "hello" },
  });
  const runtime = await client.registerRuntime(runtimeRegistration());
  assert.equal(runtime.id, "runtime-1");
  assert.equal(runtime.purpose, "execution");
  assert.equal((await client.heartbeatRuntime(runtime.id)).id, "runtime-1");
  assert.equal((await client.claimAgentRequest("s1", "request-1", runtime.id)).claimed, true);
  const completed = await client.completeAgentRequest("s1", "request-1", {
    runtimeId: runtime.id,
    idempotencyKey: "complete-key-0001",
    payload: { text: "done" },
  });
  assert.equal(completed.runtime?.captureFidelity, "harness_transcript");
  const committed = await client.commitLocalTurn("s1", {
    localTurnId: "codex-local-1",
    runtimeId: runtime.id,
    basedOnSequence: 3,
    occurredAt: "2026-08-25T00:00:03.000Z",
    observedModel: "gpt-5.6-terra",
    observedReasoningEffort: "high",
    requestPayload: { text: "local request" },
    responsePayload: { text: "local response" },
    toolEvents: [{
      type: "tool_call",
      payload: { tool_name: "command_execution", tool_call_id: "command:1", arguments: { command: "npm test" } },
      occurred_at: "2026-08-25T00:00:03.500Z",
    }],
  });
  assert.equal(committed.headBeforeCommit, 3);
  assert.equal(committed.reconciliationRequired, false);
  assert.equal((await client.createSnapshotRequest("s1")).id, "snapshot-created");
  const snapshot = await client.getSnapshotRequest("snapshot-1");
  assert.equal(snapshot.throughSequence, 5);
  assert.equal(snapshot.createdAt, "2026-08-25T00:00:00.000Z");
  assert.equal((await client.listSnapshotRequests("pending", 10))[0]?.id, "snapshot-1");
  assert.equal((await client.claimSnapshotRequest("snapshot-1", runtime.id)).status, "claimed");
  assert.equal((await client.completeSnapshotRequest("snapshot-1", runtime.id, {
    thread_id: "snapshot-thread",
    thread_name: "GatherThread snapshot · Demo · through 5",
  })).status, "completed");
  const failedSnapshot = await client.failSnapshotRequest("snapshot-1", runtime.id, { code: "projection_failed", message: "failed" });
  assert.deepEqual(failedSnapshot.failure, { code: "projection_failed", message: "failed" });

  assert.deepEqual(requests.map((item) => item.url), [
    "https://collab.example/v1/me",
    "https://collab.example/v1/projects",
    "https://collab.example/v1/projects/p1/sessions",
    "https://collab.example/v1/sessions",
    "https://collab.example/v1/sessions/s1",
    "https://collab.example/v1/sessions/s1/events?after_sequence=0&limit=200",
    "https://collab.example/v1/sessions/s1/events",
    "https://collab.example/v1/runtimes",
    "https://collab.example/v1/runtimes/runtime-1/heartbeat",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/claim",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/complete",
    "https://collab.example/v1/sessions/s1/local-turns",
    "https://collab.example/v1/sessions/s1/snapshot-requests",
    "https://collab.example/v1/snapshot-requests/snapshot-1",
    "https://collab.example/v1/snapshot-requests?status=pending&limit=10",
    "https://collab.example/v1/snapshot-requests/snapshot-1/claim",
    "https://collab.example/v1/snapshot-requests/snapshot-1/complete",
    "https://collab.example/v1/snapshot-requests/snapshot-1/fail",
  ]);
  assert.equal(requests[4]?.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[4]?.init.body)), {
    title: "Renamed",
    idempotency_key: "rename-key-0001",
  });
  assert.deepEqual(JSON.parse(String(requests[6]?.init.body)), {
    type: "human_chat",
    idempotency_key: "chat-key-0001",
    payload: { text: "hello" },
    visibility: "session",
  });
  assert.equal(JSON.parse(String(requests[7]?.init.body)).capture_fidelity, "harness_transcript");
  assert.equal(JSON.parse(String(requests[7]?.init.body)).purpose, "execution");
  assert.equal(requests[0]?.init.headers && new Headers(requests[0].init.headers).get("authorization"), "Bearer secret-token");
  assert.equal(requests[0]?.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(requests[11]?.init.body)), {
    local_turn_id: "codex-local-1",
    runtime_id: "runtime-1",
    based_on_sequence: 3,
    occurred_at: "2026-08-25T00:00:03.000Z",
    observed_model: "gpt-5.6-terra",
    observed_reasoning_effort: "high",
    request_payload: { text: "local request" },
    response_payload: { text: "local response" },
    tool_events: [{
      type: "tool_call",
      payload: { tool_name: "command_execution", tool_call_id: "command:1", arguments: { command: "npm test" } },
      occurred_at: "2026-08-25T00:00:03.500Z",
    }],
  });
  assert.deepEqual(JSON.parse(String(requests[16]?.init.body)), {
    runtime_id: "runtime-1",
    result: {
      thread_id: "snapshot-thread",
      thread_name: "GatherThread snapshot · Demo · through 5",
    },
  });
});

test("HTTP client redacts its bearer credential from server errors", async () => {
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1",
    bearerToken: "secret-token",
    fetch: async () => Response.json({ error: { code: "unauthorized", message: "rejected secret-token" } }, { status: 401 }),
  });
  await assert.rejects(client.listSessions(), (error: unknown) => {
    assert.ok(error instanceof CollaborationHttpError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthorized");
    assert.equal(error.message, "Collaboration API 401: rejected [REDACTED]");
    return true;
  });
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
    purpose: "execution",
  };
}

function wireSnapshotRequest(id: string, status = "pending") {
  return {
    id,
    session_id: "s1",
    through_sequence: 5,
    status,
    created_at: "2026-08-25T00:00:00.000Z",
    ...(status === "failed" ? { failure: { code: "projection_failed", message: "failed" } } : {}),
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
