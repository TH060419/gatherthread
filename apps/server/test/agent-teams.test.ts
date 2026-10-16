import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTeamRunDetailSchema, type AgentTeamPlan, type CanonicalEvent } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams, parseTeamDirective } from "../src/agent-teams.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { CodeRepository } from "../src/code-repository.js";
import { ApiError } from "../src/errors.js";
import { randomBytes, randomUUID } from "node:crypto";

const directive = (stepId: string, action: "complete" | "delegate" = "complete", target = "worker") =>
  `Public result.\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: stepId, action,
    ...(action === "delegate" ? { target_node_id: target, task: "Carry out the subordinate task" } : {}) })}\n\`\`\``;
function fixture() {
  let time = Date.now(); const clock = () => new Date(time);
  const db = new CollaborationDatabase(":memory:", { clock });
  const service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Fixture owner", device_name: "Fixture desktop" }).actor;
  const session = service.createSession(actor, { title: "Team fixture", mode: "multi", idempotency_key: "fixture-team-session" }).session;
  const lead = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "openai", model: "fixture-gpt",
    context_deletion_version: 1, execution_profiles: [{ provider: "openai", model: "fixture-gpt", reasoning_efforts: ["low"] }],
    local_session_id: "fixture-codex", capture_fidelity: "harness_transcript" });
  const worker = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "deepseek-harness", provider: "deepseek", model: "fixture-deepseek",
    context_deletion_version: 1, execution_profiles: [{ provider: "deepseek", model: "fixture-deepseek" }], local_session_id: "fixture-dsh", capture_fidelity: "harness_transcript" });
  const plan: AgentTeamPlan = { name: "Fixture team", team_prompt: "Coordinate accurately", nodes: [
    { id: "lead", label: "Director", role: "Delegate then review", x: 0, y: 0,
      target: { kind: "local", runtime_id: lead.id, harness: "codex", provider: "openai", model: "fixture-gpt", reasoning_effort: "low" } },
    { id: "worker", label: "Implementer", role: "Implement and return a public result", x: 350, y: 0,
      target: { kind: "local", runtime_id: worker.id, harness: "deepseek-harness", provider: "deepseek", model: "fixture-deepseek" } },
  ], edges: [{ id: "lead-worker", source: "lead", target: "worker", direction: "one_way" }] };
  const teams = new AgentTeams(service, undefined, { clock, autoStart: false });
  const start = (custom: AgentTeamPlan = plan, maxCalls = 12) => teams.start(actor, session.id, { plan: custom, entry_node_id: "lead", content: "Human task",
    max_calls: maxCalls, max_duration_minutes: 30, content_revision: db.requireSession(session.id).content_revision ?? 0,
    idempotency_key: `fixture-team-start-${Math.random()}` }).run;
  const complete = (runId: string, action: "complete" | "delegate" = "complete", target = "worker", answer?: string) => {
    const run = teams.read(actor, session.id, runId).run, step = run.steps.find(step => step.id === run.current_step_id)!;
    const node = run.plan.nodes.find(node => node.id === step.node_id)!;
    assert.equal(node.target.kind, "local");
    if (node.target.kind !== "local" || !step.request_event_id) throw new Error("Expected an accepted local step");
    const claim = service.claimAgentRequest(actor, session.id, step.request_event_id, node.target.runtime_id);
    return service.completeAgentRequest(actor, session.id, step.request_event_id, node.target.runtime_id,
      `fixture-complete-${step.id}`, { text: answer ?? directive(step.id, action, target) }, node.target.model, node.target.reasoning_effort, claim.attempt_count);
  };
  const close = () => { teams.close(); db.close(); };
  return { db, service, actor, session, lead, worker, plan, teams, start, complete, clock, advance: (ms: number) => { time += ms; }, close };
}
async function drive(teams: AgentTeams, check: () => boolean) {
  for (let index = 0; index < 100 && !check(); index++) { await teams.pump(); await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(check(), `Team coordinator did not reach the expected durable state: ${JSON.stringify(teams.store.sql.prepare(
    "SELECT status,error_code,calls_used,purpose FROM agent_team_runs").all())}`);
}
function orientation(f: ReturnType<typeof fixture>, requestId: string) {
  const content = String((f.db.getEvent(f.session.id, requestId).payload as { content: string }).content);
  const line = content.split("\n").find(item => item.startsWith('{"first_contact":'));
  assert.ok(line, "Every task call explicitly receives its current public Team orientation");
  return { content, value: JSON.parse(line) };
}
function conflictAnswer(stepId: string, explanation = "The role and module instructions conflict; please clarify which permitted outcome is intended.") {
  return `${explanation}\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: stepId, action: "clarify" })}\n\`\`\``;
}
test("human-started exact Codex -> DSH delegation returns the result to the director over a one-way edge", async () => {
  const f = fixture(); try {
    f.plan.nodes[1]!.role = `Implement and return the public result. ${"Keep the configured responsibility. ".repeat(5)}`.trimEnd();
    f.plan.nodes[1]!.prompt = "A worker-only instruction excluded from another module's public overview.";
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const firstLead = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    const firstView = orientation(f, firstLead.request_event_id!);
    assert.equal(firstView.value.first_contact, true); assert.equal(firstView.value.phase, "initial_assignment");
    assert.equal(firstView.value.team.modules.find((node: { id: string }) => node.id === "worker").role, f.plan.nodes[1]!.role);
    assert.equal(firstView.content.includes(f.plan.nodes[1]!.prompt), false);
    assert.equal(JSON.stringify(firstView.value).includes(f.worker.id), false);
    f.complete(run.id, "delegate");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.current_node_id, "worker");
    const childStep = f.teams.read(f.actor, f.session.id, run.id).run.steps[1]!;
    const childView = orientation(f, childStep.request_event_id!);
    assert.equal(childView.value.first_contact, true); assert.equal(childView.value.phase, "delegated_assignment");
    assert.equal(childView.value.assigned_by.id, "lead"); assert.equal(childView.value.return_result_to.id, "lead");
    assert.deepEqual(childView.value.allowed_call_targets, []); assert.equal(childView.content.includes(f.plan.nodes[1]!.prompt), true);
    const childResponse = f.complete(run.id);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    const resumed = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(resumed.current_node_id, "lead");
    const returnedView = orientation(f, resumed.steps.at(-1)!.request_event_id!);
    assert.equal(returnedView.value.first_contact, false); assert.equal(returnedView.value.phase, "reviewing_return");
    assert.equal(returnedView.value.returned_result_from.id, "worker"); assert.equal(returnedView.value.return_result_to.kind, "human_requester");
    const request = f.db.getEvent(f.session.id, resumed.steps.at(-1)!.request_event_id!);
    assert.match(String((request.payload as { content: string }).content), /Returned subordinate result/);
    assert.match(String((request.payload as { content: string }).content), /Public result/);
    assert.equal(f.teams.store.step(resumed.current_step_id!).context_response_id, childResponse.id);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    const finished = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(finished.calls_used, 3); AgentTeamRunDetailSchema.parse(finished);
    assert.equal(f.service.replay(f.actor, f.session.id, 0, 100).events.filter(event => event.type === "agent_request").length, 3);
    assert.equal(f.teams.start(f.actor, f.session.id, JSON.parse(f.teams.store.row(run.id).input_json)).replayed, true);
  } finally { f.close(); }
});
test("a plain canonical leaf answer returns to its parent with counted calls; public chat never does", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "leaf-chat-is-not-completion",
      payload: { content: "6 × 7 = 42" } });
    await f.teams.pump(); assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 2);
    f.complete(run.id, "complete", "worker", "6 × 7 = 42. The gatherthread-team protocol is documented separately.");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    const returned = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(returned.current_node_id, "lead");
    const prompt = f.db.getEvent(f.session.id, returned.steps.at(-1)!.request_event_id!);
    assert.match(String((prompt.payload as { content: string }).content), /6 × 7 = 42/);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 3);
  } finally { f.close(); }
});

