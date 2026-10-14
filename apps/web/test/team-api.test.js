import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { ExampleCollaborationApi } from "../src/example-api.js";
import { translateUiText } from "../src/i18n.js";

const teamPlan = () => ({ name: "Review team", team_prompt: "Review the agreed task.", nodes: [
  { id: "planner", label: "Planner", role: "Plan the work.", x: 100, y: 120,
    target: { kind: "local", runtime_id: "runtime:codex", harness: "codex", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "high" } },
  { id: "reviewer", label: "Reviewer", role: "Check the result.", x: 400, y: 120,
    target: { kind: "cloud", profile_id: "review-profile", provider: "siliconflow", model: "review-model", include_code: false } },
], edges: [{ id: "review", source: "planner", target: "reviewer", direction: "bidirectional" }] });

const runDetail = (overrides = {}) => ({ id: "run:1", session_id: "s:1", status: "running",
  created_at: "2026-10-12T00:00:00.000Z", deadline_at: "2026-10-12T00:30:00.000Z", finished_at: null,
  calls_used: 1, max_calls: 12, max_duration_minutes: 30, current_node_id: "planner", current_step_id: "step:1", error_code: null,
  plan: teamPlan(), content: "Implement the agreed task.", steps: [{ id: "step:1", node_id: "planner", node_label: "Planner",
    status: "running", request_event_id: "event:1", response_event_id: null, created_at: "2026-10-12T00:00:00.000Z",
    finished_at: null, parent_step_id: null }], ...overrides });

const runSummary = (run = runDetail()) => {
  const { plan: _plan, content: _content, steps: _steps, ...summary } = run;
  return summary;
};

const startInput = (overrides = {}) => ({ plan: teamPlan(), entry_node_id: "planner", content: "Implement the agreed task.",
  idempotency_key: "team-start-stable-key", ...overrides });

test("team HTTP helpers retain strict wire envelopes, encoded IDs, cookies and retry keys", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { plan: null, revision: null }, { plan: teamPlan(), revision: 1 }, { runs: [runSummary()] },
    { run: runDetail(), replayed: true }, { run: runDetail() },
    ...["pause", "resume", "stop", "continue"].map(() => ({ run: runDetail() })),
  ];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json({ data: responses[requests.length - 1] });
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example/" });
    assert.deepEqual(await api.getAgentTeamPlan("s / 1"), responses[0]);
    const save = { plan: teamPlan(), expected_revision: null };
    assert.deepEqual(await api.saveAgentTeamPlan("s / 1", save), responses[1]);
    assert.deepEqual(await api.listAgentTeamRuns("s:1"), responses[2]);
    assert.deepEqual(await api.startAgentTeamRun("s:1", startInput({ max_calls: 4, max_duration_minutes: 10 })), responses[3]);
    assert.deepEqual(await api.getAgentTeamRun("s:1", "run:1"), responses[4]);
    for (const action of ["pause", "resume", "stop", "continue"]) {
      assert.deepEqual(await api.controlAgentTeamRun("s:1", "run:1", { action, idempotency_key: `team-${action}-stable-key` }), { run: runDetail() });
    }
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method ?? "GET"]), [
      ["https://gatherthread.example/v1/sessions/s%20%2F%201/agent-team-plan", "GET"],
      ["https://gatherthread.example/v1/sessions/s%20%2F%201/agent-team-plan", "PUT"],
      ["https://gatherthread.example/v1/sessions/s%3A1/agent-team-runs", "GET"],
      ["https://gatherthread.example/v1/sessions/s%3A1/agent-team-runs", "POST"],
      ["https://gatherthread.example/v1/sessions/s%3A1/agent-team-runs/run%3A1", "GET"],
      ...Array.from({ length: 4 }, () => ["https://gatherthread.example/v1/sessions/s%3A1/agent-team-runs/run%3A1/control", "POST"]),
    ]);
    assert.ok(requests.every(({ options }) => options.credentials === "include" && options.headers.Accept === "application/json"
      && options.headers.Authorization === undefined));
    assert.deepEqual(JSON.parse(requests[1].options.body), save);
    assert.deepEqual(JSON.parse(requests[3].options.body), startInput({ max_calls: 4, max_duration_minutes: 10 }));
    for (const [index, action] of ["pause", "resume", "stop", "continue"].entries()) {
      assert.deepEqual(JSON.parse(requests[index + 5].options.body), { action, idempotency_key: `team-${action}-stable-key` });
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("team reads forward cancellation without attaching it to a later control mutation", async () => {
  const previousFetch = globalThis.fetch, requests = [];
  globalThis.fetch = (url, options) => {
    requests.push({ url, options });
    if (options.method === "POST") return Promise.resolve(Response.json({ data: { run: runDetail() } }));
    return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("Synthetic cancellation", "AbortError")), { once: true }));
  };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" });
    for (const read of [signal => api.getAgentTeamPlan("s:1", { signal }), signal => api.listAgentTeamRuns("s:1", { signal }),
      signal => api.getAgentTeamRun("s:1", "run:1", { signal })]) {
      const controller = new AbortController(), result = read(controller.signal);
      assert.equal(requests.at(-1).options.signal, controller.signal); controller.abort();
      await assert.rejects(result, error => error instanceof ApiError && error.code === "network_error");
    }
    await api.controlAgentTeamRun("s:1", "run:1", { action: "stop", idempotency_key: "stop-after-read-abort" });
    assert.equal(requests.at(-1).options.signal, undefined);
    assert.equal(JSON.parse(requests.at(-1).options.body).action, "stop");
  } finally { globalThis.fetch = previousFetch; }
});

