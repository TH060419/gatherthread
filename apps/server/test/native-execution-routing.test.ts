import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";
import { AgentTeamLibrary } from "../src/agent-team-library.js";
import { AgentSharing } from "../src/agent-sharing.js";
import { AgentShareLimitsSchema, type AgentTeamPlan } from "@gatherthread/protocol";
import { startCollaborationServer } from "../src/server.js";
import { identityFixture, browserSessionFixture } from "./auth-fixtures.js";

function fixture(path = ":memory:") {
  let key = 0;
  const db = new CollaborationDatabase(path), service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Routing fixture owner", device_name: "Routing fixture native" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Original native scope", idempotency_key: "routing-original-session" }).session;
  const registration = { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "synthetic", model: "routing-model",
    context_deletion_version: 1 as const, local_session_id: "routing-native-identity", capture_fidelity: "harness_transcript" as const };
  const runtime = service.registerRuntime(actor, registration), teams = new AgentTeams(service, undefined, { autoStart: false });
  const library = new AgentTeamLibrary(teams);
  const plan: AgentTeamPlan = { name: "Saved routing Team", team_prompt: "", nodes: [{ id: "lead", label: "Lead", role: "Review", x: 0, y: 0,
    target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "synthetic", model: "routing-model" } }], edges: [] };
  const savedStart = async (stop = true) => {
    const saved = library.save(actor, "routing-saved-team", { draft: plan, expected_revision: null, idempotency_key: `routing-save-${++key}` }).team;
    const probe = library.test(actor, saved.id, session.id, { expected_revision: saved.revision, content_revision: 0, idempotency_key: `routing-test-${++key}` });
    await teams.pump();
    const step = teams.store.steps(probe.run.id)[0]!, claim = service.claimAgentRequest(actor, session.id, step.request_event_id!, runtime.id);
    const content = (db.getEvent(session.id, step.request_event_id!).payload as { content: string }).content;
    const encoded = content.split("\n").find(line => line.startsWith('["GT_TEAM_OK:'))!;
    assert.ok(encoded, "Exercise the actual saved connectivity probe, not a raw run bypass");
    service.completeAgentRequest(actor, session.id, step.request_event_id!, runtime.id, `routing-probe-answer-${++key}`,
      { content: (JSON.parse(encoded) as string[]).join("\n") }, "routing-model", undefined, claim.attempt_count);
    await teams.pump(); assert.equal(library.read(actor, saved.id).test_status, "passed");
    const enabled = library.control(actor, saved.id, session.id, { enabled: true, expected_revision: saved.revision, idempotency_key: `routing-enable-${++key}` }).team;
    const started = library.start(actor, saved.id, session.id, { expected_revision: enabled.revision, content: "Public saved Team task",
      content_revision: 0, idempotency_key: `routing-start-${++key}` });
    await teams.pump(); const request = teams.store.steps(started.run.id)[0]!.request_event_id!;
    const execution = service.claimAgentRequest(actor, session.id, request, runtime.id);
    if (stop) teams.control(actor, session.id, started.run.id, { action: "stop", idempotency_key: `routing-stop-${++key}` });
    return { run: started.run, request, attempt: execution.attempt_count! };
  };
  return { db, service, actor, session, registration, runtime, teams, library, savedStart,
    close() { teams.close(); db.close(); } };
}