test("plain answers cannot silently complete a delegating node, and leaf control blocks still require exact validity", async () => {
  for (const answer of ["", directive("step-from-another-run"), "```gatherthread-team\n{broken}\n```", directive("step-from-another-run") + "\n" + directive("step-from-another-run")]) {
    const f = fixture(); try {
      const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
      f.complete(run.id, "complete", "worker", answer);
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "failed");
      const failed = f.teams.read(f.actor, f.session.id, run.id).run;
      assert.match(failed.error_code!, /^team_directive_(invalid|mismatch)$/u); assert.equal(failed.calls_used, 2);
    } finally { f.close(); }
  }
  const f = fixture(); try {
    const plan = structuredClone(f.plan); plan.edges[0]!.direction = "bidirectional";
    const run = f.start(plan); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    f.complete(run.id, "complete", "worker", "6 × 7 = 42");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "failed");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.error_code, "team_directive_invalid");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 2);
  } finally { f.close(); }
});

test("a leaf's explicit delegation cannot borrow the implicit parent-return grant", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    f.complete(run.id, "delegate", "lead");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "failed");
    const failed = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(failed.error_code, "team_delegation_forbidden"); assert.equal(failed.calls_used, 2);
  } finally { f.close(); }
});

test("bidirectional cycles terminate at the transactional accepted-call limit", async () => {
  const f = fixture(); try {
    const plan = structuredClone(f.plan); plan.edges[0]!.direction = "bidirectional";
    const run = f.start(plan, 3);
    for (let call = 1; call <= 3; call++) {
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === call);
      const current = f.teams.read(f.actor, f.session.id, run.id).run.current_node_id;
      f.complete(run.id, "delegate", current === "lead" ? "worker" : "lead");
    }
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "call_limit");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 3);
    assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "no-budget-resume" }));
  } finally { f.close(); }
});
test("invalid edges, stale nonces and unrelated public messages cannot authorize a next call", async () => {
  for (const failure of ["edge", "nonce", "missing"] as const) {
    const f = fixture(); try {
      const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "unrelated-handoff-message", payload: { content: directive("forged", "delegate") } });
      const step = f.teams.read(f.actor, f.session.id, run.id).run.current_step_id!;
      f.complete(run.id, "complete", "worker", failure === "edge" ? directive(step, "delegate", "outside-plan")
        : failure === "nonce" ? directive("another-step", "delegate") : "Plain answer without a team control block");
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "failed");
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 1);
    } finally { f.close(); }
  }
  assert.throws(() => parseTeamDirective(`${directive("step")}\n${directive("step")}`, "step"));
  assert.throws(() => parseTeamDirective(`${directive("step")}\ntrailing text`, "step"));
});
test("paused queued steps cannot be claimed, and resume is a fresh counted request without a duplicate control", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const first = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "pause-queued-team" });
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id).status, "paused");
    assert.throws(() => f.service.completeAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id, "late-team-answer", { text: directive(first.id) }));
    const input = { action: "resume" as const, idempotency_key: "resume-queued-team" };
    f.teams.control(f.actor, f.session.id, run.id, input); f.teams.control(f.actor, f.session.id, run.id, input);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.steps.length, 2);
    assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: input.idempotency_key }));
    assert.throws(() => f.service.pauseAgentRequest(f.actor, f.session.id, f.teams.read(f.actor, f.session.id, run.id).run.steps[1]!.request_event_id!), /bounded team/);
  } finally { f.close(); }
});
test("deadline fences queued and active native work even without an online connector", async () => {
  const f = fixture(); try {
    const run = f.teams.start(f.actor, f.session.id, { plan: f.plan, entry_node_id: "lead", content: "Deadline task", max_calls: 12,
      max_duration_minutes: 1, idempotency_key: "deadline-team-start" }).run;
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
    f.advance(61000); await f.teams.pump();
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.status, "timed_out");
    assert.throws(() => f.service.appendAgentProgress(f.actor, f.session.id, step.request_event_id!, f.lead.id, "late-team-progress", { content: "Late work" }));
    assert.throws(() => f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id, "late-team-deadline-result", { text: directive(step.id) }));
    f.service.heartbeatRuntime(f.actor, f.lead.id);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id).status, "paused");
  } finally { f.close(); }
});
test("a queued or claimed team loses its original device grant without revoking another device's ordinary work", async t => {
  for (const invalidation of ["revoked", "expired"] as const) for (const claimed of [false, true]) {
    await t.test(`${invalidation} authorizer / ${claimed ? "claimed" : "queued"} step`, async () => {
      const f = fixture();
      try {
        const device = f.db.createDevice(f.actor.user_id, "Independent fixture executor");
        const executor = { ...f.actor, device_id: device.device_id };
        const runtime = f.service.registerRuntime(executor, { session_id: f.session.id, device_id: executor.device_id,
          harness: "codex", provider: "openai", model: "fixture-gpt", context_deletion_version: 1,
          execution_profiles: [{ provider: "openai", model: "fixture-gpt", reasoning_efforts: ["low"] }],
          local_session_id: "independent-team-executor", capture_fidelity: "harness_transcript" });
        const leaf = structuredClone(f.plan); leaf.nodes = [leaf.nodes[0]!]; leaf.edges = [];
        leaf.nodes[0]!.target = { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "fixture-gpt", reasoning_effort: "low" };
        const started = f.start(leaf);
        await drive(f.teams, () => f.teams.read(executor, f.session.id, started.id).run.calls_used === 1);
        const step = f.teams.read(executor, f.session.id, started.id).run.steps[0]!;
        const request = step.request_event_id!;
        if (claimed) assert.equal(f.service.claimAgentRequest(executor, f.session.id, request, runtime.id).status, "claimed");
        if (invalidation === "revoked") f.db.revokeDevice(executor, f.actor.device_id);
        else {
          f.db.sqlite.prepare("UPDATE devices SET expires_at=? WHERE id=?").run(new Date(f.clock().getTime() + 1).toISOString(), f.actor.device_id);
          f.advance(1);
        }
        f.db.assertActiveDevice(executor);
        assert.equal(f.db.teamRequestMayExecute(request), false, "execution must be fenced before the next maintenance tick");
        assert.equal(f.service.claimAgentRequest(executor, f.session.id, request, runtime.id).status, "paused");
        if (claimed) {
          assert.throws(() => f.service.appendAgentProgress(executor, f.session.id, request, runtime.id, "late-grant-progress", { content: "Late progress" }));
          assert.throws(() => f.service.appendEvent(executor, f.session.id, { type: "tool_result", visibility: "session",
            idempotency_key: "late-grant-tool", reply_to_event_id: request, runtime_id: runtime.id, payload: { content: "Late tool output" } }));
          assert.throws(() => f.service.completeAgentRequest(executor, f.session.id, request, runtime.id, "late-grant-answer", { text: "Late final answer" }));
        }
        for (let index = 0; index < 3; index++) await f.teams.pump();
        const ended = f.teams.read(executor, f.session.id, started.id).run;
        assert.equal(ended.status, "failed"); assert.equal(ended.error_code, "agent_team_authorization_lost");
        assert.equal(ended.calls_used, 1);
        if (claimed) assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)?.status, "paused");
        assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE reply_to_event_id=? AND type IN ('agent_progress','agent_response','tool_result')").get(request)?.n, 0);
        const ordinary = f.service.appendEvent(executor, f.session.id, { type: "agent_request", visibility: "session",
          idempotency_key: "valid-device-ordinary-request", payload: { content: "Ordinary task from the still-valid device",
            execution_profile: { harness: "codex", provider: "openai", model: "fixture-gpt", runtime_id: runtime.id } } });
        assert.equal(f.service.claimAgentRequest(executor, f.session.id, ordinary.id, runtime.id).status, "claimed");
        f.service.appendAgentProgress(executor, f.session.id, ordinary.id, runtime.id, "ordinary-progress", { content: "Ordinary progress" });
        assert.equal(f.service.completeAgentRequest(executor, f.session.id, ordinary.id, runtime.id, "ordinary-answer", { text: "Ordinary final answer" }).type, "agent_response");
      } finally { f.close(); }
    });
  }
});
test("waiting team grants recheck session write access and ownership before maintenance or dispatch", async t => {
  for (const change of ["viewer", "removed", "solo", "archived"] as const) await t.test(change, async () => {
    const f = fixture();
    try {
      const member = f.db.createIdentity({ display_name: "Fixture participant", device_name: "Fixture browser" }).actor;
      f.service.setMembership(f.actor, f.session.id, member.user_id, "participant", `grant-participant-${change}`);
      const device = f.db.createDevice(member.user_id, "Participant executor"), executor = { ...member, device_id: device.device_id };
      const runtime = f.service.registerRuntime(executor, { session_id: f.session.id, device_id: executor.device_id, harness: "codex",
        provider: "openai", model: "fixture-gpt", context_deletion_version: 1, local_session_id: "participant-native", capture_fidelity: "harness_transcript" });
      const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
      plan.nodes[0]!.target = { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "fixture-gpt" };
      const run = f.teams.start(member, f.session.id, { plan, entry_node_id: "lead", content: "Member task", max_calls: 12,
        max_duration_minutes: 30, idempotency_key: `member-run-${change}` }).run;
      await drive(f.teams, () => f.teams.store.row(run.id).calls_used === 1);
      const request = f.teams.store.steps(run.id)[0]!.request_event_id!;
      if (change === "viewer") f.service.setMembership(f.actor, f.session.id, member.user_id, "viewer", "revoke-write");
      else if (change === "removed") f.service.removeMembership(f.actor, f.session.id, member.user_id, "remove-participant");
      else f.service.updateSession(f.actor, f.session.id, { ...(change === "solo" ? { mode: "solo" as const } : { state: "archived" as const }), idempotency_key: `change-${change}` });
      assert.equal(f.db.teamRequestMayExecute(request), false);
      await f.teams.pump();
      assert.equal(f.teams.store.row(run.id).error_code, "agent_team_authorization_lost");
      assert.equal(f.teams.store.row(run.id).status, "failed"); assert.equal(f.teams.store.row(run.id).calls_used, 1);
    } finally { f.close(); }
  });
});
test("private plans use revisions; viewers, foreign runtimes and generic forged metadata are refused", async () => {
  const f = fixture(); try {
    assert.equal(f.teams.savePlan(f.actor, f.session.id, f.plan, null).revision, 1);
    assert.equal(f.teams.savePlan(f.actor, f.session.id, f.plan, null).revision, 1);
    assert.throws(() => f.teams.savePlan(f.actor, f.session.id, { ...f.plan, name: "Stale edit" }, null));
    const other = f.db.createIdentity({ display_name: "Other fixture", device_name: "Other desktop" }).actor;
    f.service.setMembership(f.actor, f.session.id, other.user_id, "participant", "other-team-member");
    assert.deepEqual(f.teams.getPlan(other, f.session.id), { plan: null, revision: null });
    assert.throws(() => f.teams.start(other, f.session.id, { plan: f.plan, entry_node_id: "lead", content: "Foreign target", max_calls: 12,
      max_duration_minutes: 30, idempotency_key: "foreign-team-start" }));
    f.service.setMembership(f.actor, f.session.id, other.user_id, "viewer", "other-team-viewer");
    assert.throws(() => f.teams.savePlan(other, f.session.id, f.plan, null));
    for (const type of ["human_chat", "agent_request"] as const) assert.throws(() => f.service.appendEvent(f.actor, f.session.id, {
      type, visibility: "session", idempotency_key: `forged-team-${type}`, payload: { content: "Forged", agent_team: {} } }), /server-owned/);
    const malformed = structuredClone(f.plan); malformed.nodes[0]!.target = { ...f.plan.nodes[0]!.target, model: "not-advertised" };
    assert.throws(() => f.start(malformed));
  } finally { f.close(); }
});
test("fresh Team reservations require the exact originating start key while historical canonical requests remain readable", async () => {
  const f = fixture(); try {
    const run = f.start(), step = f.teams.store.pending(run.id), original = f.teams.store.row(run.id);
    const before = f.db.requireSession(f.session.id).next_sequence;
    const metadata = { run_id: run.id, step_id: step.id, node_id: "lead", node_label: "Director", task_content: "Human task" };
    for (const startKey of [undefined, "different-originating-start-key"]) {
      assert.throws(() => f.service.appendTeamAgentRequest(f.actor, f.session.id, { type: "agent_request", visibility: "session",
        content_revision: 0, idempotency_key: `reject-start-key-${startKey ?? "missing"}`, payload: {
          content: "Do not accept missing or unrelated originating run identity", execution_profile: {
            harness: "codex", provider: "openai", model: "fixture-gpt", runtime_id: f.lead.id, reasoning_effort: "low" },
          agent_team: { ...metadata, ...(startKey ? { start_idempotency_key: startKey } : {}) },
        } }, () => assert.fail("A rejected reservation must not charge or accept its step")),
      error => error instanceof ApiError && error.code === "forbidden");
    }
    assert.equal(f.db.requireSession(f.session.id).next_sequence, before);
    assert.equal(f.teams.store.row(run.id).calls_used, 0); assert.equal(f.teams.store.step(step.id).status, "pending");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const accepted = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!, request = f.db.getEvent(f.session.id, accepted.request_event_id!);
    const payload = request.payload as { agent_team: { start_idempotency_key?: string } };
    assert.equal(payload.agent_team.start_idempotency_key, original.idempotency_key);
    // Simulate a pre-upgrade canonical envelope. Its public history and permanent
    // Team ownership remain readable without retroactively requiring the field.
    const legacy = structuredClone(request.payload) as { agent_team: { start_idempotency_key?: string } };
    delete legacy.agent_team.start_idempotency_key;
    f.db.sqlite.prepare("UPDATE events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy), request.id);
    assert.equal(f.db.getEvent(f.session.id, request.id).type, "agent_request");
    assert.ok((f.service.replay(f.actor, f.session.id, 0, 100).events.find(event => event.id === request.id)!.payload as { agent_team: unknown }).agent_team);
    assert.equal(f.db.teamRequestMayExecute(request.id), true);
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "legacy-start-key-stop" });
    f.teams.forget(f.actor, f.session.id, run.id);
    assert.equal(f.db.teamRequestMayExecute(request.id), false);
  } finally { f.close(); }
});
test("server restart pauses the bounded run and retains accepted-call accounting", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.teams.close(); const restored = new AgentTeams(f.service, undefined, { clock: f.clock, autoStart: false });
    try {
      const recovered = restored.read(f.actor, f.session.id, run.id).run;
      assert.equal(recovered.status, "paused"); assert.equal(recovered.error_code, "server_restart"); assert.equal(recovered.calls_used, 1);
      await restored.pump(); assert.equal(restored.read(f.actor, f.session.id, run.id).run.calls_used, 1);
      restored.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "restart-team-resume" });
      await drive(restored, () => restored.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    } finally { restored.close(); }
  } finally { f.close(); }
});

