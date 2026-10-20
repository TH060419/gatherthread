import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";
import { startCollaborationServer } from "../src/server.js";
import { identityFixture } from "./auth-fixtures.js";
import { AgentShareLimitsSchema, type AgentTeamPlan, type CanonicalEvent } from "@gatherthread/protocol";
import { AgentSharing } from "../src/agent-sharing.js";

const dropNativeCaptureTriggers = `DROP TRIGGER IF EXISTS agent_native_exit_hold_session_capture;
  DROP TRIGGER IF EXISTS agent_native_exit_hold_runtime_capture; DROP TRIGGER IF EXISTS agent_native_exit_hold_claim_capture;
  DROP TRIGGER IF EXISTS agent_native_exit_hold_event_capture;
  DROP INDEX IF EXISTS agent_request_claims_native_pending_idx;`;

function fixture(path = ":memory:") {
  let time = Date.now(), key = 0;
  const clock = () => new Date(time), db = new CollaborationDatabase(path, { clock });
  const service = new CollaborationService(db), actor = db.bootstrapIdentity({ display_name: "Synthetic owner", device_name: "Synthetic executor" }).actor;
  const session = service.createSession(actor, { title: "Native exit control", mode: "multi", idempotency_key: "native-exit-session" }).session;
  const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id,
    harness: "codex", provider: "synthetic", model: "synthetic-model", context_deletion_version: 1,
    local_session_id: "synthetic-turn", capture_fidelity: "harness_transcript" });
  const teams = new AgentTeams(service, undefined, { clock, autoStart: false });
  const plan: AgentTeamPlan = { name: "Synthetic exit Team", team_prompt: "", entry_node_id: "lead", nodes: [
    { id: "lead", label: "Lead", role: "Review", x: 0, y: 0, target: { kind: "local", runtime_id: runtime.id,
      harness: "codex", provider: "synthetic", model: "synthetic-model" } }], edges: [] };
  const ordinary = () => service.appendEvent(actor, session.id, { type: "agent_request", visibility: "session",
    idempotency_key: `native-next-${++key}`, payload: { content: "A separate synthetic request", harness: "codex",
      runtime_id: runtime.id, provider: "synthetic", model: "synthetic-model" } });
  const start = async () => {
    const run = teams.start(actor, session.id, { plan, entry_node_id: "lead", content: "Synthetic task", max_calls: 1,
      max_duration_minutes: 1, content_revision: 0, idempotency_key: `native-exit-start-${++key}` }).run;
    await teams.pump();
    const request = teams.store.steps(run.id)[0]!.request_event_id!;
    assert.ok(request);
    const claim = service.claimAgentRequest(actor, session.id, request, runtime.id);
    return { run, request, claim };
  };
  return { db, service, actor, session, runtime, teams, ordinary, start, advance: (ms: number) => { time += ms; },
    close() { teams.close(); db.close(); } };
}

for (const action of ["pause", "stop", "deadline"] as const) test(`native ${action} fences work but retains capacity until exact exit acknowledgment`, async () => {
  const f = fixture(); try {
    const { run, request, claim } = await f.start(), attempt = claim.attempt_count!;
    assert.deepEqual(f.service.readAgentExecution(f.actor, f.session.id, request, f.runtime.id, attempt), { active: true });
    if (action === "deadline") { f.advance(61_000); await f.teams.pump(); }
    else f.teams.control(f.actor, f.session.id, run.id, { action, idempotency_key: `native-${action}-control` });
    assert.equal(f.teams.store.row(run.id).status, action === "deadline" ? "timed_out" : action === "pause" ? "paused" : "stopped");
    assert.deepEqual(f.service.readAgentExecution(f.actor, f.session.id, request, f.runtime.id, attempt), { active: false });
    const next = f.ordinary();
    f.advance(6 * 60_000); // Waiting for a lease is not proof that the process exited.
    f.service.heartbeatRuntime(f.actor, f.runtime.id);
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id), { code: "runtime_busy" });
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt + 1);
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id), { code: "runtime_busy" });
    f.service.heartbeatRuntime(f.actor, f.runtime.id);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, attempt);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id).status, "claimed");
  } finally { f.close(); }
});

