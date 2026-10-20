import { randomUUID } from "node:crypto";
import { AgentTeamPlanSchema, AgentTeamRunDetailSchema, historySummaryText, type AgentTeamPlan, type AgentTeamRunDetail,
  type AgentTeamRunSummary, type CanonicalEvent, type ControlAgentTeamRunInput, type StartAgentTeamRunInput, type JsonValue } from "@gatherthread/protocol";
import type { Actor } from "./database.js";
import type { CollaborationService } from "./service.js";
import { ApiError, conflict, forbidden, idempotencyConflict, notFound } from "./errors.js";
import { redactJson } from "./redaction.js";
import { teamStartDigest } from "./agent-team-schema.js";
import { TEAM_GLOBAL_ISSUES, teamAgentFailureCode, teamPublicIssueCode } from "./agent-team-errors.js";

export interface TeamState { node_id: string; task: string; parent_step_id: string | null;
  context_response_id: string | null; stack: { step_id: string; node_id: string }[];
  clarification_event_id?: string; conflict_response_id?: string }
export interface TeamRunRow { id: string; session_id: string; user_id: string; device_id: string; display_name: string;
  idempotency_key: string; input_json: string; plan_json: string; content: string; status: AgentTeamRunSummary["status"];
  calls_used: number; max_calls: number; max_duration_minutes: number; created_at: string; deadline_at: string;
  finished_at: string | null; current_node_id: string | null; current_step_id: string | null; error_code: string | null;
  state_json: string; next_attempt_at: string | null; wait_reason: string | null; bytes: number; content_revision: number; purpose: "task" | "test";
  definition_id: string | null; definition_revision: number | null; library_request_digest: string | null }
export interface TeamStepRow { id: string; run_id: string; node_id: string; node_label: string; task: string;
  status: AgentTeamRunDetail["steps"][number]["status"]; request_event_id: string | null; response_event_id: string | null;
  parent_step_id: string | null; context_response_id: string | null; created_at: string; finished_at: string | null }
const TERMINAL = new Set(["completed", "failed", "stopped", "timed_out", "call_limit"]);
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

