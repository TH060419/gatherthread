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
import { redactJson } from "../src/redaction.js";
import { randomBytes, randomUUID } from "node:crypto";
import { teamStartDigest } from "../src/agent-team-schema.js";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const directive = (stepId: string, action: "complete" | "delegate" = "complete", target = "worker") =>
  `Public result.\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: stepId, action,
    ...(action === "delegate" ? { target_node_id: target, task: "Carry out the subordinate task" } : {}) })}\n\`\`\``;
function fixture(path = ":memory:") {
  let time = Date.now(); const clock = () => new Date(time);
  const db = new CollaborationDatabase(path, { clock });
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

test("Team control parsing retains a short final instruction after a long public answer and rejects ambiguous fences", () => {
  const body = JSON.stringify({ version: 1, step_id: "bounded-step", action: "complete" });
  const block = `\`\`\`gatherthread-team\n${body}\n\`\`\``;
  assert.equal(parseTeamDirective(`${"A public result.\n".repeat(12000)}${block}\n \t`, "bounded-step").action, "complete");
  assert.equal(parseTeamDirective(`Earlier public text.\r\n\`\`\`gatherthread-team \t\r\n${body}\r\n\`\`\` \t\r\n`, "bounded-step").action, "complete");
  assert.equal(parseTeamDirective(`\`\`\`text\nOrdinary code example\n\`\`\`\n${block}`, "bounded-step").action, "complete");
  for (const answer of [block + "\n" + block, block + "\nUnapproved trailing text", "```gatherthread-team\n{}",
    `\`\`\`gatherthread-team\n${" ".repeat(15001)}${body}\n\`\`\``, `\`\`\`gatherthread-team\n${block}`]) {
    assert.throws(() => parseTeamDirective(answer, "bounded-step"), { code: "team_directive_invalid" });
  }
  assert.throws(() => parseTeamDirective(block, "another-step"), { code: "team_directive_mismatch" });
});

test("malformed bounded Team answers cannot monopolize the coordinator while searching for a final control block", { timeout: 15000 }, async t => {
  // Run the adversarial shape off the test runner's thread. Start the deadline
  // after module loading, so a regression is interrupted rather than hanging
  // the server suite; no provider or canonical payload is needed or retained.
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    (async () => {
      const { parseTeamDirective } = await import(${JSON.stringify(new URL("../src/agent-teams.js", import.meta.url).href)});
      parentPort.once("message", () => {
        const opening = ["\x60".repeat(3) + "gatherthread-team", ""].join("\\n");
        const answer = opening.repeat(Math.floor(196608 / opening.length));
        const started = performance.now(); let code;
        try { parseTeamDirective(answer, "bounded-step"); } catch (error) { code = error.code; }
        parentPort.postMessage({ code, elapsed: performance.now() - started, bytes: Buffer.byteLength(answer) });
      });
      parentPort.postMessage("ready");
    })().catch(() => parentPort.postMessage("fixture_failed"));
  `, { eval: true });
  t.after(() => worker.terminate());
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", value => value === "ready" ? resolve() : reject(new Error("Parser worker failed before execution")));
  });
  const result = await new Promise<{ code: string; elapsed: number; bytes: number }>((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error("Bounded malformed Team answer exceeded the 2-second parser budget")); }, 2000);
    worker.once("message", value => { clearTimeout(deadline); resolve(value); }); worker.postMessage("parse");
  });
  assert.equal(result.code, "team_directive_invalid"); assert.ok(result.bytes <= 196608);
  assert.ok(result.elapsed < 1000, `Bounded scanning took ${result.elapsed}ms`);
});

for (const code of ["codex_turn_cancelled", "codex_turn_missing", "codex_turn_failed", "harness_execution_failed",
  "agent_request_abandoned", "unknown_private_provider_detail", "provider_auth_failed"]) {
  test(`native Team failure keeps an allowlisted category and frozen module only: ${code}`, async () => {
    const f = fixture(); try {
      const run = f.start(); await drive(f.teams, () => f.teams.store.row(run.id).calls_used === 1);
      const step = f.teams.store.steps(run.id)[0]!;
      const claim = f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
      f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id, `diagnostic-${code}`,
        { text: "Synthetic executor ended", status: "failed", error: { code, message: "PRIVATE_RAW_DETAIL_MUST_NOT_BE_EXPOSED" } },
        "fixture-gpt", "low", claim.attempt_count);
      await drive(f.teams, () => f.teams.store.row(run.id).status === "failed");
      const detail = f.teams.read(f.actor, f.session.id, run.id).run;
      const expected = ["unknown_private_provider_detail", "provider_auth_failed"].includes(code) ? "agent_team_agent_failed" : code;
      assert.equal(detail.error_code, expected);
      assert.deepEqual(detail.issue, { code: expected, node_id: "lead", node_label: "Director", target_kind: "local", retry_at: null });
      assert.deepEqual(f.teams.list(f.actor, f.session.id).runs[0]!.issue, detail.issue);
      assert.equal(JSON.stringify(detail).includes("PRIVATE_RAW_DETAIL_MUST_NOT_BE_EXPOSED"), false);
      assert.equal(detail.calls_used, 1); assert.equal(detail.steps.length, 1);
    } finally { f.close(); }
  });
}

test("a queued Team identifies a previous native exit hold before and after claim erasure, then clears the explanation on exact cleanup", async () => {
  const f = fixture(); try {
    const old = f.start(); await drive(f.teams, () => f.teams.store.row(old.id).calls_used === 1);
    const request = f.teams.store.steps(old.id)[0]!.request_event_id!;
    const claim = f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
    f.teams.control(f.actor, f.session.id, old.id, { action: "stop", idempotency_key: "hold-explanation-stop" });
    const next = f.start(); await drive(f.teams, () => f.teams.store.row(next.id).calls_used === 1);
    const expected = { code: "agent_team_native_exit_pending", node_id: "lead", node_label: "Director", target_kind: "local", retry_at: null };
    assert.deepEqual(f.teams.read(f.actor, f.session.id, next.id).run.issue, expected);
    f.db.sqlite.prepare("DELETE FROM agent_request_claims WHERE request_event_id=?").run(request);
    assert.deepEqual(f.teams.read(f.actor, f.session.id, next.id).run.issue, expected);
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.lead.id, claim.attempt_count!);
    assert.equal(f.teams.read(f.actor, f.session.id, next.id).run.issue?.code, "agent_team_waiting_executor");
    assert.equal(f.teams.store.row(next.id).calls_used, 1);
  } finally { f.close(); }
});

test("native queued, disconnected and expired-claim Teams expose live wait reasons without changing execution or losing a completed result", async () => {
  const f = fixture(); try {
    const run = f.start(); await drive(f.teams, () => f.teams.store.row(run.id).calls_used === 1);
    let detail = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.deepEqual(detail.issue, { code: "agent_team_waiting_executor", node_id: "lead", node_label: "Director", target_kind: "local", retry_at: null });
    const step = detail.steps[0]!, request = step.request_event_id!;
    const claim = f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.issue, undefined);
    f.advance(31000);
    detail = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(detail.issue?.code, "agent_team_runtime_offline"); assert.equal(detail.status, "running");
    f.service.heartbeatRuntime(f.actor, f.lead.id);
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.issue, undefined);
    f.advance(Date.parse(String(f.db.sqlite.prepare("SELECT lease_expires_at FROM agent_request_claims WHERE request_event_id=?").get(request)!.lease_expires_at)) - f.clock().getTime());
    f.service.heartbeatRuntime(f.actor, f.lead.id);
    detail = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(detail.issue?.code, "agent_team_claim_expired"); assert.equal(detail.calls_used, 1);
    assert.equal(detail.steps.length, 1); assert.equal(detail.error_code, null);
    // Presence or lease evidence must not override an already committed answer
    // still waiting for coordinator consumption after a transient lost wakeup.
    f.db.sqlite.prepare("UPDATE agent_request_claims SET lease_expires_at=? WHERE request_event_id=?")
      .run(new Date(f.clock().getTime() + 60000).toISOString(), request);
    f.service.completeAgentRequest(f.actor, f.session.id, request, f.lead.id, "diagnostic-committed-answer",
      { text: directive(step.id) }, "fixture-gpt", "low", claim.attempt_count);
    f.db.sqlite.prepare("UPDATE runtimes SET status='offline' WHERE id=?").run(f.lead.id);
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.issue, undefined);
    await drive(f.teams, () => f.teams.store.row(run.id).status === "completed");
  } finally { f.close(); }
});

test("preflight diagnosis identifies own offline, revoked and changed models but never reveals a foreign or missing runtime", () => {
  for (const reason of ["offline", "revoked", "model", "missing", "foreign"]) {
    const f = fixture(); try {
      const plan = structuredClone(f.plan);
      if (reason === "offline") f.advance(31000);
      if (reason === "revoked") f.db.sqlite.prepare("UPDATE runtimes SET status='revoked' WHERE id=?").run(f.lead.id);
      if (reason === "model") (plan.nodes[0]!.target as { model: string }).model = "not-advertised";
      if (reason === "missing") (plan.nodes[0]!.target as { runtime_id: string }).runtime_id = "missing-exact-runtime";
      if (reason === "foreign") {
        const peer = f.db.createIdentity({ display_name: "Foreign synthetic owner", device_name: "Foreign synthetic device" }).actor;
        f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "diagnostic-peer");
        const runtime = f.service.registerRuntime(peer, { session_id: f.session.id, device_id: peer.device_id, harness: "codex", provider: "openai",
          model: "fixture-gpt", local_session_id: "foreign-synthetic-codex", capture_fidelity: "harness_transcript" });
        (plan.nodes[0]!.target as { runtime_id: string }).runtime_id = runtime.id;
      }
      const expected = reason === "offline" ? "agent_team_runtime_offline" : reason === "revoked" ? "agent_team_runtime_revoked"
        : reason === "model" ? "agent_team_model_unavailable" : "agent_team_target_unavailable";
      assert.throws(() => f.start(plan), error => error instanceof ApiError && error.code === expected
        && JSON.stringify(error.details) === JSON.stringify({ node_id: "lead", node_label: "Director", target_kind: "local" }));
      assert.equal(f.teams.list(f.actor, f.session.id).runs.length, 0);
    } finally { f.close(); }
  }
});

test("Team budget, original authorization and manual pauses have global diagnostics without blaming the current module", async () => {
  for (const reason of ["deadline", "call_limit", "user_paused", "authority", "restart"]) {
    const f = fixture(); let restored: AgentTeams | undefined;
    try {
      const run = f.start(f.plan, reason === "call_limit" ? 1 : 12);
      await drive(f.teams, () => f.teams.store.row(run.id).calls_used === 1);
      if (reason === "deadline") { f.advance(30 * 60000); await f.teams.pump(); }
      if (reason === "call_limit") { f.complete(run.id, "delegate"); await f.teams.pump(); }
      if (reason === "user_paused") f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "diagnostic-manual-pause" });
      if (reason === "authority") { f.service.revokeDevice(f.actor, f.actor.device_id); await f.teams.pump(); }
      if (reason === "restart") { f.teams.close(); restored = new AgentTeams(f.service, undefined, { clock: f.clock, autoStart: false }); }
      const result = (restored ?? f.teams).store.summary((restored ?? f.teams).store.row(run.id));
      assert.deepEqual(result.issue, { code: reason === "deadline" ? "agent_team_deadline" : reason === "call_limit" ? "agent_team_call_limit"
        : reason === "authority" ? "agent_team_authorization_lost" : reason === "restart" ? "server_restart" : reason,
        node_id: null, node_label: null, target_kind: null, retry_at: null });
    } finally { restored?.close(); f.close(); }
  }
});

test("unknown dispatch codes and legacy private diagnostics never escape either public error field", async () => {
  for (const source of ["dispatch", "legacy"]) {
    const f = fixture(); try {
      const run = f.start();
      if (source === "dispatch") {
        f.service.appendTeamAgentRequest = () => { throw new ApiError(503, "synthetic_private_dispatch_detail", "Synthetic private exception text"); };
        await drive(f.teams, () => f.teams.store.row(run.id).status === "failed");
      } else {
        f.db.sqlite.prepare("UPDATE agent_team_runs SET status='failed',error_code=?,finished_at=? WHERE id=?")
          .run("synthetic_private_legacy_detail", f.clock().toISOString(), run.id);
      }
      assert.match(f.teams.store.row(run.id).error_code!, /^synthetic_private_/u, "Do not rewrite old persistent diagnostics or rollback data");
      const detail = f.teams.read(f.actor, f.session.id, run.id).run;
      assert.equal(detail.error_code, "agent_team_execution_failed"); assert.equal(detail.issue?.code, "agent_team_execution_failed");
      assert.equal(JSON.stringify(detail).includes("synthetic_private_"), false);
      assert.equal(JSON.stringify(f.teams.list(f.actor, f.session.id)).includes("synthetic_private_"), false);
    } finally { f.close(); }
  }
});

test("rejected Team recovery keeps conflict compatibility while exposing the precise safe recovery reason", async () => {
  for (const reason of ["receipt_cleared", "run_ended", "deadline", "call_limit", "not_timed_out", "continue_required", "clarification_unavailable"]) {
    const f = fixture(); try {
      const run = f.start(f.plan, reason === "call_limit" ? 1 : 12), original = JSON.parse(f.teams.store.row(run.id).input_json);
      await drive(f.teams, () => f.teams.store.row(run.id).calls_used === 1);
      if (reason === "receipt_cleared") {
        f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "diagnostic-clear-stop" });
        f.teams.forget(f.actor, f.session.id, run.id);
      } else if (reason === "run_ended") {
        f.complete(run.id); await drive(f.teams, () => f.teams.store.row(run.id).status === "completed");
      } else {
        f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "diagnostic-recovery-pause" });
        if (reason === "continue_required") f.teams.store.settle(run.id, "paused", "agent_timeout");
        if (reason === "clarification_unavailable") {
          f.teams.store.settle(run.id, "paused", "agent_team_instruction_conflict");
          f.db.sqlite.prepare("UPDATE agent_team_steps SET status='completed' WHERE run_id=?").run(run.id);
        }
        if (reason === "deadline") {
          f.advance(30 * 60000); f.service.heartbeatRuntime(f.actor, f.lead.id); f.service.heartbeatRuntime(f.actor, f.worker.id);
        }
      }
      const operation = () => reason === "receipt_cleared" ? f.teams.start(f.actor, f.session.id, original)
        : f.teams.control(f.actor, f.session.id, run.id,
          { action: reason === "not_timed_out" ? "continue" : "resume", idempotency_key: "diagnostic-recovery-rejected" });
      assert.throws(operation, error => {
        assert.ok(error instanceof ApiError); assert.equal(error.status, 409); assert.equal(error.code, "conflict");
        assert.deepEqual(error.details, { issue_code: `agent_team_${reason}` }); return true;
      });
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_controls WHERE idempotency_key='diagnostic-recovery-rejected'").get()!.n, 0);
    } finally { f.close(); }
  }
});
function conflictAnswer(stepId: string, explanation = "The role and module instructions conflict; please clarify which permitted outcome is intended.") {
  return `${explanation}\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: stepId, action: "clarify" })}\n\`\`\``;
}

