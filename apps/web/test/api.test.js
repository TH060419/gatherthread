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

test("Agent requests carry the selected model and reasoning profile on the production wire", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return Response.json({ data: { event: {
      id: "e1", session_id: "s1", sequence: 1, idempotency_key: "agent-request-0001",
      type: "agent_request", actor_user_id: "u1", actor_display_name: "Alice",
      created_at: "2026-08-29T00:00:00.000Z", visibility: "session", reply_to_event_id: null,
      payload: { content: "Inspect this", execution_profile: { harness: "codex", model: "gpt-5.6-terra", reasoning_effort: "high" } },
    } } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    await api.appendAgentRequest("s1", {
      content: "Inspect this",
      idempotencyKey: "agent-request-0001",
      executionProfile: { harness: "codex", model: "gpt-5.6-terra", reasoningEffort: "high" },
    });
    assert.equal(captured.url, "https://gatherthread.example/v1/sessions/s1/events");
    assert.deepEqual(JSON.parse(captured.options.body).payload.execution_profile, {
      harness: "codex",
      model: "gpt-5.6-terra",
      reasoning_effort: "high",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek Harness requests target one exact runtime without Codex fallback or credentials", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return Response.json({ data: { event: {
      id: "e-dsh", session_id: "s1", sequence: 2, idempotency_key: "agent-request-dsh-0001",
      type: "agent_request", actor_user_id: "u1", actor_display_name: "Alice",
      created_at: "2026-09-06T00:00:00.000Z", visibility: "session", reply_to_event_id: null,
      payload: {
        content: "Inspect this with DSH",
        execution_profile: {
          harness: "deepseek-harness",
          provider: "Local Provider",
          model: "CaseSensitive/Model-X",
          runtime_id: "runtime-dsh-1",
        },
      },
    } } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    await api.appendAgentRequest("s1", {
      content: "Inspect this with DSH",
      idempotencyKey: "agent-request-dsh-0001",
      executionProfile: {
        harness: "deepseek-harness",
        provider: "Local Provider",
        model: "CaseSensitive/Model-X",
        runtimeId: "runtime-dsh-1",
      },
    });
    assert.equal(captured.url, "https://gatherthread.example/v1/sessions/s1/events");
    assert.equal(captured.options.credentials, "include");
    assert.equal(captured.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(captured.options.body).payload.execution_profile, {
      harness: "deepseek-harness",
      provider: "Local Provider",
      model: "CaseSensitive/Model-X",
      runtime_id: "runtime-dsh-1",
    });
    assert.doesNotMatch(captured.options.body, /reasoning|token|authorization/iu);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek Harness discovery, pairing approval, and revocation use Cookie-authenticated server routes", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { data: { runtimes: [{
      id: "runtime-dsh-1", device_id: "device-dsh-1", harness: "deepseek-harness",
      provider: "Local Provider", model: "CaseSensitive/Model-X", status: "online",
      last_seen_at: "2026-09-06T00:00:00.000Z",
    }] } },
    { data: { pairing: {
      pairing_id: "dshp-one-use", user_code: "ABCD-2345", device_name: "Studio DSH",
      expires_at: "2026-09-06T00:05:00.000Z", status: "approved",
    } } },
    undefined,
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const body = responses.shift();
    return body === undefined
      ? new Response(null, { status: 204 })
      : Response.json(body);
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    const runtimes = await api.listSessionRuntimes("session / one");
    assert.deepEqual(runtimes, [{
      id: "runtime-dsh-1", deviceId: "device-dsh-1", harness: "deepseek-harness",
      provider: "Local Provider", model: "CaseSensitive/Model-X", status: "online",
      lastSeenAt: "2026-09-06T00:00:00.000Z",
    }]);
    assert.equal((await api.approveDshPairing("ABCD-2345")).status, "approved");
    await api.revokeDevice("device / dsh");
    assert.deepEqual(requests.map(({ url, options }) => [options.method ?? "GET", url]), [
      ["GET", "https://gatherthread.example/v1/sessions/session%20%2F%20one/runtimes"],
      ["POST", "https://gatherthread.example/v1/dsh-pairings/approve"],
      ["DELETE", "https://gatherthread.example/v1/devices/device%20%2F%20dsh"],
    ]);
    assert.deepEqual(JSON.parse(requests[1].options.body), { user_code: "ABCD-2345" });
    assert.ok(requests.every(({ options }) => options.credentials === "include"));
    assert.ok(requests.every(({ options }) => options.headers.Authorization === undefined));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project participants cannot append to solo sessions", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  api.currentUser = { id: "user-maya", username: "Maya Ortiz" };
  await assert.rejects(
    () => api.appendHumanChat("session-notes", { content: "should fail", idempotencyKey: "forbidden" }),
    (error) => error.status === 403 && error.code === "forbidden",
  );
});