/** All authority is current; the original device is a bounded-run grant, never a credential. */
export class AgentTeamStore {
  constructor(readonly service: CollaborationService, readonly clock: () => Date = () => new Date()) {}
  get sql() { return this.service.database.sqlite; }
  now() { return this.clock().toISOString(); }
  assertSafeInput(input: AgentTeamPlan | StartAgentTeamRunInput) {
    if (stable(redactJson(input as unknown as JsonValue)) !== stable(input)) {
      throw new ApiError(400, "agent_team_sensitive_input", "Remove credentials from team rules, roles and tasks before saving or starting");
    }
    const plan = "plan" in input ? input.plan : input;
    if (Buffer.byteLength(JSON.stringify(plan)) > 65536) throw new ApiError(413,
      "agent_team_plan_too_large", "Team rules and roles exceed the saved-plan limit; shorten them before saving or starting");
  }
  assertContext(run: TeamRunRow) {
    if (run.content_revision !== (this.service.database.requireSession(run.session_id).content_revision ?? 0)) {
      throw new ApiError(409, "context_changed", "Shared history changed; start a new team task with current history");
    }
  }
  transaction<T>(work: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.sql.exec("COMMIT"); return value; }
    catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
  authorize(actor: Actor, sessionId: string, write = false) {
    this.service.database.assertActiveDevice(actor);
    if (write) {
      const { session } = this.service.requireWrite(actor, sessionId);
      if (session.state !== "active") throw conflict("Archived sessions do not accept team tasks");
    } else this.service.requireMembership(actor, sessionId);
  }
  actor(run: TeamRunRow): Actor { return { user_id: run.user_id, device_id: run.device_id, display_name: run.display_name }; }
  plan(run: TeamRunRow): AgentTeamPlan { return AgentTeamPlanSchema.parse(JSON.parse(run.plan_json)); }
  state(run: TeamRunRow): TeamState { return JSON.parse(run.state_json) as TeamState; }
  row(id: string): TeamRunRow { const row = this.sql.prepare("SELECT * FROM agent_team_runs WHERE id=?").get(id) as unknown as TeamRunRow | undefined;
    if (!row) throw notFound("Agent team run"); return row; }
  startReceipt(actor: Actor, sessionId: string, key: string) {
    return this.sql.prepare("SELECT * FROM agent_team_start_receipts WHERE session_id=? AND user_id=? AND key_digest=?")
      .get(sessionId, actor.user_id, teamStartDigest(key));
  }
  private conflictIssue(issueCode: string, message: string): ApiError { return new ApiError(409, "conflict", message, { issue_code: issueCode }); }
  clearedStart(): never { throw this.conflictIssue("agent_team_receipt_cleared",
    "This team request was already accepted and its private record was cleared; start a new task with a new key"); }
  own(actor: Actor, sessionId: string, id: string, write = false) {
    this.authorize(actor, sessionId, write); this.prune(); const row = this.row(id);
    if (row.session_id !== sessionId || row.user_id !== actor.user_id) throw notFound("Agent team run");
    this.assertContext(row); return row;
  }
  step(id: string): TeamStepRow { const row = this.sql.prepare("SELECT * FROM agent_team_steps WHERE id=?").get(id) as unknown as TeamStepRow | undefined;
    if (!row) throw notFound("Agent team step"); return row; }
  steps(runId: string): TeamStepRow[] { return this.sql.prepare("SELECT * FROM agent_team_steps WHERE run_id=? ORDER BY rowid").all(runId) as unknown as TeamStepRow[]; }
  summary(run: TeamRunRow): AgentTeamRunSummary {
    const issue = this.issue(run);
    return { id: run.id, session_id: run.session_id, status: run.status, purpose: run.purpose, definition_id: run.definition_id,
      created_at: run.created_at, deadline_at: run.deadline_at,
      finished_at: run.finished_at, calls_used: run.calls_used, max_calls: run.max_calls, max_duration_minutes: run.max_duration_minutes,
      current_node_id: run.current_node_id, current_step_id: run.current_step_id,
      error_code: run.error_code ? teamPublicIssueCode(run.error_code) : null,
      ...(issue ? { issue } : {}) };
  }
  private issue(run: TeamRunRow): NonNullable<AgentTeamRunSummary["issue"]> | undefined {
    let code = run.error_code ?? (run.status === "running" ? run.wait_reason : null);
    const node = this.plan(run).nodes.find(node => node.id === run.current_node_id);
    if (code === "agent_timeout" && node && run.current_step_id) {
      const step = this.step(run.current_step_id);
      if (step.response_event_id) {
        const payload = this.service.database.getEvent(run.session_id, step.response_event_id).payload;
        const error = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.error : undefined;
        const cause = error && typeof error === "object" && !Array.isArray(error) ? error.code : undefined;
        const safe = teamAgentFailureCode(cause, node.target.kind);
        if (["agent_share_timeout", "provider_timeout", "container_timeout", "agent_timeout"].includes(safe)) code = safe;
      }
    }
    // An accepted native request can remain queued or lose presence without a
    // final response. Describe that wait while retaining its exact-route grant.
    if (!code && run.status === "running" && node?.target.kind === "local" && run.current_step_id) {
      const step = this.step(run.current_step_id);
      if (step.status === "running" && step.request_event_id && !step.response_event_id
        && !this.sql.prepare("SELECT 1 FROM events WHERE session_id=? AND type='agent_response' AND reply_to_event_id=?")
          .get(run.session_id, step.request_event_id)) {
        const runtimeId = node.target.runtime_id;
        const online = this.service.database.listSessionRuntimesForUser(run.session_id, run.user_id)
          .find(runtime => runtime.id === runtimeId)?.status === "online";
        const claim = this.sql.prepare("SELECT status,lease_expires_at FROM agent_request_claims WHERE request_event_id=?").get(step.request_event_id);
        if (claim?.status === "claimed" && typeof claim.lease_expires_at === "string" && claim.lease_expires_at <= this.now()) {
          code = "agent_team_claim_expired";
        } else if (!online) code = "agent_team_runtime_offline";
        else if (!claim) {
          const pending = this.sql.prepare("SELECT 1 FROM agent_request_claims WHERE runtime_id=? AND execution_pending=1 LIMIT 1").get(runtimeId);
          code = pending ? "agent_team_native_exit_pending"
            : this.service.database.executionHoldIssue(runtimeId) ?? "agent_team_waiting_executor";
        }
      }
    }
    if (!code && run.status === "running" && node?.target.kind === "shared" && run.current_step_id) {
      const step = this.step(run.current_step_id);
      if (step.request_event_id && this.sql.prepare("SELECT status FROM agent_share_jobs WHERE request_event_id=?")
        .get(step.request_event_id)?.status === "queued") code = "agent_share_queued";
    }
    if (!code) return undefined;
    code = teamPublicIssueCode(code);
    const local = !TEAM_GLOBAL_ISSUES.has(code) ? node : undefined;
    return { code, node_id: local?.id ?? null, node_label: local?.label ?? null, target_kind: local?.target.kind ?? null,
      retry_at: run.status === "running" ? run.next_attempt_at : null };
  }
  detail(run: TeamRunRow): AgentTeamRunDetail {
    const plan = this.plan(run);
    return AgentTeamRunDetailSchema.parse({ ...this.summary(run), plan, content: run.content,
      steps: this.steps(run.id).map(({ id, node_id, node_label, status, request_event_id, response_event_id, parent_step_id, created_at, finished_at }) => {
        // Acceptance consumes a call, but a queued native request is not yet work.
        const queued = status === "running" && request_event_id && plan.nodes.find(node => node.id === node_id)?.target.kind === "local"
          && !this.sql.prepare("SELECT 1 FROM agent_request_claims WHERE request_event_id=?").get(request_event_id);
        return { id, node_id, node_label, status: queued ? "pending" : status,
          request_event_id, response_event_id, parent_step_id, created_at, finished_at };
      }) });
  }
  read(actor: Actor, sessionId: string, id: string) { return { run: this.detail(this.own(actor, sessionId, id)) }; }
  list(actor: Actor, sessionId: string) {
    this.authorize(actor, sessionId); this.prune();
    return { runs: (this.sql.prepare(`SELECT * FROM agent_team_runs WHERE session_id=? AND user_id=?
      ORDER BY status IN ('running','paused') DESC,purpose='task' DESC,created_at DESC,rowid DESC LIMIT 50`)
      .all(sessionId, actor.user_id) as unknown as TeamRunRow[]).map(row => this.summary(row)) };
  }
  getPlan(actor: Actor, sessionId: string) {
    this.authorize(actor, sessionId); this.prune();
    const row = this.sql.prepare("SELECT plan_json,revision FROM agent_team_plans WHERE session_id=? AND user_id=?").get(sessionId, actor.user_id);
    return { plan: row ? AgentTeamPlanSchema.parse(JSON.parse(String(row.plan_json))) : null, revision: row ? Number(row.revision) : null };
  }
  savePlan(actor: Actor, sessionId: string, plan: AgentTeamPlan, expectedRevision: number | null) {
    this.assertSafeInput(plan);
    return this.transaction(() => {
      this.authorize(actor, sessionId, true); this.prune();
      const previous = this.getPlan(actor, sessionId);
      // A lost acknowledgement can repeat exactly the saved plan without advancing revision.
      if (previous.revision !== expectedRevision) {
        if (previous.plan && stable(previous.plan) === stable(plan)) return previous;
        throw conflict("Team plan changed in another tab; reload before saving");
      }
      const serialized = JSON.stringify(plan); const bytes = Buffer.byteLength(serialized);
      const old = this.sql.prepare("SELECT bytes FROM agent_team_plans WHERE session_id=? AND user_id=?").get(sessionId, actor.user_id);
      this.room(actor.user_id, sessionId, bytes - Number(old?.bytes ?? 0), old ? undefined : "plan");
      const revision = (previous.revision ?? 0) + 1;
      this.sql.prepare(`INSERT INTO agent_team_plans(session_id,user_id,revision,plan_json,bytes,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,user_id) DO UPDATE SET revision=excluded.revision,plan_json=excluded.plan_json,bytes=excluded.bytes,updated_at=excluded.updated_at`)
        .run(sessionId, actor.user_id, revision, serialized, bytes, this.now());
      return { plan, revision };
    });
  }
  create(actor: Actor, sessionId: string, input: StartAgentTeamRunInput, purpose: "task" | "test" = "task",
    onCreated?: (run: TeamRunRow) => void, beforeCreate?: () => void) {
    this.assertSafeInput(input);
    return this.transaction(() => {
      this.authorize(actor, sessionId, true); this.prune();
      const previous = this.sql.prepare("SELECT * FROM agent_team_runs WHERE session_id=? AND user_id=? AND idempotency_key=?")
        .get(sessionId, actor.user_id, input.idempotency_key) as unknown as TeamRunRow | undefined;
      const inputJson = stable(input);
      const contentRevision = this.service.database.requireSession(sessionId).content_revision ?? 0;
      if (input.content_revision !== undefined ? input.content_revision !== contentRevision : contentRevision > 0) {
        throw new ApiError(409, "context_changed", "Shared history changed; refresh before starting a team task");
      }
      if (previous) {
        if (previous.input_json !== inputJson || previous.purpose !== purpose) throw idempotencyConflict("Team run retry must keep the original plan, task and limits");
        return { run: this.detail(previous), replayed: true };
      }
      const consumed = this.startReceipt(actor, sessionId, input.idempotency_key);
      if (consumed) {
        if (consumed.input_digest && (consumed.input_digest !== teamStartDigest(inputJson) || consumed.purpose !== purpose)) {
          throw idempotencyConflict("Team run retry must keep the original plan, task and limits");
        }
        this.clearedStart();
      }
      if (purpose === "test" && (input.reply_to_event_id !== undefined || input.mentions !== undefined)) {
        throw conflict("Connectivity tests cannot quote or mention conversation members");
      }
      this.service.database.validateTeamTaskReferences(sessionId, input);
      // A replacement may fence its old probe only as part of accepting this
      // run. Any later quota/storage refusal rolls that fence back as well.
      beforeCreate?.();
      const active = this.sql.prepare("SELECT COUNT(*) AS count FROM agent_team_runs WHERE user_id=? AND status IN ('running','paused')")
        .get(actor.user_id) as { count: number };
      if (active.count >= 2) throw new ApiError(429, "agent_team_busy", "Stop an existing team run before starting another");
      const id = `team-${randomUUID()}`; const created = this.now();
      const deadline = new Date(this.clock().getTime() + input.max_duration_minutes * 60000).toISOString();
      const state: TeamState = { node_id: input.entry_node_id, task: input.content, parent_step_id: null, context_response_id: null, stack: [] };
      const plan = JSON.stringify(input.plan), stateJson = JSON.stringify(state);
      const bytes = Buffer.byteLength(inputJson) + Buffer.byteLength(plan) + Buffer.byteLength(input.content) + Buffer.byteLength(stateJson) + 2048;
      try { this.room(actor.user_id, sessionId, bytes, "run"); }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== "agent_team_storage_full") throw error;
        // Superseded connectivity probes are hidden execution caches, not task
        // history. Reclaim only this owner's ended, unreferenced probes under
        // storage pressure, in the same transaction as the replacement start.
        this.preserveCompletedTests();
        this.sql.prepare(`DELETE FROM agent_team_runs WHERE user_id=? AND purpose='test'
          AND status NOT IN ('running','paused') AND NOT EXISTS(SELECT 1 FROM agent_team_definitions d
            WHERE d.user_id=agent_team_runs.user_id AND d.test_run_id=agent_team_runs.id)`).run(actor.user_id);
        this.room(actor.user_id, sessionId, bytes, "run");
      }
      // Permanent content-free fences are independently bounded. Clearing a run
      // releases its private snapshot, never the right to reuse an accepted key.
      for (const [predicate, args, limit] of [["user_id=?", [actor.user_id], 10000], ["session_id=?", [sessionId], 20000], ["1=1", [], 200000]] as const) {
        const count = Number(this.sql.prepare(`SELECT COUNT(*) AS n FROM agent_team_start_receipts WHERE ${predicate}`).get(...args)?.n ?? 0);
        if (count >= limit) throw new ApiError(429, "agent_team_storage_full", "Team start receipt storage is full; existing tasks can still be stopped or cleared");
      }
      this.sql.prepare(`INSERT INTO agent_team_runs(id,session_id,user_id,device_id,display_name,idempotency_key,input_json,plan_json,content,content_revision,
        status,max_calls,max_duration_minutes,created_at,deadline_at,current_node_id,state_json,bytes,purpose) VALUES(?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?)`)
        .run(id, sessionId, actor.user_id, actor.device_id, actor.display_name, input.idempotency_key, inputJson, plan, input.content,
          contentRevision, input.max_calls, input.max_duration_minutes, created, deadline, input.entry_node_id, stateJson, bytes, purpose);
      onCreated?.(this.row(id));
      const bound = this.row(id);
      this.sql.prepare(`INSERT INTO agent_team_start_receipts
        (session_id,user_id,key_digest,run_id,input_digest,purpose,definition_id,library_request_digest,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, actor.user_id, teamStartDigest(input.idempotency_key), id,
          teamStartDigest(inputJson), purpose, bound.definition_id, bound.library_request_digest, created);
      return { run: this.detail(this.row(id)), replayed: false };
    });
  }
  runnable(run: TeamRunRow) {
    if (run.status !== "running") throw conflict("This team run is not running");
    this.assertContext(run);
    this.service.database.assertTeamRunAuthority(run);
    if (this.clock().getTime() >= Date.parse(run.deadline_at)) throw new ApiError(409, "agent_team_deadline", "The team time limit has been reached");
  }
  pending(runId: string): TeamStepRow {
    return this.transaction(() => {
      const run = this.row(runId); this.runnable(run);
      if (run.current_step_id) return this.step(run.current_step_id);
      if (run.calls_used >= run.max_calls) throw new ApiError(409, "agent_team_call_limit", "The team call limit has been reached");
      if (this.steps(run.id).length >= 49) throw new ApiError(429, "agent_team_storage_full", "This run has too many interrupted steps; start a new team task");
      const state = this.state(run), node = this.plan(run).nodes.find(node => node.id === state.node_id)!;
      const bytes = Buffer.byteLength(state.task) + 1024; this.charge(run, bytes);
      const id = `step-${randomUUID()}`;
      this.sql.prepare(`INSERT INTO agent_team_steps(id,run_id,node_id,node_label,task,status,parent_step_id,context_response_id,created_at)
        VALUES(?,?,?,?,?,'pending',?,?,?)`).run(id, run.id, node.id, node.label, state.task, state.parent_step_id, state.context_response_id, this.now());
      this.sql.prepare("UPDATE agent_team_runs SET current_step_id=?,current_node_id=? WHERE id=?").run(id, node.id, run.id);
      return this.step(id);
    });
  }
  /** Called from the SAME canonical-write transaction; failure rolls back quotas and the event. */
  accepted(stepId: string, event: CanonicalEvent) {
    const step = this.step(stepId), run = this.row(step.run_id); this.runnable(run);
    if (run.current_step_id !== step.id || step.status !== "pending" || run.calls_used >= run.max_calls
      || event.session_id !== run.session_id || event.actor_user_id !== run.user_id) throw conflict("The team step is no longer authorized");
    this.sql.prepare("UPDATE agent_team_steps SET status='running',request_event_id=? WHERE id=?").run(event.id, step.id);
    this.sql.prepare("UPDATE agent_team_runs SET calls_used=calls_used+1,next_attempt_at=NULL,wait_reason=NULL WHERE id=?").run(run.id);
  }
  transition(run: TeamRunRow, state: TeamState) {
    const serialized = JSON.stringify(state);
    const growth = Buffer.byteLength(serialized) - Buffer.byteLength(run.state_json);
    if (growth > 0) this.charge(run, growth);
    this.sql.prepare("UPDATE agent_team_runs SET state_json=?,current_step_id=NULL,current_node_id=?,next_attempt_at=NULL,wait_reason=NULL,error_code=NULL WHERE id=?")
      .run(serialized, state.node_id, run.id);
  }
  settle(runId: string, status: TeamRunRow["status"], errorCode: string | null = null) {
    this.sql.prepare("UPDATE agent_team_runs SET status=?,error_code=?,finished_at=?,next_attempt_at=NULL,wait_reason=NULL WHERE id=?")
      .run(status, errorCode, TERMINAL.has(status) ? this.now() : null, runId);
    if (status === "completed") this.preserveCompletedTests(runId);
  }
  private preserveCompletedTests(runId: string | null = null) {
    // A verified probe is acknowledged by the server, not by a later browser
    // poll. Matching the exact current test pointer prevents a replaced/edited
    // definition from borrowing an older result. Control-only revisions may
    // retain that result because they do not change its configuration.
    this.sql.prepare(`UPDATE agent_team_definitions SET tested_revision=revision
      WHERE tested_revision IS NOT revision AND EXISTS(SELECT 1 FROM agent_team_runs r
        WHERE r.id=agent_team_definitions.test_run_id AND r.definition_id=agent_team_definitions.id
        AND r.user_id=agent_team_definitions.user_id AND r.purpose='test' AND r.status='completed'
        AND (? IS NULL OR r.id=?))`).run(runId, runId);
  }
  due() { return this.sql.prepare(`SELECT r.* FROM agent_team_runs r LEFT JOIN agent_team_steps s ON s.id=r.current_step_id
    WHERE r.status='running' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=?)
      AND (r.current_step_id IS NULL OR s.status='pending' OR EXISTS (
        SELECT 1 FROM events e WHERE e.session_id=r.session_id AND e.reply_to_event_id=s.request_event_id AND e.type='agent_response'))
    ORDER BY COALESCE(s.created_at,r.created_at),r.rowid LIMIT 32`)
    .all(this.now()) as unknown as TeamRunRow[]; }
  defer(runId: string, seconds: number, reason: string) {
    this.sql.prepare("UPDATE agent_team_runs SET next_attempt_at=?,wait_reason=? WHERE id=?")
      .run(new Date(this.clock().getTime() + Math.max(1, seconds) * 1000).toISOString(), reason, runId);
  }
  private clarifiedState(run: TeamRunRow): TeamState {
    const step = run.current_step_id ? this.step(run.current_step_id) : undefined;
    const response = step?.response_event_id ? this.service.database.getEvent(run.session_id, step.response_event_id) : undefined;
    if (!step || step.status !== "completed" || !response || response.deleted || response.type !== "agent_response"
      || response.actor_user_id !== run.user_id || response.reply_to_event_id !== step.request_event_id) {
      throw this.conflictIssue("agent_team_clarification_unavailable", "This Team conflict report is no longer available; start a new task");
    }
    const candidates = this.sql.prepare(`SELECT id,payload_json FROM events WHERE session_id=? AND actor_user_id=?
      AND type='human_chat' AND visibility='session' AND deleted_at IS NULL AND sequence>? ORDER BY sequence DESC`);
    for (const candidate of candidates.iterate(run.session_id, run.user_id, response.sequence)) {
      if (!historySummaryText(JSON.parse(String(candidate.payload_json))).trim()) continue;
      return { ...this.state(run), clarification_event_id: String(candidate.id), conflict_response_id: response.id };
    }
    throw new ApiError(409, "agent_team_clarification_required",
      "Send a public clarification after the Agent's conflict report before resuming this Team");
  }
  hasUnconsumedSuccess(run: TeamRunRow) {
    if (!run.current_step_id) return false;
    const step = this.step(run.current_step_id);
    if (step.response_event_id || !step.request_event_id) return false;
    const row = this.sql.prepare("SELECT id FROM events WHERE session_id=? AND type='agent_response' AND reply_to_event_id=? ORDER BY sequence LIMIT 1")
      .get(run.session_id, step.request_event_id);
    if (!row) return false;
    const response = this.service.database.getEvent(run.session_id, String(row.id)), payload = response.payload;
    return !response.deleted && response.actor_user_id === run.user_id
      && !(payload && typeof payload === "object" && !Array.isArray(payload) && payload.status === "failed");
  }
  control(actor: Actor, sessionId: string, id: string, input: ControlAgentTeamRunInput) {
    return this.transaction(() => {
      const run = this.own(actor, sessionId, id, true);
      const existing = this.sql.prepare("SELECT action FROM agent_team_controls WHERE run_id=? AND idempotency_key=?").get(id, input.idempotency_key);
      if (existing) { if (existing.action !== input.action) throw idempotencyConflict(); return { run: this.detail(run), changed: false }; }
      let unchanged = false;
      if (TERMINAL.has(run.status)) {
        if (input.action === "stop" && run.status === "stopped") unchanged = true;
        else throw this.conflictIssue("agent_team_run_ended", "This team run has ended; start a new task");
      }
      if (input.action === "pause" && run.status === "paused" || (input.action === "resume" || input.action === "continue") && run.status === "running") {
        unchanged = true;
      }
      if (!unchanged && (input.action === "resume" || input.action === "continue")) {
        // A grant whose original device was revoked cannot be renewed through another device.
        this.authorize(this.actor(run), sessionId, true);
        // Pausing/restarting after the final result was committed can leave only
        // its settlement pending. Resume may validate/consume that result at the
        // call limit; dispatch still has no allowance for another request.
        const settleOnly = input.action === "resume" && !["agent_timeout", "agent_team_instruction_conflict"].includes(run.error_code ?? "")
          && this.hasUnconsumedSuccess(run);
        if (this.clock().getTime() >= Date.parse(run.deadline_at)) throw this.conflictIssue("agent_team_deadline", "Team execution time is exhausted; start a new task");
        if (run.calls_used >= run.max_calls && !settleOnly) throw this.conflictIssue("agent_team_call_limit", "Team calls are exhausted; start a new task");
        if (input.action === "continue" && run.error_code !== "agent_timeout") throw this.conflictIssue("agent_team_not_timed_out", "Only a timed-out team step can be continued");
        if (input.action === "resume" && run.error_code === "agent_timeout") throw this.conflictIssue("agent_team_continue_required", "Continue the timed-out team step explicitly");
      }
      const clarification = !unchanged && input.action === "resume" && run.error_code === "agent_team_instruction_conflict"
        ? this.clarifiedState(run) : undefined;
      const count = this.sql.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(reserved),0) AS reserved,
        COALESCE(SUM(reserved=1 AND action='pause'),0) AS pauses,
        COALESCE(SUM(reserved=1 AND action='stop'),0) AS stops FROM agent_team_controls WHERE run_id=?`).get(id)!;
      const critical = !unchanged && (input.action === "stop" || input.action === "pause");
      let reserved = Number(count.count) - Number(count.reserved) >= 128;
      if (!reserved) {
        try { this.charge(run, 512); }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== "agent_team_storage_full" || !critical) throw error;
          reserved = true;
        }
      }
      // The prepaid 2048-byte fixed allowance includes two Pause receipts and
      // one independent Stop receipt. Repeated pauses (including old records)
      // cannot consume Stop's capacity. No-ops still require ordinary capacity.
      const used = Number(input.action === "stop" ? count.stops : count.pauses);
      if (reserved && (!critical || used >= (input.action === "stop" ? 1 : 2))) {
        throw new ApiError(429, "agent_team_storage_full", "This run has too many control changes; stop it and start a new task");
      }
      this.sql.prepare("INSERT INTO agent_team_controls(run_id,idempotency_key,action,created_at,reserved) VALUES(?,?,?,?,?)")
        .run(id, input.idempotency_key, input.action, this.now(), Number(reserved));
      if (unchanged) return { run: this.detail(this.row(id)), changed: false };
      // A conflict already has a verified completed response. Resume must create
      // a fresh counted step, while keeping the frozen assignment and call stack.
      if (clarification) this.transition(this.row(id), clarification);
      this.settle(id, input.action === "stop" ? "stopped" : input.action === "pause" ? "paused" : "running",
        input.action === "pause" ? "user_paused" : null);
      return { run: this.detail(this.row(id)), changed: true };
    });
  }
  forget(actor: Actor, sessionId: string, id: string) {
    this.transaction(() => { const run = this.own(actor, sessionId, id, true);
      if (!TERMINAL.has(run.status)) throw conflict("Stop this team run before clearing its private record");
      this.sql.prepare("DELETE FROM agent_team_runs WHERE id=?").run(id); });
  }
  private charge(run: TeamRunRow, bytes: number) {
    if (run.bytes + bytes > 524288) throw new ApiError(429, "agent_team_storage_full", "Team control storage is full; clear an old completed team record");
    this.room(run.user_id, run.session_id, bytes); this.sql.prepare("UPDATE agent_team_runs SET bytes=bytes+? WHERE id=?").run(bytes, run.id);
  }
  private room(userId: string, sessionId: string, bytes: number, adding?: "plan" | "run") {
    const table = adding === "plan" ? "agent_team_plans" : "agent_team_runs";
    if (adding) for (const [predicate, args, limit] of [["user_id=?", [userId], 100], ["session_id=?", [sessionId], 200], ["1=1", [], 2000]] as const) {
      const count = Number(this.sql.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get(...args)?.count ?? 0);
      if (count >= limit) throw new ApiError(429, "agent_team_storage_full", "Team control storage is full; clear an old completed team record");
    }
    for (const [predicate, args, limit] of [["user_id=?", [userId], 8 * 1024 * 1024], ["session_id=?", [sessionId], 16 * 1024 * 1024], ["1=1", [], 64 * 1024 * 1024]] as const) {
      const usage = Number(this.sql.prepare(`SELECT SUM(bytes) AS bytes FROM (SELECT bytes FROM agent_team_plans WHERE ${predicate} UNION ALL SELECT bytes FROM agent_team_runs WHERE ${predicate})`)
        .get(...args, ...args)?.bytes ?? 0);
      if (usage + bytes > limit) throw new ApiError(429, "agent_team_storage_full", "Team control storage is full; clear an old completed team record");
    }
  }
  prune() {
    // Preserve successful results from preview databases written before stamps
    // were recorded in the completion transaction, before dropping their cache.
    this.preserveCompletedTests();
    this.sql.prepare("DELETE FROM agent_team_runs WHERE status NOT IN ('running','paused') AND finished_at<=?")
      .run(new Date(this.clock().getTime() - 30 * 86400000).toISOString());
  }
}
