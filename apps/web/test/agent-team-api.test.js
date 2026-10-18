import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ApiError, HttpCollaborationApi } from "../src/api.js";

const stamp = "2026-10-16T00:00:00.000Z";
const target = { kind: "local", runtime_id: "runtime-fixture", harness: "codex", provider: "openai", model: "fixture-model" };
const draft = { name: "Fixture Team", team_prompt: "", nodes: [
  { id: "module-fixture", label: "Fixture module", role: "", x: 0, y: 0, target },
], edges: [] };
const team = { id: "team:fixture", revision: 1, draft, max_calls: 12, max_duration_minutes: 30, enabled: false,
  tested_revision: null, test_run_id: null, test_session_id: null, test_status: "not_tested", updated_at: stamp };
const module = { id: "favorite:fixture", module: { label: "Fixture module", role: "", target }, created_at: stamp };
const summary = { id: "run:fixture", session_id: "session:fixture", definition_id: team.id, purpose: "task", status: "running",
  created_at: stamp, deadline_at: "2026-10-16T00:30:00.000Z", finished_at: null, calls_used: 0, max_calls: 12,
  max_duration_minutes: 30, current_node_id: "module-fixture", current_step_id: null, error_code: null };
const run = { ...summary, plan: draft, content: "Synthetic task", steps: [] };
const save = { draft, max_calls: 12, max_duration_minutes: 30, expected_revision: null, idempotency_key: "team-save-fixture-key" };
const start = { expected_revision: 1, content_revision: 0, content: "Synthetic task", solo_transfer_ack: false, idempotency_key: "team-start-fixture-key" };
const invalidResponse = error => error instanceof ApiError && error.status === 502 && !error.message.includes("private-fixture");

test("Team HTTP errors preserve only bounded diagnostic fields through the real request path", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: "conflict", message: "private-fixture-provider-body",
    details: { issue_code: "agent_team_call_limit", node_id: "module-fixture", node_label: "执行模块", target_kind: "shared",
      headers: { authorization: "private-fixture-header" }, raw_error: "private-fixture-error" } } }, { status: 409 });
  try {
    const api = new HttpCollaborationApi();
    await assert.rejects(api.controlTeamRun(summary.session_id, summary.id, { action: "resume", idempotency_key: "safe-issue-control" }), error => {
      assert.equal(error.status, 409); assert.equal(error.code, "conflict");
      assert.deepEqual(error.details, { issue_code: "agent_team_call_limit", node_id: "module-fixture", node_label: "执行模块", target_kind: "shared" });
      assert.equal(JSON.stringify(error).includes("private-fixture"), false); assert.equal(error.message.includes("private-fixture"), false);
      return true;
    });
    await assert.rejects(api.request("/v1/projects"), error => { assert.equal(error.details, undefined); return true; });
    globalThis.fetch = async () => Response.json({ error: { code: "conflict", message: "private-fixture",
      details: { issue_code: "agent_team_call_limit", node_label: "x".repeat(121) } } }, { status: 409 });
    await assert.rejects(api.controlTeamRun(summary.session_id, summary.id, { action: "resume", idempotency_key: "invalid-issue-control" }),
      error => { assert.equal(error.details, undefined); return true; });
  } finally { globalThis.fetch = previous; }
});

test("Team API requests use strict snake_case input and reject unsupported overrides before transport", () => {
  const api = new HttpCollaborationApi(); let transported = 0;
  api.request = () => { transported++; throw Error("Unexpected transport"); };
  for (const input of [{ ...save, max_calls: 0 }, { ...save, owner_user_id: "another-account" },
    { ...save, draft: { ...draft, nodes: [{ ...draft.nodes[0], target: { ...target, api_key: "dummy" } }] } },
    { ...save, draft: { ...draft, entry_node_id: "missing-module" } }]) {
    assert.throws(() => api.saveAgentTeam(team.id, input), error => error instanceof ApiError && error.status === 422);
  }
  assert.throws(() => api.controlAgentTeam(summary.session_id, team.id, { enabled: true, idempotency_key: "missing-cas-key" }),
    error => error instanceof ApiError && error.status === 422);
  assert.throws(() => api.executeAgentTeam(summary.session_id, team.id, { ...start, plan: draft }),
    error => error instanceof ApiError && error.status === 422);
  assert.throws(() => api.saveTeamModule(module.id, { module: { ...module.module, x: 10 }, idempotency_key: "bad-favorite-key" }),
    error => error instanceof ApiError && error.status === 422);
  assert.equal(transported, 0);
});