const cloudOptions = (runContainer: NonNullable<HostedAgentOptions["runContainer"]>): HostedAgentOptions => ({ image: `example/hosted@sha256:${"a".repeat(64)}`,
  endpoints: [{ id: "fixture-endpoint", profileId: "fixture-cloud", label: "Fixture cloud", provider: "deepseek", model: "fixture-cloud-model",
    baseUrl: "https://api.deepseek.com/v1", apiToken: "fixture-only-never-production", quotaGroup: "fixture-account", dailyRuns: 100, maxConcurrent: 1 }],
  userDailyRuns: 100, globalDailyRuns: 100, maxConcurrent: 1, userMinIntervalSeconds: 1, userMaxConcurrent: 1, runContainer });
function cloudStep(args: string[]) {
  const control = args.find(arg => arg.includes("dst=/run/gatherthread,readonly"))!;
  const directory = /src=([^,]+),dst/u.exec(control)![1]!;
  const prompt = readFileSync(join(directory, "prompt.txt"), "utf8");
  return { prompt, step: /"step_id":"(step-[a-f0-9-]+)"/u.exec(prompt)![1]! };
}
test("a server-contained cloud leaf completes from its plain final answer without inventing native provenance", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-cloud-leaf-")); let calls = 0;
  const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), cloudOptions(async () => {
    calls++; return JSON.stringify({ answer: "6 × 7 = 42", files: [] });
  }));
  f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
  try {
    const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud",
      provider: "deepseek", model: "fixture-cloud-model", include_code: false } }]; plan.edges = [];
    const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Calculate 6*7", max_calls: 1,
      max_duration_minutes: 30, idempotency_key: "plain-cloud-leaf-start" }).run;
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    const completed = teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(completed.calls_used, 1); assert.equal(calls, 1);
    const reply = f.db.getEvent(f.session.id, completed.steps[0]!.response_event_id!);
    assert.equal((reply.payload as { content: string }).content, "6 × 7 = 42");
    assert.equal(reply.runtime_provenance?.harness, "opencode"); assert.equal(reply.runtime_provenance?.runtime_id, undefined);
  } finally { teams.close(); await hosted.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("cloud code notices preserve valid terminal team decisions after either save outcome", { skip: process.platform === "win32" }, async () => {
  for (const saveError of [false, true]) {
    const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-notice-"));
    const repository = new CodeRepository(f.db, directory);
    const file = { path: "result.txt", content_base64: Buffer.from("42\n").toString("base64"), executable: false };
    const hosted = new HostedAgent(f.service, repository, cloudOptions(async args => {
      const { step } = cloudStep(args);
      return JSON.stringify({ answer: directive(step).replace("```gatherthread-team\n", "```gatherthread-team \t\r\n"),
        files: [file], save_error: saveError ? "synthetic save refusal" : null });
    }));
    f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
    try {
      repository.enable(f.actor, f.session.project_id, { idempotency_key: "team-notice-code-enable" });
      const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud",
        provider: "deepseek", model: "fixture-cloud-model", include_code: true } }]; plan.edges = [];
      const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Write the arithmetic result",
        max_calls: 1, max_duration_minutes: 30, idempotency_key: "team-notice-start" }).run;
      await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status !== "running");
      const completed = teams.read(f.actor, f.session.id, run.id).run;
      assert.equal(completed.status, "completed"); assert.equal(completed.calls_used, 1);
      const content = (f.db.getEvent(f.session.id, completed.steps[0]!.response_event_id!).payload as { content: string }).content;
      assert.match(content, saveError ? /files could not be saved/ : /Changes were saved/);
      assert.equal(parseTeamDirective(content, completed.steps[0]!.id).action, "complete");
      const branch = repository.status(f.actor, f.session.project_id).own_branch_id;
      if (saveError) {
        assert.equal(branch, null, "a refused save cannot create a personal branch");
        assert.deepEqual(repository.snapshot(f.actor, f.session.project_id, "main").snapshot.files, []);
      } else {
        assert.ok(branch);
        assert.deepEqual(repository.snapshot(f.actor, f.session.project_id, branch).snapshot.files, [file]);
      }
    } finally { teams.close(); await hosted.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("cloud timeout continuation is a fresh counted step, rejects public continuation bypass, and stays under 12KiB context", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-cloud-")); let calls = 0;
  const repository = new CodeRepository(f.db, directory);
  const hosted = new HostedAgent(f.service, repository, cloudOptions(async args => {
    calls++; const { step, prompt } = cloudStep(args); assert.ok(Buffer.byteLength(prompt) < 36000);
    assert.ok(prompt.includes("Prior shared requirement: preserve the agreed behavior."));
    if (calls === 1) throw new Error("agent_timeout");
    assert.ok(prompt.includes("Human update after timeout: check the final result."));
    assert.equal(prompt.split("Original cloud task").length, 2);
    return JSON.stringify({ answer: directive(step), files: [] });
  }));
  f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
  try {
    const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud", provider: "deepseek", model: "fixture-cloud-model", include_code: false } }]; plan.edges = [];
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "team-prior-human-context",
      payload: { content: "Prior shared requirement: preserve the agreed behavior." } });
    const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Original cloud task", max_calls: 3,
      max_duration_minutes: 30, idempotency_key: "cloud-team-start" }).run;
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "paused");
    const paused = teams.read(f.actor, f.session.id, run.id).run; assert.equal(paused.error_code, "agent_timeout"); assert.equal(paused.calls_used, 1);
    const original = f.db.getEvent(f.session.id, paused.steps[0]!.request_event_id!);
    await assert.rejects(hosted.start(f.actor, f.session.id, { profile_id: "fixture-cloud", include_code: false,
      content: String((original.payload as { content: string }).content), idempotency_key: "bypass-team-continue", continue_from_event_id: original.id }), /bounded team/);
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "team-timeout-human-update",
      payload: { content: "Human update after timeout: check the final result." } });
    f.advance(1000);
    teams.control(f.actor, f.session.id, run.id, { action: "continue", idempotency_key: "cloud-team-continue" });
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    assert.equal(teams.read(f.actor, f.session.id, run.id).run.calls_used, 2); assert.equal(hosted.status(f.actor).user_used_runs, 2);
  } finally { teams.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
test("a timed-out cloud subordinate continues explicitly then returns to its native parent within the original budget", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-mixed-")); let cloudCalls = 0;
  const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), cloudOptions(async args => {
    const { step, prompt } = cloudStep(args); cloudCalls++;
    assert.ok(prompt.includes("Original mixed task"));
    if (cloudCalls === 1) throw new Error("agent_timeout");
    return JSON.stringify({ answer: `Cloud subordinate verified result.\n\n${directive(step)}`, files: [] });
  }));
  f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
  try {
    const plan = structuredClone(f.plan);
    plan.nodes[1]!.target = { kind: "cloud", profile_id: "fixture-cloud", provider: "deepseek", model: "fixture-cloud-model", include_code: false };
    const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Original mixed task",
      max_calls: 4, max_duration_minutes: 30, idempotency_key: "mixed-team-start" }).run;
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate");
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "paused");
    const paused = teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(paused.current_node_id, "worker"); assert.equal(paused.calls_used, 2);
    await teams.pump(); assert.equal(cloudCalls, 1, "timeout cannot retry itself");
    f.advance(1000);
    teams.control(f.actor, f.session.id, run.id, { action: "continue", idempotency_key: "mixed-team-continue" });
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.calls_used === 4);
    const returned = teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(returned.current_node_id, "lead"); assert.equal(returned.deadline_at, run.deadline_at);
    const request = f.db.getEvent(f.session.id, returned.steps.at(-1)!.request_event_id!);
    const prompt = String((request.payload as { content: string }).content);
    assert.ok(prompt.includes("Original mixed task")); assert.ok(prompt.includes("Cloud subordinate verified result"));
    f.complete(run.id);
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    const finished = teams.read(f.actor, f.session.id, run.id).run;
    assert.deepEqual(finished.steps.map(step => step.node_id), ["lead", "worker", "worker", "lead"]);
    assert.equal(finished.calls_used, 4); assert.equal(cloudCalls, 2);
  } finally { teams.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
test("private storage caps refuse oversized control growth and still allow stopping", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.db.sqlite.prepare("UPDATE agent_team_runs SET bytes=524288 WHERE id=?").run(run.id);
    f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "full-team-pause" });
    assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "full-team-resume" }),
      error => error instanceof ApiError && error.code === "agent_team_storage_full");
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "full-team-stop" }).run.status, "stopped");
    const head = f.db.requireSession(f.session.id).next_sequence; f.teams.forget(f.actor, f.session.id, run.id);
    assert.equal(f.db.requireSession(f.session.id).next_sequence, head);
  } finally { f.close(); }
});