test("one human Team send preserves its quote and exact UTF-16 mentions only on the first canonical request", async () => {
  const f = fixture(); try {
    const peer = f.db.createIdentity({ display_name: "Mention fixture", device_name: "Mention device", can_create_projects: true }).actor;
    f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "team-reference-member");
    const quote = f.service.appendEvent(peer, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "team-reference-source", payload: { content: "REFERENCE_SOURCE_BODY_MUST_NOT_BE_COPIED_TO_CONTROL_PROMPT" } });
    const content = "  🧪 @Mention fixture review this with @Mention fixture  \n";
    const first = content.indexOf("@"), last = content.lastIndexOf("@");
    const mentions = [first, last].map(start => ({ user_id: peer.user_id, start, end: start + "@Mention fixture".length }));
    const plan = structuredClone(f.plan); plan.team_prompt = `Rule preface\n${content}\nRule ending`; plan.nodes[0]!.role = `Role preface\n${content}\nRole ending`;
    const input = { plan, entry_node_id: "lead", content, mentions, reply_to_event_id: quote.id,
      max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: "team-reference-run" };
    const { run } = f.teams.start(f.actor, f.session.id, input);
    assert.equal(run.content, content); assert.equal(JSON.parse(f.teams.store.row(run.id).input_json).content, content);
    assert.equal(f.teams.start(f.actor, f.session.id, input).replayed, true);
    for (const changed of [{ ...input, reply_to_event_id: null }, { ...input, mentions: [] },
      { ...input, mentions: [{ ...mentions[0]!, start: first + 1, end: mentions[0]!.end + 1 }] }]) {
      assert.throws(() => f.teams.start(f.actor, f.session.id, changed), { code: "idempotency_conflict" });
    }
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!, event = f.db.getEvent(f.session.id, step.request_event_id!);
    const payload = event.payload as { content: string; mentions: typeof mentions; agent_team: { task_content: string } };
    assert.equal(event.reply_to_event_id, quote.id); assert.equal(payload.agent_team.task_content, content);
    assert.equal(payload.content.includes("REFERENCE_SOURCE_BODY_MUST_NOT_BE_COPIED_TO_CONTROL_PROMPT"), false);
    const assignmentBoundary = `[GT_TEAM_ASSIGNMENT:${step.id}]\n`;
    const assignmentOffset = payload.content.indexOf(assignmentBoundary) + assignmentBoundary.length;
    assert.equal(payload.content.split(assignmentBoundary).length, 2);
    assert.ok(assignmentOffset > payload.content.indexOf(content), "A repeated task in rules is not the selected mention occurrence");
    assert.deepEqual(payload.mentions, mentions.map(mention => ({ ...mention, start: mention.start + assignmentOffset, end: mention.end + assignmentOffset })));
    for (const mention of payload.mentions) assert.equal(payload.content.slice(mention.start, mention.end), "@Mention fixture");
    assert.deepEqual(f.db.listProjectMentions(peer, f.session.project_id).mentions.map(item => [item.id, item.excerpt]), [[event.id, content]]);
    f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
    f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    for (const later of f.teams.read(f.actor, f.session.id, run.id).run.steps.slice(1)) {
      const request = f.db.getEvent(f.session.id, later.request_event_id!);
      assert.equal(request.reply_to_event_id, null); assert.equal((request.payload as { mentions?: unknown }).mentions, undefined);
    }
    assert.equal(f.db.listProjectMentions(peer, f.session.project_id).mentions.length, 1);
    // A quote stays a reference: deleting its source retains the independent
    // human Team task body, but invalidates model-derived output and old context.
    f.db.deleteMessage(peer, f.session.id, quote.id, "team-reference-erase-source");
    assert.equal(f.db.getEvent(f.session.id, event.id).deleted, undefined);
    assert.equal((f.db.getEvent(f.session.id, event.id).payload as { agent_team: { task_content: string } }).agent_team.task_content, content);
    assert.throws(() => f.teams.start(f.actor, f.session.id, input), { code: "context_changed" });
  } finally { f.close(); }
});

