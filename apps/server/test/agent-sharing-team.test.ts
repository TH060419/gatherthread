import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentShareLimitsSchema, type AgentTeamPlan } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentSharing } from "../src/agent-sharing.js";
import { AgentTeams } from "../src/agent-teams.js";
import { AgentTeamLibrary } from "../src/agent-team-library.js";
import { ApiError } from "../src/errors.js";
import { redactJson } from "../src/redaction.js";

function setup(limits = AgentShareLimitsSchema.parse({})) {
  let now = Date.parse("2026-10-15T05:00:00.000Z"); const clock = () => new Date(now);
  const db = new CollaborationDatabase(":memory:", { clock }); const service = new CollaborationService(db);
  const a = db.bootstrapIdentity({ display_name: "Synthetic A", device_name: "A test device" }).actor;
  const b = db.createIdentity({ display_name: "Synthetic B", device_name: "B test device", can_create_projects: true }).actor;
  const source = service.createSession(a, { title: "A shared source", mode: "multi", idempotency_key: "shared-team-source" }).session;
  service.setMembership(a, source.id, b.user_id, "participant", "shared-team-membership");
  const solo = service.createSession(b, { project_id: source.project_id, title: "B Solo", mode: "solo", idempotency_key: "shared-team-solo" }).session;
  const aRuntime = service.registerRuntime(a, { session_id: source.id, device_id: a.device_id, harness: "codex", provider: "openai", model: "fixture-owner-model",
    execution_profiles: [{ provider: "openai", model: "fixture-owner-model", reasoning_efforts: ["high"] }], local_session_id: "synthetic-owner-local",
    capture_fidelity: "harness_transcript", context_deletion_version: 1,
    sharing_capability: { version: 1, isolated: true, project_only: true, cancellation: true, liveness_watchdog: true } });
  const bRuntime = service.registerRuntime(b, { session_id: solo.id, device_id: b.device_id, harness: "deepseek-harness", provider: "deepseek", model: "fixture-director",
    local_session_id: "synthetic-b-local", capture_fidelity: "harness_transcript", context_deletion_version: 1 });
  const sharing = new AgentSharing(service, { clock, autoStart: false });
  sharing.sourceAvailability(a, { project_id: source.project_id, source_runtime_id: aRuntime.id, state: "ready", idempotency_key: "shared-team-native-ready" });
  const saved = sharing.save(a, source.project_id, { source_runtime_id: aRuntime.id, execution_profile: { harness: "codex", provider: "openai",
    model: "fixture-owner-model", reasoning_effort: "high" }, allowed_user_ids: [b.user_id], limits,
    expected_revision: null, idempotency_key: "shared-team-save" }).share;
  const share = sharing.control(a, source.project_id, saved.id, { action: "enable", expected_revision: saved.revision,
    idempotency_key: "shared-team-enable" }).share;
  const teams = new AgentTeams(service, undefined, { sharing, clock, autoStart: false });
  const library = new AgentTeamLibrary(teams);
  const sharedTarget = { kind: "shared" as const, share_id: share.id, share_revision: share.revision,
    harness: "codex" as const, provider: "openai", model: "fixture-owner-model", reasoning_effort: "high" };
  const plan: AgentTeamPlan = { name: "Synthetic shared team", team_prompt: "Work on the public task", nodes: [
    { id: "director", label: "B director", role: "Delegate and verify", x: 0, y: 0,
      target: { kind: "local", runtime_id: bRuntime.id, harness: "deepseek-harness", provider: "deepseek", model: "fixture-director" } },
    { id: "worker", label: "A shared worker", role: "Answer the assigned task", x: 350, y: 0, target: sharedTarget },
  ], edges: [{ id: "delegate", source: "director", target: "worker", direction: "one_way" }] };
  const start = (ack = true, selectedPlan = plan, minutes = 30) => teams.start(b, solo.id, { plan: selectedPlan, entry_node_id: selectedPlan.nodes[0]!.id,
    content: "Compute a simple public result", max_calls: 12, max_duration_minutes: minutes, content_revision: 0,
    solo_transfer_ack: ack, idempotency_key: `shared-team-start-${randomUUID()}` }).run;
  const completeOwn = (runId: string, delegate = false) => {
    const run = teams.read(b, solo.id, runId).run, step = run.steps.find(item => item.id === run.current_step_id)!;
    const claimed = service.claimAgentRequest(b, solo.id, step.request_event_id!, bRuntime.id);
    return service.completeAgentRequest(b, solo.id, step.request_event_id!, bRuntime.id, `director-result-${step.id}`,
      { content: `Public result.\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: step.id,
        action: delegate ? "delegate" : "complete", ...(delegate ? { target_node_id: "worker", task: "Compute 6 times 7" } : {}) })}\n\`\`\`` },
      "fixture-director", undefined, claimed.attempt_count);
  };
  const completeShared = (outcome: "completed" | "timed_out" = "completed") => {
    const job = sharing.listJobs(a, source.project_id).jobs.find(item => item.status === "queued")!;
    const claimed = sharing.claim(a, job.id, { idempotency_key: `shared-team-claim-${job.id}` });
    const result = sharing.complete(a, job.id, { claim_attempt: claimed.capsule.claim_attempt, idempotency_key: `shared-team-complete-${job.id}`,
      observed_model: "fixture-owner-model", observed_reasoning_effort: "high", outcome, executor_stopped: true,
      payload: outcome === "completed" ? { content: "42", status: "completed" } : {} });
    return { claimed, result };
  };
  return { db, service, a, b, aRuntime, bRuntime, source, solo, sharing, share, teams, library, plan, sharedTarget, start, completeOwn, completeShared,
    advance: (ms: number) => { now += ms; }, close: () => { teams.close(); sharing.close(); db.close(); } };
}
async function drive(f: ReturnType<typeof setup>, runId: string, predicate: (run: ReturnType<typeof f.teams.read>["run"]) => boolean) {
  for (let n = 0; n < 40; n++) { await f.teams.pump(); if (predicate(f.teams.read(f.b, f.solo.id, runId).run)) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail("Shared team did not reach the expected state");
}

test("B Solo team delegates to A's shared Codex and returns without granting A ordinary Solo writes", async () => {
  const f = setup(); try {
    const run = f.start(); await drive(f, run.id, value => value.calls_used === 1);
    f.completeOwn(run.id, true); await drive(f, run.id, value => value.calls_used === 2);
    const { claimed, result } = f.completeShared();
    assert.match(claimed.capsule.content, /Your role/); assert.equal(claimed.capsule.job.requester_user_id, f.b.user_id);
    assert.equal(result.event.actor_user_id, f.b.user_id); assert.equal(result.event.runtime_provenance?.user_id, f.a.user_id);
    assert.throws(() => f.service.appendEvent(f.a, f.solo.id, { type: "human_chat", visibility: "session", payload: { content: "Forbidden" }, idempotency_key: "foreign-solo-write" }));
    await drive(f, run.id, value => value.calls_used === 3);
    f.completeOwn(run.id); await drive(f, run.id, value => value.status === "completed");
    assert.equal(f.teams.read(f.b, f.solo.id, run.id).run.calls_used, 3);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 1);
  } finally { f.close(); }
});
test("Solo team start requires explicit transfer acknowledgment and exact shared model", () => {
  const f = setup(); try {
    assert.throws(() => f.start(false), { code: "shared_agent_solo_disclosure_required" });
    const changed = structuredClone(f.plan); changed.nodes[1]!.target = { ...f.sharedTarget, model: "ungranted-model" };
    assert.throws(() => f.start(true, changed), { code: "agent_share_profile_changed" });
    assert.equal(f.sharing.listJobs(f.a, f.source.project_id).jobs.length, 0);
  } finally { f.close(); }
});
test("team Stop cancels accepted shared work and late native completion cannot advance the graph", async () => {
  const f = setup(); try {
    const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] };
    const run = f.start(true, plan); await drive(f, run.id, value => value.calls_used === 1);
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
    const claimed = f.sharing.claim(f.a, job.id, { idempotency_key: "stop-shared-claim" });
    f.teams.control(f.b, f.solo.id, run.id, { action: "stop", idempotency_key: "stop-shared-team" });
    assert.equal(f.sharing.store.job(job.id).status, "cancelled");
    assert.throws(() => f.sharing.complete(f.a, job.id, { claim_attempt: claimed.capsule.claim_attempt,
      idempotency_key: "late-shared-team", observed_model: "fixture-owner-model", observed_reasoning_effort: "high",
      outcome: "completed", executor_stopped: true, payload: { content: "Late" } }));
    assert.equal(f.teams.read(f.b, f.solo.id, run.id).run.status, "stopped");
  } finally { f.close(); }
});
test("a human-paused shared Team resumes in a fresh counted step instead of consuming its own cancellation as a failure", async t => {
  for (const claimed of [false, true]) await t.test(claimed ? "claimed" : "queued", async () => {
    const f = setup(); try {
      const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, run = f.start(true, plan);
      await drive(f, run.id, value => value.calls_used === 1);
      const first = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
      const claim = claimed ? f.sharing.claim(f.a, first.id, { idempotency_key: "shared-human-pause-claim" }) : null;
      f.teams.control(f.b, f.solo.id, run.id, { action: "pause", idempotency_key: "shared-human-pause" });
      assert.equal(f.sharing.store.job(first.id).status, "cancelled");
      assert.equal(f.teams.read(f.b, f.solo.id, run.id).run.status, "paused");
      const resume = { action: "resume" as const, idempotency_key: "shared-human-resume" };
      f.teams.control(f.b, f.solo.id, run.id, resume); f.teams.control(f.b, f.solo.id, run.id, resume);
      await drive(f, run.id, value => value.calls_used === 2 || value.status === "failed");
      const resumed = f.teams.read(f.b, f.solo.id, run.id).run;
      assert.equal(resumed.status, "running"); assert.equal(resumed.calls_used, 2);
      assert.equal(resumed.steps.length, 2); assert.notEqual(resumed.current_step_id, run.current_step_id);
      if (claim) {
        const next = f.sharing.listJobs(f.a, f.source.project_id).jobs.find(item => item.status === "queued")!;
        assert.throws(() => f.sharing.claim(f.a, next.id, { idempotency_key: "shared-resume-before-cleanup" }), { code: "agent_share_busy" });
        f.sharing.abortAck(f.a, first.id, { claim_attempt: claim.capsule.claim_attempt,
          executor_stopped: true, idempotency_key: "shared-human-pause-cleanup" });
      }
      f.completeShared(); await drive(f, run.id, value => value.status === "completed");
      assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 2);
    } finally { f.close(); }
  });
});
test("pausing after a shared Agent already answered preserves that completed result on Resume without another charged call", async () => {
  const f = setup(); try {
    const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, run = f.start(true, plan);
    await drive(f, run.id, value => value.calls_used === 1); f.completeShared();
    f.teams.control(f.b, f.solo.id, run.id, { action: "pause", idempotency_key: "shared-completed-pause" });
    f.teams.control(f.b, f.solo.id, run.id, { action: "resume", idempotency_key: "shared-completed-resume" });
    await drive(f, run.id, value => value.status === "completed");
    const result = f.teams.read(f.b, f.solo.id, run.id).run;
    assert.equal(result.calls_used, 1); assert.equal(result.steps.length, 1);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 1);
  } finally { f.close(); }
});
test("forgotten and expired shared Team start keys cannot create a second broker job or consume another allowance", async t => {
  for (const cleanup of ["forget", "prune"] as const) await t.test(cleanup, async () => {
    const f = setup(); try {
      const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, run = f.start(true, plan);
      const input = JSON.parse(f.teams.store.row(run.id).input_json);
      await drive(f, run.id, value => value.calls_used === 1);
      f.teams.control(f.b, f.solo.id, run.id, { action: "stop", idempotency_key: "shared-consumed-stop" });
      if (cleanup === "forget") f.teams.forget(f.b, f.solo.id, run.id);
      else { f.advance(31 * 86400000); f.teams.store.prune(); }
      const snapshot = () => ({ head: f.db.requireSession(f.solo.id).next_sequence,
        jobs: f.db.sqlite.prepare("SELECT * FROM agent_share_jobs ORDER BY id").all(),
        usage: f.db.sqlite.prepare("SELECT * FROM agent_share_daily_usage ORDER BY member_user_id").all(),
        calls: f.db.sqlite.prepare("SELECT COALESCE(SUM(calls_used),0) AS n FROM agent_team_runs").get()!.n });
      const before = snapshot();
      assert.throws(() => f.teams.start(f.b, f.solo.id, input), { code: "conflict" });
      assert.throws(() => f.teams.start(f.b, f.solo.id, { ...input, content: "Changed shared task" }), { code: "idempotency_conflict" });
      await f.teams.pump(); assert.deepEqual(snapshot(), before);
      assert.equal(before.jobs.length, 1); assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    } finally { f.close(); }
  });
});
test("shared timeout offers a counted explicit team continuation", async () => {
  const f = setup(); try {
    const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, run = f.start(true, plan);
    await drive(f, run.id, value => value.calls_used === 1); f.completeShared("timed_out");
    await drive(f, run.id, value => value.status === "paused");
    const timedOut = f.teams.read(f.b, f.solo.id, run.id).run;
    assert.equal(timedOut.error_code, "agent_timeout");
    assert.deepEqual(timedOut.issue, { code: "agent_share_timeout", node_id: "worker", node_label: "A shared worker",
      target_kind: "shared", retry_at: null });
    assert.deepEqual(f.teams.list(f.b, f.solo.id).runs.find(item => item.id === run.id)?.issue, timedOut.issue);
    f.teams.control(f.b, f.solo.id, run.id, { action: "continue", idempotency_key: "continue-shared-team" });
    await drive(f, run.id, value => value.calls_used === 2); f.completeShared();
    await drive(f, run.id, value => value.status === "completed");
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 2);
  } finally { f.close(); }
});
test("a redacted shared-native Team prefix keeps its public quote and final UTF-16 mentions without notifying again on timeout continuation", async () => {
  const f = setup(); try {
    const quote = f.service.appendEvent(f.b, f.solo.id, { type: "human_chat", visibility: "session", idempotency_key: "shared-team-quoted-source",
      payload: { content: "Synthetic shared reference" } });
    const content = "  😀 @Synthetic A compute the public result  \n", start = content.indexOf("@");
    const plan = { ...f.plan, nodes: [{ ...f.plan.nodes[1]!, role: "Return a verification token:" }], edges: [] };
    const input = { plan, entry_node_id: "worker", content, reply_to_event_id: quote.id,
      mentions: [{ user_id: f.a.user_id, start, end: start + "@Synthetic A".length }], max_calls: 12, max_duration_minutes: 30,
      content_revision: 0, solo_transfer_ack: true, idempotency_key: "shared-team-reference-start" };
    const run = f.teams.start(f.b, f.solo.id, input).run;
    await drive(f, run.id, value => value.calls_used === 1);
    const { claimed } = f.completeShared("timed_out");
    assert.equal(claimed.capsule.reply_to_event_id, quote.id); assert.equal(claimed.capsule.quoted_message?.event_id, quote.id);
    assert.equal(claimed.capsule.quoted_message?.content, "Synthetic shared reference");
    const mention = claimed.capsule.mentions![0]!;
    assert.equal(mention.user_id, f.a.user_id); assert.equal(claimed.capsule.content.slice(mention.start, mention.end), "@Synthetic A");
    const request = f.db.getEvent(f.solo.id, claimed.job.request_event_id);
    const payload = request.payload as { content: string; mentions: typeof input.mentions; agent_team: { task_content: string } };
    assert.equal(payload.agent_team.task_content, content); assert.match(payload.content, /\[REDACTED\]/u);
    assert.equal(redactJson(payload.content), payload.content);
    assert.equal(payload.content.slice(payload.mentions[0]!.start, payload.mentions[0]!.end), "@Synthetic A");
    assert.equal(payload.content, claimed.capsule.content); assert.deepEqual(payload.mentions, claimed.capsule.mentions);
    assert.equal(f.teams.start(f.b, f.solo.id, input).replayed, true);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 1);
    await drive(f, run.id, value => value.status === "paused");
    f.teams.control(f.b, f.solo.id, run.id, { action: "continue", idempotency_key: "shared-team-reference-continue" });
    await drive(f, run.id, value => value.calls_used === 2);
    const continued = f.completeShared();
    assert.equal(continued.claimed.capsule.reply_to_event_id, null); assert.equal(continued.claimed.capsule.quoted_message, undefined);
    assert.equal(continued.claimed.capsule.mentions, undefined);
    await drive(f, run.id, value => value.status === "completed");
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 2);
    assert.deepEqual(f.db.listProjectMentions(f.a, f.source.project_id).mentions.map(item => [item.id, item.excerpt]), [[request.id, content]]);
  } finally { f.close(); }
});
test("shared Team broker allowance rolls back if a tampered final payload's redaction would invalidate its mention ranges", async () => {
  const f = setup();
  const append = f.db.appendSharedBrokerEventInsideTransaction.bind(f.db);
  f.db.appendSharedBrokerEventInsideTransaction = (...args: Parameters<typeof f.db.appendSharedBrokerEventInsideTransaction>) => {
    const input = args[1];
    if (input.type === "agent_request") {
      const payload = input.payload as { content: string; mentions: Array<{ user_id: string; start: number; end: number }> };
      const prefix = "Return a verification token: ";
      args[1] = { ...input, payload: { ...payload, content: prefix + payload.content,
        mentions: payload.mentions.map(mention => ({ ...mention, start: mention.start + prefix.length, end: mention.end + prefix.length })) } };
    }
    return append(...args);
  };
  try {
    const content = "@Synthetic A review", plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] };
    const run = f.teams.start(f.b, f.solo.id, { plan, entry_node_id: "worker", content,
      mentions: [{ user_id: f.a.user_id, start: 0, end: "@Synthetic A".length }], max_calls: 2, max_duration_minutes: 30,
      content_revision: 0, solo_transfer_ack: true, idempotency_key: "shared-final-redacted-payload" }).run;
    const before = f.db.requireSession(f.solo.id).next_sequence;
    await drive(f, run.id, value => value.status === "failed");
    assert.equal(f.teams.read(f.b, f.solo.id, run.id).run.calls_used, 0);
    assert.equal(f.sharing.listJobs(f.a, f.source.project_id).jobs.length, 0);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 0);
    assert.equal(f.db.requireSession(f.solo.id).next_sequence, before);
  } finally { f.close(); }
});
test("a stale selected mention at shared Team dispatch rolls back the broker reservation and its daily allowance", async () => {
  const f = setup(); try {
    const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, content = "@Synthetic A review";
    const run = f.teams.start(f.b, f.solo.id, { plan, entry_node_id: "worker", content,
      mentions: [{ user_id: f.a.user_id, start: 0, end: "@Synthetic A".length }], max_calls: 12, max_duration_minutes: 30,
      content_revision: 0, solo_transfer_ack: true, idempotency_key: "shared-team-stale-mention" }).run;
    const before = f.db.requireSession(f.solo.id).next_sequence;
    f.db.sqlite.prepare("UPDATE users SET display_name=? WHERE id=?").run("Renamed A", f.a.user_id);
    await drive(f, run.id, value => value.status === "failed");
    assert.equal(f.teams.read(f.b, f.solo.id, run.id).run.calls_used, 0);
    assert.equal(f.sharing.listJobs(f.a, f.source.project_id).jobs.length, 0);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 0);
    assert.equal(f.db.requireSession(f.solo.id).next_sequence, before);
  } finally { f.close(); }
});
test("shared call deadline never extends the human-started team's deadline", async () => {
  const f = setup(); try {
    const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, run = f.start(true, plan, 1);
    await drive(f, run.id, value => value.calls_used === 1);
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!, claimed = f.sharing.claim(f.a, job.id, { idempotency_key: "bounded-shared-claim" });
    assert.equal(claimed.capsule.deadline_at, run.deadline_at);
    f.advance(60001); f.sharing.pump(); await drive(f, run.id, value => value.status === "timed_out");
    assert.equal(f.sharing.store.job(job.id).status, "timed_out");
  } finally { f.close(); }
});