test("successful no-op control retries never operate a later run state", () => {
  const f = fixture();
  try {
    const run = f.start();
    const resume = { action: "resume" as const, idempotency_key: "noop-team-resume" };
    const continuing = { action: "continue" as const, idempotency_key: "noop-team-continue" };
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, resume).run.status, "running");
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, continuing).run.status, "running");
    f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "human-team-pause" });
    const pause = { action: "pause" as const, idempotency_key: "noop-team-pause" };
    f.teams.control(f.actor, f.session.id, run.id, pause);
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, resume).run.status, "paused");
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, continuing).run.status, "paused");
    f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "new-team-resume" });
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, pause).run.status, "running");
    assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { ...pause, action: "stop" }),
      error => error instanceof ApiError && error.code === "idempotency_conflict");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 0);
  } finally { f.close(); }
});

test("ordinary control exhaustion keeps bounded Pause and independent Stop receipts", () => {
  const f = fixture();
  try {
    const run = f.start();
    for (let index = 0; index < 128; index++) f.teams.control(f.actor, f.session.id, run.id,
      { action: "resume", idempotency_key: `noop-resume-receipt-${index}` });
    const pause = { action: "pause" as const, idempotency_key: "reserved-team-pause" };
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, pause).run.status, "paused");
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, pause).run.status, "paused");
    assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "extra-noop-pause" }),
      error => error instanceof ApiError && error.code === "agent_team_storage_full");
    const stop = { action: "stop" as const, idempotency_key: "reserved-team-stop" };
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, stop).run.status, "stopped");
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, stop).run.status, "stopped");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_controls WHERE run_id=?").get(run.id)!.count, 130);
  } finally { f.close(); }
});