for (const harness of ["codex", "deepseek-harness"] as const) {
  test(`whole-prompt redaction preserves final mention ranges for the first ${harness} Team step without duplicate notifications`, async () => {
    const f = fixture(); try {
      const peer = f.db.createIdentity({ display_name: "Synthetic owner", device_name: "Synthetic mention device", can_create_projects: true }).actor;
      f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "redaction-mention-member");
      const quote = f.service.appendEvent(peer, f.session.id, { type: "human_chat", visibility: "session",
        idempotency_key: "redaction-mention-source", payload: { content: "Independent quoted task" } });
      const content = harness === "codex" ? "@Synthetic owner review" : "  🧪 @Synthetic owner review\r\n@Synthetic owner token:  ";
      const role = "Return a verification token:";
      assert.equal(redactJson(role), role, "the individual role has no secret and must remain accepted");
      assert.equal(redactJson(content), content);
      const plan = structuredClone(f.plan); plan.team_prompt = `Repeat the task without using it as a location: ${content}`;
      plan.nodes[0]!.role = role;
      if (harness === "deepseek-harness") {
        const leadTarget = plan.nodes[0]!.target;
        plan.nodes[0]!.target = plan.nodes[1]!.target; plan.nodes[1]!.target = leadTarget;
      }
      const mentions = [...new Set([content.indexOf("@"), content.lastIndexOf("@")])]
        .map(start => ({ user_id: peer.user_id, start, end: start + "@Synthetic owner".length }));
      const input = { plan, entry_node_id: "lead", content, mentions, reply_to_event_id: quote.id,
        max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: "redaction-mention-start" };
      const run = f.teams.start(f.actor, f.session.id, input).run;
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const first = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      const event = f.db.getEvent(f.session.id, first.request_event_id!);
      const payload = event.payload as { content: string; mentions: typeof mentions; agent_team: { task_content: string } };
      assert.match(payload.content, /\[REDACTED\]/u, "whole-prompt filtering is still active across the generated prefix");
      assert.equal(event.reply_to_event_id, quote.id); assert.equal(payload.agent_team.task_content, content);
      assert.deepEqual(redactJson(payload), payload, "downstream persistence must not move the ranges again");
      for (const mention of payload.mentions) assert.equal(payload.content.slice(mention.start, mention.end), "@Synthetic owner");
      const boundary = `[GT_TEAM_ASSIGNMENT:${first.id}]\n`, offset = payload.content.indexOf(boundary) + boundary.length;
      assert.equal(payload.content.split(boundary).length, 2);
      assert.equal(payload.content.slice(offset, offset + content.length), content);
      assert.deepEqual(payload.mentions, mentions.map(mention => ({ ...mention, start: mention.start + offset, end: mention.end + offset })));
      assert.equal(f.teams.start(f.actor, f.session.id, input).replayed, true);
      assert.equal(f.teams.store.row(run.id).calls_used, 1);
      f.complete(run.id, "delegate"); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
      f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 3);
      f.complete(run.id); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
      for (const later of f.teams.read(f.actor, f.session.id, run.id).run.steps.slice(1)) {
        const event = f.db.getEvent(f.session.id, later.request_event_id!);
        assert.equal(event.reply_to_event_id, null); assert.equal((event.payload as { mentions?: unknown }).mentions, undefined);
      }
      assert.deepEqual(f.db.listProjectMentions(peer, f.session.project_id).mentions.map(item => [item.id, item.excerpt]), [[event.id, content]]);
    } finally { f.close(); }
  });
}

test("whole-prompt redaction cannot be bypassed by individually safe role and task fragments", async () => {
  const f = fixture(); try {
    const role = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const content = `@Fixture owner review\n${["-----END", "PRIVATE KEY-----"].join(" ")}`;
    assert.equal(redactJson(role), role); assert.equal(redactJson(content), content);
    const plan = structuredClone(f.plan); plan.nodes[0]!.role = role;
    const mentions = [{ user_id: f.actor.user_id, start: 0, end: "@Fixture owner".length }];
    const before = f.db.requireSession(f.session.id).next_sequence;
    const run = f.teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content, mentions,
      max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: "redaction-cross-fragment-start" }).run;
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "failed");
    const failed = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(failed.error_code, "agent_team_sensitive_input"); assert.equal(failed.calls_used, 0);
    assert.equal(f.db.requireSession(f.session.id).next_sequence, before);
    assert.equal(f.db.listProjectMentions(f.actor, f.session.project_id).mentions.length, 0);
    assert.ok(failed.steps.every(step => step.request_event_id === null));
  } finally { f.close(); }
});

test("native Team reservations reject pre-redaction mention ranges before writing or charging a call", async () => {
  const f = fixture(); try {
    const content = "@Fixture owner review", mentions = [{ user_id: f.actor.user_id, start: 0, end: "@Fixture owner".length }];
    const key = "redaction-native-final-payload", run = f.teams.start(f.actor, f.session.id, { plan: f.plan, entry_node_id: "lead", content, mentions,
      max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: key }).run;
    const step = f.teams.store.pending(run.id), prefix = "Return a verification token:\n\nAssigned task:\n";
    const payload = { content: prefix + content, mentions: mentions.map(mention => ({ ...mention, start: mention.start + prefix.length, end: mention.end + prefix.length })),
      agent_team: { run_id: run.id, step_id: step.id, node_id: "lead", node_label: "Director", task_content: content, start_idempotency_key: key },
      execution_profile: { harness: "codex", provider: "openai", model: "fixture-gpt", reasoning_effort: "low", runtime_id: f.lead.id } };
    assert.equal(payload.content.slice(payload.mentions[0]!.start, payload.mentions[0]!.end), "@Fixture owner");
    assert.notEqual(redactJson(payload.content), payload.content, "this raw input shifts after whole-string filtering");
    const before = f.db.requireSession(f.session.id).next_sequence;
    assert.throws(() => f.db.appendTeamAgentRequest(f.actor, f.session.id, { type: "agent_request", visibility: "session",
      idempotency_key: "redaction-native-forged-canonical", content_revision: 0, payload }, () => assert.fail("A shifted final range must not commit")), { code: "forbidden" });
    assert.equal(f.teams.store.row(run.id).calls_used, 0); assert.equal(f.teams.store.step(step.id).status, "pending");
    assert.equal(f.db.requireSession(f.session.id).next_sequence, before);
    assert.equal(f.db.listProjectMentions(f.actor, f.session.project_id).mentions.length, 0);
  } finally { f.close(); }
});

test("Team reference acceptance rejects foreign/private/deleted quotes and stale, forged or overlapping mention ranges before allocating a run", async () => {
  const f = fixture(); try {
    const outsider = f.db.createIdentity({ display_name: "Outside member", device_name: "Outside device", can_create_projects: true }).actor;
    const foreign = f.service.createSession(f.actor, { title: "Other reference session", mode: "multi", idempotency_key: "team-quote-other-session" }).session;
    const append = (sessionId: string, visibility: "session" | "owner_only", key: string) => f.service.appendEvent(f.actor, sessionId,
      { type: "human_chat", visibility, idempotency_key: key, payload: { content: "Synthetic quote" } });
    const privateQuote = append(f.session.id, "owner_only", "team-private-quote"), foreignQuote = append(foreign.id, "session", "team-foreign-quote");
    const erased = append(f.session.id, "session", "team-erased-quote"); f.db.deleteMessage(f.actor, f.session.id, erased.id, "team-erase-quote");
    const input = { plan: f.plan, entry_node_id: "lead", content: "@Fixture owner review", max_calls: 12, max_duration_minutes: 30,
      content_revision: 1, idempotency_key: "team-invalid-reference" };
    const span = { user_id: f.actor.user_id, start: 0, end: "@Fixture owner".length };
    const before = f.db.requireSession(f.session.id).next_sequence;
    for (const changed of [{ reply_to_event_id: privateQuote.id }, { reply_to_event_id: foreignQuote.id }, { reply_to_event_id: erased.id },
      { mentions: [{ ...span, user_id: outsider.user_id }] }, { mentions: [{ ...span, start: 1 }] },
      { mentions: [span, span] }, { mentions: [{ ...span, end: 1 }] }]) {
      assert.throws(() => f.teams.start(f.actor, f.session.id, { ...input, ...changed }));
      assert.equal(f.teams.store.list(f.actor, f.session.id).runs.length, 0);
      assert.equal(f.db.requireSession(f.session.id).next_sequence, before);
    }
    const valid = f.teams.start(f.actor, f.session.id, { ...input, mentions: [span] }).run;
    // The saved range must still match a current member at actual dispatch.
    f.db.sqlite.prepare("UPDATE users SET display_name=? WHERE id=?").run("Renamed fixture", f.actor.user_id);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, valid.id).run.status === "failed");
    assert.equal(f.teams.read(f.actor, f.session.id, valid.id).run.calls_used, 0);
    assert.equal(f.db.requireSession(f.session.id).next_sequence, before);
  } finally { f.close(); }
});