test("minimal connectivity probes use the ordinary shared allowance and cannot reserve an extra task after it is exhausted", async () => {
  const f = setup(AgentShareLimitsSchema.parse({ per_member_daily_calls: 3, total_daily_calls: 3 })); try {
    const draft = structuredClone(f.plan);
    draft.nodes[0]!.target = f.sharedTarget;
    const saved = f.library.save(f.b, "shared-probe", { draft, max_calls: 1, max_duration_minutes: 30,
      expected_revision: null, idempotency_key: "shared-probe-save" }).team;
    const unrelatedHistory = "SYNTHETIC_UNRELATED_HISTORY_MUST_NOT_REACH_PROBES";
    f.service.appendEvent(f.b, f.source.id, { type: "human_chat", visibility: "session",
      idempotency_key: "shared-probe-unrelated-history", payload: { content: `${unrelatedHistory} ${"h".repeat(20000)}` } });
    const accepted = f.library.test(f.b, saved.id, f.source.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: "shared-probe-start" });
    assert.equal(accepted.run.purpose, "test"); assert.equal(accepted.run.max_calls, 3);
    for (let index = 0; index < 3; index++) {
      for (let spin = 0; spin < 20; spin++) {
        await f.teams.pump();
        if (f.sharing.listJobs(f.a, f.source.project_id).jobs.some(job => job.status === "queued")) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const run = f.teams.read(f.b, f.source.id, accepted.run.id).run;
      const step = run.steps.find(item => item.id === run.current_step_id)!;
      const job = f.sharing.listJobs(f.a, f.source.project_id).jobs.find(item => item.status === "queued")!;
      assert.ok(job); assert.equal(job.execution_profile.reasoning_effort, "high");
      const claim = f.sharing.claim(f.a, job.id, { idempotency_key: `shared-probe-claim-${index}` });
      assert.match(claim.capsule.content, /Do not use tools, change files, delegate/u);
      const canonical = f.db.getEvent(f.source.id, job.request_event_id);
      assert.equal(claim.capsule.through_sequence, canonical.sequence - 1);
      assert.equal(claim.capsule.context.through_sequence, claim.capsule.through_sequence);
      assert.equal(claim.capsule.content_revision, 0); assert.equal(claim.capsule.context.content_revision, 0);
      assert.deepEqual(claim.capsule.context.items, []);
      assert.equal(JSON.stringify(claim.capsule).includes(unrelatedHistory), false);
      const encoded = claim.capsule.content.split("\n").find(line => line.startsWith('["GT_TEAM_OK:'));
      assert.ok(encoded, "The shared executor must receive its expected public probe lines");
      const lines = JSON.parse(encoded) as string[];
      assert.equal(lines[0], `GT_TEAM_OK:${step.node_id}:${step.id}`);
      if (index === 2) assert.match(lines[1]!, /^GT_TEAM_ROUTE:delegate:director:worker:/u);
      assert.equal(f.db.getEvent(f.source.id, job.request_event_id).payload &&
        (f.db.getEvent(f.source.id, job.request_event_id).payload as { agent_team: { purpose: string } }).agent_team.purpose, "test");
      f.sharing.complete(f.a, job.id, { claim_attempt: claim.capsule.claim_attempt, idempotency_key: `shared-probe-result-${index}`,
        observed_model: f.sharedTarget.model, observed_reasoning_effort: "high", outcome: "completed", executor_stopped: true,
        payload: { content: lines.join("\n"), status: "completed" } });
    }
    for (let spin = 0; spin < 20; spin++) { await f.teams.pump(); await new Promise(resolve => setImmediate(resolve)); }
    const tested = f.library.read(f.b, saved.id);
    assert.equal(tested.test_status, "passed"); assert.equal(tested.max_calls, 1);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 3);
    const enabled = f.library.control(f.b, saved.id, f.source.id, { enabled: true,
      expected_revision: tested.revision, idempotency_key: "shared-probe-enable" }).team;
    const task = f.library.start(f.b, saved.id, f.source.id, { expected_revision: enabled.revision,
      content: "This task must not bypass the exhausted shared allowance", content_revision: 0, idempotency_key: "shared-probe-task" });
    for (let spin = 0; spin < 20; spin++) { await f.teams.pump(); await new Promise(resolve => setImmediate(resolve)); }
    const failed = f.teams.read(f.b, f.source.id, task.run.id).run;
    assert.equal(failed.status, "failed"); assert.equal(failed.error_code, "agent_share_daily_limit"); assert.equal(failed.calls_used, 0);
    assert.deepEqual(failed.issue, { code: "agent_share_daily_limit", node_id: "director", node_label: "B director",
      target_kind: "shared", retry_at: null });
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 3);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_share_jobs").get()!.n, 3);
  } finally { f.close(); }
});