test("recognized credentials are rejected before private storage and before canonical Agent acceptance", () => {
  const f = fixture();
  try {
    const sensitive = ["sk", "syntheticfixturevalue12345678"].join("-");
    for (const field of ["team_prompt", "role", "task"]) {
      const plan = structuredClone(f.plan);
      if (field === "team_prompt") plan.team_prompt = sensitive;
      if (field === "role") plan.nodes[0]!.role = sensitive;
      if (field !== "task") assert.throws(() => f.teams.savePlan(f.actor, f.session.id, plan, null),
        error => error instanceof ApiError && error.code === "agent_team_sensitive_input");
      assert.throws(() => f.teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: field === "task" ? sensitive : "Public task",
        max_calls: 12, max_duration_minutes: 30, idempotency_key: `sensitive-team-${field}` }),
        error => error instanceof ApiError && error.code === "agent_team_sensitive_input");
    }
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_plans").get()!.count, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_runs").get()!.count, 0);
    assert.equal(f.service.replay(f.actor, f.session.id, 0, 100).events.some(event => event.type === "agent_request"), false);
  } finally { f.close(); }
});

test("message erasure scrubs private team copies, fences late work and rejects stale automatic starts", async () => {
  const f = fixture();
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "team-erasure-source", payload: { content: "Disposable source" } });
    const run = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
    f.db.deleteMessage(f.actor, f.session.id, source.id, "team-source-erasure");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_runs WHERE session_id=?").get(f.session.id)!.count, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_steps").get()!.count, 0);
    assert.equal(f.db.teamRequestMayExecute(step.request_event_id!), false);
    assert.throws(() => f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id,
      "late-erased-team-result", { text: directive(step.id, "delegate") }));
    assert.throws(() => f.teams.start(f.actor, f.session.id, { plan: f.plan, entry_node_id: "lead", content: "Stale task",
      max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: "stale-erased-team-start" }),
      error => error instanceof ApiError && error.code === "context_changed");
    assert.throws(() => f.teams.start(f.actor, f.session.id, { plan: f.plan, entry_node_id: "lead", content: "Unpinned task",
      max_calls: 12, max_duration_minutes: 30, idempotency_key: "unpinned-erased-team-start" }),
      error => error instanceof ApiError && error.code === "context_changed");
    await f.teams.pump();
    const current = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, current.id).run.calls_used === 1);
    const request = f.db.getEvent(f.session.id, f.teams.read(f.actor, f.session.id, current.id).run.steps[0]!.request_event_id!);
    assert.equal(request.content_revision, 1);
  } finally { f.close(); }
});