test("team starts use bounded protocol defaults and preserve exact DSH selections", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ data: { run: runDetail(), replayed: false } });
  };
  try {
    const plan = teamPlan();
    plan.nodes[0].target = { kind: "local", runtime_id: "runtime:dsh", harness: "deepseek-harness", provider: "deepseek-official",
      model: "deepseek-v4", reasoning_effort: "max" };
    const api = new HttpCollaborationApi();
    await api.startAgentTeamRun("s:1", startInput({ plan }));
    await api.startAgentTeamRun("s:1", startInput({ plan }));
    assert.deepEqual(requests[0], { ...startInput({ plan }), max_calls: 12, max_duration_minutes: 30 });
    assert.deepEqual(requests[1], requests[0]);
  } finally { globalThis.fetch = previousFetch; }
});

test("team request validation rejects graph, budget, private fields and unknown control actions before fetch", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Fetch must not be called"); };
  try {
    const api = new HttpCollaborationApi();
    const badGraph = teamPlan(); badGraph.edges[0].target = "missing";
    const invalidInputs = [startInput({ max_calls: 0 }), startInput({ max_calls: 49 }), startInput({ max_duration_minutes: 0 }),
      startInput({ max_duration_minutes: 121 }), startInput({ entry_node_id: "missing" }), startInput({ plan: badGraph }),
      startInput({ secret_override: "private-fixture" }), startInput({ idempotency_key: "short" })];
    for (const input of invalidInputs) {
      assert.throws(() => api.startAgentTeamRun("s:1", input), (error) => error instanceof ApiError && error.code === "validation_error"
        && error.status === 422 && !error.message.includes("private-fixture"));
    }
    assert.throws(() => api.saveAgentTeamPlan("s:1", { plan: teamPlan(), expectedRevision: null }), (error) => error.code === "validation_error");
    assert.throws(() => api.controlAgentTeamRun("s:1", "run:1", { action: "restart", idempotency_key: "control-stable-key" }),
      (error) => error.code === "validation_error");
    assert.throws(() => api.controlAgentTeamRun("s:1", "run:1", { action: "stop", idempotency_key: "control-stable-key", actor_id: "other" }),
      (error) => error.code === "validation_error");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("all team response helpers fail closed on extra private fields and malformed values", async () => {
  const previousFetch = globalThis.fetch;
  let response;
  globalThis.fetch = async () => Response.json({ data: response });
  try {
    const api = new HttpCollaborationApi();
    const cases = [
      [{ plan: null, revision: null, private_source: "private-fixture" }, () => api.getAgentTeamPlan("s:1")],
      [{ plan: { ...teamPlan(), private_prompt: "private-fixture" }, revision: 1 }, () => api.saveAgentTeamPlan("s:1", { plan: teamPlan(), expected_revision: null })],
      [{ runs: [{ ...runSummary(), content: "private-fixture" }] }, () => api.listAgentTeamRuns("s:1")],
      [{ run: { ...runDetail(), requester_token: "private-fixture" }, replayed: false }, () => api.startAgentTeamRun("s:1", startInput())],
      [{ run: runDetail({ steps: [{ ...runDetail().steps[0], private_thinking: "private-fixture" }] }) }, () => api.getAgentTeamRun("s:1", "run:1")],
      [{ run: runDetail({ calls_used: 99 }) }, () => api.controlAgentTeamRun("s:1", "run:1", { action: "pause", idempotency_key: "control-stable-key" })],
    ];
    for (const [body, call] of cases) {
      response = body;
      await assert.rejects(call, (error) => {
        assert.equal(error instanceof ApiError, true);
        assert.equal(error.code, "invalid_agent_team_response");
        assert.equal(error.message, "Agent team response is invalid. Refresh and try again.");
        assert.equal(error.message.includes("private-fixture"), false);
        return true;
      });
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("team response identities cannot replace the requested session or run", async () => {
  const previousFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async () => Response.json({ data: body });
  try {
    const api = new HttpCollaborationApi();
    for (const [response, call] of [
      [{ run: runDetail({ session_id: "another-session" }), replayed: false }, () => api.startAgentTeamRun("s:1", startInput())],
      [{ run: runDetail({ session_id: "another-session" }) }, () => api.getAgentTeamRun("s:1", "run:1")],
      [{ run: runDetail({ session_id: "another-session" }) }, () => api.controlAgentTeamRun("s:1", "run:1", { action: "pause", idempotency_key: "control-stable-key" })],
    ]) {
      body = response;
      await assert.rejects(call, (error) => error.code === "invalid_agent_team_response");
    }
    body = { run: runDetail({ id: "another-run" }) };
    await assert.rejects(api.getAgentTeamRun("s:1", "run:1"), (error) => error.code === "invalid_agent_team_response");
    body = { runs: [runSummary(runDetail({ session_id: "another-session" }))] };
    await assert.rejects(api.listAgentTeamRuns("s:1"), (error) => error.code === "invalid_agent_team_response");
  } finally { globalThis.fetch = previousFetch; }
});

test("team transport errors keep stable status/code while suppressing server payloads", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const api = new HttpCollaborationApi();
    globalThis.fetch = async () => Response.json({ error: { code: "revision_conflict", message: "private-fixture", details: { secret: "private-fixture" } } }, { status: 409 });
    await assert.rejects(api.getAgentTeamPlan("s:1"), (error) => error instanceof ApiError && error.status === 409
      && error.code === "revision_conflict" && error.message === "Agent team request failed. Refresh and try again.");
    globalThis.fetch = async () => Response.json({ error: { code: "private-fixture", message: "private-fixture" } }, { status: 403 });
    await assert.rejects(api.listAgentTeamRuns("s:1"), (error) => error.code === "http_error" && !error.message.includes("private-fixture"));
    globalThis.fetch = async () => { throw new TypeError("private-fixture"); };
    await assert.rejects(api.getAgentTeamPlan("s:1"), (error) => error.code === "network_error" && !error.message.includes("private-fixture"));
    globalThis.fetch = async () => new Response("private-fixture", { status: 200 });
    await assert.rejects(api.getAgentTeamPlan("s:1"), (error) => error.code === "invalid_agent_team_response" && !error.message.includes("private-fixture"));
  } finally { globalThis.fetch = previousFetch; }
});

test("team APIs preserve the browser same-origin credential boundary", async () => {
  const previousFetch = globalThis.fetch, previousLocation = globalThis.location;
  let requests = 0;
  globalThis.location = new URL("https://gatherthread.example/app/");
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected fetch"); };
  try {
    await assert.rejects(new HttpCollaborationApi({ baseUrl: "https://other.invalid" }).getAgentTeamPlan("s:1"),
      (error) => error.code === "invalid_api_origin");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

test("mock plans are actor-private, copy-safe, revision checked and use current writer permissions", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const originalActor = api.currentUser;
  assert.deepEqual(await api.getAgentTeamPlan("session-orbit"), { plan: null, revision: null });
  const saved = await api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: null });
  assert.equal(saved.revision, 1);
  saved.plan.name = "Changed outside the store";
  assert.equal((await api.getAgentTeamPlan("session-orbit")).plan.name, "Review team");
  await assert.rejects(api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: null }),
    (error) => error.code === "revision_conflict" && error.status === 409);
  assert.equal((await api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: 1 })).revision, 2);
  const maya = api.sessions[0].members.find(member => member.userId === "user-maya");
  api.currentUser = { id: maya.userId, username: maya.username };
  assert.deepEqual(await api.getAgentTeamPlan("session-orbit"), { plan: null, revision: null });
  await api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: null });
  await assert.rejects(api.saveAgentTeamPlan("session-notes", { plan: teamPlan(), expected_revision: null }), (error) => error.code === "forbidden");
  api.currentUser = originalActor;
  const owner = api.sessions[0].members.find(member => member.userId === originalActor.id);
  owner.role = "viewer";
  await assert.rejects(api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: 2 }), (error) => error.code === "forbidden");
  owner.role = "owner";
  api.projects[0].state = "archived";
  await assert.rejects(api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: 2 }), (error) => error.code === "forbidden");
  api.projects[0].state = "active";
  api.currentUser = { id: "not-a-member" };
  await assert.rejects(api.getAgentTeamPlan("session-orbit"), (error) => error.code === "forbidden");
});