test("a shared allowance exhausted after the first probe phase cannot skip the route phase or unlock Enable", async () => {
  const f = setup(AgentShareLimitsSchema.parse({ per_member_daily_calls: 2, total_daily_calls: 2 })); try {
    const draft = structuredClone(f.plan); draft.nodes[0]!.target = f.sharedTarget;
    const saved = f.library.save(f.b, "shared-route-quota", { draft, max_calls: 1, expected_revision: null,
      idempotency_key: "shared-route-quota-save" }).team;
    const accepted = f.library.test(f.b, saved.id, f.source.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: "shared-route-quota-start" });
    for (let index = 0; index < 2; index++) {
      for (let spin = 0; spin < 20; spin++) {
        await f.teams.pump();
        if (f.sharing.listJobs(f.a, f.source.project_id).jobs.some(job => job.status === "queued")) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const job = f.sharing.listJobs(f.a, f.source.project_id).jobs.find(item => item.status === "queued")!; assert.ok(job);
      const claimed = f.sharing.claim(f.a, job.id, { idempotency_key: `shared-route-quota-claim-${index}` });
      const encoded = claimed.capsule.content.split("\n").find(line => line.startsWith('["GT_TEAM_OK:'));
      assert.ok(encoded); const lines = JSON.parse(encoded) as string[];
      assert.equal(lines.length, 1, "This only completes the individual-module phase");
      f.sharing.complete(f.a, job.id, { claim_attempt: claimed.capsule.claim_attempt,
        idempotency_key: `shared-route-quota-complete-${index}`, observed_model: f.sharedTarget.model,
        observed_reasoning_effort: "high", outcome: "completed", executor_stopped: true,
        payload: { content: lines.join("\n"), status: "completed" } });
    }
    for (let spin = 0; spin < 20; spin++) { await f.teams.pump(); await new Promise(resolve => setImmediate(resolve)); }
    const failed = f.teams.read(f.b, f.source.id, accepted.run.id).run;
    assert.equal(failed.status, "failed"); assert.equal(failed.error_code, "agent_share_daily_limit"); assert.equal(failed.calls_used, 2);
    assert.equal(f.library.read(f.b, saved.id).test_status, "failed");
    assert.throws(() => f.library.control(f.b, saved.id, f.source.id, { enabled: true,
      expected_revision: saved.revision, idempotency_key: "shared-route-quota-cannot-enable" }), { code: "conflict" });
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 2);
  } finally { f.close(); }
});