test("personal cloud team continuation retains its exact configuration revision and never switches payer after an edit", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-personal-")); let calls = 0;
  const options = { ...cloudOptions(async () => { calls++; throw new Error("container_timeout"); }), personalApiEncryptionKey: randomBytes(32).toString("base64") };
  const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), options);
  f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
  try {
    const metadata = { expected_revision: null, provider_id: "deepseek" as const, label: "Fixture personal model", model: "deepseek-chat",
      enabled: true, api_key: ["synthetic", "team", "provider", "value"].join("-") };
    const config = hosted.putPersonalApi(f.actor, randomUUID(), metadata);
    const profile = hosted.status(f.actor).profiles.find(profile => profile.id === config.profile_id)!;
    const plan = structuredClone(f.plan); plan.edges = []; plan.nodes = [{ ...plan.nodes[0]!, target: {
      kind: "cloud", profile_id: config.profile_id, provider: profile.provider, model: profile.model, include_code: false, api_config_revision: config.revision } }];
    const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Fixture personal task", max_calls: 3,
      max_duration_minutes: 30, idempotency_key: "team-personal-original" }).run;
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "paused");
    assert.equal(teams.read(f.actor, f.session.id, run.id).run.error_code, "agent_timeout");
    const requestId = teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    assert.equal(hosted.selection(f.actor, f.session.id, requestId).api_config_revision, config.revision);
    const updated = hosted.putPersonalApi(f.actor, config.id, { ...metadata, label: "Updated fixture label", expected_revision: config.revision });
    assert.notEqual(updated.revision, config.revision);
    assert.throws(() => teams.control(f.actor, f.session.id, run.id, { action: "continue", idempotency_key: "team-personal-continue" }),
      error => error instanceof ApiError && error.code === "agent_team_target_unavailable");
    assert.equal(teams.read(f.actor, f.session.id, run.id).run.status, "paused");
    assert.equal(teams.read(f.actor, f.session.id, run.id).run.calls_used, 1);
    assert.equal(calls, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM hosted_agent_daily_usage WHERE billing_source='personal'").get()!.count, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM hosted_agent_daily_usage WHERE billing_source='service'").get()!.count, 0);
  } finally { teams.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("maximum-length Chinese team instructions preserve the entire original task across delegation and return", async () => {
  const f = fixture();
  try {
    const original = "原".repeat(3000), plan = structuredClone(f.plan);
    plan.team_prompt = "规".repeat(2000); plan.nodes.forEach(node => { node.role = "职".repeat(1000); });
    const run = f.teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: original, max_calls: 3,
      max_duration_minutes: 30, idempotency_key: "long-chinese-team" }).run;
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const child = f.teams.read(f.actor, f.session.id, run.id).run.steps[1]!;
    const prompt = String((f.db.getEvent(f.session.id, child.request_event_id!).payload as { content: string }).content);
    assert.ok(prompt.includes(original)); assert.ok(prompt.includes(plan.team_prompt)); assert.ok(prompt.includes(plan.nodes[1]!.role));
    assert.ok(prompt.length > 6000); assert.ok(Buffer.byteLength(prompt) < 40000);
    f.complete(run.id);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    f.complete(run.id);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
  } finally { f.close(); }
});

test("waiting native executions do not occupy every scheduler slot or starve another owner's accepted team", async () => {
  const f = fixture();
  try {
    const runs = [];
    for (let index = 0; index < 33; index++) {
      const actor = f.db.createIdentity({ display_name: `Scheduler fixture ${index}`, device_name: "Fixture", can_create_projects: true }).actor;
      const project = f.service.createProject(actor, { title: "Own scheduler fixture", idempotency_key: `scheduler-project-${index}` });
      const { session } = f.service.createSession(actor, { project_id: project.id, mode: "multi", title: "Waiting native execution", idempotency_key: `scheduler-session-${index}` });
      const runtime = f.service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id,
        harness: "codex", provider: "openai", model: "fixture-scheduler", context_deletion_version: 1,
        capture_fidelity: "harness_transcript", local_session_id: `fixture-scheduler-${index}` });
      const plan: AgentTeamPlan = { name: "Scheduler team", team_prompt: "Finish this assignment", edges: [], nodes: [{
        id: "lead", label: "Lead", role: "Finish", x: 0, y: 0,
        target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "fixture-scheduler" } }] };
      runs.push({ actor, session, run: f.teams.start(actor, session.id, { plan, entry_node_id: "lead", content: "Public scheduler fixture",
        max_calls: 1, max_duration_minutes: 30, content_revision: 0, idempotency_key: `scheduler-team-start-${index}` }).run });
    }
    const last = runs.at(-1)!;
    await drive(f.teams, () => f.teams.read(last.actor, last.session.id, last.run.id).run.calls_used === 1);
    for (const entry of runs) assert.equal(f.teams.read(entry.actor, entry.session.id, entry.run.id).run.calls_used, 1);
    assert.equal(f.teams.store.due().length, 0, "unfinished native replies wait without resubmitting or blocking ready teams");
  } finally { f.close(); }
});

test("an accepted native call is displayed as queued until the exact runtime actually claims it", async () => {
  const f = fixture();
  try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const queued = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(queued.steps[0]!.status, "pending"); assert.ok(queued.steps[0]!.request_event_id);
    f.service.claimAgentRequest(f.actor, f.session.id, queued.steps[0]!.request_event_id!, f.lead.id);
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.status, "running");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 1);
  } finally { f.close(); }
});

test("erasing a returned subordinate result scrubs its copied parent prompt and leaves the independent human task", async () => {
  const f = fixture();
  try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const marker = "Disposable derived result must disappear";
    const child = f.teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!;
    const answer = f.complete(run.id, "complete", "worker", `${marker}\n\n${directive(child.id)}`);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    const steps = f.teams.read(f.actor, f.session.id, run.id).run.steps;
    const copied = steps.at(-1)!.request_event_id!;
    assert.ok(JSON.stringify(f.db.getEvent(f.session.id, copied).payload).includes(marker));
    f.db.deleteMessage(f.actor, f.session.id, answer.id, "team-child-result-erasure");
    assert.equal(f.db.getEvent(f.session.id, copied).deleted?.reason, "request");
    assert.equal(f.db.teamRequestMayExecute(copied), false);
    assert.ok(!JSON.stringify(f.service.replay(f.actor, f.session.id, 0, 100).events).includes(marker));
    assert.equal(f.db.getEvent(f.session.id, steps[0]!.request_event_id!).deleted, undefined);
  } finally { f.close(); }
});

test("canonical team derivation remains erasable after its ended private record has been cleared", async () => {
  const f = fixture();
  try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const lead = f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    const steps = f.teams.read(f.actor, f.session.id, run.id).run.steps;
    f.teams.forget(f.actor, f.session.id, run.id);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_steps").get()!.count, 0);
    f.db.deleteMessage(f.actor, f.session.id, lead.id, "team-forgotten-result-erasure");
    for (const step of steps.slice(1)) {
      assert.ok(f.db.getEvent(f.session.id, step.request_event_id!).deleted);
      assert.ok(f.db.getEvent(f.session.id, step.response_event_id!).deleted);
      assert.equal(f.db.teamRequestMayExecute(step.request_event_id!), false);
    }
  } finally { f.close(); }
});

test("repeated full-quota pauses cannot consume the independent emergency Stop receipt", async () => {
  const f = fixture();
  try {
    const run = f.start();
    for (let index = 0; index < 2; index++) {
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === index + 1);
      f.db.sqlite.prepare("UPDATE agent_team_runs SET bytes=524288 WHERE id=?").run(run.id);
      f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: `full-pause-${index}` });
      f.db.sqlite.prepare("UPDATE agent_team_runs SET bytes=400000 WHERE id=?").run(run.id);
      f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: `released-resume-${index}` });
    }
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    const request = f.teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!.request_event_id!;
    f.db.sqlite.prepare("UPDATE agent_team_runs SET bytes=524288 WHERE id=?").run(run.id);
    const stop = { action: "stop" as const, idempotency_key: "independent-emergency-stop" };
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, stop).run.status, "stopped");
    assert.equal(f.teams.control(f.actor, f.session.id, run.id, stop).run.status, "stopped");
    assert.equal(f.db.teamRequestMayExecute(request), false);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id).status, "paused");
    const receipts = f.db.sqlite.prepare("SELECT action,COUNT(*) AS count FROM agent_team_controls WHERE run_id=? AND reserved=1 GROUP BY action").all(run.id);
    assert.deepEqual(receipts.map(row => [row.action, row.count]), [["pause", 2], ["stop", 1]]);
  } finally { f.close(); }
});