test("Forget cannot release an unconfirmed native exit or hide its content-free stop signal", async () => {
  const f = fixture(); try {
    const { run, request, claim } = await f.start();
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "native-exit-forget-stop" });
    f.teams.forget(f.actor, f.session.id, run.id);
    assert.equal(f.service.readAgentExecution(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!).active, false);
    const next = f.ordinary();
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id), { code: "runtime_busy" });
    const other = f.db.createDevice(f.actor.user_id, "Synthetic different device");
    const otherDevice = { ...f.actor, device_id: other.device.id };
    assert.deepEqual(f.service.acknowledgeAgentExecutionStopped(otherDevice, f.session.id, request, f.runtime.id, claim.attempt_count!), { active: false });
    assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id).status, "claimed");
  } finally { f.close(); }
});

test("a completed native turn releases its hold while a delayed older exit cannot clear a newer attempt", async () => {
  const f = fixture(); try {
    const { request, claim } = await f.start();
    f.db.sqlite.prepare("UPDATE agent_request_claims SET attempt_count=2 WHERE request_event_id=?").run(request);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!);
    assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
    f.service.completeAgentRequest(f.actor, f.session.id, request, f.runtime.id, "native-confirmed-final", { content: "Synthetic final answer" }, undefined, undefined, 2);
    assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 0);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, f.ordinary().id, f.runtime.id).status, "claimed");
  } finally { f.close(); }
});

test("exact stopped cleanup is permitted for a revoked runtime without granting renewed execution", async () => {
  const f = fixture(); try {
    const { run, request, claim } = await f.start();
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "native-revoked-stop" });
    f.db.sqlite.prepare("UPDATE runtimes SET status='revoked' WHERE id=?").run(f.runtime.id);
    assert.throws(() => f.service.readAgentExecution(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!), { code: "forbidden" });
    assert.deepEqual(f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!), { active: false });
    assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 0);
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, f.ordinary().id, f.runtime.id), { code: "conflict" });
  } finally { f.close(); }
});

test("exit cleanup survives access and history invalidation without restoring execution authority", async t => {
  for (const change of ["viewer", "removed", "archived", "history_erased", "request_erased", "authorizer_revoked"] as const) {
    await t.test(change, async () => {
      const f = fixture(); try {
        const requester = f.db.createIdentity({ display_name: "Synthetic participant", device_name: "Synthetic browser" }).actor;
        f.service.setMembership(f.actor, f.session.id, requester.user_id, "participant", `exit-member-${change}`);
        const native = { ...requester, device_id: f.db.createDevice(requester.user_id, "Independent native executor").device_id };
        const runtime = f.service.registerRuntime(native, { session_id: f.session.id, device_id: native.device_id,
          harness: "codex", provider: "synthetic", model: "synthetic-model", context_deletion_version: 1,
          local_session_id: `exit-invalidated-${change}`, capture_fidelity: "harness_transcript" });
        const source = f.service.appendEvent(requester, f.session.id, { type: "human_chat", visibility: "session",
          idempotency_key: `exit-source-${change}`, payload: { content: "Synthetic source that may be erased" } });
        const plan: AgentTeamPlan = { name: "Synthetic invalidation Team", team_prompt: "", nodes: [{
          id: "lead", label: "Lead", role: "", x: 0, y: 0, target: { kind: "local", runtime_id: runtime.id,
            harness: "codex", provider: "synthetic", model: "synthetic-model" } }], edges: [] };
        const run = f.teams.start(requester, f.session.id, { plan, entry_node_id: "lead", content: "Synthetic task",
          content_revision: 0, max_calls: 2, max_duration_minutes: 1, idempotency_key: `exit-invalidation-${change}` }).run;
        await f.teams.pump();
        const request = f.teams.store.steps(run.id)[0]!.request_event_id!;
        const claim = f.service.claimAgentRequest(native, f.session.id, request, runtime.id);
        if (change === "viewer") f.service.setMembership(f.actor, f.session.id, requester.user_id, "viewer", "exit-downgrade");
        else if (change === "removed") f.service.removeMembership(f.actor, f.session.id, requester.user_id, "exit-remove");
        else if (change === "archived") f.service.updateSession(f.actor, f.session.id, { state: "archived", idempotency_key: "exit-archive" });
        else if (change === "authorizer_revoked") f.db.revokeDevice(native, requester.device_id);
        else f.service.deleteMessage(requester, f.session.id, change === "request_erased" ? request : source.id, "exit-erase");
        assert.equal(f.db.teamRequestMayExecute(request), false, "invalidation fences native execution before coordinator maintenance");
        await f.teams.pump();
        const hold = () => f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending;
        assert.equal(hold(), 1, "authorization or erasure is not proof that a native process exited");
        if (change === "authorizer_revoked") assert.throws(() => f.service.acknowledgeAgentExecutionStopped(requester, f.session.id, request, runtime.id, claim.attempt_count!));
        else assert.deepEqual(f.service.acknowledgeAgentExecutionStopped(requester, f.session.id, request, runtime.id, claim.attempt_count!), { active: false });
        assert.equal(hold(), 1);
        assert.deepEqual(f.service.acknowledgeAgentExecutionStopped(native, f.session.id, request, runtime.id, claim.attempt_count!), { active: false });
        assert.equal(hold(), 0);
        assert.deepEqual(f.service.acknowledgeAgentExecutionStopped(native, f.session.id, request, runtime.id, claim.attempt_count!), { active: false });
        assert.throws(() => f.service.completeAgentRequest(native, f.session.id, request, runtime.id, "exit-invalidated-answer",
          { content: "Must not publish after invalidation" }, undefined, undefined, claim.attempt_count));
        assert.equal(f.db.teamRequestMayExecute(request), false, "metadata cleanup never renews the frozen Team grant");
      } finally { f.close(); }
    });
  }
});

