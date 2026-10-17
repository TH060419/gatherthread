import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCollaborationServer } from "../src/server.js";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";
import { identityFixture, browserSessionFixture } from "./auth-fixtures.js";
import type { AgentTeamPlan } from "@gatherthread/protocol";

test("team HTTP routes enforce private ownership, writer/device authority, CSRF and durable action keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-http-"));
  const browserOrigin = "http://team-fixture.invalid";
  const server = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"), authTokenPepper: "fictional-team-http-test-pepper-long-enough",
    allowedOrigins: [browserOrigin], actorWriteRateLimit: { windowMs: 1000, limit: 100 } }, 0);
  const owner = identityFixture(server, {}).body.data, peer = identityFixture(server, {}).body.data;
  const { session } = server.service.createSession(owner.actor, { mode: "multi", title: "HTTP team", idempotency_key: "http-team-session" });
  server.service.setMembership(owner.actor, session.id, peer.actor.user_id, "participant", "http-team-peer");
  const runtime = server.service.registerRuntime(owner.actor, { session_id: session.id, device_id: owner.actor.device_id, harness: "codex", provider: "openai", model: "fixture-http", context_deletion_version: 1, capture_fidelity: "harness_transcript", local_session_id: "fixture-http" });
  const plan: AgentTeamPlan = { name: "Private HTTP team", entry_node_id: "lead", team_prompt: "Coordinate", nodes: [{ id: "lead", label: "Lead", role: "Review", x: 0, y: 0,
    target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "fixture-http" } }], edges: [] };
  const root = `/v1/sessions/${session.id}`, token = owner.token;
  async function request(path: string, method = "GET", body?: unknown, credential = token, cookie?: string, origin?: string) {
    const response = await fetch(server.origin + path, { method, headers: { ...(cookie ? { cookie } : { authorization: `Bearer ${credential}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as { data: Record<string, any>; error?: { code: string } } };
  }
  try {
    // Native credentials cannot create account library entries, nor bypass testing with a raw plan.
    const save = { draft: plan, expected_revision: null, idempotency_key: "http-team-save-key" };
    assert.equal((await request("/v1/agent-teams/fixture-team", "PUT", save)).status, 403);
    assert.equal((await request(`${root}/agent-team-plan`, "PUT", { plan, expected_revision: null })).status, 404);
    assert.equal((await request(`${root}/agent-team-runs`, "POST", { plan, entry_node_id: "lead", content: "Bypass", idempotency_key: "http-bypass-key" })).status, 404);
    const cookie = browserSessionFixture(server, { token }).headers.get("set-cookie")!.split(";")[0]!;
    const peerCookie = browserSessionFixture(server, { token: peer.token }).headers.get("set-cookie")!.split(";")[0]!;
    const web = (path: string, method = "GET", body?: unknown, authCookie = cookie) => request(path, method, body, token, authCookie, browserOrigin);
    assert.equal((await request("/v1/agent-teams/fixture-team", "PUT", save, token, cookie, "https://foreign.example")).status, 403);
    const saved = await web("/v1/agent-teams/fixture-team", "PUT", save); assert.equal(saved.status, 200);
    const revision = saved.body!.data.team.revision;
    assert.equal((await web("/v1/agent-teams", "GET", undefined, peerCookie)).body!.data.teams.length, 0);
    const teamPath = `${root}/agent-teams/fixture-team`;
    assert.equal((await web(`${teamPath}/control`, "POST", { enabled: true, expected_revision: revision, idempotency_key: "http-enable-untested" })).status, 409);
    const testInput = { expected_revision: revision, content_revision: 0, idempotency_key: "http-test-key" };
    const tested = await web(`${teamPath}/test`, "POST", testInput); assert.equal(tested.status, 202);
    const probeId = tested.body!.data.run.id;
    assert.equal((await web(`${teamPath}/test`, "POST", testInput)).body!.data.run.id, probeId);
    for (let index = 0; index < 30; index++) {
      const detail = (await web(`${root}/agent-team-runs/${probeId}`)).body!.data.run;
      const step = detail.steps.find((item: { id: string }) => item.id === detail.current_step_id);
      if (step?.request_event_id) {
        const claim = server.service.claimAgentRequest(owner.actor, session.id, step.request_event_id, runtime.id);
        server.service.completeAgentRequest(owner.actor, session.id, step.request_event_id, runtime.id, "http-complete-probe",
          { text: `GT_TEAM_OK:lead:${step.id}` }, "fixture-http", undefined, claim.attempt_count); break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let library;
    for (let index = 0; index < 30; index++) {
      library = (await web("/v1/agent-teams")).body!.data;
      if (library.teams[0].test_status === "passed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(library!.teams[0].test_status, "passed");
    const enabled = await web(`${teamPath}/control`, "POST", { enabled: true, expected_revision: revision, idempotency_key: "http-enable-tested" });
    assert.equal(enabled.status, 200);
    const quote = server.service.appendEvent(peer.actor, session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "http-team-reference-source", payload: { content: "Synthetic HTTP quote" } });
    const content = `  🧪 @${peer.actor.display_name} Human start  \n`, mentionStart = content.indexOf("@");
    const input = { expected_revision: enabled.body!.data.team.revision, content, reply_to_event_id: quote.id,
      mentions: [{ user_id: peer.actor.user_id, start: mentionStart, end: mentionStart + `@${peer.actor.display_name}`.length }],
      idempotency_key: "http-team-human-start", content_revision: 0 };
    const started = await web(`${teamPath}/start`, "POST", input); assert.equal(started.status, 202);
    const runId = started.body!.data.run.id;
    assert.equal(started.body!.data.run.content, content);
    assert.equal((await web(`${teamPath}/start`, "POST", { ...input, reply_to_event_id: null })).status, 409);
    assert.equal((await web(`${teamPath}/start`, "POST", { ...input, mentions: [] })).status, 409);
    const replay = await web(`${teamPath}/start`, "POST", input); assert.equal(replay.body!.data.run.id, runId); assert.equal(replay.body!.data.replayed, true);
    assert.equal((await request(`${root}/agent-team-runs/${runId}`, "GET", undefined, peer.token)).status, 404);
    assert.deepEqual((await request(`${root}/agent-team-runs`, "GET", undefined, peer.token)).body!.data.runs, []);
    assert.equal((await web(`${root}/agent-team-runs/${runId}`, "DELETE", {})).status, 409);
    const controlPath = `${root}/agent-team-runs/${runId}/control`, stop = { action: "stop", idempotency_key: "http-team-stop-key" };
    assert.equal((await web(controlPath, "POST", stop)).status, 200);
    assert.equal((await web(controlPath, "POST", stop)).body!.data.run.status, "stopped");
    assert.equal((await web(controlPath, "POST", { ...stop, action: "resume" })).status, 409);
    assert.equal((await web("/v1/agent-teams/fixture-team", "DELETE", { idempotency_key: "http-peer-delete-key" }, peerCookie)).status, 404);
    assert.equal((await web(`${root}/agent-team-runs/${runId}`, "DELETE", {})).status, 204);
    server.database.revokeDevice(owner.actor, owner.actor.device_id);
    assert.equal((await web("/v1/agent-teams")).status, 401);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("opening an older team database adds revision and reserved-control columns without rewriting saved plans", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-migration-")), path = join(directory, "server.sqlite");
  let database = new CollaborationDatabase(path);
  try {
    const service = new CollaborationService(database), actor = database.bootstrapIdentity({ display_name: "Migration fixture", device_name: "Fixture" }).actor;
    const { session } = service.createSession(actor, { mode: "multi", title: "Migration", idempotency_key: "team-migrate-session" });
    const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "openai", model: "fixture", context_deletion_version: 1, capture_fidelity: "harness_transcript", local_session_id: "fixture-migration" });
    const teams = new AgentTeams(service, undefined, { autoStart: false });
    const plan: AgentTeamPlan = { name: "Keep private draft", team_prompt: "Keep rules", nodes: [{ id: "lead", label: "Lead", role: "Keep role", x: 0, y: 0, target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "fixture" } }], edges: [] };
    teams.savePlan(actor, session.id, plan, null); teams.close();
    database.sqlite.exec("ALTER TABLE agent_team_runs DROP COLUMN content_revision");
    database.sqlite.exec("ALTER TABLE agent_team_controls DROP COLUMN reserved");
    database.close(); database = new CollaborationDatabase(path);
    const restored = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false });
    try {
      assert.deepEqual(restored.getPlan(actor, session.id), { plan, revision: 1 });
      for (const [table, column] of [["agent_team_runs", "content_revision"], ["agent_team_controls", "reserved"]])
        assert.ok(database.sqlite.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column));
    } finally { restored.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