test("explicit reasoning conflicts stop delegation while missing legacy provenance is defined separately", async () => {
  for (const observed of ["low", "high", undefined]) {
    const f = fixture();
    try {
      f.service.registerRuntime(f.actor, { runtime_id: f.lead.id, session_id: f.session.id, device_id: f.actor.device_id,
        harness: "codex", provider: "openai", model: "fixture-gpt", context_deletion_version: 1,
        execution_profiles: [{ provider: "openai", model: "fixture-gpt", reasoning_efforts: ["low", "high"] }],
        local_session_id: "fixture-codex", capture_fidelity: "harness_transcript" });
      const plan = structuredClone(f.plan);
      plan.nodes[0]!.target = { kind: "local", runtime_id: f.lead.id, harness: "codex", provider: "openai", model: "fixture-gpt", reasoning_effort: "high" };
      const run = f.start(plan);
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      const claim = f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
      const answer = f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id,
        "observed-reasoning-response", { text: directive(step.id, "delegate") }, "fixture-gpt", observed, claim.attempt_count);
      assert.equal(answer.runtime_provenance?.reasoning_effort, observed);
      await f.teams.pump();
      const result = f.teams.read(f.actor, f.session.id, run.id).run;
      if (observed === "low") {
        assert.equal(result.status, "failed"); assert.equal(result.error_code, "team_response_route_mismatch");
        assert.equal(result.calls_used, 1); assert.equal(result.steps.length, 1);
      } else {
        await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
        assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.current_node_id, "worker");
      }
    } finally { f.close(); }
  }
});

test("terminal private records expire through reads or maintenance without creating another plan", async () => {
  for (const path of ["detail", "list", "plan", "maintenance"]) {
    const f = fixture();
    try {
      f.teams.savePlan(f.actor, f.session.id, f.plan, null);
      const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const request = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
      f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "retention-stop" });
      const head = f.db.requireSession(f.session.id).next_sequence;
      f.advance((path === "maintenance" ? 31 : 30) * 86400000);
      if (path === "detail") assert.throws(() => f.teams.read(f.actor, f.session.id, run.id), error => error instanceof ApiError && error.status === 404);
      if (path === "list") assert.deepEqual(f.teams.list(f.actor, f.session.id).runs, []);
      if (path === "plan") assert.equal(f.teams.getPlan(f.actor, f.session.id).revision, 1);
      if (path === "maintenance") await f.teams.pump();
      for (const table of ["agent_team_runs", "agent_team_steps", "agent_team_controls"]) {
        assert.equal(f.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0);
      }
      assert.equal(f.db.requireSession(f.session.id).next_sequence, head);
      assert.equal(f.db.getEvent(f.session.id, request).type, "agent_request");
      assert.equal(f.db.teamRequestMayExecute(request), false);
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_plans").get()!.count, 1);
    } finally { f.close(); }
  }
});

test("Forget cannot turn a canonical timed-out team request into an executable ordinary continuation", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-forgotten-")); let calls = 0;
  const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), cloudOptions(async () => {
    calls++; throw new Error("agent_timeout");
  }));
  f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
  try {
    const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud",
      provider: "deepseek", model: "fixture-cloud-model", include_code: false } }]; plan.edges = [];
    const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "One bounded cloud task",
      max_calls: 1, max_duration_minutes: 30, idempotency_key: "forgotten-cloud-team" }).run;
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "paused");
    const original = f.db.getEvent(f.session.id, teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!);
    const continuation = { profile_id: "fixture-cloud", include_code: false, content: String((original.payload as { content: string }).content),
      continue_from_event_id: original.id, idempotency_key: "ordinary-before-forget" };
    await assert.rejects(hosted.start(f.actor, f.session.id, continuation), /bounded team/);
    teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "stop-forgotten-cloud-team" });
    teams.forget(f.actor, f.session.id, run.id); f.advance(1000);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_steps").get()!.count, 0);
    const head = f.db.requireSession(f.session.id).next_sequence;
    await assert.rejects(hosted.start(f.actor, f.session.id, { ...continuation, idempotency_key: "ordinary-after-forget" }), /bounded team/);
    assert.equal(calls, 1); assert.equal(f.db.requireSession(f.session.id).next_sequence, head);
    assert.equal(f.db.teamRequestMayExecute(original.id), false);
  } finally { teams.close(); await hosted.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("deleting the original paused request also erases its resumed copy without needing a final response", async () => {
  const f = fixture();
  try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const original = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "team-copy-pause" });
    f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "team-copy-resume" });
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const resumed = f.teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!.request_event_id!;
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "team-copy-stop" }); f.teams.forget(f.actor, f.session.id, run.id);
    f.db.deleteMessage(f.actor, f.session.id, original, "team-original-copy-erasure");
    assert.ok(f.db.getEvent(f.session.id, resumed).deleted); assert.equal(f.db.teamRequestMayExecute(resumed), false);
  } finally { f.close(); }
});

test("modules sharing one underlying runtime still receive independent first-contact orientation", async () => {
  const f = fixture(); try {
    const plan = structuredClone(f.plan); plan.nodes[1]!.target = structuredClone(plan.nodes[0]!.target);
    const run = f.start(plan);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const lead = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    assert.equal(orientation(f, lead.request_event_id!).value.first_contact, true);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const worker = f.teams.read(f.actor, f.session.id, run.id).run.steps[1]!;
    const workerView = orientation(f, worker.request_event_id!).value;
    assert.equal(workerView.current_module.id, "worker"); assert.equal(workerView.first_contact, true);
    assert.equal(workerView.assigned_by.id, "lead"); assert.equal(workerView.return_result_to.id, "lead");
    assert.deepEqual(workerView.allowed_call_targets, []);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    const returned = f.teams.read(f.actor, f.session.id, run.id).run.steps[2]!;
    assert.equal(orientation(f, returned.request_event_id!).value.first_contact, false);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
  } finally { f.close(); }
});