test("source erasure between Team acceptance and its first dispatch fences all quote work without consuming a call", async () => {
  const f = fixture(); try {
    const quote = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "team-quote-race-source", payload: { content: "Race source" } });
    const started = f.teams.start(f.actor, f.session.id, { plan: f.plan, entry_node_id: "lead", content: "Quote race task",
      reply_to_event_id: quote.id, max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: "team-quote-race-start" }).run;
    f.db.deleteMessage(f.actor, f.session.id, quote.id, "team-quote-race-delete");
    for (let index = 0; index < 5; index++) await f.teams.pump();
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(started.id), undefined,
      "Erasure also removes the now-stale private pending snapshot");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=? AND json_extract(payload_json,'$.agent_team.run_id')=?")
      .get(f.session.id, started.id)?.n, 0);
  } finally { f.close(); }
});

test("trusted Team dispatch cannot omit or replace the original quote and selected recipients", async () => {
  const f = fixture(); try {
    const quote = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "team-dispatch-quote",
      payload: { content: "Synthetic dispatch quote" } });
    const content = "@Fixture owner review", mentions = [{ user_id: f.actor.user_id, start: 0, end: "@Fixture owner".length }];
    const run = f.teams.start(f.actor, f.session.id, { plan: f.plan, entry_node_id: "lead", content, mentions, reply_to_event_id: quote.id,
      max_calls: 12, max_duration_minutes: 30, content_revision: 0, idempotency_key: "team-dispatch-reference-start" }).run;
    const step = f.teams.store.pending(run.id), metadata = { run_id: run.id, step_id: step.id, node_id: "lead", node_label: "Director",
      task_content: content, start_idempotency_key: "team-dispatch-reference-start" };
    const payload = { content: `Prefix\n${content}`, mentions: mentions.map(mention => ({ ...mention, start: mention.start + 7, end: mention.end + 7 })),
      execution_profile: { harness: "codex", provider: "openai", model: "fixture-gpt", reasoning_effort: "low", runtime_id: f.lead.id }, agent_team: metadata };
    const input = { type: "agent_request" as const, visibility: "session" as const, payload, reply_to_event_id: quote.id,
      content_revision: 0, idempotency_key: "team-forged-dispatch" };
    for (const forged of [{ ...input, reply_to_event_id: null }, { ...input, payload: { ...payload, mentions: undefined } },
      { ...input, payload: { ...payload, mentions } }, { ...input, payload: { ...payload, mentions: [] } }]) {
      assert.throws(() => f.db.appendTeamAgentRequest(f.actor, f.session.id, forged as Parameters<typeof f.db.appendTeamAgentRequest>[2],
        () => assert.fail("A forged dispatch must not be accepted")));
      assert.equal(f.teams.store.row(run.id).calls_used, 0); assert.equal(f.teams.store.step(step.id).status, "pending");
    }
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
  } finally { f.close(); }
});
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

test("the native completion grant enforces the exact deadline before coordinator maintenance", async t => {
  for (const offset of [59999, 60000, 60001]) await t.test(`${offset} milliseconds`, async () => {
    const f = fixture(); try {
      const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
      const run = f.teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Exact deadline boundary",
        max_calls: 1, max_duration_minutes: 1, content_revision: 0, idempotency_key: `exact-deadline-${offset}` }).run;
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      const claim = f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
      f.advance(offset); f.service.heartbeatRuntime(f.actor, f.lead.id);
      const finish = () => f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id,
        `exact-deadline-reply-${offset}`, { text: "A verified final result" }, "fixture-gpt", "low", claim.attempt_count);
      const head = f.db.requireSession(f.session.id).next_sequence;
      if (offset < 60000) finish();
      else { assert.throws(finish); assert.equal(f.db.requireSession(f.session.id).next_sequence, head); }
      await f.teams.pump();
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.status, offset < 60000 ? "completed" : "timed_out");
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 1);
    } finally { f.close(); }
  });
});

test("explicit terminal-record cleanup restores account run capacity and keeps canonical results and consumed keys", async () => {
  const f = fixture(); try {
    const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
    const first = f.start(plan, 1), original = JSON.parse(f.teams.store.row(first.id).input_json);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, first.id).run.calls_used === 1);
    const request = f.teams.read(f.actor, f.session.id, first.id).run.steps[0]!.request_event_id!;
    const response = f.complete(first.id, "complete", "worker", "Retained public result");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, first.id).run.status === "completed");
    for (let index = 0; index < 99; index++) {
      const run = f.start(plan, 1); f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: `capacity-stop-${index}` });
    }
    assert.throws(() => f.start(plan, 1), { code: "agent_team_storage_full" });
    const head = f.db.requireSession(f.session.id).next_sequence;
    f.teams.forget(f.actor, f.session.id, first.id);
    assert.equal(f.db.getEvent(f.session.id, request).type, "agent_request"); assert.equal(f.db.getEvent(f.session.id, response.id).type, "agent_response");
    assert.equal(f.db.requireSession(f.session.id).next_sequence, head);
    assert.throws(() => f.teams.start(f.actor, f.session.id, original), { code: "conflict" });
    const replacement = f.start(plan, 1); assert.notEqual(replacement.id, first.id);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 100);
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
        if (claimed) {
          assert.throws(() => f.service.claimAgentRequest(executor, f.session.id, ordinary.id, runtime.id), { code: "runtime_busy" });
          f.service.acknowledgeAgentExecutionStopped(executor, f.session.id, request, runtime.id, 1);
        }
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

test("native Team acceptance checks effective heartbeat presence before allocating a private run", () => {
  const f = fixture(); try {
    f.advance(31000);
    assert.equal(f.db.listSessionRuntimesForUser(f.session.id, f.actor.user_id).find(runtime => runtime.id === f.lead.id)!.status, "offline");
    assert.throws(() => f.start(), { code: "agent_team_runtime_offline" });
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_request'").get()!.n, 0);
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
test("two devices replaying interleaved Pause and Resume receipts cannot undo a later decision or duplicate a call", async () => {
  const f = fixture(); try {
    const second = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Synthetic second control device").device_id };
    const peer = f.db.createIdentity({ display_name: "Synthetic other member", device_name: "Synthetic peer device", can_create_projects: true }).actor;
    f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "interleaved-controls-peer");
    const run = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const original = JSON.parse(f.teams.store.row(run.id).input_json);
    const receipts: Array<{ action: "pause" | "resume"; idempotency_key: string }> = [];
    for (let round = 0; round < 5; round++) {
      const current = f.teams.read(second, f.session.id, run.id).run;
      const request = current.steps.at(-1)!.request_event_id!;
      const claim = f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
      const pause = { action: "pause" as const, idempotency_key: `interleaved-pause-${round}` };
      f.teams.control(round % 2 ? f.actor : second, f.session.id, run.id, pause);
      receipts.push(pause);
      for (const receipt of receipts) assert.equal(f.teams.control(second, f.session.id, run.id, receipt).run.status, "paused");
      assert.equal(f.teams.start(second, f.session.id, original).replayed, true);
      assert.throws(() => f.teams.control(peer, f.session.id, run.id, { action: "resume", idempotency_key: `peer-resume-${round}` }), { code: "not_found" });
      assert.throws(() => f.service.appendAgentProgress(f.actor, f.session.id, request, f.lead.id,
        `interrupted-progress-${round}`, { content: "A late result from the interrupted device" }, "fixture-gpt", "low", claim.attempt_count));
      const resume = { action: "resume" as const, idempotency_key: `interleaved-resume-${round}` };
      f.teams.control(round % 2 ? second : f.actor, f.session.id, run.id, resume);
      receipts.push(resume);
      for (const receipt of receipts) assert.equal(f.teams.control(f.actor, f.session.id, run.id, receipt).run.status, "running");
      await drive(f.teams, () => f.teams.read(second, f.session.id, run.id).run.calls_used === round + 2);
      assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id).status, "paused");
      assert.throws(() => f.service.completeAgentRequest(f.actor, f.session.id, request, f.lead.id,
        `interrupted-result-${round}`, { text: "Must not resume an old native execution" }, "fixture-gpt", "low", claim.attempt_count));
      const next = f.teams.read(second, f.session.id, run.id).run.steps.at(-1)!;
      assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id), { code: "runtime_busy" });
      f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.lead.id, claim.attempt_count);
    }
    const stop = { action: "stop" as const, idempotency_key: "interleaved-final-stop" };
    f.teams.control(second, f.session.id, run.id, stop);
    for (const receipt of [...receipts, stop]) assert.equal(f.teams.control(f.actor, f.session.id, run.id, receipt).run.status, "stopped");
    await f.teams.pump();
    const ended = f.teams.read(second, f.session.id, run.id).run;
    assert.equal(ended.calls_used, 6); assert.equal(ended.steps.length, 6);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_request'").get()!.n, 6);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response'").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_controls WHERE run_id=?").get(run.id)!.n, 11);
  } finally { f.close(); }
});