test("a confirmed-exit receipt converges after its entire session was deleted", async () => {
  const f = fixture(); try {
    const { request, claim } = await f.start();
    f.service.deleteSession(f.actor, f.session.id);
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_request_claims WHERE request_event_id=?").get(request), undefined);
    const acknowledge = () => f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!);
    assert.deepEqual(acknowledge(), { active: false }, "there is no surviving hold, so a durable confirmed-exit receipt must not retry a permanent 404 forever");
    assert.deepEqual(acknowledge(), { active: false });
    f.db.revokeDevice(f.actor, f.actor.device_id);
    assert.throws(acknowledge, "even a no-op receipt requires an active authenticated device");
  } finally { f.close(); }
});

test("deleting a session retains its native pool hold across restart until the exact old executor confirms exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-detached-native-exit-")), path = join(directory, "server.sqlite"), f = fixture(path);
  let closed = false, reopened: CollaborationDatabase | undefined, sharing: AgentSharing | undefined;
  try {
    const { request, claim } = await f.start(), oldSession = f.session.id, oldRuntime = f.runtime.id;
    const peer = f.db.createIdentity({ display_name: "Synthetic borrower", device_name: "Synthetic borrower device" }).actor;
    f.service.deleteSession(f.actor, oldSession);
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_request_claims WHERE request_event_id=?").get(request), undefined);
    const held = f.db.sqlite.prepare("SELECT * FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!;
    assert.equal(held.runtime_id, oldRuntime); assert.equal(held.owner_device_id, f.actor.device_id);
    for (const secret of ["Synthetic task", "Synthetic exit Team", "Review", "synthetic-turn"]) assert.equal(JSON.stringify(held).includes(secret), false);
    f.close(); closed = true;
    reopened = new CollaborationDatabase(path); const service = new CollaborationService(reopened);
    assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!.n, 1);
    const next = service.createSession(f.actor, { project_id: f.session.project_id, mode: "multi", title: "Replacement native session",
      idempotency_key: "detached-next-session" }).session;
    service.setMembership(f.actor, next.id, peer.user_id, "participant", "detached-peer-membership");
    const capability = { version: 1 as const, isolated: true as const, project_only: true as const, cancellation: true as const, liveness_watchdog: true as const };
    const profile = { harness: "codex" as const, provider: "synthetic", model: "synthetic-model" };
    const runtime = service.registerRuntime(f.actor, { session_id: next.id, device_id: f.actor.device_id, ...profile,
      sharing_capability: capability, context_deletion_version: 1, local_session_id: "replacement-synthetic-native", capture_fidelity: "harness_transcript" });
    sharing = new AgentSharing(service, { autoStart: false });
    sharing.sourceAvailability(f.actor, { project_id: next.project_id, source_runtime_id: runtime.id, state: "ready", idempotency_key: "detached-native-ready" });
    const saved = sharing.save(f.actor, next.project_id, { source_runtime_id: runtime.id, execution_profile: profile,
      allowed_user_ids: [peer.user_id], limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "detached-save-share" }).share;
    const enabled = sharing.control(f.actor, next.project_id, saved.id, { action: "enable", expected_revision: saved.revision,
      idempotency_key: "detached-enable-share" }).share;
    const borrowed = sharing.start(peer, next.id, { share_id: enabled.id, share_revision: enabled.revision,
      content: "Synthetic borrowed request", content_revision: 0, solo_transfer_ack: false, idempotency_key: "detached-borrowed" });
    const ordinary = service.appendEvent(f.actor, next.id, { type: "agent_request", visibility: "session", idempotency_key: "detached-ordinary",
      payload: { content: "Synthetic ordinary task", execution_profile: { ...profile, runtime_id: runtime.id } } });
    const busy = () => {
      assert.throws(() => service.claimAgentRequest(f.actor, next.id, ordinary.id, runtime.id), { code: "runtime_busy" });
      assert.throws(() => sharing!.claim(f.actor, borrowed.job.id, { idempotency_key: "detached-share-claim" }), { code: "agent_share_busy" });
    };
    busy();
    const otherDevice = { ...f.actor, device_id: reopened.createDevice(f.actor.user_id, "Another synthetic device").device_id };
    for (const [actor, attempt] of [[peer, claim.attempt_count!], [otherDevice, claim.attempt_count!], [f.actor, claim.attempt_count! + 1]] as const) {
      assert.deepEqual(service.acknowledgeAgentExecutionStopped(actor, oldSession, request, oldRuntime, attempt), { active: false });
      busy();
    }
    assert.deepEqual(service.acknowledgeAgentExecutionStopped(f.actor, oldSession, request, oldRuntime, claim.attempt_count!), { active: false });
    assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 0);
    const owned = service.claimAgentRequest(f.actor, next.id, ordinary.id, runtime.id);
    service.completeAgentRequest(f.actor, next.id, ordinary.id, runtime.id, "detached-ordinary-finished", { content: "Synthetic completed result" }, undefined, undefined, owned.attempt_count);
    assert.equal(sharing.claim(f.actor, borrowed.job.id, { idempotency_key: "detached-share-claim" }).job.status, "running");
    assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { sharing?.close(); reopened?.close(); if (!closed) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("project deletion preserves exact native exit metadata without project/session foreign-key resurrection", async () => {
  const f = fixture(); try {
    const { request, claim } = await f.start();
    f.service.deleteProject(f.actor, f.session.project_id);
    const held = f.db.sqlite.prepare("SELECT * FROM agent_native_exit_holds WHERE request_event_id=?").get(request)!;
    assert.equal(held.project_id, f.session.project_id); assert.equal(held.session_id, f.session.id);
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM projects WHERE id=?").get(f.session.project_id), undefined);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 0);
    assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.close(); }
});

test("detached native hold capture rolls back with refused session deletion and account deletion clears only its owner's holds", async () => {
  const f = fixture(); try {
    const { request } = await f.start();
    f.db.sqlite.exec(`CREATE TRIGGER synthetic_refused_history_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT,'Synthetic deletion refused'); END;`);
    assert.throws(() => f.service.deleteSession(f.actor, f.session.id), /Synthetic deletion refused/u);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
    assert.equal(f.db.requireSession(f.session.id).id, f.session.id);
    f.db.sqlite.exec("DROP TRIGGER synthetic_refused_history_delete");
    f.service.deleteProject(f.actor, f.session.project_id);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n, 1);
    const peer = f.db.createIdentity({ display_name: "Another hold owner", device_name: "Another native device" }).actor;
    f.db.sqlite.prepare(`INSERT INTO agent_native_exit_holds
      (request_event_id,runtime_id,claim_attempt,owner_user_id,owner_device_id,project_id,session_id,harness,created_at)
      VALUES('unrelated-native-request','unrelated-native-runtime',1,?,?,?,?,'codex',?)`)
      .run(peer.user_id, peer.device_id, f.session.project_id, f.session.id, new Date().toISOString());
    f.service.deleteAccount(f.actor);
    const remaining = f.db.sqlite.prepare("SELECT request_event_id,owner_user_id FROM agent_native_exit_holds").all();
    assert.equal(remaining.length, 1); assert.equal(remaining[0]!.request_event_id, "unrelated-native-request");
    assert.equal(remaining[0]!.owner_user_id, peer.user_id);
    assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.close(); }
});