test("mock and disposable example run mutations visibly refuse execution and append no model events", async () => {
  for (const api of [new MockCollaborationApi({ latency: 0 }), new ExampleCollaborationApi()]) {
    const before = structuredClone(api.events.get("session-orbit"));
    assert.deepEqual(await api.listAgentTeamRuns("session-orbit"), { runs: [] });
    for (const call of [() => api.startAgentTeamRun("session-orbit", startInput()), () => api.getAgentTeamRun("session-orbit", "run:1"),
      () => api.controlAgentTeamRun("session-orbit", "run:1", { action: "continue", idempotency_key: "control-stable-key" })]) {
      await assert.rejects(call, (error) => error.code === "agent_team_server_required"
        && error.message === "Agent team runs require a connected server.");
    }
    assert.deepEqual(api.events.get("session-orbit"), before);
    const owner = api.sessions[0].members.find(member => member.userId === api.currentUser.id);
    owner.role = "viewer";
    await assert.rejects(api.startAgentTeamRun("session-orbit", startInput()), (error) => error.code === "forbidden");
    await assert.rejects(api.controlAgentTeamRun("session-orbit", "run:1", { action: "stop", idempotency_key: "control-stable-key" }),
      (error) => error.code === "forbidden");
  }
});

test("mock session deletion removes requester-private team plans", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  await api.saveAgentTeamPlan("session-orbit", { plan: teamPlan(), expected_revision: null });
  await api.saveAgentTeamPlan("session-notes", { plan: teamPlan(), expected_revision: null });
  await api.deleteSession("session-orbit");
  assert.equal(api.agentTeamPlans.size, 1);
  assert.equal((await api.getAgentTeamPlan("session-notes")).plan.name, "Review team");
  await assert.rejects(api.getAgentTeamPlan("session-orbit"), (error) => error.code === "not_found");
});