test("HTTP saved Team execution cannot be moved to another runtime scope before its exact stop acknowledgment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-native-route-http-")), origin = "http://routing-fixture.invalid";
  const server = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"),
    authTokenPepper: "synthetic-routing-http-pepper-long-enough", allowedOrigins: [origin], actorWriteRateLimit: { windowMs: 1000, limit: 200 } }, 0);
  try {
    const identity = identityFixture(server, {}).body.data;
    const cookie = browserSessionFixture(server, { token: identity.token }).headers.get("set-cookie")!.split(";")[0]!;
    const session = server.service.createSession(identity.actor, { mode: "multi", title: "HTTP original native scope", idempotency_key: "routing-http-session" }).session;
    const other = server.service.createSession(identity.actor, { mode: "multi", title: "HTTP other native scope", idempotency_key: "routing-http-other" }).session;
    const call = async (path: string, method: string, body?: unknown, browser = false) => {
      const response = await fetch(server.origin + path, { method, headers: { "content-type": "application/json",
        ...(browser ? { cookie, origin } : { authorization: `Bearer ${identity.token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as { data: any; error?: { code: string } } };
    };
    const registration = { session_id: session.id, device_id: identity.actor.device_id, harness: "codex", provider: "synthetic", model: "routing-model",
      local_session_id: "routing-http-native", capture_fidelity: "harness_transcript", context_deletion_version: 1 };
    const native = await call("/v1/runtimes", "POST", registration); assert.equal(native.status, 201); const runtime = native.body.data.runtime;
    const plan = { name: "HTTP saved routing Team", team_prompt: "", nodes: [{ id: "lead", label: "Lead", role: "Review", x: 0, y: 0,
      target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "synthetic", model: "routing-model" } }], edges: [] };
    const saved = await call("/v1/agent-teams/routing-http-team", "PUT", { draft: plan, expected_revision: null, idempotency_key: "routing-http-save" }, true);
    assert.equal(saved.status, 200);
    const root = `/v1/sessions/${session.id}`, teamPath = `${root}/agent-teams/routing-http-team`;
    const stepFor = async (id: string) => {
      for (let count = 0; count < 100; count++) {
        const read = await call(`${root}/agent-team-runs/${id}`, "GET", undefined, true);
        assert.equal(read.status, 200); const step = read.body.data.run.steps.find((item: any) => item.request_event_id);
        if (step) return step;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("The public saved execution did not dispatch a native request");
    };
    const probe = await call(`${teamPath}/test`, "POST", { expected_revision: saved.body.data.team.revision,
      content_revision: 0, idempotency_key: "routing-http-probe" }, true); assert.equal(probe.status, 202);
    const testStep = await stepFor(probe.body.data.run.id);
    const claim = await call(`${root}/agent-requests/${testStep.request_event_id}/claim`, "POST", { runtime_id: runtime.id, execution_control_version: 1 });
    assert.equal(claim.status, 200);
    assert.equal((await call(`${root}/agent-requests/${testStep.request_event_id}/complete`, "POST", {
      runtime_id: runtime.id, claim_attempt: claim.body.data.attempt_count, idempotency_key: "routing-http-probe-answer",
      payload: { content: `GT_TEAM_OK:lead:${testStep.id}` }, observed_model: "routing-model" })).status, 201);
    let enabled: any;
    for (let count = 0; count < 100; count++) {
      enabled = await call(`${teamPath}/control`, "POST", { enabled: true, expected_revision: saved.body.data.team.revision,
        idempotency_key: "routing-http-enable" }, true);
      if (enabled.status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(enabled.status, 200);
    const accepted = await call(`${teamPath}/start`, "POST", { expected_revision: enabled.body.data.team.revision,
      content: "Real HTTP saved Team route", content_revision: 0, idempotency_key: "routing-http-start" }, true); assert.equal(accepted.status, 202);
    const step = await stepFor(accepted.body.data.run.id), requestPath = `${root}/agent-requests/${step.request_event_id}`;
    const active = await call(`${requestPath}/claim`, "POST", { runtime_id: runtime.id, execution_control_version: 1 }); assert.equal(active.status, 200);
    assert.equal((await call(`${root}/agent-team-runs/${accepted.body.data.run.id}/control`, "POST", { action: "stop", idempotency_key: "routing-http-stop" }, true)).status, 200);
    const refused = await call("/v1/runtimes", "POST", { ...registration, session_id: other.id });
    assert.equal(refused.status, 409); assert.equal(refused.body.error?.code, "agent_team_native_exit_pending");
    assert.deepEqual((await call(`${requestPath}/execution/stopped`, "POST", { runtime_id: runtime.id, claim_attempt: active.body.data.attempt_count })).body.data, { active: false });
    const rebound = await call("/v1/runtimes", "POST", { ...registration, session_id: other.id });
    assert.equal(rebound.status, 201); assert.equal(rebound.body.data.runtime.id, runtime.id);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a public saved/tested/enabled Team's unresolved native claim prevents runtime session/project/purpose rebinding", async t => {
  for (const mutation of ["session", "project", "purpose"] as const) await t.test(mutation, async () => {
    const f = fixture(); try {
      const { request, attempt } = await f.savedStart();
      const other = f.service.createSession(f.actor, { ...(mutation === "session" ? { project_id: f.session.project_id } : {}),
        mode: "multi", title: "Other native scope", idempotency_key: "routing-other-session" }).session;
      const input = mutation === "purpose" ? { ...f.registration, purpose: "snapshot_connector" as const }
        : { ...f.registration, session_id: other.id };
      const before = f.db.getRuntime(f.runtime.id);
      assert.throws(() => f.service.registerRuntime(f.actor, input), { code: "agent_team_native_exit_pending", status: 409 });
      assert.deepEqual(f.db.getRuntime(f.runtime.id), before);
      f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt + 1);
      assert.throws(() => f.service.registerRuntime(f.actor, input), { code: "agent_team_native_exit_pending" });
      f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
      assert.equal(f.service.registerRuntime(f.actor, input).id, f.runtime.id);
    } finally { f.close(); }
  });
});

test("legacy runtime rebinding cannot move a native claim's cleanup route or deletion pool", async t => {
  for (const deleted of [false, true]) await t.test(deleted ? "origin session deleted" : "origin retained", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-native-route-reopen-")), path = join(directory, "server.sqlite"), f = fixture(path);
    let closed = false, reopened: CollaborationDatabase | undefined, sharing: AgentSharing | undefined;
    try {
      const { request, attempt } = await f.savedStart();
      const other = f.service.createSession(f.actor, { mode: "multi", title: "Legacy wrong runtime scope", idempotency_key: "routing-legacy-other" }).session;
      // Simulate a previous preview's persisted legal upsert; current public
      // registration must reject this while the physical exit is unconfirmed.
      f.db.sqlite.prepare("UPDATE runtimes SET session_id=?,purpose='snapshot_connector' WHERE id=?").run(other.id, f.runtime.id);
      if (deleted) f.service.deleteSession(f.actor, f.session.id);
      f.close(); closed = true;
      reopened = new CollaborationDatabase(path); const service = new CollaborationService(reopened);
      if (deleted) {
        const held = reopened.sqlite.prepare("SELECT project_id,session_id FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!;
        assert.ok(held, "A mutable current purpose cannot suppress capture of a real claimed native execution");
        assert.equal(held.project_id, f.session.project_id); assert.equal(held.session_id, f.session.id);
      }
      const replacement = service.createSession(f.actor, { project_id: f.session.project_id, mode: "multi", title: "Original project replacement",
        idempotency_key: "routing-original-replacement" }).session;
      const capability = { version: 1 as const, isolated: true as const, project_only: true as const, cancellation: true as const, liveness_watchdog: true as const };
      const profile = { harness: "codex" as const, provider: "synthetic", model: "routing-model" };
      const native = service.registerRuntime(f.actor, { ...f.registration, session_id: replacement.id, local_session_id: "routing-independent-native", sharing_capability: capability });
      const peer = reopened.createIdentity({ display_name: "Routing fixture peer", device_name: "Routing peer device" }).actor;
      service.setMembership(f.actor, replacement.id, peer.user_id, "participant", "routing-replacement-peer");
      sharing = new AgentSharing(service, { autoStart: false });
      sharing.sourceAvailability(f.actor, { project_id: replacement.project_id, source_runtime_id: native.id, state: "ready", idempotency_key: "routing-replacement-ready" });
      const saved = sharing.save(f.actor, replacement.project_id, { source_runtime_id: native.id, execution_profile: profile,
        allowed_user_ids: [peer.user_id], limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "routing-replacement-share" }).share;
      const enabled = sharing.control(f.actor, replacement.project_id, saved.id, { action: "enable", expected_revision: saved.revision, idempotency_key: "routing-replacement-enable" }).share;
      const job = sharing.start(peer, replacement.id, { share_id: enabled.id, share_revision: enabled.revision, content: "Synthetic borrowed task",
        content_revision: 0, solo_transfer_ack: false, idempotency_key: "routing-replacement-job" }).job;
      assert.throws(() => sharing!.claim(f.actor, job.id, { idempotency_key: "routing-replacement-claim" }), { code: "agent_share_busy" });
      service.acknowledgeAgentExecutionStopped(f.actor, other.id, request, f.runtime.id, attempt);
      assert.throws(() => sharing!.claim(f.actor, job.id, { idempotency_key: "routing-replacement-claim" }), { code: "agent_share_busy" });
      service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
      assert.equal(sharing.claim(f.actor, job.id, { idempotency_key: "routing-replacement-claim" }).job.status, "running");
      if (!deleted) assert.equal(reopened.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 0);
      assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!.n, 0);
      assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { sharing?.close(); reopened?.close(); if (!closed) f.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

test("native routing freezes identity changes for every unresolved state but permits same-route catalog refresh", async t => {
  for (const status of ["claimed", "paused", "failed", "completed"] as const) await t.test(status, async () => {
    const f = fixture(); try {
      const { request, attempt } = await f.savedStart(status !== "claimed");
      // Old previews can persist a terminal logical status without an exit
      // receipt. The storage hold, not the user-facing status, is authoritative.
      if (status === "failed" || status === "completed") f.db.sqlite.prepare("UPDATE agent_request_claims SET status=? WHERE request_event_id=?").run(status, request);
      const other = f.service.createSession(f.actor, { mode: "multi", title: "Frozen scope target", idempotency_key: "routing-state-other" }).session;
      const refreshed = f.service.registerRuntime(f.actor, { ...f.registration, provider: "refreshed-provider", model: "refreshed-model",
        execution_profiles: [{ provider: "refreshed-provider", model: "refreshed-model", reasoning_efforts: ["low", "high"] }] });
      assert.equal(refreshed.id, f.runtime.id); assert.equal(refreshed.model, "refreshed-model");
      assert.equal(f.service.heartbeatRuntime(f.actor, f.runtime.id).id, f.runtime.id);
      assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
      assert.throws(() => f.service.registerRuntime(f.actor, { ...f.registration, session_id: other.id }), { code: "agent_team_native_exit_pending" });
      assert.throws(() => f.service.registerRuntime(f.actor, { ...f.registration, purpose: "snapshot_connector" }), { code: "agent_team_native_exit_pending" });
      const foreign = f.db.createIdentity({ display_name: "Foreign fixture owner", device_name: "Foreign fixture native" }).actor;
      f.service.setMembership(f.actor, f.session.id, foreign.user_id, "participant", "routing-state-foreign");
      const second = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Second fixture executor").device_id };
      for (const actor of [foreign, second]) {
        assert.throws(() => f.service.registerRuntime(actor, { ...f.registration, runtime_id: f.runtime.id, device_id: actor.device_id }), { code: "not_found" });
        f.service.acknowledgeAgentExecutionStopped(actor, f.session.id, request, f.runtime.id, attempt);
        assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
      }
      assert.throws(() => f.service.registerRuntime(f.actor, { ...f.registration, runtime_id: f.runtime.id, harness: "dsh" }), { code: "not_found" });
      assert.equal(f.db.getRuntime(f.runtime.id).harness, "codex");
      f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
      assert.equal(f.service.registerRuntime(f.actor, { ...f.registration, session_id: other.id }).id, f.runtime.id);
    } finally { f.close(); }
  });
});

test("deleting the canonical request directly captures its original pool before FK claim removal", async () => {
  const f = fixture(); try {
    const { request, attempt } = await f.savedStart();
    const other = f.service.createSession(f.actor, { mode: "multi", title: "Old mutable binding", idempotency_key: "routing-event-other" }).session;
    f.db.sqlite.prepare("UPDATE runtimes SET session_id=?,purpose='snapshot_connector' WHERE id=?").run(other.id, f.runtime.id);
    assert.throws(() => f.db.sqlite.prepare("DELETE FROM events WHERE id=?").run(request), /FOREIGN KEY/u);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 0,
      "A refused maintenance deletion rolls back its capture too");
    // There is no individual public envelope-delete API. Exercise the parent
    // FK boundary with legal synthetic maintenance order, without disabling FKs.
    f.db.sqlite.prepare("DELETE FROM events WHERE reply_to_event_id=?").run(request);
    f.db.sqlite.prepare("DELETE FROM events WHERE id=?").run(request);
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_request_claims WHERE request_event_id=?").get(request), undefined);
    const hold = f.db.sqlite.prepare("SELECT * FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!;
    assert.equal(hold.session_id, f.session.id); assert.equal(hold.project_id, f.session.project_id); assert.equal(hold.origin_verified, 1);
    f.service.acknowledgeAgentExecutionStopped(f.actor, other.id, request, f.runtime.id, attempt);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 1);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 0);
    assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.close(); }
});

test("a detached held runtime ID cannot be resurrected to change execution ownership", async () => {
  const f = fixture(); try {
    const { request, attempt } = await f.savedStart();
    f.service.deleteSession(f.actor, f.session.id);
    const replacement = f.service.createSession(f.actor, { project_id: f.session.project_id, mode: "multi", title: "New session",
      idempotency_key: "routing-reuse-session" }).session;
    const registration = { ...f.registration, runtime_id: f.runtime.id, session_id: replacement.id };
    const foreign = f.db.createIdentity({ display_name: "Foreign reuse fixture", device_name: "Foreign native device" }).actor;
    f.service.setMembership(f.actor, replacement.id, foreign.user_id, "participant", "routing-reuse-foreign");
    assert.throws(() => f.service.registerRuntime(foreign, { ...registration, device_id: foreign.device_id }), { code: "not_found" });
    assert.throws(() => f.service.registerRuntime(f.actor, registration), { code: "agent_team_native_exit_pending" });
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt + 1);
    assert.throws(() => f.service.registerRuntime(f.actor, registration), { code: "agent_team_native_exit_pending" });
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
    assert.equal(f.service.registerRuntime(f.actor, registration).id, f.runtime.id);
  } finally { f.close(); }
});

test("a stopped legacy Team returns its persisted exact claim generation after reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-native-legacy-attempt-")), path = join(directory, "server.sqlite"), f = fixture(path);
  let closed = false, reopened: CollaborationDatabase | undefined;
  try {
    const { request } = await f.savedStart();
    // Older previews re-dispatched native Team claims after a lease lapse.
    // Current Teams never do so; preserve an actually persisted old generation
    // rather than mocking the HTTP client's attempt value.
    f.db.sqlite.prepare("UPDATE agent_request_claims SET attempt_count=2 WHERE request_event_id=?").run(request);
    f.close(); closed = true;
    reopened = new CollaborationDatabase(path); const service = new CollaborationService(reopened);
    const paused = service.claimAgentRequest(f.actor, f.session.id, request, f.runtime.id);
    assert.equal(paused.status, "paused"); assert.equal(paused.attempt_count, 2);
    const other = service.registerRuntime(f.actor, { ...f.registration, local_session_id: "routing-legacy-other-runtime" });
    assert.throws(() => service.claimAgentRequest(f.actor, f.session.id, request, other.id), { code: "agent_request_already_claimed" });
    service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, 1);
    assert.equal(reopened.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
    service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, 2);
    assert.equal(reopened.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 0);
    assert.equal(service.claimAgentRequest(f.actor, f.session.id, request, f.runtime.id).attempt_count, 2);
  } finally { reopened?.close(); if (!closed) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("upgrading a legacy wrong-scope detached hold repairs surviving canonical origin and conservatively contains missing origin", async t => {
  for (const deleted of [false, true]) await t.test(deleted ? "original history already deleted" : "canonical origin survives", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-native-old-origin-")), path = join(directory, "server.sqlite"), f = fixture(path);
    let closed = false, reopened: CollaborationDatabase | undefined, sharing: AgentSharing | undefined;
    try {
      const { request, attempt } = await f.savedStart();
      const wrong = f.service.createSession(f.actor, { mode: "multi", title: "Old guessed project", idempotency_key: "routing-upgrade-wrong" }).session;
      f.db.sqlite.prepare("UPDATE runtimes SET session_id=?,purpose='snapshot_connector' WHERE id=?").run(wrong.id, f.runtime.id);
      // A previous preview captured the runtime's latest scope rather than the
      // original request. This row respects all real FKs; it contains no content.
      f.db.sqlite.prepare(`INSERT INTO agent_native_exit_holds
        (request_event_id,runtime_id,claim_attempt,owner_user_id,owner_device_id,project_id,session_id,harness,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(request, f.runtime.id, attempt, f.actor.user_id, f.actor.device_id,
        wrong.project_id, wrong.id, "codex", new Date().toISOString());
      if (deleted) f.service.deleteSession(f.actor, f.session.id);
      assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
      f.close(); closed = true;
      const old = new DatabaseSync(path);
      old.exec(`DROP TRIGGER agent_native_exit_hold_session_capture; DROP TRIGGER agent_native_exit_hold_runtime_capture;
        DROP TRIGGER agent_native_exit_hold_claim_capture; DROP TRIGGER agent_native_exit_hold_event_capture;
        ALTER TABLE agent_native_exit_holds DROP COLUMN origin_verified;`); old.close();
      reopened = new CollaborationDatabase(path); let service = new CollaborationService(reopened);
      const held = reopened.sqlite.prepare("SELECT * FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!;
      assert.equal(held.origin_verified, deleted ? 0 : 1);
      assert.equal(held.project_id, deleted ? wrong.project_id : f.session.project_id);
      assert.equal(held.session_id, deleted ? wrong.id : f.session.id);
      if (!deleted) {
        service.acknowledgeAgentExecutionStopped(f.actor, wrong.id, request, f.runtime.id, attempt);
        assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 1);
      } else {
        // Neither guessed project nor missing canonical scope is safe evidence
        // that a new project may use the same native pool.
        const next = service.createSession(f.actor, { mode: "multi", title: "Unrelated project", idempotency_key: "routing-upgrade-unrelated" }).session;
        const capability = { version: 1 as const, isolated: true as const, project_only: true as const, cancellation: true as const, liveness_watchdog: true as const };
        const profile = { harness: "codex" as const, provider: "synthetic", model: "routing-model" };
        const runtime = service.registerRuntime(f.actor, { ...f.registration, session_id: next.id, local_session_id: "routing-upgrade-independent", sharing_capability: capability });
        const peer = reopened.createIdentity({ display_name: "Upgrade fixture peer", device_name: "Upgrade fixture peer device" }).actor;
        service.setMembership(f.actor, next.id, peer.user_id, "participant", "routing-upgrade-member");
        const second = { ...f.actor, device_id: reopened.createDevice(f.actor.user_id, "Upgrade fixture other executor").device_id };
        sharing = new AgentSharing(service, { autoStart: false });
        sharing.sourceAvailability(f.actor, { project_id: next.project_id, source_runtime_id: runtime.id, state: "ready", idempotency_key: "routing-upgrade-ready" });
        const saved = sharing.save(f.actor, next.project_id, { source_runtime_id: runtime.id, execution_profile: profile,
          allowed_user_ids: [peer.user_id], limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "routing-upgrade-share" }).share;
        const enabled = sharing.control(f.actor, next.project_id, saved.id, { action: "enable", expected_revision: saved.revision, idempotency_key: "routing-upgrade-enable" }).share;
        const job = sharing.start(peer, next.id, { share_id: enabled.id, share_revision: enabled.revision, content: "Synthetic upgrade borrowed task",
          content_revision: 0, solo_transfer_ack: false, idempotency_key: "routing-upgrade-job" }).job;
        const ordinary = service.appendEvent(f.actor, next.id, { type: "agent_request", visibility: "session", idempotency_key: "routing-upgrade-ordinary",
          payload: { content: "Synthetic upgrade ordinary task", execution_profile: { ...profile, runtime_id: runtime.id } } });
        const busy = () => {
          assert.equal(reopened!.executionHoldIssue(runtime.id), "agent_team_native_exit_pending");
          assert.throws(() => service.claimAgentRequest(f.actor, next.id, ordinary.id, runtime.id), { code: "runtime_busy" });
          assert.throws(() => sharing!.claim(f.actor, job.id, { idempotency_key: "routing-upgrade-claim" }), { code: "agent_share_busy" });
        };
        busy();
        for (const [actor, receiptAttempt] of [[peer, attempt], [second, attempt], [f.actor, attempt + 1]] as const) {
          assert.deepEqual(service.acknowledgeAgentExecutionStopped(actor, f.session.id, request, f.runtime.id, receiptAttempt), { active: false }); busy();
        }
        service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
        const owned = service.claimAgentRequest(f.actor, next.id, ordinary.id, runtime.id);
        service.completeAgentRequest(f.actor, next.id, ordinary.id, runtime.id, "routing-upgrade-ordinary-done", { content: "Synthetic result" }, undefined, undefined, owned.attempt_count);
        assert.equal(sharing.claim(f.actor, job.id, { idempotency_key: "routing-upgrade-claim" }).job.status, "running");
      }
      service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
      assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!.n, 0);
      sharing?.close(); sharing = undefined; reopened.close(); reopened = new CollaborationDatabase(path); service = new CollaborationService(reopened);
      assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!.n, 0,
        "A second migration never resurrects an exact acknowledged exit");
      assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { sharing?.close(); reopened?.close(); if (!closed) f.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