test("lost Pause or Stop cleanup is retried by its receipt, and a paused restart repairs the durable cancellation signal", async t => {
  for (const phase of ["pause", "stop", "paused-restart", "stopped-restart", "stopped-pump"] as const) await t.test(phase, async () => {
    const f = fixture(); let restored: AgentTeams | undefined;
    try {
      const second = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Synthetic cleanup recovery device").device_id };
      const run = f.start();
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const first = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      const claim = f.service.claimAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id);
      const cancel = f.service.pauseTeamAgentRequest.bind(f.service);
      f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic interrupted cancellation transaction"); };
      const stopped = phase.startsWith("stop");
      const control = { action: stopped ? "stop" as const : "pause" as const, idempotency_key: `cleanup-${phase}` };
      assert.equal(f.teams.control(second, f.session.id, run.id, control).run.status, stopped ? "stopped" : "paused");
      assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(first.request_event_id!)!.status, "claimed");
      assert.throws(() => f.service.appendAgentProgress(f.actor, f.session.id, first.request_event_id!, f.lead.id,
        `cleanup-${phase}-fenced-progress`, { content: "Still fenced before physical cleanup recovers" }, "fixture-gpt", "low", claim.attempt_count));
      f.service.pauseTeamAgentRequest = cancel;
      if (phase.endsWith("-restart")) {
        f.teams.close(); restored = new AgentTeams(f.service, undefined, { clock: f.clock, autoStart: false });
      } else if (phase === "stopped-pump") await f.teams.pump();
      else f.teams.control(f.actor, f.session.id, run.id, control);
      const teams = restored ?? f.teams;
      assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(first.request_event_id!)!.status, "paused");
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_progress' AND reply_to_event_id=?").get(first.request_event_id!)!.n, 1);
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_controls WHERE run_id=?").get(run.id)!.n, 1);
      teams.control(second, f.session.id, run.id, control);
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_progress' AND reply_to_event_id=?").get(first.request_event_id!)!.n, 1);
      assert.equal(teams.read(second, f.session.id, run.id).run.status, stopped ? "stopped" : "paused");
      if (!stopped) {
        teams.control(second, f.session.id, run.id, { action: "resume", idempotency_key: `cleanup-${phase}-resume` });
        await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
        const next = teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!;
        assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id), { code: "runtime_busy" });
        f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, first.request_event_id!, f.lead.id, claim.attempt_count);
        f.service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id);
        assert.equal(teams.control(second, f.session.id, run.id, control).run.status, "running");
        assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(next.request_event_id!)!.status, "claimed",
          "a stale Pause receipt must not cancel the newer resumed execution");
      }
    } finally { restored?.close(); f.close(); }
  });
});

test("a queued exact native request survives an offline interval without fallback or another accepted call", async () => {
  const f = fixture(); try {
    const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
    const run = f.start(plan, 1);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const request = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    f.advance(120000);
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id));
    await f.teams.pump();
    assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.status, "running");
    f.service.heartbeatRuntime(f.actor, f.lead.id);
    f.complete(run.id, "complete", "worker", "The exact reconnected device completed its queued task");
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    const completed = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(completed.calls_used, 1); assert.equal(completed.steps.length, 1);
    assert.equal(completed.steps[0]!.request_event_id, request);
    assert.equal(f.db.sqlite.prepare("SELECT attempt_count FROM agent_request_claims WHERE request_event_id=?").get(request)!.attempt_count, 1);
  } finally { f.close(); }
});

test("outstanding native cancellation retries are bounded, back off failures and eventually release every stopped runtime", async () => {
  const f = fixture(); try {
    const cancel = f.service.pauseTeamAgentRequest.bind(f.service); let attempts = 0;
    f.service.pauseTeamAgentRequest = () => { attempts++; throw new Error("Synthetic cleanup service temporarily unavailable"); };
    for (let index = 0; index < 33; index++) {
      const runtime = f.service.registerRuntime(f.actor, { session_id: f.session.id, device_id: f.actor.device_id,
        harness: "codex", provider: "openai", model: "fixture-gpt", context_deletion_version: 1,
        execution_profiles: [{ provider: "openai", model: "fixture-gpt", reasoning_efforts: ["low"] }],
        local_session_id: `synthetic-cleanup-runtime-${index}`, capture_fidelity: "harness_transcript" });
      const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
      if (plan.nodes[0]!.target.kind !== "local") throw new Error("Expected the fixture's exact native target");
      plan.nodes[0]!.target.runtime_id = runtime.id;
      const run = f.start(plan, 1);
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, runtime.id);
      f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: `bounded-cleanup-stop-${index}` });
    }
    attempts = 0; f.advance(5000);
    await f.teams.pump(); assert.equal(attempts, 32, "one tick attempts no more than 32 outstanding claims");
    await f.teams.pump(); assert.equal(attempts, 33, "a failing first batch does not starve the remaining claim");
    await f.teams.pump(); assert.equal(attempts, 33, "unavailable cleanup does not spin until its retry deadline");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_request_claims WHERE status='claimed'").get()!.n, 33);
    f.service.pauseTeamAgentRequest = cancel; f.advance(5000);
    await f.teams.pump(); await f.teams.pump();
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_request_claims WHERE status='claimed'").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs WHERE status='stopped' AND calls_used=1").get()!.n, 33);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_progress'").get()!.n, 33);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response'").get()!.n, 0);
  } finally { f.close(); }
});

test("a failed Pause followed immediately by Resume retries the historical claim without cancelling its newer current step", async () => {
  const f = fixture(); try {
    const run = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const first = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    f.service.claimAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id);
    const cancel = f.service.pauseTeamAgentRequest.bind(f.service);
    f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic cancellation lost across immediate Resume"); };
    f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "history-cleanup-pause" });
    f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "history-cleanup-resume" });
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const next = f.teams.read(f.actor, f.session.id, run.id).run.steps.at(-1)!;
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id), { code: "runtime_busy" });
    f.service.pauseTeamAgentRequest = cancel; f.advance(5000); await f.teams.pump();
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(first.request_event_id!)!.status, "paused");
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id), { code: "runtime_busy" });
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, first.request_event_id!, f.lead.id, 1);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id).status, "claimed");
    await f.teams.pump();
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(next.request_event_id!)!.status, "claimed");
    const current = f.teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(current.status, "running"); assert.equal(current.calls_used, 2); assert.equal(current.current_step_id, next.id);
  } finally { f.close(); }
});

test("a stopped native claim with a revoked authorizer holds its slot until the still-valid executor acknowledges exit", async () => {
  const f = fixture(); try {
    const executor = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Synthetic independent executor").device_id };
    const runtime = f.service.registerRuntime(executor, { session_id: f.session.id, device_id: executor.device_id, harness: "codex", provider: "openai",
      model: "fixture-gpt", context_deletion_version: 1, execution_profiles: [{ provider: "openai", model: "fixture-gpt", reasoning_efforts: ["low"] }],
      local_session_id: "synthetic-revoked-author-cleanup", capture_fidelity: "harness_transcript" });
    const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
    if (plan.nodes[0]!.target.kind !== "local") throw new Error("Expected exact native target");
    plan.nodes[0]!.target.runtime_id = runtime.id;
    const run = f.start(plan, 1);
    await drive(f.teams, () => f.teams.read(executor, f.session.id, run.id).run.calls_used === 1);
    const request = f.teams.read(executor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    f.service.claimAgentRequest(executor, f.session.id, request, runtime.id);
    const cancel = f.service.pauseTeamAgentRequest.bind(f.service);
    f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic Stop cancellation failure before device revocation"); };
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "revoked-author-cleanup-stop" });
    f.service.pauseTeamAgentRequest = cancel;
    f.db.revokeDevice(executor, f.actor.device_id);
    await f.teams.pump();
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "paused");
    assert.equal(f.teams.read(executor, f.session.id, run.id).run.status, "stopped");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response' OR type='agent_progress'").get()!.n, 0,
      "trusted cleanup must not publish new content using a revoked author's grant");
    const ordinary = f.service.appendEvent(executor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: "after-revoked-author-cleanup",
      payload: { content: "An independent human request", execution_profile: { harness: "codex", provider: "openai", model: "fixture-gpt", runtime_id: runtime.id } } });
    assert.throws(() => f.service.claimAgentRequest(executor, f.session.id, ordinary.id, runtime.id), { code: "runtime_busy" });
    f.service.acknowledgeAgentExecutionStopped(executor, f.session.id, request, runtime.id, 1);
    assert.equal(f.service.claimAgentRequest(executor, f.session.id, ordinary.id, runtime.id).status, "claimed");
  } finally { f.close(); }
});

test("Forget fences a failed Stop's native claim without releasing the execution slot before an exact exit acknowledgment", async () => {
  const f = fixture(); try {
    const run = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const request = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
    f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic Stop cancellation failure before Forget"); };
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "forget-cleanup-stop" });
    f.teams.forget(f.actor, f.session.id, run.id);
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "paused");
    assert.equal(f.db.teamRequestMayExecute(request), false);
    assert.equal(f.db.getEvent(f.session.id, request).type, "agent_request");
    const ordinary = f.service.appendEvent(f.actor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: "after-forget-cleanup",
      payload: { content: "An independent human request", execution_profile: { harness: "codex", provider: "openai", model: "fixture-gpt", runtime_id: f.lead.id } } });
    assert.throws(() => f.service.claimAgentRequest(f.actor, f.session.id, ordinary.id, f.lead.id), { code: "runtime_busy" });
    f.service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, request, f.lead.id, 1);
    assert.equal(f.service.claimAgentRequest(f.actor, f.session.id, ordinary.id, f.lead.id).status, "claimed");
  } finally { f.close(); }
});