test("a conflict can resume only after a fresh nonempty public human clarification by the original requester", async t => {
  for (const candidate of ["none", "old", "other-user", "agent", "blank", "other-session", "deleted"] as const) await t.test(candidate, async () => {
    const f = fixture(); try {
      if (candidate === "old") f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
        idempotency_key: "old-before-conflict", payload: { content: "An earlier human message is not a response to a later conflict." } });
      const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      const report = f.complete(run.id, "complete", "worker", conflictAnswer(step.id));
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "paused");
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.error_code, "agent_team_instruction_conflict");
      if (candidate === "other-user") {
        const peer = f.db.createIdentity({ display_name: "Synthetic clarification peer", device_name: "Peer device" }).actor;
        f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "clarification-peer-join");
        f.service.appendEvent(peer, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "peer-after-conflict",
          payload: { content: "Another user's advice cannot authorize the requester's continuation." } });
      } else if (candidate === "agent") {
        const ordinary = f.service.appendEvent(f.actor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: "agent-after-conflict",
          payload: { content: "An independent Agent answer is not human clarification.", execution_profile: {
            harness: "codex", provider: "openai", model: "fixture-gpt", runtime_id: f.lead.id, reasoning_effort: "low" } } });
        const claim = f.service.claimAgentRequest(f.actor, f.session.id, ordinary.id, f.lead.id);
        f.service.completeAgentRequest(f.actor, f.session.id, ordinary.id, f.lead.id, "agent-clarification-answer",
          { content: "The Agent proposes a resolution." }, "fixture-gpt", "low", claim.attempt_count);
      } else if (candidate === "blank") f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
        idempotency_key: "blank-after-conflict", payload: { content: " \n\t " } });
      else if (candidate === "other-session") {
        const other = f.service.createSession(f.actor, { project_id: f.session.project_id, mode: "multi", title: "Other clarification session",
          idempotency_key: "other-clarification-session" }).session;
        f.service.appendEvent(f.actor, other.id, { type: "human_chat", visibility: "session", idempotency_key: "other-session-after-conflict",
          payload: { content: "A different session cannot resolve this Team's conflict." } });
      } else if (candidate === "deleted") {
        const removed = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "deleted-after-conflict",
          payload: { content: "A withdrawn clarification must not remain usable." } });
        f.db.deleteMessage(f.actor, f.session.id, removed.id, "delete-unused-clarification");
      }
      if (candidate === "deleted") {
        assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "resume-deleted-clarification" }));
        assert.equal(f.db.teamRequestMayExecute(step.request_event_id!), false);
      } else {
        assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: `resume-invalid-${candidate}` }),
          (error: unknown) => error instanceof ApiError && error.code === "agent_team_clarification_required");
        assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "continue", idempotency_key: `continue-invalid-${candidate}` }),
          (error: unknown) => error instanceof ApiError && error.code === "conflict");
        const paused = f.teams.read(f.actor, f.session.id, run.id).run;
        assert.equal(paused.status, "paused"); assert.equal(paused.calls_used, 1); assert.equal(paused.steps[0]!.response_event_id, report.id);
        assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_controls WHERE run_id=?").get(run.id)!.n, 0);
      }
    } finally { f.close(); }
  });
});

test("owner clarification resumes a child in one fresh counted step, keeps its parent stack, and freezes the selected message across retries", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const child = f.teams.read(f.actor, f.session.id, run.id).run.steps[1]!;
    const report = f.complete(run.id, "complete", "worker", conflictAnswer(child.id, "The public child role conflicts with the requested method."));
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "paused");
    const before = f.teams.store.state(f.teams.store.row(run.id));
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "earlier-owner-clarification",
      payload: { content: "An earlier answer before the final clarification." } });
    const clarification = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "chosen-owner-clarification",
      payload: { content: "Preserve the configured role; use the permitted read-only method." } });
    const resume = { action: "resume" as const, idempotency_key: "clarified-child-resume" };
    f.teams.control(f.actor, f.session.id, run.id, resume);
    assert.equal(f.teams.store.row(run.id).current_step_id, null);
    const state = f.teams.store.state(f.teams.store.row(run.id));
    assert.deepEqual(state.stack, before.stack); assert.equal(state.node_id, before.node_id); assert.equal(state.task, before.task);
    assert.equal(state.parent_step_id, before.parent_step_id); assert.equal(state.context_response_id, before.context_response_id);
    assert.equal(state.clarification_event_id, clarification.id); assert.equal(state.conflict_response_id, report.id);
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "newer-message-after-resume",
      payload: { content: "A later message cannot alter an already accepted control receipt." } });
    f.teams.control(f.actor, f.session.id, run.id, resume);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    const active = f.teams.read(f.actor, f.session.id, run.id).run, next = active.steps.at(-1)!;
    assert.notEqual(next.id, child.id); assert.equal(next.node_id, "worker"); assert.equal(next.parent_step_id, child.parent_step_id);
    assert.equal(active.deadline_at, run.deadline_at); assert.equal(active.max_calls, run.max_calls);
    const request = f.db.getEvent(f.session.id, next.request_event_id!);
    assert.equal((request.payload as { agent_team: { clarification_event_id: string } }).agent_team.clarification_event_id, clarification.id);
    const nextView = orientation(f, request.id);
    assert.match(nextView.content, /public child role conflicts/u); assert.match(nextView.content, /use the permitted read-only method/u);
    assert.equal(nextView.value.phase, "clarification_resume"); assert.equal(nextView.value.first_contact, false);
    assert.equal(nextView.value.assigned_by.id, "lead"); assert.equal(nextView.value.return_result_to.id, "lead");
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 4);
    assert.equal(f.teams.store.state(f.teams.store.row(run.id)).clarification_event_id, clarification.id);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 4);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_controls WHERE run_id=? AND action='resume'").get(run.id)!.n, 1);
  } finally { f.close(); }
});

test("deleting explicit human clarification recursively erases its copied Team prompts even after Forget while preserving ordinary human quotes", async t => {
  for (const forgotten of [false, true]) await t.test(forgotten ? "after private Forget" : "with private run retained", async () => {
    const f = fixture(); try {
      const leaf = structuredClone(f.plan); leaf.nodes = [leaf.nodes[0]!]; leaf.edges = [];
      const run = f.start(leaf); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const first = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      const report = f.complete(run.id, "complete", "worker", conflictAnswer(first.id));
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "paused");
      const clarification = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "erasable-human-clarification",
        payload: { content: "A synthetic clarification body that must disappear from derived prompts." } });
      const quote = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "independent-human-clarification-quote",
        reply_to_event_id: clarification.id, payload: { content: "My independent human comment is preserved." } });
      // The most recent owner message is what the explicit Resume adopts.
      const chosen = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "chosen-erasable-clarification",
        payload: { content: "Use the synthetic clarified method within the frozen role." } });
      const peer = f.db.createIdentity({ display_name: "Synthetic quoting peer", device_name: "Quoting peer device" }).actor;
      f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "clarification-erasure-peer-join");
      const preserved = f.service.appendEvent(peer, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "independent-clarification-quote-peer",
        reply_to_event_id: chosen.id, payload: { content: "A peer's independently authored quoted comment survives." } });
      f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "resume-erasable-clarification" });
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
      const copied = f.teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!;
      assert.equal((f.db.getEvent(f.session.id, copied.request_event_id!).payload as { agent_team: { clarification_event_id: string } }).agent_team.clarification_event_id, chosen.id);
      f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
      const answer = f.teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!.response_event_id!;
      if (forgotten) f.teams.forget(f.actor, f.session.id, run.id);
      f.db.deleteMessage(f.actor, f.session.id, chosen.id, "erase-adopted-clarification");
      assert.ok(f.db.getEvent(f.session.id, copied.request_event_id!).deleted); assert.ok(f.db.getEvent(f.session.id, answer).deleted);
      assert.equal(f.db.teamRequestMayExecute(copied.request_event_id!), false);
      assert.equal(Boolean(f.db.getEvent(f.session.id, report.id).deleted), false);
      assert.equal(Boolean(f.db.getEvent(f.session.id, quote.id).deleted), false);
      assert.equal(Boolean(f.db.getEvent(f.session.id, preserved.id).deleted), false);
      assert.equal((f.db.getEvent(f.session.id, quote.id).payload as { content: string }).content, "My independent human comment is preserved.");
      assert.equal((f.db.getEvent(f.session.id, preserved.id).payload as { content: string }).content, "A peer's independently authored quoted comment survives.");
    } finally { f.close(); }
  });
});
