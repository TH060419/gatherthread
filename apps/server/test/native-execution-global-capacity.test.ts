import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTeamPlan } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";

test("global native hold admission honors 100000 identities, preserves detached occupancy and leaves ordinary claims available", { timeout: 30000 }, async () => {
  const db = new CollaborationDatabase(":memory:"), service = new CollaborationService(db);
  const teams = new AgentTeams(service, undefined, { autoStart: false });
  try {
    const actor = db.bootstrapIdentity({ display_name: "Global capacity caller", device_name: "Capacity executor" }).actor;
    const other = db.createIdentity({ display_name: "Legacy hold owner", device_name: "Legacy executor", can_create_projects: true }).actor;
    const session = service.createSession(actor, { title: "Current project", mode: "multi", idempotency_key: "global-cap-current" }).session;
    const old = service.createSession(other, { title: "Independent legacy project", mode: "multi", idempotency_key: "global-cap-legacy" }).session;
    const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex",
      provider: "synthetic", model: "synthetic-model", context_deletion_version: 1,
      local_session_id: "global-cap-native", capture_fidelity: "harness_transcript" });
    const dsh = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "deepseek-harness",
      provider: "synthetic", model: "synthetic-dsh", context_deletion_version: 1,
      local_session_id: "global-cap-dsh", capture_fidelity: "harness_transcript" });
    // Legacy records are not evicted by the new per-account admission ceiling.
    // Populate the real global boundary without 100000 provider calls or tokens.
    db.sqlite.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO agent_native_exit_holds(request_event_id,runtime_id,claim_attempt,owner_user_id,owner_device_id,project_id,session_id,harness,created_at)
      SELECT 'global-old-request-'||i,'global-old-runtime-'||i,1,?,?,?,?, 'codex',? FROM n`)
      .run(other.user_id, other.device_id, old.project_id!, old.id, new Date().toISOString());
    assert.equal(Number(db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n), 100000);
    assert.equal(db.executionHoldIssue(runtime.id), "agent_team_native_hold_capacity");
    assert.equal(db.executionHoldIssue(runtime.id, false), undefined);
    const plan: AgentTeamPlan = { name: "Global capacity Team", team_prompt: "", nodes: [{ id: "lead", label: "Lead", role: "", x: 0, y: 0,
      target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "synthetic", model: "synthetic-model" } }], edges: [] };
    const run = teams.start(actor, session.id, { plan, entry_node_id: "lead", content: "Synthetic capacity task", max_calls: 1,
      max_duration_minutes: 1, content_revision: 0, idempotency_key: "global-cap-task" }).run;
    await teams.pump(); const request = teams.store.steps(run.id)[0]!.request_event_id!;
    assert.throws(() => service.claimAgentRequest(actor, session.id, request, runtime.id), { code: "agent_team_native_hold_capacity", status: 429 });
    assert.equal(db.sqlite.prepare("SELECT 1 FROM agent_request_claims WHERE request_event_id=?").get(request), undefined);
    service.acknowledgeAgentExecutionStopped(actor, old.id, "global-old-request-1", "global-old-runtime-1", 1);
    assert.equal(db.executionHoldIssue(runtime.id), "agent_team_native_hold_capacity", "another account cannot free global capacity");
    service.acknowledgeAgentExecutionStopped(other, old.id, "global-old-request-1", "global-old-runtime-1", 1);
    assert.equal(db.executionHoldIssue(runtime.id), undefined);
    const claimed = service.claimAgentRequest(actor, session.id, request, runtime.id);
    assert.equal(claimed.status, "claimed");
    assert.equal(db.executionHoldIssue(dsh.id), "agent_team_native_hold_capacity", "99999 detached plus one live attempt reaches the global limit");
    db.sqlite.prepare("DELETE FROM agent_request_claims WHERE request_event_id=?").run(request);
    assert.equal(Number(db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_native_exit_holds").get()!.n), 100000);
    assert.equal(db.executionHoldIssue(dsh.id), "agent_team_native_hold_capacity", "moving one exact identity must not lose its occupied capacity");
    const ordinary = service.appendEvent(actor, session.id, { type: "agent_request", visibility: "session", idempotency_key: "global-cap-ordinary",
      payload: { content: "Ordinary synthetic work", execution_profile: {
        runtime_id: dsh.id, harness: "deepseek-harness", provider: "synthetic", model: "synthetic-dsh" } } });
    const ordinaryClaim = service.claimAgentRequest(actor, session.id, ordinary.id, dsh.id);
    assert.equal(ordinaryClaim.status, "claimed");
    service.completeAgentRequest(actor, session.id, ordinary.id, dsh.id, "global-cap-ordinary-complete", { content: "Synthetic completion" },
      undefined, undefined, ordinaryClaim.attempt_count);
    service.acknowledgeAgentExecutionStopped(actor, session.id, request, runtime.id, claimed.attempt_count! + 1);
    assert.equal(db.executionHoldIssue(dsh.id), "agent_team_native_hold_capacity");
    service.acknowledgeAgentExecutionStopped(actor, session.id, request, runtime.id, claimed.attempt_count!);
    assert.equal(db.executionHoldIssue(dsh.id), undefined);
    assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { teams.close(); db.close(); }
});