test("native hold storage admits no new Team hold at capacity while ordinary execution and exact cleanup remain available", async () => {
  const f = fixture(); try {
    const insert = f.db.sqlite.prepare(`INSERT INTO agent_native_exit_holds
      (request_event_id,runtime_id,claim_attempt,owner_user_id,owner_device_id,project_id,session_id,harness,created_at,origin_verified)
      VALUES(?,?,1,?,?,?,?,?,?,1)`);
    f.db.sqlite.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 1000; index++) insert.run(`detached-cap-${index}`, `detached-runtime-${index}`, f.actor.user_id,
      f.actor.device_id, f.session.project_id, f.session.id, "codex", new Date().toISOString());
    f.db.sqlite.exec("COMMIT");
    assert.equal(f.db.executionHoldIssue(f.runtime.id), "agent_team_native_exit_pending");
    const session = f.service.createSession(f.actor, { mode: "multi", title: "Independent native project", idempotency_key: "native-cap-new-project" }).session;
    const runtime = f.service.registerRuntime(f.actor, { session_id: session.id, device_id: f.actor.device_id, harness: "codex",
      provider: "synthetic", model: "synthetic-model", context_deletion_version: 1, local_session_id: "native-cap-other-project", capture_fidelity: "harness_transcript" });
    assert.equal(f.db.executionHoldIssue(runtime.id), "agent_team_native_hold_capacity");
    assert.equal(f.db.executionHoldIssue(runtime.id, false), undefined);
    const ordinary = f.service.appendEvent(f.actor, session.id, { type: "agent_request", visibility: "session", idempotency_key: "native-cap-ordinary",
      payload: { content: "Ordinary task has no new exit-hold storage charge", execution_profile: {
        harness: "codex", provider: "synthetic", model: "synthetic-model", runtime_id: runtime.id } } });
    const own = f.service.claimAgentRequest(f.actor, session.id, ordinary.id, runtime.id);
    f.service.completeAgentRequest(f.actor, session.id, ordinary.id, runtime.id, "native-cap-ordinary-done", { content: "Completed" }, undefined, undefined, own.attempt_count);
    const plan: AgentTeamPlan = { name: "Native hold capacity", team_prompt: "", nodes: [{ id: "lead", label: "Lead", role: "", x: 0, y: 0,
      target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "synthetic", model: "synthetic-model" } }], edges: [] };
    const run = f.teams.start(f.actor, session.id, { plan, entry_node_id: "lead", content: "A new bounded Team task",
      max_calls: 1, max_duration_minutes: 1, content_revision: 0, idempotency_key: "native-cap-team" }).run;
    await f.teams.pump(); const request = f.teams.store.steps(run.id)[0]!.request_event_id!;
    assert.deepEqual(f.teams.read(f.actor, session.id, run.id).run.issue, {
      code: "agent_team_native_hold_capacity", node_id: null, node_label: null, target_kind: null, retry_at: null,
    });
    assert.throws(() => f.service.claimAgentRequest(f.actor, session.id, request, runtime.id), { code: "agent_team_native_hold_capacity", status: 429 });
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_request_claims WHERE request_event_id=?").get(request), undefined);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, "detached-cap-0", "detached-runtime-0", 2);
    assert.equal(f.db.executionHoldIssue(runtime.id), "agent_team_native_hold_capacity");
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, "detached-cap-0", "detached-runtime-0", 1);
    assert.equal(f.db.executionHoldIssue(runtime.id), undefined);
    assert.equal(f.teams.read(f.actor, session.id, run.id).run.issue?.code, "agent_team_waiting_executor");
    assert.equal(f.service.claimAgentRequest(f.actor, session.id, request, runtime.id).status, "claimed");
  } finally { f.close(); }
});

