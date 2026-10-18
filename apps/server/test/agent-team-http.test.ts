import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCollaborationServer } from "../src/server.js";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";
import { AgentTeamLibrary } from "../src/agent-team-library.js";
import { identityFixture, browserSessionFixture } from "./auth-fixtures.js";
import type { AgentTeamPlan } from "@gatherthread/protocol";

test("a public saved-Team mutation replay identifies its original write but returns the current configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-replay-current-")), origin = "http://team-replay-fixture.invalid";
  const server = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"),
    authTokenPepper: "fictional-team-replay-current-pepper-long-enough", allowedOrigins: [origin] }, 0);
  try {
    const identity = identityFixture(server, {}).body.data;
    const cookie = browserSessionFixture(server, { token: identity.token }).headers.get("set-cookie")!.split(";")[0]!;
    const path = `${server.origin}/v1/agent-teams/http-replay-team`;
    const put = async (input: unknown) => {
      const response = await fetch(path, { method: "PUT", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() as { data: { team: { revision: number; draft: { team_prompt: string; name: string } }; replayed: boolean }; error?: { code: string } } };
    };
    const original = { draft: { name: "Originally accepted Team", team_prompt: "Original rules", nodes: [], edges: [] },
      max_calls: 12, max_duration_minutes: 30, expected_revision: null, idempotency_key: "http-replay-original-save" };
    const accepted = await put(original); assert.equal(accepted.status, 200); assert.equal(accepted.body.data.replayed, false);
    const remote = await put({ ...original, draft: { ...original.draft, team_prompt: "Newer rules from another browser" },
      expected_revision: accepted.body.data.team.revision, idempotency_key: "http-replay-remote-save" });
    assert.equal(remote.status, 200); assert.ok(remote.body.data.team.revision > accepted.body.data.team.revision);
    const replay = await put(original);
    assert.equal(replay.status, 200); assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.team.revision, remote.body.data.team.revision);
    assert.equal(replay.body.data.team.draft.team_prompt, "Newer rules from another browser");
    assert.notEqual(replay.body.data.team.draft.team_prompt, original.draft.team_prompt,
      "Web Save recovery must compare this current response with its frozen input before advancing a newer local draft's CAS");
    const changed = await put({ ...original, draft: { ...original.draft, name: "A changed replay is still forbidden" } });
    assert.equal(changed.status, 409); assert.equal(changed.body.error?.code, "idempotency_conflict");
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

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
    const label = `@${peer.actor.display_name}`, prefix = `${label} `.repeat(32), longContent = prefix + "中".repeat(3000 - prefix.length);
    const longInput = { ...input, content: longContent, idempotency_key: "http-team-max-chinese-start",
      mentions: Array.from({ length: 32 }, (_value, index) => ({ user_id: peer.actor.user_id,
        start: index * (label.length + 1), end: index * (label.length + 1) + label.length })) };
    assert.equal(longContent.length, 3000); assert.ok(Buffer.byteLength(JSON.stringify(longInput)) > 8192);
    const longStarted = await web(`${teamPath}/start`, "POST", longInput);
    assert.equal(longStarted.status, 202, "The HTTP admission limit must accept schema-valid Chinese tasks and 32 selected mentions");
    const longRun = longStarted.body!.data.run;
    assert.equal(longRun.content, longContent);
    assert.equal((await web(`${root}/agent-team-runs/${longRun.id}/control`, "POST", { action: "stop",
      idempotency_key: "http-team-max-chinese-stop" })).status, 200);
    assert.equal((await web(`${root}/agent-team-runs/${longRun.id}`, "DELETE", {})).status, 204);
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

test("additive start-key migration fences retained and previously forgotten runs across a database restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-keys-")), path = join(directory, "server.sqlite");
  let database = new CollaborationDatabase(path), teams: AgentTeams | undefined;
  try {
    let service = new CollaborationService(database);
    const actor = database.bootstrapIdentity({ display_name: "Synthetic migration owner", device_name: "Synthetic migration device" }).actor;
    const { session } = service.createSession(actor, { mode: "multi", title: "Consumed-key migration", idempotency_key: "migrate-key-session" });
    const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "openai",
      model: "synthetic-model", context_deletion_version: 1, capture_fidelity: "harness_transcript", local_session_id: "synthetic-migration-local" });
    const plan: AgentTeamPlan = { name: "Private migration plan", team_prompt: "", nodes: [{ id: "lead", label: "Lead", role: "", x: 0, y: 0,
      target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "synthetic-model" } }], edges: [] };
    const input = { plan, entry_node_id: "lead", content: "SYNTHETIC_TASK_PRIVATE_COPY", max_calls: 1,
      max_duration_minutes: 30, content_revision: 0, idempotency_key: "synthetic-retained-start" };
    teams = new AgentTeams(service, undefined, { autoStart: false });
    const retained = teams.start(actor, session.id, input).run;
    teams.control(actor, session.id, retained.id, { action: "stop", idempotency_key: "synthetic-retained-stop" });
    const oldInput = { ...input, idempotency_key: "synthetic-forgotten-start" }, forgotten = teams.start(actor, session.id, oldInput).run;
    await teams.pump(); assert.equal(teams.read(actor, session.id, forgotten.id).run.calls_used, 1);
    teams.control(actor, session.id, forgotten.id, { action: "stop", idempotency_key: "synthetic-forgotten-stop" });
    teams.forget(actor, session.id, forgotten.id);
    const head = database.requireSession(session.id).next_sequence;
    teams.close(); database.sqlite.exec("DROP TABLE agent_team_start_receipts"); database.close();
    database = new CollaborationDatabase(path); service = new CollaborationService(database);
    teams = new AgentTeams(service, undefined, { autoStart: false });
    assert.equal(teams.start(actor, session.id, input).run.id, retained.id);
    assert.equal(teams.store.startReceipt(actor, session.id, input.idempotency_key)!.input_digest?.toString().length, 64);
    const canonicalFence = teams.store.startReceipt(actor, session.id, oldInput.idempotency_key)!;
    assert.equal(canonicalFence.run_id, forgotten.id); assert.equal(canonicalFence.input_digest, null);
    for (const retry of [oldInput, { ...oldInput, content: "Changed legacy input" }]) {
      assert.throws(() => teams!.start(actor, session.id, retry), { code: "conflict" });
    }
    teams.forget(actor, session.id, retained.id); teams.close(); database.close();
    database = new CollaborationDatabase(path); teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false });
    assert.throws(() => teams!.start(actor, session.id, input), { code: "conflict" });
    assert.throws(() => teams!.start(actor, session.id, { ...input, content: "Changed known input" }), { code: "idempotency_conflict" });
    await teams.pump(); assert.equal(database.requireSession(session.id).next_sequence, head);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n, 2);
  } finally { teams?.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("account revision clocks survive deleting every Team and seed from existing preview definitions on migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-clock-")), path = join(directory, "server.sqlite");
  let database = new CollaborationDatabase(path), teams: AgentTeams | undefined;
  try {
    const actor = database.bootstrapIdentity({ display_name: "Synthetic revision owner", device_name: "Synthetic revision device" }).actor;
    const input = { draft: { name: "A private empty draft", team_prompt: "", nodes: [], edges: [] },
      expected_revision: null, idempotency_key: "clock-initial-save" };
    teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false });
    let library = new AgentTeamLibrary(teams), original = library.save(actor, "clock-team", input).team;
    library.delete(actor, "team", original.id, "clock-initial-delete");
    teams.close(); database.close(); database = new CollaborationDatabase(path);
    teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false }); library = new AgentTeamLibrary(teams);
    const replacement = library.save(actor, original.id, { ...input, idempotency_key: "clock-replacement-save" }).team;
    assert.ok(replacement.revision > original.revision);
    assert.throws(() => library.save(actor, original.id, { ...input, expected_revision: original.revision,
      idempotency_key: "clock-stale-browser-save" }), { code: "conflict" });
    original = replacement;
    teams.close(); database.sqlite.exec("DROP TABLE agent_team_revision_clocks"); database.close();
    database = new CollaborationDatabase(path); teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false });
    library = new AgentTeamLibrary(teams);
    const edited = library.save(actor, original.id, { ...input, draft: { ...input.draft, name: "A migrated edit" },
      expected_revision: original.revision, idempotency_key: "clock-migrated-edit" }).team;
    assert.ok(edited.revision > original.revision); assert.equal(edited.draft.name, "A migrated edit");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_revision_clocks WHERE user_id=?").get(actor.user_id)!.n, 1);
  } finally { teams?.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("upgrading a preview that already deleted every Team does not recycle the old browser's revision", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-legacy-clock-")), path = join(directory, "server.sqlite");
  let database = new CollaborationDatabase(path), teams: AgentTeams | undefined;
  try {
    const actor = database.bootstrapIdentity({ display_name: "Synthetic legacy revision owner", device_name: "Synthetic old browser" }).actor;
    teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false });
    let library = new AgentTeamLibrary(teams);
    const input = { draft: { name: "Legacy deleted Team", team_prompt: "", nodes: [], edges: [] },
      expected_revision: null, idempotency_key: "legacy-clock-initial-save" };
    library.save(actor, "legacy-deleted-id", input);
    // The earlier preview assigned revision 1 independently to each new Team
    // and had no account clock. Represent that persisted version explicitly,
    // including the case where deletion preceded the first clock migration.
    database.sqlite.prepare("UPDATE agent_team_definitions SET revision=1 WHERE id=?").run("legacy-deleted-id");
    database.sqlite.exec("DROP TABLE agent_team_revision_clocks");
    library.delete(actor, "team", "legacy-deleted-id", "legacy-clock-before-upgrade-delete");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_definitions").get()!.n, 0);
    teams.close(); database.close(); database = new CollaborationDatabase(path);
    teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false }); library = new AgentTeamLibrary(teams);
    const replacement = library.save(actor, "legacy-deleted-id", { ...input,
      draft: { ...input.draft, name: "A different post-upgrade Team" }, idempotency_key: "legacy-clock-new-team" }).team;
    assert.throws(() => library.save(actor, replacement.id, { ...input, expected_revision: 1,
      draft: { ...input.draft, name: "Stale old-browser overwrite" }, idempotency_key: "legacy-clock-stale-browser-save" }), { code: "conflict" });
    assert.ok(replacement.revision > 1);
    assert.equal(library.read(actor, replacement.id).draft.name, "A different post-upgrade Team");
  } finally { teams?.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