test("team response and server-required errors have bilingual public messages", () => {
  for (const [message, chinese] of [
    ["Agent team response is invalid. Refresh and try again.", "Agent 团队响应无效，请刷新后重试。"],
    ["Agent team runs require a connected server.", "Agent 团队运行需要连接服务器。"],
  ]) {
    assert.equal(translateUiText(message, "en"), message);
    assert.equal(translateUiText(message, "zh-CN"), chinese);
  }
});

test("terminal private team cleanup uses same-origin cookies and keeps transport errors generic", async () => {
  const originalFetch = globalThis.fetch, requests = [];
  try {
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response(null, { status: 204 }); };
    const api = new HttpCollaborationApi();
    await api.forgetAgentTeamRun("session:fixture", "run:fixture");
    assert.equal(requests[0].url, "/v1/sessions/session%3Afixture/agent-team-runs/run%3Afixture");
    assert.equal(requests[0].options.method, "DELETE"); assert.equal(requests[0].options.body, "{}");
    assert.equal(requests[0].options.credentials, "include");
    globalThis.fetch = async () => { throw new Error("private transport detail"); };
    await assert.rejects(() => api.forgetAgentTeamRun("session:fixture", "run:fixture"), error =>
      error instanceof ApiError && error.status === 0 && !error.message.includes("private transport detail"));
  } finally { globalThis.fetch = originalFetch; }
});