test("unauthorized exit acknowledgment has the same response before and after another user's claim", () => {
  const f = fixture(); try {
    const outsider = f.db.createIdentity({ display_name: "Synthetic outsider", device_name: "Synthetic outsider device" }).actor;
    const request = f.ordinary();
    const acknowledge = () => f.service.acknowledgeAgentExecutionStopped(outsider, f.session.id, request.id, f.runtime.id, 1);
    assert.deepEqual(acknowledge(), { active: false });
    f.service.claimAgentRequest(f.actor, f.session.id, request.id, f.runtime.id);
    const before = f.db.sqlite.prepare("SELECT * FROM agent_request_claims WHERE request_event_id=?").get(request.id);
    assert.deepEqual(acknowledge(), { active: false });
    assert.deepEqual(f.db.sqlite.prepare("SELECT * FROM agent_request_claims WHERE request_event_id=?").get(request.id), before);
  } finally { f.close(); }
});

test("migration conservatively retains a paused native exit after the old Team request payload was erased", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-erased-native-exit-migrate-")), path = join(directory, "server.sqlite"), f = fixture(path);
  let closed = false;
  try {
    const { request } = await f.start();
    f.service.deleteMessage(f.actor, f.session.id, request, "native-upgrade-erase");
    assert.equal(f.db.sqlite.prepare("SELECT json_type(payload_json,'$.agent_team') AS team FROM events WHERE id=?").get(request)!.team, null);
    f.close(); closed = true;
    const sql = new DatabaseSync(path); sql.exec(dropNativeCaptureTriggers + "ALTER TABLE agent_request_claims DROP COLUMN execution_pending"); sql.close();
    const migrated = new CollaborationDatabase(path); try {
      assert.equal(migrated.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
      assert.deepEqual(migrated.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { migrated.close(); }
  } finally { if (!closed) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("migration retains legacy failed Team executions despite a server-generated failure answer, including erased requests", async t => {
  for (const erased of [false, true]) await t.test(erased ? "erased failed request" : "failed request with canonical server answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-failed-native-exit-migrate-")), path = join(directory, "server.sqlite"), f = fixture(path);
    let closed = false;
    try {
      const finishedOrdinary = f.ordinary();
      const ordinaryClaim = f.service.claimAgentRequest(f.actor, f.session.id, finishedOrdinary.id, f.runtime.id);
      f.service.completeAgentRequest(f.actor, f.session.id, finishedOrdinary.id, f.runtime.id, "legacy-ordinary-completed",
        { content: "A confirmed completed ordinary turn" }, undefined, undefined, ordinaryClaim.attempt_count);
      const { request, claim } = await f.start();
      // Exercise the historical server's actual lease-abandonment transition:
      // its canonical error answer was never a native process exit receipt.
      const legacy = f.db as unknown as { failAbandonedClaim(session: string, request: CanonicalEvent, harness: string): CanonicalEvent | undefined };
      const failed = legacy.failAbandonedClaim(f.session.id, f.db.getEvent(f.session.id, request), "codex")!;
      assert.equal(failed.type, "agent_response"); assert.equal((failed.payload as { status: string }).status, "failed");
      if (erased) f.service.deleteMessage(f.actor, f.session.id, request, "legacy-failed-erasure");
      assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "failed");
      f.close(); closed = true;
      const old = new DatabaseSync(path); old.exec(dropNativeCaptureTriggers + "ALTER TABLE agent_request_claims DROP COLUMN execution_pending"); old.close();
      const migrated = new CollaborationDatabase(path); try {
        const service = new CollaborationService(migrated);
        assert.equal(migrated.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
        assert.equal(migrated.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(finishedOrdinary.id)!.execution_pending, 0);
        if (!erased) assert.equal((migrated.getEvent(f.session.id, failed.id).payload as { status: string }).status, "failed");
        const next = service.appendEvent(f.actor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: "after-legacy-failure",
          content_revision: migrated.requireSession(f.session.id).content_revision ?? 0, payload: { content: "A later independent ordinary request",
            execution_profile: { runtime_id: f.runtime.id, harness: "codex", provider: "synthetic", model: "synthetic-model" } } });
        assert.throws(() => service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id), { code: "runtime_busy" });
        service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.runtime.id, claim.attempt_count!);
        assert.equal(service.claimAgentRequest(f.actor, f.session.id, next.id, f.runtime.id).status, "claimed");
        assert.deepEqual(migrated.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { migrated.close(); }
    } finally { if (!closed) f.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

test("native exit holds migrate once, survive reopen and require an exact authenticated executor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-native-exit-migrate-")), path = join(directory, "server.sqlite");
  const f = fixture(path); let request = "", actor = f.actor, runtime = f.runtime, session = f.session;
  try {
    const started = await f.start(); request = started.request;
    f.teams.control(actor, session.id, started.run.id, { action: "stop", idempotency_key: "native-migration-stop" });
    f.close();
    const sql = new DatabaseSync(path); sql.exec(dropNativeCaptureTriggers + "ALTER TABLE agent_request_claims DROP COLUMN execution_pending"); sql.close();
    for (let index = 0; index < 2; index++) {
      const db = new CollaborationDatabase(path); try {
        assert.equal(db.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
        assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { db.close(); }
    }
  } finally { if (!request) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("native execution HTTP control requires versioned claims and validates exact attempt and actor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-native-exit-http-"));
  const server = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"), authTokenPepper: "synthetic-native-exit-http-pepper-long-enough" }, 0);
  const teams = new AgentTeams(server.service, undefined, { autoStart: false });
  try {
    const identity = identityFixture(server, {}).body.data, actor = identity.actor;
    const session = server.service.createSession(actor, { title: "Synthetic native HTTP", mode: "multi", idempotency_key: "native-http-session" }).session;
    const runtime = server.service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "synthetic", model: "fixture",
      context_deletion_version: 1, capture_fidelity: "harness_transcript", local_session_id: "native-http" });
    const plan: AgentTeamPlan = { name: "Synthetic HTTP Team", team_prompt: "", entry_node_id: "lead", nodes: [{ id: "lead", label: "Lead", role: "", x: 0, y: 0,
      target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "synthetic", model: "fixture" } }], edges: [] };
    const run = teams.start(actor, session.id, { plan, entry_node_id: "lead", content: "Synthetic task", max_calls: 1, max_duration_minutes: 1,
      content_revision: 0, idempotency_key: "native-http-start" }).run;
    await teams.pump(); const request = teams.store.steps(run.id)[0]!.request_event_id!;
    const base = `${server.origin}/v1/sessions/${session.id}/agent-requests/${request}`;
    const call = async (path: string, method: string, body?: unknown, token = identity.token) => {
      const result = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: result.status, body: await result.json() as { data?: any; error?: { code: string } } };
    };
    assert.equal((await call("/claim", "POST", { runtime_id: runtime.id })).body.error?.code, "agent_execution_control_required");
    assert.equal((await call("/claim", "POST", { runtime_id: runtime.id, execution_control_version: 1 })).status, 200);
    const query = `?runtime_id=${runtime.id}&claim_attempt=1`;
    assert.deepEqual((await call("/execution" + query, "GET")).body.data, { active: true });
    assert.equal((await call(`/execution?runtime_id=${runtime.id}&claim_attempt=0`, "GET")).status, 400);
    assert.equal((await call("/execution/stopped", "POST", { runtime_id: runtime.id, claim_attempt: 1, extra: true })).status, 400);
    const second = server.database.createDevice(actor.user_id, "Synthetic different native device");
    assert.equal((await call("/execution" + query, "GET", undefined, second.token)).status, 403);
    assert.deepEqual((await call("/execution/stopped", "POST", { runtime_id: runtime.id, claim_attempt: 1 }, second.token)).body.data, { active: false });
    assert.equal(server.database.sqlite.prepare("SELECT execution_pending FROM agent_request_claims WHERE request_event_id=?").get(request)!.execution_pending, 1);
    teams.control(actor, session.id, run.id, { action: "stop", idempotency_key: "native-http-stop" });
    assert.deepEqual((await call("/execution" + query, "GET")).body.data, { active: false });
    assert.deepEqual((await call("/execution/stopped", "POST", { runtime_id: runtime.id, claim_attempt: 1 })).body.data, { active: false });
    server.service.deleteSession(actor, session.id);
    assert.equal((await call("/execution" + query, "GET")).status, 404, "a deleted session cannot be read through execution observation");
    assert.deepEqual((await call("/execution/stopped", "POST", { runtime_id: runtime.id, claim_attempt: 1 })).body.data,
      { active: false }, "only confirmed-exit cleanup converges after the request and hold were deleted");
  } finally { teams.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