test("a saved Solo connectivity test requires disclosure before creating its run or consuming a shared allowance", () => {
  const f = setup(); try {
    const draft = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] };
    const saved = f.library.save(f.b, "solo-shared-probe", { draft, expected_revision: null, idempotency_key: "solo-probe-save" }).team;
    const input = { expected_revision: saved.revision, content_revision: 0, idempotency_key: "solo-probe-start" };
    assert.throws(() => f.library.test(f.b, saved.id, f.solo.id, input), { code: "shared_agent_solo_disclosure_required" });
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 0);
    assert.equal(f.library.test(f.b, saved.id, f.solo.id, { ...input, solo_transfer_ack: true }).run.purpose, "test");
  } finally { f.close(); }
});

test("a saved shared Team reuses the same project grant across Multi and Solo, with fresh disclosure and exact session context", async () => {
  const f = setup(); try {
    const multiMarker = "SYNTHETIC_MULTI_ONLY_HISTORY", soloMarker = "SYNTHETIC_BORROWER_SOLO_HISTORY";
    f.service.appendEvent(f.b, f.source.id, { type: "human_chat", visibility: "session", idempotency_key: "shared-library-multi-history",
      payload: { content: multiMarker } });
    f.service.appendEvent(f.b, f.solo.id, { type: "human_chat", visibility: "session", idempotency_key: "shared-library-solo-history",
      payload: { content: soloMarker } });
    const draft = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] };
    const saved = f.library.save(f.b, "shared-library-cross-session", { draft, expected_revision: null,
      idempotency_key: "shared-library-cross-session-save" }).team;
    const testRun = f.library.test(f.b, saved.id, f.source.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: "shared-library-cross-session-test" }).run;
    for (let spin = 0; spin < 20; spin++) {
      await f.teams.pump(); if (f.sharing.listJobs(f.a, f.source.project_id).jobs.some(job => job.status === "queued")) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    const probeJob = f.sharing.listJobs(f.a, f.source.project_id).jobs.find(job => job.status === "queued")!; assert.ok(probeJob);
    const probeClaim = f.sharing.claim(f.a, probeJob.id, { idempotency_key: "shared-library-cross-session-probe-claim" });
    const encoded = probeClaim.capsule.content.split("\n").find(line => line.startsWith('["GT_TEAM_OK:')); assert.ok(encoded);
    f.sharing.complete(f.a, probeJob.id, { claim_attempt: probeClaim.capsule.claim_attempt,
      idempotency_key: "shared-library-cross-session-probe-result", observed_model: f.sharedTarget.model,
      observed_reasoning_effort: "high", outcome: "completed", executor_stopped: true,
      payload: { content: (JSON.parse(encoded) as string[]).join("\n"), status: "completed" } });
    for (let spin = 0; spin < 20; spin++) {
      await f.teams.pump(); if (f.teams.read(f.b, f.source.id, testRun.id).run.status === "completed") break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(f.library.read(f.b, saved.id).test_status, "passed");
    const enabled = f.library.control(f.b, saved.id, f.source.id, { enabled: true, expected_revision: saved.revision,
      idempotency_key: "shared-library-cross-session-enable" }).team;
    const input = { expected_revision: enabled.revision, content: "Use the saved grant in my Solo", content_revision: 0,
      idempotency_key: "shared-library-cross-session-start" };
    assert.throws(() => f.library.start(f.b, saved.id, f.solo.id, input), { code: "shared_agent_solo_disclosure_required" });
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 1);
    const run = f.library.start(f.b, saved.id, f.solo.id, { ...input, solo_transfer_ack: true }).run;
    await drive(f, run.id, value => value.calls_used === 1);
    const taskJob = f.sharing.listJobs(f.a, f.source.project_id).jobs.find(job => job.status === "queued")!; assert.ok(taskJob);
    const taskClaim = f.sharing.claim(f.a, taskJob.id, { idempotency_key: "shared-library-cross-session-task-claim" });
    assert.equal(taskClaim.capsule.source_runtime_id, f.aRuntime.id);
    assert.equal(taskClaim.capsule.job.session_id, f.solo.id);
    assert.equal(taskClaim.capsule.job.share_id, f.share.id); assert.equal(taskClaim.capsule.job.share_revision, f.share.revision);
    assert.equal(JSON.stringify(taskClaim.capsule.context).includes(soloMarker), true, "An actual acknowledged task retains its permitted conversation history");
    assert.equal(JSON.stringify(taskClaim.capsule).includes(multiMarker), false, "The test session's history cannot leak into a task in another session");
    f.sharing.complete(f.a, taskJob.id, { claim_attempt: taskClaim.capsule.claim_attempt,
      idempotency_key: "shared-library-cross-session-task-result", observed_model: f.sharedTarget.model,
      observed_reasoning_effort: "high", outcome: "completed", executor_stopped: true, payload: { content: "42", status: "completed" } });
    await drive(f, run.id, value => value.status === "completed");
    const otherProject = f.service.createSession(f.b, { mode: "multi", title: "Another project", idempotency_key: "shared-library-other-project" }).session;
    assert.throws(() => f.library.start(f.b, saved.id, otherProject.id, { ...input, idempotency_key: "shared-library-cross-project-denied" }), { code: "agent_share_revoked" });
    f.sharing.sourceAvailability(f.a, { project_id: f.source.project_id, source_runtime_id: f.aRuntime.id,
      state: "offline", idempotency_key: "shared-library-agent-offline" });
    assert.throws(() => f.library.start(f.b, saved.id, f.solo.id, { ...input, solo_transfer_ack: true,
      idempotency_key: "shared-library-offline-denied" }), { code: "agent_share_revoked" });
    assert.equal(f.sharing.store.detail(f.b, f.sharing.store.row(f.share.id)).usage.calls, 2);
  } finally { f.close(); }
});