test("Team API binds exact encoded routes and sends Cookie credentials without native tokens", async () => {
  const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const value = String(url).endsWith("/start") ? { run, replayed: false }
      : String(url).endsWith("/test") ? { run: { ...run, purpose: "test" }, replayed: false }
      : String(url).includes("agent-team-modules") ? { favorite: module, replayed: false } : { team, replayed: false };
    return Response.json({ data: value });
  };
  try {
    const api = new HttpCollaborationApi();
    await api.saveAgentTeam(team.id, save);
    await api.saveTeamModule(module.id, { module: module.module, idempotency_key: "team-favorite-fixture" });
    await api.controlAgentTeam(summary.session_id, team.id, { enabled: false, idempotency_key: "team-disable-fixture" });
    await api.executeAgentTeam(summary.session_id, team.id, start);
    await api.executeAgentTeam(summary.session_id, team.id,
      { expected_revision: 1, content_revision: 0, solo_transfer_ack: false, idempotency_key: "team-test-fixture" }, true);
    assert.deepEqual(requests.map(item => [item.url, item.options.method]), [
      ["/v1/agent-teams/team%3Afixture", "PUT"], ["/v1/agent-team-modules/favorite%3Afixture", "PUT"],
      ["/v1/sessions/session%3Afixture/agent-teams/team%3Afixture/control", "POST"],
      ["/v1/sessions/session%3Afixture/agent-teams/team%3Afixture/start", "POST"],
      ["/v1/sessions/session%3Afixture/agent-teams/team%3Afixture/test", "POST"],
    ]);
    assert.ok(requests.every(item => item.options.credentials === "include" && item.options.headers.Authorization === undefined));
    assert.ok(requests.every(item => item.options.signal instanceof AbortSignal));
    assert.deepEqual(JSON.parse(requests[3].options.body), start);
  } finally { globalThis.fetch = previous; }
});

test("saved-Team and favorite responses reject unknown private fields and wrong item identity", async () => {
  const api = new HttpCollaborationApi();
  for (const value of [{ team: { ...team, id: "different-team" }, replayed: false },
    { team, replayed: false, credentials: "private-fixture" }, { team: { ...team, token: "private-fixture" }, replayed: false }]) {
    api.request = async () => value;
    await assert.rejects(api.saveAgentTeam(team.id, save), invalidResponse);
    await assert.rejects(api.controlAgentTeam(summary.session_id, team.id, { enabled: false, idempotency_key: "team-disable-fixture" }), invalidResponse);
  }
  api.request = async () => ({ favorite: { ...module, id: "different-favorite" }, replayed: false });
  await assert.rejects(api.saveTeamModule(module.id, { module: module.module, idempotency_key: "team-favorite-fixture" }), invalidResponse);
  api.request = async () => ({ teams: [team], modules: [module], team_limit: 5, module_limit: 5, token: "private-fixture" });
  await assert.rejects(api.listAgentTeams(), invalidResponse);
});

test("accepted Team executions bind session, saved definition and task-versus-test purpose", async () => {
  const api = new HttpCollaborationApi();
  for (const changed of [{ ...run, session_id: "another-session" }, { ...run, definition_id: "another-definition" },
    { ...run, purpose: "test" }, { ...run, purpose: undefined }, { ...run, definition_id: undefined }]) {
    api.request = async () => ({ run: changed, replayed: false });
    await assert.rejects(api.executeAgentTeam(summary.session_id, team.id, start), invalidResponse);
  }
  api.request = async () => ({ run, replayed: false });
  await assert.rejects(api.executeAgentTeam(summary.session_id, team.id,
    { expected_revision: 1, content_revision: 0, idempotency_key: "team-purpose-probe" }, true), invalidResponse);
  for (const changed of [{ ...run, id: "another-run" }, { ...run, session_id: "another-session" }]) {
    api.request = async () => ({ run: changed });
    await assert.rejects(api.getTeamRun(summary.session_id, run.id), invalidResponse);
    await assert.rejects(api.controlTeamRun(summary.session_id, run.id, { action: "stop", idempotency_key: "team-stop-fixture" }), invalidResponse);
  }
});

test("run lists reject even one schema-valid run from a different session", async () => {
  const api = new HttpCollaborationApi();
  api.request = async () => ({ runs: [summary, { ...summary, id: "other-run", session_id: "another-session" }] });
  await assert.rejects(api.listTeamRuns(summary.session_id), invalidResponse);
  api.request = async () => ({ runs: [summary] });
  assert.equal((await api.listTeamRuns(summary.session_id)).runs.length, 1);
});

test("Team deletion accepts only the strict content-free deletion receipt", async () => {
  const api = new HttpCollaborationApi();
  for (const value of [{ deleted: true, replayed: false, private_data: "private-fixture" }, { deleted: true },
    { deleted: false, replayed: false }]) {
    api.request = async () => value;
    await assert.rejects(api.deleteTeamItem("team", team.id, { idempotency_key: "team-delete-fixture" }), invalidResponse);
  }
  api.request = async () => ({ deleted: true, replayed: false });
  assert.deepEqual(await api.deleteTeamItem("module", module.id, { idempotency_key: "favorite-delete-fixture" }), { deleted: true, replayed: false });
});

