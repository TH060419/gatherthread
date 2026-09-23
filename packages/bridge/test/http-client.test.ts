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
    { data: { members: [{ user_id: "u1", display_name: "Alice", role: "owner", runtime: { id: "r1", device_id: "private", local_session_id: "private", purpose: "execution", harness: "codex", provider: "openai", model: "gpt-5.6-sol", status: "online" } }] } },
    { data: { sessions: [{ id: "s1", project_id: "p1", title: "Demo", mode: "multi", state: "active", role: "owner", current_sequence: 2, updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { session: { id: "s1", project_id: "p1", title: "Renamed", mode: "multi", state: "active", role: "owner", current_sequence: 3 } } },
    { data: { events: [wireEvent("e1", 1)], cursor: 1, has_more: false } },
    { data: { event: wireEvent("e2", 2) } },
    { data: { runtime: wireRuntime() } },
    { data: { runtime: wireRuntime() } },
    { data: { request_event_id: "request-1", runtime_id: "runtime-1", status: "claimed", attempt_count: 2 } },
    { data: { event: wireEvent("progress-1", 3, wireProvenance()) } },
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
  assert.deepEqual((await client.listSessionMembers("s1"))[0], {
    displayName: "Alice",
    role: "owner",
    runtime: { purpose: "execution", harness: "codex", provider: "openai", model: "gpt-5.6-sol", status: "online" },
  });
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
  assert.deepEqual(runtime.executionProfiles, [{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
  }]);
  assert.equal((await client.heartbeatRuntime(runtime.id)).id, "runtime-1");
  assert.equal((await client.claimAgentRequest("s1", "request-1", runtime.id)).attemptCount, 2);
  const progress = await client.appendAgentProgress("s1", "request-1", {
    runtimeId: runtime.id,
    claimAttempt: 2,
    idempotencyKey: "progress-key-0001",
    payload: { content: "Checking files" },
  });
  assert.equal(progress.runtime?.captureFidelity, "harness_transcript");
  const completed = await client.completeAgentRequest("s1", "request-1", {
    runtimeId: runtime.id,
    claimAttempt: 2,
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
    "https://collab.example/v1/sessions/s1/members",
    "https://collab.example/v1/sessions",
    "https://collab.example/v1/sessions/s1",
    "https://collab.example/v1/sessions/s1/events?after_sequence=0&limit=200",
    "https://collab.example/v1/sessions/s1/events",
    "https://collab.example/v1/runtimes",
    "https://collab.example/v1/runtimes/runtime-1/heartbeat",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/claim",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/progress",
    "https://collab.example/v1/sessions/s1/agent-requests/request-1/complete",
    "https://collab.example/v1/sessions/s1/local-turns",
    "https://collab.example/v1/sessions/s1/snapshot-requests",
    "https://collab.example/v1/snapshot-requests/snapshot-1",
    "https://collab.example/v1/snapshot-requests?status=pending&limit=10",
    "https://collab.example/v1/snapshot-requests/snapshot-1/claim",
    "https://collab.example/v1/snapshot-requests/snapshot-1/complete",
    "https://collab.example/v1/snapshot-requests/snapshot-1/fail",
  ]);
  assert.equal(requests[5]?.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[5]?.init.body)), {
    title: "Renamed",
    idempotency_key: "rename-key-0001",
  });
  assert.deepEqual(JSON.parse(String(requests[7]?.init.body)), {
    type: "human_chat",
    idempotency_key: "chat-key-0001",
    payload: { text: "hello" },
    visibility: "session",
  });
  assert.equal(JSON.parse(String(requests[8]?.init.body)).capture_fidelity, "harness_transcript");
  assert.equal(JSON.parse(String(requests[8]?.init.body)).purpose, "execution");
  assert.deepEqual(JSON.parse(String(requests[8]?.init.body)).execution_profiles, [{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoning_efforts: ["low", "high"],
    default_reasoning_effort: "low",
  }]);
  assert.equal(requests[0]?.init.headers && new Headers(requests[0].init.headers).get("authorization"), "Bearer secret-token");
  assert.equal(requests[0]?.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(requests[11]?.init.body)), {
    runtime_id: "runtime-1",
    claim_attempt: 2,
    idempotency_key: "progress-key-0001",
    payload: { content: "Checking files" },
  });
  assert.deepEqual(JSON.parse(String(requests[12]?.init.body)), {
    runtime_id: "runtime-1",
    claim_attempt: 2,
    idempotency_key: "complete-key-0001",
    payload: { text: "done" },
  });
  assert.deepEqual(JSON.parse(String(requests[13]?.init.body)), {
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
  assert.deepEqual(JSON.parse(String(requests[14]?.init.body)), { kind: "immutable" });
  assert.deepEqual(JSON.parse(String(requests[18]?.init.body)), {
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

test("HTTP client rejects a malformed present claim attempt instead of treating it as legacy", async () => {
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1",
    bearerToken: "secret-token",
    fetch: async () => Response.json({
      data: {
        request_event_id: "request-1",
        runtime_id: "runtime-1",
        status: "claimed",
        attempt_count: "2",
      },
    }),
  });
  await assert.rejects(
    client.claimAgentRequest("session-1", "request-1", "runtime-1"),
    /claim\.attempt_count/,
  );
});

test("HTTP client rejects malformed advertised runtime execution profiles", async () => {
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1",
    bearerToken: "secret-token",
    fetch: async () => Response.json({ data: { runtime: {
      ...wireRuntime(),
      execution_profiles: [{
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoning_efforts: ["low"],
        default_reasoning_effort: "high",
      }],
    } } }),
  });
  await assert.rejects(client.registerRuntime(runtimeRegistration()), /default_reasoning_effort/u);
});