test("shared Team output cannot forge the team control envelope or use a different observed effort", async () => {
  const f = setup(); try {
    const run = f.start(true, { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] });
    await drive(f, run.id, value => value.calls_used === 1);
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
    const claim = f.sharing.claim(f.a, job.id, { idempotency_key: "shared-provenance-claim" });
    const input = { claim_attempt: claim.capsule.claim_attempt, observed_model: f.sharedTarget.model,
      observed_reasoning_effort: "high", outcome: "completed" as const, executor_stopped: true as const,
      idempotency_key: "shared-provenance-finish", payload: { content: "42", status: "completed" } };
    assert.throws(() => f.sharing.complete(f.a, job.id, { ...input, observed_reasoning_effort: "low" }),
      (error: unknown) => error instanceof ApiError && error.code === "agent_share_profile_changed");
    assert.throws(() => f.sharing.complete(f.a, job.id, { ...input,
      payload: { ...input.payload, agent_team: { run_id: "other-run", step_id: "other-step" } } }), { code: "forbidden" });
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response' AND reply_to_event_id=?")
      .get(job.request_event_id)!.n, 0);
    const result = f.sharing.complete(f.a, job.id, input);
    assert.equal(result.event.actor_user_id, f.b.user_id);
    assert.equal(result.event.shared_execution?.share_id, f.share.id);
    assert.equal(result.event.shared_execution?.share_revision, f.share.revision);
    assert.equal(result.event.runtime_provenance?.user_id, f.a.user_id);
    assert.equal(result.event.runtime_provenance?.runtime_id, undefined);
    await drive(f, run.id, value => value.status === "completed");
  } finally { f.close(); }
});

