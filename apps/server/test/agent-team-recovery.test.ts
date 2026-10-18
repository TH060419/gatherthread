import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentShareLimitsSchema, type AgentTeamPlan } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentSharing } from "../src/agent-sharing.js";
import { AgentTeams } from "../src/agent-teams.js";

/** All identities and native executions are fictional; restart really closes and reopens SQLite. */
function recoveryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-recover-")), filename = join(directory, "state.sqlite");
  let time = Date.parse("2026-10-18T00:00:00.000Z"); const clock = () => new Date(time);
  let db = new CollaborationDatabase(filename, { clock, authTokenPepper: "synthetic-team-recovery-pepper" });
  let service = new CollaborationService(db);
  const owner = db.bootstrapIdentity({ display_name: "Recovery owner", device_name: "Native executor" }).actor;
  const borrower = db.createIdentity({ display_name: "Recovery borrower", device_name: "Browser one", can_create_projects: true }).actor;
  const browserTwo = { ...borrower, device_id: db.createDevice(borrower.user_id, "Browser two").device_id };
  const source = service.createSession(owner, { title: "Recovery source", mode: "multi", idempotency_key: "recovery-source" }).session;
  service.setMembership(owner, source.id, borrower.user_id, "participant", "recovery-member");
  const session = service.createSession(borrower, { project_id: source.project_id, title: "Recovery Solo", mode: "solo", idempotency_key: "recovery-solo" }).session;
  const runtime = service.registerRuntime(owner, { session_id: source.id, device_id: owner.device_id, harness: "codex",
    provider: "openai", model: "synthetic-recovery-model", local_session_id: "synthetic-recovery-native",
    capture_fidelity: "harness_transcript", context_deletion_version: 1,
    sharing_capability: { version: 1, isolated: true, project_only: true, cancellation: true, liveness_watchdog: true } });
  let sharing = new AgentSharing(service, { clock, autoStart: false });
  const ready = { project_id: source.project_id, source_runtime_id: runtime.id, state: "ready" as const, idempotency_key: "recovery-initial-ready" };
  sharing.sourceAvailability(owner, ready);
  const saved = sharing.save(owner, source.project_id, { source_runtime_id: runtime.id, allowed_user_ids: [borrower.user_id],
    limits: AgentShareLimitsSchema.parse({}), expected_revision: null, enabled: true, idempotency_key: "recovery-share" }).share;
  let teams = new AgentTeams(service, undefined, { sharing, clock, autoStart: false });
  const plan: AgentTeamPlan = { name: "Recovery team", team_prompt: "Return the public answer", nodes: [{ id: "worker", label: "Shared worker",
    role: "Answer the task", x: 0, y: 0, target: { kind: "shared", share_id: saved.id, share_revision: saved.revision,
      harness: "codex", provider: "openai", model: "synthetic-recovery-model" } }], edges: [] };
  const input = { plan, entry_node_id: "worker", content: "Calculate six times seven", max_calls: 1, max_duration_minutes: 30,
    content_revision: 0, solo_transfer_ack: true, idempotency_key: "recovery-task" };
  const start = () => teams.start(borrower, session.id, input).run;
  const current = (id: string) => teams.read(browserTwo, session.id, id).run;
  const restart = () => {
    teams.close(); sharing.close(); db.close();
    db = new CollaborationDatabase(filename, { clock, authTokenPepper: "synthetic-team-recovery-pepper" });
    service = new CollaborationService(db);
    // Match the production server's recovery ordering.
    db.failInterruptedHostedAgentJobs();
    sharing = new AgentSharing(service, { clock, autoStart: false });
    teams = new AgentTeams(service, undefined, { sharing, clock, autoStart: false });
  };
  return { owner, borrower, browserTwo, source, session, runtime, saved, ready, input, start, current, restart,
    get db() { return db; }, get service() { return service; }, get sharing() { return sharing; }, get teams() { return teams; },
    advance(ms: number) { time += ms; },
    close() { teams.close(); sharing.close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function drive(f: ReturnType<typeof recoveryFixture>, check: () => boolean) {
  for (let n = 0; n < 40 && !check(); n++) { await f.teams.pump(); await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(check(), "Recovery must reach the expected durable state");
}

test("a lost shared completion acknowledgment survives a real server restart and settles from another browser without another native call", async () => {
  const f = recoveryFixture(); try {
    const run = f.start(); await drive(f, () => f.current(run.id).calls_used === 1);
    const job = f.sharing.listJobs(f.owner, f.source.project_id).jobs[0]!;
    f.sharing.claim(f.owner, job.id, { idempotency_key: "recovery-complete-claim" });
    // The broker commits the answer, but the coordinator/browser never receives its wakeup/ACK.
    f.teams.close();
    const finish = { claim_attempt: 1, idempotency_key: "recovery-complete-answer", observed_model: "synthetic-recovery-model",
      outcome: "completed" as const, executor_stopped: true as const, payload: { content: "42", status: "completed" } };
    const result = f.sharing.complete(f.owner, job.id, finish);
    f.restart();
    assert.equal(f.current(run.id).status, "paused");
    assert.equal(f.sharing.store.row(f.saved.id).enabled, 0);
    const beforeHead = f.db.requireSession(f.session.id).next_sequence;
    const replay = f.sharing.complete(f.owner, job.id, finish);
    assert.equal(replay.replayed, true); assert.equal(replay.event.id, result.event.id);
    const resume = { action: "resume" as const, idempotency_key: "recovery-completed-resume" };
    f.teams.control(f.browserTwo, f.session.id, run.id, resume);
    f.teams.control(f.borrower, f.session.id, run.id, resume);
    await drive(f, () => f.current(run.id).status === "completed");
    assert.equal(f.current(run.id).calls_used, 1); assert.equal(f.current(run.id).steps.length, 1);
    assert.equal(f.current(run.id).steps[0]!.response_event_id, result.event.id);
    assert.equal(f.db.requireSession(f.session.id).next_sequence, beforeHead);
    assert.equal(f.sharing.store.usage(f.sharing.store.row(f.saved.id), f.borrower.user_id).calls, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_share_jobs").get()!.n, 1);
  } finally { f.close(); }
});

test("interrupted shared work stays fenced across reconnect, lost cleanup ACK and an explicit new grant epoch", async () => {
  const f = recoveryFixture(); try {
    const run = f.start(); await drive(f, () => f.current(run.id).calls_used === 1);
    const job = f.sharing.listJobs(f.owner, f.source.project_id).jobs[0]!;
    f.sharing.claim(f.owner, job.id, { idempotency_key: "recovery-interrupted-claim" });
    f.advance(4000); f.restart();
    assert.equal(f.current(run.id).status, "paused"); assert.equal(f.current(run.id).calls_used, 1);
    const cancelled = f.sharing.store.job(job.id);
    assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.cleanup_pending, 1);
    assert.equal(cancelled.seconds_reserved, 720);
    f.sharing.sourceAvailability(f.owner, f.ready); // Replay of an old READY is never an enable operation.
    assert.equal(f.sharing.store.row(f.saved.id).enabled, 0);
    assert.throws(() => f.sharing.complete(f.owner, job.id, { claim_attempt: 1,
      idempotency_key: "recovery-interrupted-late-answer", observed_model: "synthetic-recovery-model", outcome: "completed",
      executor_stopped: true, payload: { content: "Late answer must be rejected" } }), { code: "agent_share_lease_expired" });
    const revision = f.sharing.store.row(f.saved.id).revision;
    f.sharing.control(f.owner, f.source.project_id, f.saved.id, { action: "enable", expected_revision: revision,
      idempotency_key: "recovery-manual-enable" });
    assert.throws(() => f.teams.control(f.browserTwo, f.session.id, run.id, { action: "resume", idempotency_key: "recovery-old-grant-resume" }),
      { code: "agent_share_revoked" });
    const cleanup = { claim_attempt: 1, executor_stopped: true as const, idempotency_key: "recovery-cleanup-once" };
    f.sharing.abortAck(f.owner, job.id, cleanup);
    const settled = f.sharing.store.usage(f.sharing.store.row(f.saved.id), f.borrower.user_id);
    assert.equal(settled.seconds_reserved, 0); assert.equal(settled.seconds_used, 4); assert.equal(settled.calls, 1);
    f.restart();
    assert.equal(f.sharing.abortAck(f.owner, job.id, cleanup).replayed, true);
    assert.deepEqual(f.sharing.store.usage(f.sharing.store.row(f.saved.id), f.borrower.user_id), settled);
    assert.equal(f.sharing.store.job(job.id).cleanup_pending, 0);
    assert.equal(f.teams.start(f.browserTwo, f.session.id, f.input).replayed, true);
    assert.equal(f.current(run.id).status, "paused"); assert.equal(f.current(run.id).steps.length, 1);
  } finally { f.close(); }
});

test("one source losing its execution lease cancels two borrowers' queued and running Teams without releasing unknown native cleanup", async () => {
  const f = recoveryFixture(); try {
    const second = f.db.createIdentity({ display_name: "Second recovery borrower", device_name: "Second borrower browser", can_create_projects: true }).actor;
    f.service.setMembership(f.owner, f.source.id, second.user_id, "participant", "recovery-second-member");
    const secondSolo = f.service.createSession(second, { project_id: f.source.project_id, title: "Second recovery Solo", mode: "solo",
      idempotency_key: "recovery-second-solo" }).session;
    const granted = f.sharing.save(f.owner, f.source.project_id, { share_id: f.saved.id, source_runtime_id: f.runtime.id,
      expected_revision: f.saved.revision, enabled: true, allowed_user_ids: [f.borrower.user_id, second.user_id],
      limits: AgentShareLimitsSchema.parse({}), idempotency_key: "recovery-two-borrowers" }).share;
    const plan = structuredClone(f.input.plan);
    assert.equal(plan.nodes[0]!.target.kind, "shared");
    if (plan.nodes[0]!.target.kind !== "shared") throw new Error("Expected a shared target");
    plan.nodes[0]!.target.share_revision = granted.revision;
    const firstRun = f.teams.start(f.borrower, f.session.id, { ...f.input, plan }).run;
    const secondRun = f.teams.start(second, secondSolo.id, { ...f.input, plan, idempotency_key: "recovery-second-task" }).run;
    await drive(f, () => f.current(firstRun.id).calls_used === 1 && f.teams.read(second, secondSolo.id, secondRun.id).run.calls_used === 1);
    const jobs = f.sharing.listJobs(f.owner, f.source.project_id).jobs;
    assert.equal(jobs.length, 2);
    const running = jobs.find(job => job.requester_user_id === f.borrower.user_id)!;
    const queued = jobs.find(job => job.requester_user_id === second.user_id)!;
    f.sharing.claim(f.owner, running.id, { idempotency_key: "recovery-two-running" });
    assert.throws(() => f.sharing.claim(f.owner, queued.id, { idempotency_key: "recovery-two-queued" }), { code: "agent_share_busy" });
    f.advance(15000); f.sharing.pump();
    assert.equal(f.sharing.store.row(f.saved.id).enabled, 0);
    assert.equal(f.sharing.store.job(running.id).status, "cancelled");
    assert.equal(f.sharing.store.job(queued.id).status, "cancelled");
    assert.equal(f.sharing.store.job(running.id).cleanup_pending, 1);
    assert.equal(f.sharing.store.job(queued.id).cleanup_pending, 0);
    const ownerUsage = f.sharing.store.usage(f.sharing.store.row(f.saved.id), "");
    assert.equal(ownerUsage.calls, 2); assert.equal(ownerUsage.seconds_reserved, 720);
    f.sharing.sourceAvailability(f.owner, { ...f.ready, idempotency_key: "recovery-source-reconnected" });
    assert.equal(f.sharing.store.row(f.saved.id).enabled, 0);
    await drive(f, () => f.current(firstRun.id).status === "failed" && f.teams.read(second, secondSolo.id, secondRun.id).run.status === "failed");
    assert.equal(f.current(firstRun.id).calls_used, 1); assert.equal(f.teams.read(second, secondSolo.id, secondRun.id).run.calls_used, 1);
    assert.throws(() => f.sharing.claim(f.owner, queued.id, { idempotency_key: "recovery-offline-queue-retry" }), { code: "conflict" });
    f.sharing.abortAck(f.owner, running.id, { claim_attempt: 1, executor_stopped: true, idempotency_key: "recovery-source-exit-confirmed" });
    const settled = f.sharing.store.usage(f.sharing.store.row(f.saved.id), "");
    assert.equal(settled.seconds_reserved, 0); assert.equal(settled.seconds_used, 15); assert.equal(settled.calls, 2);
  } finally { f.close(); }
});
