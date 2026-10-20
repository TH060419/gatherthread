import { AgentTeamDefinitionSchema, AgentTeamDraftSchema, AgentTeamFavoriteSchema, AgentTeamLibrarySchema,
  AgentTeamPlanSchema, SaveAgentTeamDefinitionSchema, SaveAgentTeamFavoriteSchema, ControlAgentTeamDefinitionSchema,
  TestAgentTeamDefinitionSchema, StartSavedAgentTeamSchema, type AgentTeamDefinition, type AgentTeamPlan,
  type SaveAgentTeamDefinition, type JsonValue } from "@gatherthread/protocol";
import type { Actor } from "./database.js";
import type { AgentTeams } from "./agent-teams.js";
import { teamAllowsDelegation } from "./agent-teams.js";
import { shareDigest, stableShareJson } from "./agent-sharing-store.js";
import { ApiError, conflict, forbidden, idempotencyConflict, notFound } from "./errors.js";
import { redactJson } from "./redaction.js";
import { AGENT_TEAM_REVISION_EPOCH } from "./agent-team-schema.js";

interface DefinitionRow { id: string; user_id: string; revision: number; config_json: string; enabled: number;
  tested_revision: number | null; test_run_id: string | null; test_session_id: string | null; updated_at: string }
type ResultRef = { kind: "team" | "favorite" | "deleted"; id: string; cancel_test_id?: string };
/** Account-private reusable configurations. Each execution separately rechecks the current session. */
export class AgentTeamLibrary {
  constructor(readonly teams: AgentTeams) {}
  get store() { return this.teams.store; }
  get sql() { return this.store.sql; }
  private active(actor: Actor) { this.store.service.database.assertActiveDevice(actor); }
  private own(actor: Actor, id: string): DefinitionRow {
    this.active(actor);
    const row = this.sql.prepare("SELECT * FROM agent_team_definitions WHERE id=? AND user_id=?").get(id, actor.user_id) as unknown as DefinitionRow | undefined;
    if (!row) throw notFound("Agent team configuration"); return row;
  }
  private safe(value: unknown) {
    if (stableShareJson(value) !== stableShareJson(redactJson(value as JsonValue))) throw new ApiError(400,
      "agent_team_sensitive_input", "Remove credentials from team configuration before saving");
  }
  private detail(row: DefinitionRow): AgentTeamDefinition {
    let status: AgentTeamDefinition["test_status"] = row.tested_revision === row.revision ? "passed" : "not_tested";
    if (row.test_run_id && status !== "passed") {
      const run = this.sql.prepare("SELECT status,purpose,user_id FROM agent_team_runs WHERE id=?").get(row.test_run_id);
      if (run?.purpose === "test" && run.user_id === row.user_id && run.status === "completed") {
        this.sql.prepare("UPDATE agent_team_definitions SET tested_revision=revision WHERE id=? AND revision=? AND test_run_id=?")
          .run(row.id, row.revision, row.test_run_id); row = { ...row, tested_revision: row.revision }; status = "passed";
      } else status = run?.status === "running" ? "running" : "failed";
    }
    const config = JSON.parse(row.config_json) as SaveAgentTeamDefinition;
    return AgentTeamDefinitionSchema.parse({ id: row.id, revision: row.revision, draft: config.draft,
      max_calls: config.max_calls, max_duration_minutes: config.max_duration_minutes, enabled: Boolean(row.enabled),
      tested_revision: row.tested_revision, test_run_id: row.test_run_id, test_session_id: row.test_session_id,
      test_status: status, updated_at: row.updated_at });
  }
  read(actor: Actor, id: string) { return this.detail(this.own(actor, id)); }
  list(actor: Actor) {
    this.active(actor);
    const teams = (this.sql.prepare("SELECT * FROM agent_team_definitions WHERE user_id=? ORDER BY rowid").all(actor.user_id) as unknown as DefinitionRow[])
      .map(row => this.detail(row));
    const modules = this.sql.prepare("SELECT id,module_json,created_at FROM agent_team_favorites WHERE user_id=? ORDER BY rowid").all(actor.user_id)
      .map(row => AgentTeamFavoriteSchema.parse({ id: row.id, module: JSON.parse(String(row.module_json)), created_at: row.created_at }));
    return AgentTeamLibrarySchema.parse({ teams, modules, team_limit: 5, module_limit: 5 });
  }
  private mutation(actor: Actor, key: string, input: unknown, action: () => ResultRef, emergency = false) {
    return this.store.transaction(() => {
      this.active(actor);
      const previous = this.sql.prepare("SELECT input_digest,result_json FROM agent_team_library_receipts WHERE user_id=? AND idempotency_key=?")
        .get(actor.user_id, key);
      if (previous) {
        if (previous.input_digest !== shareDigest(input)) throw idempotencyConflict("Team configuration retries must preserve the original action");
        return { ref: JSON.parse(String(previous.result_json)) as ResultRef, replayed: true };
      }
      this.sql.prepare("DELETE FROM agent_team_library_receipts WHERE created_at<=?")
        .run(new Date(this.store.clock().getTime() - 14 * 86400000).toISOString());
      const count = Number(this.sql.prepare("SELECT COUNT(*) AS n FROM agent_team_library_receipts WHERE user_id=?").get(actor.user_id)?.n);
      const total = Number(this.sql.prepare("SELECT COUNT(*) AS n FROM agent_team_library_receipts").get()?.n);
      if (count >= (emergency ? 1034 : 1024) || total >= (emergency ? 70536 : 65536)) throw new ApiError(429,
        "agent_team_storage_full", "Too many configuration changes; wait for receipt cleanup");
      const ref = action();
      this.sql.prepare("INSERT INTO agent_team_library_receipts(user_id,idempotency_key,input_digest,result_json,created_at) VALUES(?,?,?,?,?)")
        .run(actor.user_id, key, shareDigest(input), JSON.stringify(ref), this.store.now());
      return { ref, replayed: false };
    });
  }
  private nextRevision(actor: Actor) {
    // One bounded account clock prevents deleted/recreated IDs from recycling a
    // revision that an older browser still holds. This runs inside mutation().
    const row = this.sql.prepare(`INSERT INTO agent_team_revision_clocks(user_id,last_revision) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_revision=last_revision+1 RETURNING last_revision`)
      .get(actor.user_id, AGENT_TEAM_REVISION_EPOCH + 1)!;
    return Number(row.last_revision);
  }
  private fenceTest(actor: Actor, id: string | null | undefined) {
    if (!id) return undefined;
    const run = this.sql.prepare("SELECT user_id,purpose,status,current_step_id FROM agent_team_runs WHERE id=?").get(id);
    if (!run) return undefined;
    if (run.user_id !== actor.user_id || run.purpose !== "test") throw forbidden("Only your own connectivity test can be cancelled here");
    if (run.status === "running" || run.status === "paused") {
      this.store.settle(id, "stopped", "test_replaced");
      if (run.current_step_id) this.sql.prepare(`UPDATE agent_team_steps
        SET status=CASE WHEN status IN ('pending','running') THEN 'paused' ELSE status END,finished_at=COALESCE(finished_at,?) WHERE id=?`)
        .run(this.store.now(), run.current_step_id);
    }
    return id;
  }
  save(actor: Actor, id: string, raw: unknown) {
    const input = SaveAgentTeamDefinitionSchema.parse(raw); this.safe(input);
    const result = this.mutation(actor, input.idempotency_key, { id, save: input }, () => {
      const row = this.sql.prepare("SELECT * FROM agent_team_definitions WHERE id=?").get(id) as unknown as DefinitionRow | undefined;
      if (row && row.user_id !== actor.user_id) throw notFound("Agent team configuration");
      if ((row?.revision ?? null) !== input.expected_revision) throw conflict("Team configuration changed; refresh before saving");
      if (!row && Number(this.sql.prepare("SELECT COUNT(*) AS n FROM agent_team_definitions WHERE user_id=?").get(actor.user_id)?.n) >= 5) {
        throw new ApiError(409, "agent_team_limit", "You can save at most 5 Agent teams");
      }
      const config = JSON.stringify({ draft: input.draft, max_calls: input.max_calls, max_duration_minutes: input.max_duration_minutes });
      if (row?.config_json === config) return { kind: "team", id };
      const oldTest = this.fenceTest(actor, row?.test_run_id);
      const revision = this.nextRevision(actor);
      this.sql.prepare(`INSERT INTO agent_team_definitions(id,user_id,revision,config_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,enabled=0,
        tested_revision=NULL,test_run_id=NULL,test_session_id=NULL,updated_at=excluded.updated_at`)
        .run(id, actor.user_id, revision, config, this.store.now());
      return { kind: "team", id, ...(oldTest ? { cancel_test_id: oldTest } : {}) };
    });
    // The transaction already blocks claims/output. Retain the cleanup identity
    // in the receipt so a lost post-commit cancellation is retried with its ACK.
    if (result.ref.cancel_test_id) this.teams.stopPrivateTest(actor, result.ref.cancel_test_id);
    return { team: this.read(actor, id), replayed: result.replayed };
  }
  favorite(actor: Actor, id: string, raw: unknown) {
    const input = SaveAgentTeamFavoriteSchema.parse(raw); this.safe(input);
    const result = this.mutation(actor, input.idempotency_key, { id, favorite: input }, () => {
      if (this.sql.prepare("SELECT 1 FROM agent_team_favorites WHERE id=?").get(id)) throw conflict("Favorite ID already exists");
      if (Number(this.sql.prepare("SELECT COUNT(*) AS n FROM agent_team_favorites WHERE user_id=?").get(actor.user_id)?.n) >= 5) {
        throw new ApiError(409, "agent_team_favorite_limit", "You can favorite at most 5 modules");
      }
      this.sql.prepare("INSERT INTO agent_team_favorites(id,user_id,module_json,created_at) VALUES(?,?,?,?)")
        .run(id, actor.user_id, JSON.stringify(input.module), this.store.now()); return { kind: "favorite", id };
    });
    const favorite = this.list(actor).modules.find(item => item.id === result.ref.id);
    if (!favorite) throw notFound("Favorite module"); return { favorite, replayed: result.replayed };
  }
  delete(actor: Actor, kind: "team" | "favorite", id: string, key: string) {
    const result = this.mutation(actor, key, { delete: kind, id }, () => {
      let oldTest: string | undefined;
      if (kind === "team") { const row = this.own(actor, id); oldTest = this.fenceTest(actor, row.test_run_id);
        this.sql.prepare("DELETE FROM agent_team_definitions WHERE id=? AND user_id=?").run(id, actor.user_id);
      } else {
        if (!this.sql.prepare("SELECT 1 FROM agent_team_favorites WHERE id=? AND user_id=?").get(id, actor.user_id)) throw notFound("Favorite module");
        this.sql.prepare("DELETE FROM agent_team_favorites WHERE id=? AND user_id=?").run(id, actor.user_id);
      }
      return { kind: "deleted", id, ...(oldTest ? { cancel_test_id: oldTest } : {}) };
    });
    if (result.ref.cancel_test_id) this.teams.stopPrivateTest(actor, result.ref.cancel_test_id);
    return { deleted: true as const, replayed: result.replayed };
  }
  private checked(actor: Actor, id: string, revision: number, enabled = false) {
    const team = this.read(actor, id);
    if (team.revision !== revision) throw conflict("Team configuration changed; save and test the current configuration");
    if (enabled && (!team.enabled || team.tested_revision !== team.revision)) throw conflict("Test and enable this team before requesting it");
    return team;
  }
  private existingRun(actor: Actor, id: string, sessionId: string, key: string, purpose: "task" | "test", input: unknown) {
    this.store.authorize(actor, sessionId, true); this.store.prune();
    const run = this.sql.prepare("SELECT id,purpose,definition_id,library_request_digest FROM agent_team_runs WHERE user_id=? AND session_id=? AND idempotency_key=?")
      .get(actor.user_id, sessionId, key);
    if (!run) {
      const consumed = this.store.startReceipt(actor, sessionId, key);
      if (!consumed) return undefined;
      // Older canonical-only fences cannot establish an exact private input;
      // they still prove that this key cannot authorize another execution.
      if (consumed.input_digest && (consumed.definition_id !== id || consumed.purpose !== purpose
        || consumed.library_request_digest !== shareDigest(input))) throw idempotencyConflict("Retry the exact original team request");
      return this.store.clearedStart();
    }
    if (run.definition_id !== id || run.purpose !== purpose || run.library_request_digest !== shareDigest(input)) throw idempotencyConflict("Retry the exact original team request");
    return { ...this.teams.read(actor, sessionId, String(run.id)), replayed: true };
  }
  private bindRun(runId: string, id: string, revision: number, input: unknown) {
    this.sql.prepare("UPDATE agent_team_runs SET definition_id=?,definition_revision=?,library_request_digest=? WHERE id=?")
      .run(id, revision, shareDigest(input), runId);
  }
  private plan(team: AgentTeamDefinition): AgentTeamPlan {
    const draft = AgentTeamDraftSchema.parse(team.draft);
    if (!draft.nodes.length || draft.nodes.some(node => !node.target)) throw new ApiError(422,
      "agent_team_incomplete", "Choose an Agent, model and reasoning effort for every module");
    const plan = AgentTeamPlanSchema.parse(draft), reachable = new Set([plan.entry_node_id ?? plan.nodes[0]!.id]);
    for (let count = 0; count < plan.nodes.length; count++) for (const a of plan.nodes) if (reachable.has(a.id)) {
      for (const b of plan.nodes) if (teamAllowsDelegation(plan, a.id, b.id)) reachable.add(b.id);
    }
    if (reachable.size !== plan.nodes.length) throw new ApiError(422, "agent_team_disconnected", "Connect every module to the start module");
    return plan;
  }
  control(actor: Actor, id: string, sessionId: string, raw: unknown) {
    const input = ControlAgentTeamDefinitionSchema.parse(raw);
    const result = this.mutation(actor, input.idempotency_key, { id, control: input }, () => {
      const team = this.read(actor, id);
      if (input.enabled) {
        if (team.revision !== input.expected_revision || team.tested_revision !== team.revision) throw conflict("Test the saved configuration before enabling it");
        this.teams.validateTargets(actor, sessionId, this.plan(team), true);
      }
      const revision = this.nextRevision(actor);
      this.sql.prepare(`UPDATE agent_team_definitions SET enabled=?,updated_at=?,
        tested_revision=CASE WHEN tested_revision=revision THEN ? ELSE tested_revision END,revision=? WHERE id=?`)
        .run(Number(input.enabled), this.store.now(), revision, revision, id); return { kind: "team", id };
    }, !input.enabled);
    return { team: this.read(actor, id), replayed: result.replayed };
  }
  test(actor: Actor, id: string, sessionId: string, raw: unknown) {
    const input = TestAgentTeamDefinitionSchema.parse(raw), existing = this.existingRun(actor, id, sessionId, input.idempotency_key, "test", input);
    if (existing) return existing;
    const team = this.checked(actor, id, input.expected_revision), plan = this.plan(team);
    let oldTest: string | undefined;
    const result = this.teams.start(actor, sessionId, { plan, entry_node_id: plan.entry_node_id ?? plan.nodes[0]!.id,
      content: `Connectivity test for ${id} revision ${team.revision}; probe every module, then transfer source probe receipts along every configured direction.`,
      max_calls: plan.nodes.length + new Set(plan.edges.flatMap(edge => [edge.target,
        ...(edge.direction === "bidirectional" ? [edge.source] : [])])).size,
      max_duration_minutes: 12, idempotency_key: input.idempotency_key,
      content_revision: input.content_revision, solo_transfer_ack: input.solo_transfer_ack }, { purpose: "test", beforeCreate: () => {
      const current = this.checked(actor, id, input.expected_revision);
      if (current.test_status !== "passed") oldTest = this.fenceTest(actor, current.test_run_id);
    }, onCreated: run => {
      this.checked(actor, id, input.expected_revision);
      this.bindRun(run.id, id, input.expected_revision, input);
      this.sql.prepare("UPDATE agent_team_definitions SET enabled=0,tested_revision=NULL,test_run_id=?,test_session_id=? WHERE id=?")
        .run(run.id, sessionId, id);
    } });
    // Physical cleanup may publish a cancellation event. Do it only after the
    // replacement and old durable fence have committed together.
    if (oldTest) this.teams.stopPrivateTest(actor, oldTest);
    return result;
  }
  start(actor: Actor, id: string, sessionId: string, raw: unknown) {
    const input = StartSavedAgentTeamSchema.parse(raw), existing = this.existingRun(actor, id, sessionId, input.idempotency_key, "task", input);
    if (existing) return existing;
    const team = this.checked(actor, id, input.expected_revision, true), plan = this.plan(team);
    return this.teams.start(actor, sessionId, { plan, entry_node_id: plan.entry_node_id ?? plan.nodes[0]!.id,
      content: input.content, max_calls: team.max_calls, max_duration_minutes: team.max_duration_minutes,
      ...(input.reply_to_event_id === undefined ? {} : { reply_to_event_id: input.reply_to_event_id }),
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
      idempotency_key: input.idempotency_key, content_revision: input.content_revision, solo_transfer_ack: input.solo_transfer_ack }, {
      onCreated: run => { this.checked(actor, id, input.expected_revision, true); this.bindRun(run.id, id, input.expected_revision, input); },
    });
  }
}