async function partialServer(t, respond) {
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    respond(request.url, text ? JSON.parse(text) : undefined, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("terminal private-record cleanup binds its exact route and recovers a lost 204 without swallowing authorization failures", async () => {
  const api = new HttpCollaborationApi(), requests = [];
  api.request = async (path, options) => { requests.push([path, options.method, options.body]); return undefined; };
  assert.deepEqual(await api.forgetTeamRun(summary.session_id, summary.id), { deleted: true });
  assert.deepEqual(requests, [["/v1/sessions/session%3Afixture/agent-team-runs/run%3Afixture", "DELETE", "{}"]]);
  api.request = async (_path, options) => {
    if (options.method === "DELETE") throw new ApiError("Already cleared", { status: 404, code: "not_found" });
    return { runs: [] };
  };
  assert.deepEqual(await api.forgetTeamRun(summary.session_id, summary.id), { deleted: true });
  api.request = async () => { throw new ApiError("Session access lost", { status: 404, code: "not_found" }); };
  await assert.rejects(api.forgetTeamRun(summary.session_id, summary.id), error => error.status === 404,
    "membership loss must not be mistaken for successful private-record cleanup");
  api.request = async (_path, options) => {
    if (options.method === "DELETE") throw new ApiError("Conflicting response", { status: 404, code: "not_found" });
    return { runs: [summary] };
  };
  await assert.rejects(api.forgetTeamRun(summary.session_id, summary.id), error => error.status === 404);
  for (const [status, code] of [[403, "forbidden"], [401, "unauthorized"], [409, "conflict"], [404, "unrelated_error"]]) {
    api.request = async () => { throw new ApiError("Refused", { status, code }); };
    await assert.rejects(api.forgetTeamRun(summary.session_id, summary.id), error => error.status === status && error.code === code);
  }
  api.request = async () => ({ deleted: true });
  await assert.rejects(api.forgetTeamRun(summary.session_id, summary.id), invalidResponse);
});

test("successful headers and a partial JSON body time out; recovery reuses exactly the original body and key", async t => {
  const starts = [];
  const quotedStart = { ...start, content: "😀 @Bob review", reply_to_event_id: "quoted-event-fixture",
    mentions: [{ user_id: "bob", start: 3, end: 7 }] };
  const baseUrl = await partialServer(t, (_path, body, response) => {
    starts.push(body);
    if (starts.length === 1) { response.writeHead(202, { "Content-Type": "application/json" }); response.write('{"data":'); }
    else response.end(JSON.stringify({ data: { run, replayed: true } }));
  });
  let delivered;
  const headers = new Promise(resolve => { delivered = resolve; }), previousFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { const response = await previousFetch(...args); delivered(); return response; };
  t.after(() => { globalThis.fetch = previousFetch; });
  // Advance the clock only after the real server has accepted the task and
  // delivered its partial 202 response. Parallel CI load must not turn this
  // into a different scenario where the request never reached the server.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = new HttpCollaborationApi({ baseUrl, sharingDeadlineMs: 80 });
  const pending = api.executeAgentTeam(summary.session_id, team.id, quotedStart);
  await headers; t.mock.timers.tick(80);
  await assert.rejects(pending, error => error.code === "request_timeout");
  t.mock.timers.reset(); globalThis.fetch = previousFetch;
  const recoveryApi = new HttpCollaborationApi({ baseUrl });
  const recovered = await recoveryApi.executeAgentTeam(summary.session_id, team.id, quotedStart);
  assert.equal(recovered.replayed, true); assert.equal(recovered.run.id, run.id);
  assert.equal(starts.length, 2); assert.deepEqual(starts[0], starts[1]); assert.deepEqual(starts[0], quotedStart);
});

test("a hung error response body also has the independent Team deadline", async t => {
  const baseUrl = await partialServer(t, (_path, _body, response) => {
    response.writeHead(503, { "Content-Type": "application/json" }); response.write('{"error":');
  });
  const api = new HttpCollaborationApi({ baseUrl, sharingDeadlineMs: 50 });
  await assert.rejects(api.controlAgentTeam(summary.session_id, team.id,
    { enabled: false, idempotency_key: "team-emergency-disable" }), error => error.code === "request_timeout");
});

test("external abort fences an unfinished Team response body and an already-aborted request never transports", async t => {
  let received; const ready = new Promise(resolve => { received = resolve; });
  const baseUrl = await partialServer(t, (_path, _body, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"data":'); received();
  });
  const api = new HttpCollaborationApi({ baseUrl }), controller = new AbortController();
  const pending = api.listAgentTeams({ signal: controller.signal }); await ready; controller.abort();
  await assert.rejects(pending, error => error.code === "request_aborted" && error.status === 0);
  const untouched = new HttpCollaborationApi(); let calls = 0;
  untouched.request = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(untouched.listAgentTeams({ signal: controller.signal }), error => error.code === "request_aborted");
  assert.equal(calls, 0);
});