test("revoking a Team authorizer fences queued and running shared work even when the executor and another requester device remain valid", async t => {
  for (const claimed of [false, true]) await t.test(claimed ? "claimed native work" : "queued native work", async () => {
    const f = setup(); try {
      const replacement = { ...f.b, device_id: f.db.createDevice(f.b.user_id, "Still-authorized requester device").device_id };
      const run = f.start(true, { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] });
      await drive(f, run.id, value => value.calls_used === 1);
      const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
      if (claimed) f.sharing.claim(f.a, job.id, { idempotency_key: "authorizer-revocation-claim" });
      f.db.revokeDevice(replacement, f.b.device_id);
      f.db.assertActiveDevice(f.a); f.db.assertActiveDevice(replacement);
      assert.equal(f.db.teamRequestMayExecute(job.request_event_id), false);
      if (claimed) {
        assert.throws(() => f.sharing.renewLease(f.a, job.id, { claim_attempt: 1, idempotency_key: "revoked-team-lease" }));
        assert.throws(() => f.sharing.complete(f.a, job.id, { claim_attempt: 1, idempotency_key: "revoked-team-finish",
          observed_model: f.sharedTarget.model, observed_reasoning_effort: "high", outcome: "completed", executor_stopped: true,
          payload: { content: "Unwanted late native answer", status: "completed" } }));
      } else assert.throws(() => f.sharing.claim(f.a, job.id, { idempotency_key: "revoked-team-queued-claim" }));
      for (let spin = 0; spin < 5; spin++) await f.teams.pump();
      const ended = f.teams.read(replacement, f.solo.id, run.id).run;
      assert.equal(ended.status, "failed"); assert.equal(ended.error_code, "agent_team_authorization_lost");
      assert.equal(f.sharing.store.job(job.id).status, "cancelled");
      assert.equal(Boolean(f.sharing.store.job(job.id).cleanup_pending), claimed);
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE reply_to_event_id=? AND runtime_provenance_json IS NOT NULL")
        .get(job.request_event_id)!.n, 0);
    } finally { f.close(); }
  });
});