test("created sessions retain explicit solo or multi mode", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const created = await api.createSession("project-orbit", { name: "New multi", mode: "multi" });
  const detail = await api.getSession(created.id);
  assert.equal(detail.mode, "multi");
  assert.equal(detail.members[0].role, "owner");
});

test("mock project creation leaves an empty project until the owner creates a session", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const project = await api.createProject({ name: "New research" });
  const sessions = await api.listProjectSessions(project.id);
  assert.equal(project.sessionCount, 0);
  assert.deepEqual(sessions, []);
});

test("mock project rename updates project summaries and is creator-only", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const project = await api.createProject({ name: "Before" });
  const renamed = await api.renameProject(project.id, {
    name: "After 🚀",
    idempotencyKey: "rename-project-0001",
  });
  assert.equal(renamed.name, "After 🚀");
  assert.equal((await api.listProjects()).find((item) => item.id === project.id)?.name, "After 🚀");
  api.projects.find((item) => item.id === project.id).role = "participant";
  await assert.rejects(() => api.renameProject(project.id, {
    name: "Denied",
    idempotencyKey: "rename-project-denied-0001",
  }), (error) => error.status === 404);
});

test("mock session rename updates summaries and publishes metadata without the previous name", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const project = await api.createProject({ name: "New research" });
  const session = await api.createSession(project.id, { name: "Before", mode: "multi" });
  const received = [];
  const socket = await api.openRealtime({
    sessionId: session.id,
    afterSequence: 0,
    onEvent: (event) => received.push(event),
    onState: () => {},
  });
  try {
    const renamed = await api.renameSession(session.id, {
      name: "After 🚀",
      idempotencyKey: "rename-session-0001",
    });
    assert.equal(renamed.name, "After 🚀");
    assert.equal((await api.listProjectSessions(project.id))[0].name, "After 🚀");
    assert.deepEqual(received.at(-1).payload, { action: "renamed", title: "After 🚀" });
    assert.equal(JSON.stringify(received.at(-1).payload).includes("Before"), false);
  } finally {
    socket.close();
  }
});

test("mock project creator can switch an owned session between multi and solo", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const updated = await api.updateSession("session-orbit", {
    name: "Project Orbit",
    mode: "solo",
    idempotencyKey: "session-mode-0001",
  });
  assert.equal(updated.mode, "solo");
  assert.equal((await api.listProjectSessions("project-orbit")).find((session) => session.id === "session-orbit")?.mode, "solo");
});

test("mock project, session, and rename titles reject C0/C1 controls but keep Unicode", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const project = await api.createProject({ name: "量子项目 🚀" });
  const session = await api.createSession(project.id, { name: "Unicode 会话", mode: "multi" });
  assert.equal((await api.renameSession(session.id, {
    name: "重命名 🚀",
    idempotencyKey: "unicode-rename-0001",
  })).name, "重命名 🚀");
  for (const [index, name] of ["line\nbreak", "nul\u0000byte", "c1\u0085control"].entries()) {
    await assert.rejects(() => api.createProject({ name }), (error) => error.status === 422);
    await assert.rejects(() => api.createSession(project.id, { name, mode: "multi" }), (error) => error.status === 422);
    await assert.rejects(() => api.renameSession(session.id, {
      name,
      idempotencyKey: `control-rename-${index}`,
    }), (error) => error.status === 422);
  }
});