test("HTTP client carries the claim attempt on request-linked tool events", async () => {
  let requestBody: unknown;
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1",
    bearerToken: "secret-token",
    fetch: async (_input, init = {}) => {
      requestBody = JSON.parse(String(init.body));
      return Response.json({ data: { event: wireEvent("tool-1", 1, wireProvenance()) } });
    },
  });
  await client.appendEvent("session-1", {
    type: "tool_call",
    idempotencyKey: "tool-event-0001",
    payload: { tool_name: "shell", tool_call_id: "call-1", arguments: {} },
    replyTo: "request-1",
    runtimeId: "runtime-1",
    claimAttempt: 3,
  });
  assert.deepEqual(requestBody, {
    type: "tool_call",
    idempotency_key: "tool-event-0001",
    payload: { tool_name: "shell", tool_call_id: "call-1", arguments: {} },
    reply_to_event_id: "request-1",
    visibility: "session",
    runtime_id: "runtime-1",
    claim_attempt: 3,
  });
});

test("HTTP client creates creator-owned project solos with a stable idempotency key", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1",
    bearerToken: "secret-token",
    fetch: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return Response.json({
        data: {
          session: {
            id: "session-personal",
            project_id: "project-1",
            owner_user_id: "participant-1",
            title: "First local prompt",
            mode: "solo",
            state: "active",
            role: "participant",
            current_sequence: 1,
          },
        },
      });
    },
  });

  const session = await client.createSession("project-1", {
    sessionId: "session-dsh-native",
    title: "First local prompt",
    mode: "solo",
    idempotencyKey: "codex-solo-stable-key",
  });

  assert.equal(session.ownerUserId, "participant-1");
  assert.equal(session.role, "participant");
  assert.equal(requests[0]?.url, "https://collab.example/v1/projects/project-1/sessions");
  assert.equal(requests[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    session_id: "session-dsh-native",
    title: "First local prompt",
    mode: "solo",
    idempotency_key: "codex-solo-stable-key",
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
    executionProfiles: [{
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
    }],
  };
}

function wireSnapshotRequest(id: string, status = "pending") {
  return {
    id,
    session_id: "s1",
    kind: "immutable",
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
    execution_profiles: [{
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoning_efforts: ["low", "high"],
      default_reasoning_effort: "low",
    }],
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
test("context read HTTP preserves the project policy default, explicit views, authorization and raw history", async () => {
  const original = { kind: "original", event_id: "e1", sequence: 1, actor_user_id: "u1", content: "exact original ".repeat(500) };
  const summary = { kind: "summary", event_id: "e3", sequence: 1, actor_user_id: "u1", content: "Confirmed the original decision.", source_event_ids: ["e1"] };
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1", bearerToken: "context-user-token",
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const data = url.includes("/events?")
        ? { events: [{ ...wireEvent("e1", 1), payload: { text: original.content } }], cursor: 9, has_more: true }
        : { view: new URL(url).searchParams.get("view") === "summary" ? "summary" : "original", through_sequence: 3,
          items: [new URL(url).searchParams.get("view") === "summary" ? summary : original] };
      return new Response(JSON.stringify({ data }));
    },
  });
  assert.deepEqual(await (client as any).readContext("s1"), { view: "original", through_sequence: 3, items: [original] });
  const summarized = await (client as any).readContext("s1", "summary");
  assert.deepEqual(summarized, { view: "summary", through_sequence: 3, items: [summary] });
  assert.ok(JSON.stringify(summarized).length < original.content.length / 10);
  assert.deepEqual((await (client as any).readContext("s1", "original")).items, [original]);
  assert.equal((await client.readContext("s1", undefined, 3)).through_sequence, 3);
  assert.equal((await client.readContext("s1", "summary", 3)).through_sequence, 3);
  const raw = await client.readEvents("s1", 4, 7);
  assert.deepEqual(raw.events[0]?.payload, { text: original.content });
  assert.equal(raw.nextSequence, 9);
  assert.equal(raw.hasMore, true);
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://collab.example/v1/sessions/s1/context",
    "https://collab.example/v1/sessions/s1/context?view=summary",
    "https://collab.example/v1/sessions/s1/context?view=original",
    "https://collab.example/v1/sessions/s1/context?through_sequence=3",
    "https://collab.example/v1/sessions/s1/context?view=summary&through_sequence=3",
    "https://collab.example/v1/sessions/s1/events?after_sequence=4&limit=7",
  ]);
  for (const { init } of requests) {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer context-user-token");
    assert.equal(init?.redirect, "error");
  }
});