test("shared native concurrency remains occupied by unknown cleanup after a Team is stopped", async () => {
  const f = setup(); try {
    const run = f.start(true, { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] });
    await drive(f, run.id, value => value.calls_used === 1);
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
    f.sharing.claim(f.a, job.id, { idempotency_key: "team-slot-claim" });
    f.teams.control(f.b, f.solo.id, run.id, { action: "stop", idempotency_key: "team-slot-stop" });
    const ordinary = f.sharing.start(f.b, f.source.id, { share_id: f.share.id, share_revision: f.share.revision,
      content: "An ordinary borrower request uses the same native slot", content_revision: 0, solo_transfer_ack: false,
      idempotency_key: "ordinary-after-team-stop" });
    assert.throws(() => f.sharing.claim(f.a, ordinary.job.id, { idempotency_key: "ordinary-blocked-by-team-cleanup" }), { code: "agent_share_busy" });
    f.sharing.abortAck(f.a, job.id, { claim_attempt: 1, executor_stopped: true, idempotency_key: "team-slot-executor-quiesced" });
    assert.equal(f.sharing.claim(f.a, ordinary.job.id, { idempotency_key: "ordinary-after-team-cleanup" }).job.status, "running");
  } finally { f.close(); }
});

test("the owner's shared switch and source disconnection fence Team queues and executions through the same broker", async t => {
  for (const reason of ["disable", "offline"] as const) for (const claimed of [false, true]) await t.test(
    `${reason} / ${claimed ? "executing" : "queued"}`, async () => {
      const f = setup(); try {
        const run = f.start(true, { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] });
        await drive(f, run.id, value => value.calls_used === 1);
        const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
        if (claimed) f.sharing.claim(f.a, job.id, { idempotency_key: "shared-liveness-claim" });
        if (reason === "disable") f.sharing.control(f.a, f.source.project_id, f.share.id,
          { action: "disable", idempotency_key: "shared-team-owner-disable" });
        else f.sharing.sourceAvailability(f.a, { project_id: f.source.project_id, source_runtime_id: f.aRuntime.id,
          state: "offline", idempotency_key: "shared-team-owner-offline" });
        assert.equal(f.sharing.store.job(job.id).status, "cancelled");
        assert.equal(Boolean(f.sharing.store.job(job.id).cleanup_pending), claimed);
        assert.throws(() => f.sharing.claim(f.a, job.id, { idempotency_key: "shared-liveness-late-claim" }));
        assert.throws(() => f.sharing.complete(f.a, job.id, { claim_attempt: 1, idempotency_key: "shared-liveness-late-result",
          observed_model: f.sharedTarget.model, observed_reasoning_effort: "high", outcome: "completed", executor_stopped: true,
          payload: { content: "Discard this late result", status: "completed" } }));
        await drive(f, run.id, value => value.status === "failed");
        const ended = f.teams.read(f.b, f.solo.id, run.id).run;
        assert.equal(ended.calls_used, 1);
        assert.deepEqual(ended.issue, { code: reason === "disable" ? "agent_share_revoked" : "agent_share_offline",
          node_id: "worker", node_label: "A shared worker", target_kind: "shared", retry_at: null });
        assert.deepEqual(f.teams.list(f.b, f.solo.id).runs.find(item => item.id === run.id)?.issue, ended.issue);
        assert.equal(f.sharing.store.row(f.share.id).enabled, 0);
        f.sharing.sourceAvailability(f.a, { project_id: f.source.project_id, source_runtime_id: f.aRuntime.id,
          state: "ready", idempotency_key: "shared-team-owner-ready-after-off" });
        assert.equal(f.sharing.store.row(f.share.id).enabled, 0, "Native readiness cannot restore a manual or automatic stop");
      } finally { f.close(); }
    });
});