test("HTTP session rename uses the existing PATCH contract", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return Response.json({ data: {
      session: {
        id: "s1", project_id: "p1", title: "After", mode: "multi", state: "active",
        updated_at: "2026-08-25T10:00:00.000Z",
      },
      event: { id: "e1" },
    } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    const renamed = await api.renameSession("s1", { name: "After", idempotencyKey: "rename-session-0001" });
    assert.equal(renamed.name, "After");
    assert.equal(captured.url, "https://gatherthread.example/v1/sessions/s1");
    assert.equal(captured.options.method, "PATCH");
    assert.deepEqual(JSON.parse(captured.options.body), {
      title: "After",
      idempotency_key: "rename-session-0001",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP session settings update title and mode through one PATCH", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return Response.json({ data: {
      session: {
        id: "s1", project_id: "p1", title: "After", mode: "solo", state: "active",
        updated_at: "2026-08-25T10:00:00.000Z",
      },
      event: { id: "e1" },
    } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    const updated = await api.updateSession("s1", {
      name: "After", mode: "solo", idempotencyKey: "session-settings-0001",
    });
    assert.equal(updated.mode, "solo");
    assert.equal(captured.options.method, "PATCH");
    assert.deepEqual(JSON.parse(captured.options.body), {
      title: "After",
      mode: "solo",
      idempotency_key: "session-settings-0001",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP project rename uses the project PATCH contract", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return Response.json({ data: { project: {
      id: "p1", title: "After", state: "active", updated_at: "2026-08-25T10:00:00.000Z",
    } } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    const renamed = await api.renameProject("p1", { name: "After", idempotencyKey: "rename-project-0001" });
    assert.equal(renamed.name, "After");
    assert.equal(captured.url, "https://gatherthread.example/v1/projects/p1");
    assert.equal(captured.options.method, "PATCH");
    assert.deepEqual(JSON.parse(captured.options.body), {
      title: "After",
      idempotency_key: "rename-project-0001",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP cloud deletion uses bodyless DELETE routes", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push([String(url), options]);
    return new Response(null, { status: 204 });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    await api.deleteSession("session / one");
    await api.deleteProject("project / one");
    assert.deepEqual(requests.map(([url, options]) => [url, options.method, options.body]), [
      ["https://gatherthread.example/v1/sessions/session%20%2F%20one", "DELETE", undefined],
      ["https://gatherthread.example/v1/projects/project%20%2F%20one", "DELETE", undefined],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mock cloud deletion allows session or project creators and clears only cloud state", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const project = await api.createProject({ name: "Deletion" });
  const ownerSession = await api.createSession(project.id, { name: "Owner session", mode: "multi" });
  api.currentUser = { id: "user-maya", username: "Maya Ortiz" };
  api.projects.find((item) => item.id === project.id).role = "participant";
  await assert.rejects(() => api.deleteSession(ownerSession.id), (error) => error.status === 404);
  await assert.rejects(() => api.deleteProject(project.id), (error) => error.status === 404);

  const participantSession = await api.createSession(project.id, { name: "Participant Solo", mode: "solo" });
  await api.appendHumanChat(participantSession.id, { content: "Cloud history", idempotencyKey: "delete-cloud-history" });
  await api.deleteSession(participantSession.id);
  await assert.rejects(() => api.getSession(participantSession.id), (error) => error.status === 404);
  assert.deepEqual((await api.listProjectSessions(project.id)).map((session) => session.id), [ownerSession.id]);

  api.currentUser = { id: "user-avery", username: "Avery Chen" };
  api.projects.find((item) => item.id === project.id).role = "owner";
  await api.deleteProject(project.id);
  await assert.rejects(() => api.getProject(project.id), (error) => error.status === 404);
});

test("snapshot API creates independent frozen jobs and polls one record", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const record = {
    id: "snapshot-1",
    session_id: "s1",
    requested_by_user_id: "u1",
    through_sequence: 17,
    status: "pending",
    claimed_by_runtime_id: null,
    target_runtime_id: null,
    created_at: "2026-08-25T10:00:00.000Z",
    claimed_at: null,
    completed_at: null,
    failed_at: null,
    result: null,
    failure: null,
  };
  const responses = [
    { data: { snapshot_request: record } },
    { data: { snapshot_request: { ...record, id: "snapshot-2" } } },
    { data: { snapshot_request: { ...record, id: "snapshot-3", kind: "local_sync_status", target_runtime_id: "runtime-1" } } },
    { data: { snapshot_request: { ...record, status: "completed", result: { thread_id: "local-codex-task" } } } },
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return Response.json(responses.shift());
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    assert.equal((await api.createSnapshotRequest("s1")).throughSequence, 17);
    assert.equal((await api.createSnapshotRequest("s1", "visible_history_replace")).id, "snapshot-2");
    assert.equal((await api.createSnapshotRequest("s1", "local_sync_status", "runtime-1")).targetRuntimeId, "runtime-1");
    assert.equal((await api.getSnapshotRequest("snapshot-1")).localTaskName, "local-codex-task");
    assert.deepEqual(requests.map((request) => [request.options.method ?? "GET", request.url]), [
      ["POST", "https://gatherthread.example/v1/sessions/s1/snapshot-requests"],
      ["POST", "https://gatherthread.example/v1/sessions/s1/snapshot-requests"],
      ["POST", "https://gatherthread.example/v1/sessions/s1/snapshot-requests"],
      ["GET", "https://gatherthread.example/v1/snapshot-requests/snapshot-1"],
    ]);
    assert.deepEqual(JSON.parse(requests[0].options.body), { kind: "immutable" });
    assert.deepEqual(JSON.parse(requests[1].options.body), { kind: "visible_history_replace" });
    assert.deepEqual(JSON.parse(requests[2].options.body), { kind: "local_sync_status", target_runtime_id: "runtime-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("snapshot list requests one session and restores its newest active jobs after a page refresh", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  const record = {
    session_id: "s1",
    requested_by_user_id: "u1",
    through_sequence: 23,
    claimed_by_runtime_id: null,
    created_at: "2026-08-25T10:00:00.000Z",
    claimed_at: null,
    completed_at: null,
    failed_at: null,
    result: null,
    failure: null,
  };
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return Response.json({ data: { snapshot_requests: [
      { ...record, id: "snapshot-queued", status: "pending", created_at: "2026-08-25T10:01:00.000Z" },
      { ...record, id: "snapshot-other", session_id: "s2", status: "claimed", created_at: "2026-08-25T10:03:00.000Z" },
      { ...record, id: "snapshot-claimed", status: "claimed", created_at: "2026-08-25T10:02:00.000Z" },
    ] } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    const requests = await api.listSnapshotRequests({ sessionId: "s1", limit: 40 });
    assert.deepEqual(requests.map((request) => [request.id, request.status]), [
      ["snapshot-claimed", "claimed"],
      ["snapshot-queued", "queued"],
    ]);
    assert.equal(captured.url, "https://gatherthread.example/v1/snapshot-requests?session_id=s1&limit=40");
    assert.equal(captured.options.method, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP client normalizes the production v1 envelope and canonical event shape", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { data: { actor: { id: "u1", username: "Alice", device_id: "d1" }, expires_at: "2026-08-26T00:00:00.000Z" } },
    { data: { sessions: [{ id: "s1", title: "Shared", mode: "multi", state: "active", role: "owner", current_sequence: 2, member_count: 1, updated_at: "2026-08-25T00:00:00.000Z" }] } },
    { data: { members: [{ user_id: "u1", display_name: "Alice", role: "owner", runtime: { id: "r1", status: "online", harness: "Codex", provider: "OpenAI", model: "gpt-5.6-sol", capture_fidelity: "harness_transcript" } }] } },
    { data: { events: [{ id: "e2", session_id: "s1", sequence: 2, type: "agent_response", actor_user_id: "u1", actor_display_name: "Frozen Alice", created_at: "2026-08-25T00:00:01.000Z", reply_to_event_id: "e1", payload: { content: "done" }, runtime_provenance: { harness: "Codex", provider: "OpenAI", model: "gpt-5.6-sol", capture_fidelity: "harness_transcript" } }], cursor: 2, has_more: false } },
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
    assert.equal(replay.events[0].actor.username, "Frozen Alice");
    assert.equal(replay.events[0].provenance.username, "Frozen Alice");
    assert.equal(replay.events[0].provenance.fidelity, "harness_transcript");
    assert.equal(replay.events[0].replyTo, "e1");
    assert.equal(replay.next_after_sequence, 2);
    assert.equal(requests[0].url, "https://gatherthread.example/v1/browser-sessions");
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.credentials, "include");
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret-token");
    assert.equal(api.token, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP project API groups sessions and updates member roles at the project boundary", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const timestamp = "2026-08-25T00:00:00.000Z";
  const responses = [
    { data: { projects: [{ id: "p1", title: "Alpha", state: "active", role: "owner", session_count: 1, updated_at: timestamp }] } },
    { data: { project: { id: "p1", title: "Alpha", state: "active", updated_at: timestamp }, role: "owner" } },
    { data: { sessions: [{ id: "s1", project_id: "p1", title: "Build", mode: "multi", state: "active", role: "owner", current_sequence: 1, member_count: 2, updated_at: timestamp }] } },
    { data: { members: [{ user_id: "u1", display_name: "Alice", role: "owner" }, { user_id: "u2", display_name: "Bob", role: "participant" }] } },
    { data: { member: { user_id: "u2", display_name: "Bob", role: "viewer" } } },
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return Response.json(responses.shift());
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    assert.equal((await api.listProjects())[0].name, "Alpha");
    assert.equal((await api.getProject("p1")).role, "owner");
    assert.equal((await api.listProjectSessions("p1"))[0].projectId, "p1");
    assert.equal((await api.listProjectMembers("p1"))[1].username, "Bob");
    assert.equal((await api.setProjectMemberRole("p1", "u2", "viewer")).role, "viewer");
    assert.deepEqual(requests.map((item) => [item.options.method ?? "GET", item.url]), [
      ["GET", "https://gatherthread.example/v1/projects"],
      ["GET", "https://gatherthread.example/v1/projects/p1"],
      ["GET", "https://gatherthread.example/v1/projects/p1/sessions"],
      ["GET", "https://gatherthread.example/v1/projects/p1/members"],
      ["PUT", "https://gatherthread.example/v1/projects/p1/members/u2"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP invitation API uses exact routes, keeps secrets out of list records, and adopts claimed credentials in memory", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const record = {
    id: "i1",
    project_id: "p1",
    inviter_user_id: "owner",
    role: "participant",
    created_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2099-08-26T00:00:00.000Z",
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
    assert.equal((await api.acceptInvitation("existing-secret")).invitation.projectId, "p1");

    assert.deepEqual(requests.map((request) => [request.options.method ?? "GET", request.url]), [
      ["POST", "https://gatherthread.example/v1/projects/s1/invitations"],
      ["GET", "https://gatherthread.example/v1/projects/s1/invitations"],
      ["DELETE", "https://gatherthread.example/v1/projects/s1/invitations/i1"],
      ["POST", "https://gatherthread.example/v1/invitations/accept"],
    ]);
    assert.deepEqual(JSON.parse(requests[0].options.body), { role: "participant", ttl: "7d" });
    assert.deepEqual(JSON.parse(requests[3].options.body), { invite_token: "existing-secret" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new-user invitation claim requests a browser session without retaining the returned device credential", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ data: {
      actor: { user_id: "new-user", display_name: "New User", device_id: "new-device" },
      token: "new-device-token",
      invitation: {
        id: "i1",
        project_id: "p1",
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
    assert.equal(claimed.accessToken, "new-device-token");
    assert.equal(api.token, "");
    assert.equal(captured.url, "https://gatherthread.example/v1/invitations/claim");
    assert.equal(captured.options.headers.Authorization, undefined);
    assert.equal(captured.options.headers["X-GatherThread-Browser-Session"], "1");
    assert.equal(captured.options.credentials, "include");
    assert.deepEqual(JSON.parse(captured.options.body), {
      invite_token: "one-use-invitation-secret-that-is-long",
      display_name: "New User",
      device_name: "Work laptop",
      remember_device: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser login sends the remember-device choice without retaining the bearer", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ data: {
      actor: { id: "u1", username: "Alice", device_id: "d1" },
      expires_at: "2026-09-29T00:00:00.000Z",
    } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    await api.authenticate("device-token", { rememberDevice: true });
    assert.deepEqual(JSON.parse(captured.options.body), { remember_device: true });
    assert.equal(captured.options.headers.Authorization, "Bearer device-token");
    assert.equal(api.token, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP client restores and revokes an HttpOnly browser session without JavaScript token storage", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    new Response(JSON.stringify({ data: { id: "u1", username: "Alice", device_id: "d1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  ];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return responses.shift();
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    assert.equal((await api.restoreSession()).username, "Alice");
    await api.logout();
    assert.equal(await api.restoreSession(), null);
    assert.deepEqual(requests.map((request) => [request.options.method ?? "GET", request.url]), [
      ["GET", "https://gatherthread.example/v1/me"],
      ["DELETE", "https://gatherthread.example/v1/browser-sessions/current"],
      ["GET", "https://gatherthread.example/v1/me"],
    ]);
    assert.ok(requests.every((request) => request.options.credentials === "include"));
    assert.ok(requests.every((request) => request.options.headers.Authorization === undefined));
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