test("private-run pruning retires only its own residual native claims", async () => {
  const f = fixture(); try {
    const run = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const request = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
    f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic cancellation failure before pruning"); };
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "prune-cleanup-stop" });
    const ordinary = f.service.appendEvent(f.actor, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: "prune-unrelated-request",
      payload: { content: "A separate active task", execution_profile: { harness: "deepseek-harness", provider: "deepseek", model: "fixture-deepseek", runtime_id: f.worker.id } } });
    f.service.claimAgentRequest(f.actor, f.session.id, ordinary.id, f.worker.id);
    f.db.sqlite.prepare("UPDATE agent_team_runs SET finished_at=? WHERE id=?").run(new Date(f.clock().getTime() - 31 * 86400000).toISOString(), run.id);
    f.teams.store.prune();
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(run.id), undefined);
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "paused");
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(ordinary.id)!.status, "claimed");
    assert.equal(f.db.getEvent(f.session.id, request).deleted, undefined);
  } finally { f.close(); }
});

test("storage-pressure probe reclamation and its native-claim retirement roll back together on rejected acceptance", async () => {
  const f = fixture(); try {
    const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
    const input = { plan, entry_node_id: "lead", content: "Synthetic obsolete connectivity probe", max_calls: 1, max_duration_minutes: 30,
      content_revision: 0, idempotency_key: "reclamation-cleanup-probe" };
    const probe = f.teams.start(f.actor, f.session.id, input, { purpose: "test" }).run;
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, probe.id).run.calls_used === 1);
    const request = f.teams.read(f.actor, f.session.id, probe.id).run.steps[0]!.request_event_id!;
    f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
    f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic cancellation failure before probe reclamation"); };
    f.teams.control(f.actor, f.session.id, probe.id, { action: "stop", idempotency_key: "reclamation-cleanup-stop" });
    for (let index = 0; index < 15; index++) {
      const run = f.teams.store.create(f.actor, f.session.id, { ...input, content: `Retained ordinary record ${index}`,
        idempotency_key: `reclamation-retained-${index}` }).run;
      f.teams.store.settle(run.id, "stopped", "user_stopped");
    }
    f.db.sqlite.prepare("UPDATE agent_team_runs SET bytes=524288").run();
    const replacement = { ...input, content: "A new human task under storage pressure", idempotency_key: "reclamation-cleanup-replacement" };
    assert.throws(() => f.teams.start(f.actor, f.session.id, replacement, { onCreated: () => { throw new Error("Synthetic admission refused after reclamation"); } }), /Synthetic admission refused/u);
    assert.ok(f.db.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(probe.id));
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "claimed",
      "a rolled-back private deletion must also roll back its claim cleanup");
    f.teams.start(f.actor, f.session.id, replacement);
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(probe.id), undefined);
    assert.equal(f.db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "paused");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs WHERE idempotency_key LIKE 'reclamation-retained-%'").get()!.n, 15);
    assert.equal(f.db.getEvent(f.session.id, request).deleted, undefined);
    assert.equal(f.db.teamRequestMayExecute(request), false);
  } finally { f.close(); }
});