test("shared Team diagnostics distinguish waiting for the owner from executing and retain the frozen module label", async () => {
  const f = setup(); try {
    const plan = { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] }, run = f.start(true, plan);
    await drive(f, run.id, value => value.calls_used === 1);
    const queued = f.teams.read(f.b, f.solo.id, run.id).run;
    assert.equal(queued.status, "running"); assert.equal(queued.error_code, null);
    assert.deepEqual(queued.issue, { code: "agent_share_queued", node_id: "worker", node_label: "A shared worker",
      target_kind: "shared", retry_at: null });
    plan.nodes[0]!.label = "New draft label must not rename accepted work";
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
    f.sharing.claim(f.a, job.id, { idempotency_key: "diagnostic-shared-started" });
    assert.equal(f.teams.read(f.b, f.solo.id, run.id).run.issue, undefined);
    f.sharing.control(f.a, f.source.project_id, f.share.id, { action: "disable", idempotency_key: "diagnostic-shared-disable" });
    await drive(f, run.id, value => value.status === "failed");
    const ended = f.teams.read(f.b, f.solo.id, run.id).run;
    assert.deepEqual(ended.issue, { code: "agent_share_revoked", node_id: "worker", node_label: "A shared worker",
      target_kind: "shared", retry_at: null });
    assert.throws(() => f.teams.control(f.b, f.solo.id, run.id,
      { action: "resume", idempotency_key: "diagnostic-no-resume-failed" }), { code: "conflict" });
  } finally { f.close(); }
});

test("an expired shared execution lease is reported separately from a model timeout or a Team deadline", async () => {
  const f = setup(); try {
    const run = f.start(true, { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] });
    await drive(f, run.id, value => value.calls_used === 1);
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
    f.sharing.claim(f.a, job.id, { idempotency_key: "diagnostic-expired-lease-claim" });
    f.advance(16000); f.service.heartbeatRuntime(f.a, f.aRuntime.id); f.sharing.pump();
    await drive(f, run.id, value => value.status === "failed");
    const ended = f.teams.read(f.b, f.solo.id, run.id).run;
    assert.equal(ended.error_code, "agent_share_lease_expired");
    assert.deepEqual(ended.issue, { code: "agent_share_lease_expired", node_id: "worker", node_label: "A shared worker",
      target_kind: "shared", retry_at: null });
    assert.equal(ended.calls_used, 1); assert.equal(f.sharing.store.job(job.id).status, "cancelled");
    assert.ok(Date.parse(ended.deadline_at) > Date.parse(f.teams.store.now()));
    assert.throws(() => f.teams.control(f.b, f.solo.id, run.id,
      { action: "continue", idempotency_key: "diagnostic-no-continue-lease" }), { code: "conflict" });
  } finally { f.close(); }
});

test("a shared executor's private error payload cannot replace the safe Team diagnostic category", async () => {
  const f = setup(); try {
    const run = f.start(true, { ...f.plan, nodes: [f.plan.nodes[1]!], edges: [] });
    await drive(f, run.id, value => value.calls_used === 1);
    const job = f.sharing.listJobs(f.a, f.source.project_id).jobs[0]!;
    const claimed = f.sharing.claim(f.a, job.id, { idempotency_key: "diagnostic-private-error-claim" });
    const privateMessage = "PRIVATE_PROVIDER_DIAGNOSTIC must remain outside public Team diagnostics";
    f.sharing.complete(f.a, job.id, { claim_attempt: claimed.capsule.claim_attempt, idempotency_key: "diagnostic-private-error-finish",
      observed_model: f.sharedTarget.model, observed_reasoning_effort: "high", outcome: "failed", executor_stopped: true,
      payload: { content: privateMessage, error: { code: "provider_auth_failed", message: privateMessage } } });
    await drive(f, run.id, value => value.status === "failed");
    const ended = f.teams.read(f.b, f.solo.id, run.id).run;
    assert.equal(ended.error_code, "agent_share_execution_failed");
    assert.deepEqual(ended.issue, { code: "agent_share_execution_failed", node_id: "worker", node_label: "A shared worker",
      target_kind: "shared", retry_at: null });
    const summary = f.teams.list(f.b, f.solo.id).runs.find(item => item.id === run.id)!;
    assert.equal(JSON.stringify(summary).includes(privateMessage), false);
    assert.equal(JSON.stringify(summary).includes("provider_auth_failed"), false);
    const response = f.db.getEvent(f.solo.id, f.sharing.store.job(job.id).response_event_id!);
    assert.equal(JSON.stringify(response.payload).includes(privateMessage), false);
  } finally { f.close(); }
});