test("context read HTTP rejects invalid arguments before transport and unavailable or unauthorized servers without fallback", async () => {
  let requests = 0;
  let status = 404;
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1", bearerToken: "context-user-token",
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: { code: status === 403 ? "forbidden" : "not_found", message: "Not available" } }), { status });
    },
  });
  for (const sessionId of ["", " ", "../s1", "s1/other", "s1\n", "s".repeat(129), null]) {
    await assert.rejects((client as any).readContext(sessionId), /session.*identifier|session.*ID/i);
  }
  for (const view of ["raw", "", null, 1]) {
    await assert.rejects((client as any).readContext("s1", view), /view/);
  }
  for (const through of [-1, 0.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects((client as any).readContext("s1", undefined, through), /through_sequence/);
  }
  assert.equal(requests, 0);
  await assert.rejects((client as any).readContext("s1"), (error: any) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /unavailable.*not substituted/i);
    return true;
  });
  assert.equal(requests, 1);
  status = 403;
  await assert.rejects((client as any).readContext("s1", "summary"), (error: any) => error.status === 403 && error.code === "forbidden");
  assert.equal(requests, 2);
});

test("context read HTTP rejects malformed, mislabeled and oversized context instead of returning partial history", async () => {
  const item = { kind: "summary", event_id: "e3", sequence: 1, actor_user_id: "u1", content: "Summary", source_event_ids: ["e1"] };
  const valid = { view: "summary", through_sequence: 3, items: [item] };
  let payload: unknown = valid;
  const client = new HttpCollaborationClient({
    baseUrl: "https://collab.example/v1", bearerToken: "context-user-token",
    fetch: async () => new Response(JSON.stringify({ data: payload })),
  });
  for (const malformed of [
    { events: [], cursor: 3 },
    { ...valid, view: "original" },
    { ...valid, through_sequence: -1 },
    { ...valid, items: [{ ...item, sequence: 4 }] },
    { ...valid, items: [{ ...item, sequence: 1.5 }] },
    { ...valid, items: [{ ...item, content: { text: "not a string" } }] },
    { ...valid, items: [{ ...item, source_event_ids: [] }] },
    { ...valid, items: [{ ...item, source_event_ids: ["e1", "e1"] }] },
    { ...valid, items: [item, item] },
    { ...valid, items: [{ ...item, content: "x".repeat(256 * 1024) }] },
  ]) {
    payload = malformed;
    await assert.rejects((client as any).readContext("s1", "summary"), /context/i);
  }
  payload = { ...valid, view: "original" };
  await assert.rejects((client as any).readContext("s1", "original"), /context/i);
  payload = valid;
  await assert.rejects(client.readContext("s1", "summary", 2), /context/i);
  await assert.rejects(client.readContext("s1", "summary", 4), /context/i);
  payload = { ...valid, private_debug: "must not escape", items: [{ ...item, private_runtime_id: "private" }] };
  assert.deepEqual(await (client as any).readContext("s1", "summary"), valid);
  const nestedSources = Array.from({ length: 101 }, (_, index) => `ancestor-${index}`);
  payload = { ...valid, items: [{ ...item, source_event_ids: nestedSources }] };
  assert.deepEqual((await client.readContext("s1", "summary")).items[0]?.source_event_ids, nestedSources,
    "validated nested summaries may cover more than one generation's 100 direct sources");
});