test("a legacy database adds independent step cancellation backoff and recreates its deletion fence idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-cleanup-migration-")), path = join(directory, "fixture.db"), f = fixture(path);
  let originalClosed = false, db: CollaborationDatabase | undefined;
  try {
    const run = f.start();
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const request = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
    f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
    f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic cancellation failure before migration"); };
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "migration-cleanup-stop" });
    f.db.sqlite.exec("DROP TRIGGER agent_team_runs_native_claim_cleanup; ALTER TABLE agent_team_steps DROP COLUMN cancellation_retry_at");
    f.close(); originalClosed = true;
    for (let reopen = 0; reopen < 2; reopen++) {
      db = new CollaborationDatabase(path, { clock: f.clock });
      assert.equal(db.sqlite.prepare("PRAGMA table_info(agent_team_steps)").all().filter(column => column.name === "cancellation_retry_at").length, 1);
      assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='agent_team_runs_native_claim_cleanup'").get()!.n, 1);
      assert.equal(db.sqlite.prepare("SELECT calls_used FROM agent_team_runs WHERE id=?").get(run.id)!.calls_used, 1);
      assert.equal(db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "claimed");
      db.close(); db = undefined;
    }
  } finally { db?.close(); if (!originalClosed) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy claim-table rebuilds retain the Team deletion fence across two database reopens", async t => {
  for (const phase of ["before-leases", "before-pause"] as const) await t.test(phase, async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-team-claim-migration-")), path = join(directory, "fixture.db"), f = fixture(path);
    let originalClosed = false, db: CollaborationDatabase | undefined;
    try {
      const run = f.start();
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const request = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!;
      f.service.claimAgentRequest(f.actor, f.session.id, request, f.lead.id);
      f.service.pauseTeamAgentRequest = () => { throw new Error("Synthetic cleanup failure before legacy claim migration"); };
      f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: `legacy-claims-${phase}-stop` });
      f.close(); originalClosed = true;
      const legacy = new DatabaseSync(path);
      try {
        // Keep the new cross-table trigger while restoring a historical claims
        // shape: production must remove that dependency within its rebuild.
        legacy.exec(`PRAGMA foreign_keys=OFF; DROP TABLE agent_request_claims;
          CREATE TABLE agent_request_claims (
            request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
            runtime_id TEXT NOT NULL REFERENCES runtimes(id),claimed_at TEXT NOT NULL,completed_at TEXT,
            status TEXT NOT NULL CHECK(status IN ('claimed','completed'${phase === "before-pause" ? ",'failed'" : ""}))
            ${phase === "before-pause" ? ",attempt_count INTEGER NOT NULL DEFAULT 1,lease_expires_at TEXT" : ""}
          ) STRICT;`);
        legacy.prepare("INSERT INTO agent_request_claims(request_event_id,runtime_id,claimed_at,status) VALUES(?,?,?,'claimed')")
          .run(request, f.lead.id, f.clock().toISOString());
      } finally { legacy.close(); }
      for (let reopen = 0; reopen < 2; reopen++) {
        db = new CollaborationDatabase(path, { clock: f.clock });
        assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='agent_team_runs_native_claim_cleanup'").get()!.n, 1);
        assert.equal(db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "claimed");
        db.sqlite.exec("BEGIN IMMEDIATE");
        db.sqlite.prepare("DELETE FROM agent_team_runs WHERE id=?").run(run.id);
        assert.equal(db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "paused");
        db.sqlite.exec("ROLLBACK");
        assert.equal(db.sqlite.prepare("SELECT status FROM agent_request_claims WHERE request_event_id=?").get(request)!.status, "claimed");
        assert.equal(db.sqlite.prepare("SELECT calls_used FROM agent_team_runs WHERE id=?").get(run.id)!.calls_used, 1);
        assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
        db.close(); db = undefined;
      }
    } finally { db?.close(); if (!originalClosed) f.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

test("disk reopen recovers lost acknowledgments at queued, claimed and completed boundaries without reviving the old execution", async t => {
  for (const phase of ["queued", "claimed", "completed"] as const) await t.test(phase, async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-team-disk-recovery-"));
    const path = join(directory, "fixture.db"), f = fixture(path);
    let restored: AgentTeams | undefined, reopened: CollaborationDatabase | undefined, originalClosed = false;
    try {
      const second = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Synthetic restart recovery device").device_id };
      const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
      const run = f.start(plan, 3);
      const input = JSON.parse(f.teams.store.row(run.id).input_json);
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const first = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      if (phase === "claimed") f.service.claimAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id);
      if (phase === "completed") f.complete(run.id, "complete", "worker", "Durable answer committed before the server disappeared");
      // Close the actual SQLite handle, not merely the coordinator. The answer's
      // queued wakeup has not settled the private run when this interruption hits.
      f.close(); originalClosed = true;
      reopened = new CollaborationDatabase(path, { clock: f.clock });
      const service = new CollaborationService(reopened);
      restored = new AgentTeams(service, undefined, { clock: f.clock, autoStart: false });
      assert.equal(restored.start(second, f.session.id, input).replayed, true);
      const recovered = restored.read(second, f.session.id, run.id).run;
      assert.equal(recovered.status, "paused"); assert.equal(recovered.error_code, "server_restart"); assert.equal(recovered.calls_used, 1);
      await restored.pump();
      assert.equal(restored.read(second, f.session.id, run.id).run.calls_used, 1, "reconnect cannot execute without a new explicit Resume");
      const resume = { action: "resume" as const, idempotency_key: `disk-${phase}-resume` };
      restored.control(second, f.session.id, run.id, resume);
      restored.control(f.actor, f.session.id, run.id, resume);
      if (phase === "completed") {
        await drive(restored, () => restored!.read(second, f.session.id, run.id).run.status === "completed");
        assert.equal(restored.read(second, f.session.id, run.id).run.calls_used, 1);
      } else {
        await drive(restored, () => restored!.read(second, f.session.id, run.id).run.calls_used === 2);
        assert.equal(service.claimAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id).status, "paused");
        assert.throws(() => service.completeAgentRequest(f.actor, f.session.id, first.request_event_id!, f.lead.id,
          `disk-${phase}-late-result`, { text: "Discard the old execution after restart" }, "fixture-gpt", "low", 1));
        const next = restored.read(second, f.session.id, run.id).run.steps.at(-1)!;
        if (phase === "claimed") {
          assert.throws(() => service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id), { code: "runtime_busy" });
          service.acknowledgeAgentExecutionStopped(f.actor, f.session.id, first.request_event_id!, f.lead.id, 1);
        }
        const claim = service.claimAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id);
        service.completeAgentRequest(f.actor, f.session.id, next.request_event_id!, f.lead.id,
          `disk-${phase}-fresh-result`, { text: "The explicitly resumed task completed" }, "fixture-gpt", "low", claim.attempt_count);
        await drive(restored, () => restored!.read(second, f.session.id, run.id).run.status === "completed");
      }
      const finished = restored.read(second, f.session.id, run.id).run;
      assert.equal(finished.steps.length, phase === "completed" ? 1 : 2);
      assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response'").get()!.n, 1);
      assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_controls WHERE run_id=?").get(run.id)!.n, 1);
      assert.equal(restored.start(second, f.session.id, input).run.id, run.id);
    } finally { restored?.close(); reopened?.close(); if (!originalClosed) f.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

test("SIGKILL after a native claim leaves a durable paused grant and requires an explicit fresh counted Resume", { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-killed-")), path = join(directory, "fixture.db"), f = fixture(path);
  const run = f.start(); f.close();
  const source = `
    import { CollaborationDatabase } from ${JSON.stringify(new URL("../src/database.js", import.meta.url).href)};
    import { CollaborationService } from ${JSON.stringify(new URL("../src/service.js", import.meta.url).href)};
    import { AgentTeams } from ${JSON.stringify(new URL("../src/agent-teams.js", import.meta.url).href)};
    const db = new CollaborationDatabase(process.argv[1]);
    const service = new CollaborationService(db), teams = new AgentTeams(service, undefined, { autoStart: false });
    const actor = ${JSON.stringify(f.actor)}, session = ${JSON.stringify(f.session.id)}, run = ${JSON.stringify(run.id)};
    teams.control(actor, session, run, { action: "resume", idempotency_key: "before-SIGKILL-resume" });
    await teams.pump();
    const detail = teams.read(actor, session, run).run, step = detail.steps.at(-1);
    service.claimAgentRequest(actor, session, step.request_event_id, ${JSON.stringify(f.lead.id)});
    process.send({ request: step.request_event_id, calls: detail.calls_used });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let childErrors = ""; child.stderr?.on("data", bytes => { childErrors += String(bytes).slice(0, 2048); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  let db: CollaborationDatabase | undefined, restored: AgentTeams | undefined;
  try {
    const accepted = await new Promise<{ request: string; calls: number }>((resolve, reject) => {
      child.once("message", value => resolve(value as { request: string; calls: number }));
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`The synthetic coordinator exited before its durable claim: ${childErrors}`)));
    });
    assert.equal(accepted.calls, 1); child.kill("SIGKILL");
    assert.equal((await exited).signal, "SIGKILL");
    db = new CollaborationDatabase(path, { clock: f.clock }); const service = new CollaborationService(db);
    restored = new AgentTeams(service, undefined, { clock: f.clock, autoStart: false });
    const recovered = restored.read(f.actor, f.session.id, run.id).run;
    assert.equal(recovered.status, "paused"); assert.equal(recovered.error_code, "server_restart"); assert.equal(recovered.calls_used, 1);
    assert.equal(service.claimAgentRequest(f.actor, f.session.id, accepted.request, f.lead.id).status, "paused");
    restored.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "before-SIGKILL-resume" });
    assert.equal(restored.read(f.actor, f.session.id, run.id).run.status, "paused", "replaying a pre-crash Resume cannot create a new execution grant");
    restored.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "after-SIGKILL-resume" });
    await drive(restored, () => restored!.read(f.actor, f.session.id, run.id).run.calls_used === 2);
    const resumed = restored.read(f.actor, f.session.id, run.id).run;
    assert.equal(resumed.steps.length, 2); assert.notEqual(resumed.steps[1]!.request_event_id, accepted.request);
    assert.throws(() => service.completeAgentRequest(f.actor, f.session.id, accepted.request, f.lead.id,
      "SIGKILL-old-result", { text: "A result from the killed execution" }, "fixture-gpt", "low", 1));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_request'").get()!.n, 2);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    restored?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }); }
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

test("Resume may consume an already completed final allowed call after a lost wakeup without requiring another call allowance", async t => {
  for (const interruption of ["pause", "restart", "pause-offline", "restart-offline"] as const) await t.test(interruption, async () => {
    const f = fixture(); let restored: AgentTeams | undefined;
    try {
      const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
      const run = f.start(plan, 1);
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      f.complete(run.id, "complete", "worker", "Verified final answer before the interruption");
      if (interruption.endsWith("-offline")) {
        f.advance(31000);
        assert.equal(f.db.listSessionRuntimesForUser(f.session.id, f.actor.user_id).find(runtime => runtime.id === f.lead.id)!.status, "offline");
        // Explicit offline persistence exercises the existing preflight as well
        // as the heartbeat-derived presence check used by normal discovery.
        f.db.sqlite.prepare("UPDATE runtimes SET status='offline' WHERE id=?").run(f.lead.id);
      }
      if (interruption.startsWith("restart")) {
        f.teams.close(); restored = new AgentTeams(f.service, undefined, { clock: f.clock, autoStart: false });
      } else f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "final-answer-pause" });
      const teams = restored ?? f.teams;
      teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "final-answer-resume" });
      await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "completed");
      const completed = teams.read(f.actor, f.session.id, run.id).run;
      assert.equal(completed.calls_used, 1); assert.equal(completed.steps.length, 1);
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_request'").get()!.n, 1);
    } finally { restored?.close(); f.close(); }
  });
});

test("consuming a retained answer at the call limit never grants an extra delegation or parent-return call", async t => {
  for (const phase of ["delegate", "parent-return"] as const) await t.test(phase, async () => {
    const f = fixture(); try {
      const limit = phase === "delegate" ? 1 : 2, run = f.start(f.plan, limit);
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      f.complete(run.id, "delegate");
      if (phase === "parent-return") {
        await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 2); f.complete(run.id);
      }
      f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "limited-delegation-pause" });
      f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "limited-delegation-resume" });
      await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "call_limit");
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, limit);
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_request'").get()!.n, limit);
    } finally { f.close(); }
  });
});

test("unfinished, failed or clarification work cannot use retained-answer recovery to exceed the call limit", async t => {
  for (const pending of ["unfinished", "failed", "clarify"] as const) await t.test(pending, async () => {
    const f = fixture(); try {
      const plan = structuredClone(f.plan); plan.nodes = [plan.nodes[0]!]; plan.edges = [];
      const run = f.start(plan, 1); await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
      const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
      if (pending === "failed") {
        const claim = f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
        f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id, "limited-failed-response",
          { content: "Synthetic failed execution", status: "failed", error: { code: "fixture_failure" } }, "fixture-gpt", "low", claim.attempt_count);
      } else if (pending === "clarify") {
        f.complete(run.id, "complete", "worker", conflictAnswer(step.id));
        await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.status === "paused");
        f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "limited-human-clarification",
          payload: { content: "Please perform the original role within its existing permissions." } });
      }
      if (pending !== "clarify") f.teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "limited-unfinished-pause" });
      assert.throws(() => f.teams.control(f.actor, f.session.id, run.id, { action: "resume", idempotency_key: "limited-unfinished-resume" }), { code: "conflict" });
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.calls_used, 1);
      assert.equal(f.teams.read(f.actor, f.session.id, run.id).run.steps.length, 1);
    } finally { f.close(); }
  });
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
for (const code of ["provider_auth_failed", "provider_rate_limited", "provider_unavailable", "container_output_too_large",
  "provider_timeout", "container_timeout", "agent_timeout", "unknown_cloud_private_detail"]) {
  test(`cloud Team diagnostics preserve a safe provider category and timeout continuation: ${code}`, { skip: process.platform === "win32" }, async () => {
    const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-diagnostic-"));
    const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), cloudOptions(async () => { throw new Error(code); }));
    f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
    try {
      const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud",
        provider: "deepseek", model: "fixture-cloud-model", include_code: false } }]; plan.edges = [];
      const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Synthetic diagnostic task",
        max_calls: 2, max_duration_minutes: 30, idempotency_key: `cloud-diagnostic-${code}` }).run;
      const timeout = ["provider_timeout", "container_timeout", "agent_timeout"].includes(code);
      await drive(teams, () => teams.store.row(run.id).status === (timeout ? "paused" : "failed"));
      const detail = teams.read(f.actor, f.session.id, run.id).run;
      const safe = code === "unknown_cloud_private_detail" ? "model_unavailable" : code;
      assert.equal(detail.error_code, timeout ? "agent_timeout" : safe);
      assert.deepEqual(detail.issue, { code: safe, node_id: "lead", node_label: "Director", target_kind: "cloud", retry_at: null });
      assert.deepEqual(teams.list(f.actor, f.session.id).runs[0]!.issue, detail.issue);
      assert.equal(detail.calls_used, 1); assert.equal(detail.steps.length, 1);
      assert.equal(JSON.stringify(detail).includes("unknown_cloud_private_detail"), false);
      if (timeout) assert.throws(() => teams.control(f.actor, f.session.id, run.id,
        { action: "resume", idempotency_key: "diagnostic-resume-not-continue" }), { code: "conflict" });
    } finally { teams.close(); hosted.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("cloud capacity and minimum-interval waits report bounded automatic retry without charging a failed reservation", { skip: process.platform === "win32" }, async () => {
  for (const reason of ["busy", "rate_limit"]) {
    const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-wait-"));
    let release!: () => void, calls = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), cloudOptions(async () => {
      if (++calls === 1 && reason === "busy") await hold;
      return JSON.stringify({ answer: "Synthetic completed answer", files: [] });
    }));
    f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
    try {
      const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud",
        provider: "deepseek", model: "fixture-cloud-model", include_code: false } }]; plan.edges = [];
      const start = (key: string) => teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Synthetic queued task",
        max_calls: 2, max_duration_minutes: 30, idempotency_key: key }).run;
      const first = start(`wait-first-${reason}`);
      await drive(teams, () => reason === "busy" ? calls === 1 : teams.store.row(first.id).status === "completed");
      const second = start(`wait-second-${reason}`); await teams.pump();
      const detail = teams.read(f.actor, f.session.id, second.id).run;
      const expected = reason === "busy" ? "hosted_agent_busy" : "hosted_user_rate_limit";
      assert.equal(detail.status, "running"); assert.equal(detail.error_code, null); assert.equal(detail.calls_used, 0);
      assert.equal(detail.issue?.code, expected); assert.equal(detail.issue?.node_label, "Director");
      assert.equal(detail.issue?.target_kind, "cloud"); assert.ok(Date.parse(detail.issue!.retry_at!) > f.clock().getTime());
      assert.equal(teams.store.row(second.id).wait_reason, expected);
      assert.deepEqual(teams.list(f.actor, f.session.id).runs.find(run => run.id === second.id)!.issue, detail.issue);
      if (reason === "busy") release();
      await drive(teams, () => teams.store.row(first.id).status === "completed");
      f.advance(5001);
      await drive(teams, () => teams.store.row(second.id).status === "completed");
      assert.equal(teams.read(f.actor, f.session.id, second.id).run.issue, undefined);
      assert.equal(teams.store.row(second.id).wait_reason, null); assert.equal(calls, 2);
      assert.equal(teams.store.row(second.id).calls_used, 1);
    } finally { release(); teams.close(); hosted.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
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

test("human Pause aborts an active cloud step and Resume executes exactly one fresh counted round", {
  skip: process.platform === "win32", timeout: 10000,
}, async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gt-team-cloud-pause-")); let calls = 0;
  const hosted = new HostedAgent(f.service, new CodeRepository(f.db, directory), cloudOptions(async (_args, _timeout, signal) => {
    assert.ok(signal, "Hosted Team executions always supply their bounded cancellation signal");
    calls++;
    if (calls === 1) return await new Promise<string>(resolve => {
      const stopped = () => resolve(JSON.stringify({ answer: "Discard this interrupted late cloud answer", files: [] }));
      if (signal.aborted) stopped(); else signal.addEventListener("abort", stopped, { once: true });
    });
    return JSON.stringify({ answer: "Resumed cloud result", files: [] });
  }));
  f.teams.close(); const teams = new AgentTeams(f.service, hosted, { clock: f.clock, autoStart: false });
  try {
    const plan = structuredClone(f.plan); plan.nodes = [{ ...plan.nodes[0]!, target: { kind: "cloud", profile_id: "fixture-cloud",
      provider: "deepseek", model: "fixture-cloud-model", include_code: false } }]; plan.edges = [];
    const run = teams.start(f.actor, f.session.id, { plan, entry_node_id: "lead", content: "Cloud pause test", max_calls: 3,
      max_duration_minutes: 30, idempotency_key: "cloud-human-pause-start" }).run;
    await drive(teams, () => calls === 1);
    const first = teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    teams.control(f.actor, f.session.id, run.id, { action: "pause", idempotency_key: "cloud-human-pause" });
    await drive(teams, () => Number(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_agent_active_runs").get()!.n) === 0);
    assert.equal(teams.read(f.actor, f.session.id, run.id).run.status, "paused");
    assert.equal(f.db.sqlite.prepare("SELECT 1 FROM events WHERE reply_to_event_id=? AND type='agent_response'").get(first.request_event_id!), undefined);
    f.advance(2000);
    const resume = { action: "resume" as const, idempotency_key: "cloud-human-resume" };
    teams.control(f.actor, f.session.id, run.id, resume); teams.control(f.actor, f.session.id, run.id, resume);
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "completed");
    const completed = teams.read(f.actor, f.session.id, run.id).run;
    assert.equal(calls, 2); assert.equal(completed.calls_used, 2); assert.equal(completed.steps.length, 2);
    assert.equal(completed.steps[0]!.status, "paused");
    assert.equal((f.db.getEvent(f.session.id, completed.steps[1]!.response_event_id!).payload as { content: string }).content, "Resumed cloud result");
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
    const originalStart = JSON.parse(f.teams.store.row(run.id).input_json);
    await drive(f.teams, () => f.teams.read(f.actor, f.session.id, run.id).run.calls_used === 1);
    const step = f.teams.read(f.actor, f.session.id, run.id).run.steps[0]!;
    f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.lead.id);
    f.db.deleteMessage(f.actor, f.session.id, source.id, "team-source-erasure");
    assert.ok(f.teams.store.startReceipt(f.actor, f.session.id, originalStart.idempotency_key), "Author erasure removes task copies but preserves content-free consumed keys");
    assert.throws(() => f.teams.start(f.actor, f.session.id, originalStart), { code: "context_changed" });
    assert.throws(() => f.teams.start(f.actor, f.session.id, { ...originalStart, content_revision: 1 }), { code: "idempotency_conflict" });
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
      error => error instanceof ApiError && error.code === "agent_team_model_unavailable");
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

test("durable consumed-key capacity fails closed for new starts without holding Stop or Forget hostage", () => {
  const f = fixture(); try {
    const run = f.start(), insert = f.db.sqlite.prepare(`INSERT INTO agent_team_start_receipts
      (session_id,user_id,key_digest,run_id,input_digest,purpose,created_at) VALUES(?,?,?,?,?,'task',?)`);
    const original = JSON.parse(f.teams.store.row(run.id).input_json);
    f.teams.store.transaction(() => {
      for (let index = 1; index < 10000; index++) insert.run(f.session.id, f.actor.user_id,
        teamStartDigest(`synthetic-full-${index}`), `synthetic-old-run-${index}`, teamStartDigest("synthetic-input-digest"), f.clock().toISOString());
    });
    assert.throws(() => f.start(), { code: "agent_team_storage_full" });
    assert.equal(f.teams.start(f.actor, f.session.id, original).replayed, true);
    f.teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "synthetic-full-stop" });
    f.teams.forget(f.actor, f.session.id, run.id);
    assert.throws(() => f.teams.start(f.actor, f.session.id, original), { code: "conflict" });
    assert.throws(() => f.teams.start(f.actor, f.session.id, { ...original, content: "Changed task" }), { code: "idempotency_conflict" });
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n, 10000);
    assert.equal(f.service.replay(f.actor, f.session.id, 0, 100).events.some(event => event.type === "agent_request"), false);
  } finally { f.close(); }
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
    const input = { plan, entry_node_id: "lead", content: "One bounded cloud task",
      max_calls: 1, max_duration_minutes: 30, idempotency_key: "forgotten-cloud-team" };
    const run = teams.start(f.actor, f.session.id, input).run;
    await drive(teams, () => teams.read(f.actor, f.session.id, run.id).run.status === "paused");
    const original = f.db.getEvent(f.session.id, teams.read(f.actor, f.session.id, run.id).run.steps[0]!.request_event_id!);
    const continuation = { profile_id: "fixture-cloud", include_code: false, content: String((original.payload as { content: string }).content),
      continue_from_event_id: original.id, idempotency_key: "ordinary-before-forget" };
    await assert.rejects(hosted.start(f.actor, f.session.id, continuation), /bounded team/);
    teams.control(f.actor, f.session.id, run.id, { action: "stop", idempotency_key: "stop-forgotten-cloud-team" });
    teams.forget(f.actor, f.session.id, run.id); f.advance(1000);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_team_steps").get()!.count, 0);
    const head = f.db.requireSession(f.session.id).next_sequence;
    assert.throws(() => teams.start(f.actor, f.session.id, input), { code: "conflict" });
    assert.throws(() => teams.start(f.actor, f.session.id, { ...input, content: "Changed paid cloud task" }), { code: "idempotency_conflict" });
    await teams.pump();
    assert.equal(hosted.status(f.actor).user_used_runs, 1, "A consumed start key cannot reserve a second provider allowance");
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
