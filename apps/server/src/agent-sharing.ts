import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentShareExecutionCapsuleSchema, AgentShareJobSchema, JsonValueSchema, LiveOutputPayloadSchema,
  SaveAgentShareInputSchema, ControlAgentShareInputSchema, SharedAgentRequestInputSchema, SharedAgentMetadataSchema,
  CompleteAgentShareJobInputSchema, AgentShareJobProgressInputSchema, AbortAgentShareJobInputSchema,
  AgentShareJobLeaseInputSchema, ClaimAgentShareJobInputSchema, ReportAgentShareAvailabilityInputSchema,
  ReportAgentShareSourceAvailabilityInputSchema,
  type AgentShareExecutionCapsule, type SharedAgentMetadata, type SharedAgentProfile, type CanonicalEvent, type AgentShareJob,
  type AgentTeamRequestMetadata, type SharedAgentRequestInput, type SaveAgentShareInput, type ControlAgentShareInput,
  type AgentShareJobProgressInput, type CompleteAgentShareJobInput, type AbortAgentShareJobInput,
  type AgentShareJobLeaseInput, type ReportAgentShareAvailabilityInput, type ReportAgentShareSourceAvailabilityInput,
  type JsonValue } from "@gatherthread/protocol";
import type { CollaborationService } from "./service.js";
import type { Actor } from "./database.js";
import { AgentSharingStore, shareDigest, stableShareJson, type ShareRow, type SharedJobRow } from "./agent-sharing-store.js";
import { ApiError, conflict, forbidden, idempotencyConflict, notFound } from "./errors.js";
import { redactJson } from "./redaction.js";

export const AGENT_SHARE_LEASE_MS = 15000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const SharedFinalAnswerSchema = z.object({ content: z.string().max(65536).optional(), text: z.string().max(65536).optional(),
  status: z.literal("completed").optional(), capture_fidelity: z.literal("harness_transcript").optional(),
  source_harness: z.enum(["codex", "deepseek-harness"]).optional() }).strict()
  .refine(value => Boolean(value.content?.trim() || value.text?.trim()), "A completed shared answer must contain public text");
const SharedLifecycleSchema = z.object({ content: z.string().max(256), phase: z.literal("lifecycle"),
  status: z.enum(["thinking", "running"]) }).strict();
export interface SharedTeamReservation { metadata: AgentTeamRequestMetadata; onAccepted: (event: CanonicalEvent) => void;
  deadlineAt?: string }

/** Sharing never grants the native owner general writes to the requester's session. */
export class AgentSharing {
  readonly store: AgentSharingStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly service: CollaborationService, options: { clock?: () => Date; autoStart?: boolean; recover?: boolean } = {}) {
    this.store = new AgentSharingStore(service, options.clock);
    if (options.recover !== false) {
      this.store.transaction(() => {
        for (const row of this.store.sql.prepare("SELECT * FROM agent_shares WHERE enabled=1").all() as unknown as ShareRow[]) this.store.disable(row, "restart");
      });
      this.pump();
    }
    if (options.autoStart !== false) { this.timer = setInterval(() => { try { this.pump(); } catch { /* Grant checks at every boundary fail closed. */ } }, 500); this.timer.unref(); }
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  list(actor: Actor, projectId: string) { this.pump(); return this.store.list(actor, projectId); }
  sources(actor: Actor, projectId: string) {
    this.store.project(actor, projectId, true);
    const rows = this.store.sql.prepare(`SELECT r.id FROM runtimes r JOIN sessions s ON s.id=r.session_id
      WHERE s.project_id=? AND r.user_id=? AND r.purpose='execution' AND r.status!='revoked' AND s.state='active'
      ORDER BY r.last_seen_at DESC,r.id LIMIT 128`).all(projectId, actor.user_id);
    const runtimes = rows.flatMap(row => {
      try {
        const runtime = this.service.database.getRuntime(String(row.id));
        this.service.requireSharedAgentWrite({ ...actor, device_id: runtime.device_id }, runtime.session_id);
        const capability = this.store.sql.prepare("SELECT availability FROM agent_share_runtime_capabilities WHERE runtime_id=?").get(runtime.id);
        return [{ id: runtime.id, session_id: runtime.session_id, device_id: runtime.device_id, purpose: runtime.purpose,
          harness: runtime.harness, provider: runtime.provider, model: runtime.model,
          status: this.store.clock().getTime() - Date.parse(runtime.last_seen_at) > 30000 ? "offline" as const : runtime.status,
          ...(runtime.execution_profiles === undefined ? {} : { execution_profiles: runtime.execution_profiles }),
          ...(runtime.context_deletion_version === undefined ? {} : { context_deletion_version: runtime.context_deletion_version }),
          ...(runtime.sharing_capability === undefined ? {} : { sharing_capability: runtime.sharing_capability }),
          ...(capability ? { sharing_availability: String(capability.availability) as "ready" | "locked" | "offline" | "unsupported" } : {}) }];
      } catch { return []; }
    });
    return { runtimes };
  }
  save(actor: Actor, projectId: string, raw: SaveAgentShareInput) {
    const input = SaveAgentShareInputSchema.parse(raw), result = this.store.save(actor, projectId, input);
    this.pump(); return { ...result, share: this.store.detail(actor, this.store.row(result.share.id)) };
  }
  control(actor: Actor, projectId: string, id: string, raw: ControlAgentShareInput) {
    const result = this.store.control(actor, projectId, id, ControlAgentShareInputSchema.parse(raw));
    this.pump(); return { ...result, share: this.store.detail(actor, this.store.row(id)) };
  }
  validateSelection(actor: Actor, sessionId: string,
    target: { share_id: string; share_revision: number } & SharedAgentProfile, requireOnline = true) {
    const session = this.service.requireSharedAgentWrite(actor, sessionId).session;
    const row = this.store.row(target.share_id);
    if (row.project_id !== session.project_id || row.revision !== target.share_revision || !row.enabled) throw new ApiError(409,
      "agent_share_revoked", "Reload the shared Agent selection: its grant changed or is disabled");
    this.store.assertGrant(row, actor, requireOnline);
    this.store.source({ user_id: row.owner_user_id, device_id: row.owner_device_id, display_name: "" },
      row.project_id, row.source_runtime_id, { harness: target.harness, provider: target.provider, model: target.model,
        ...(target.reasoning_effort === undefined ? {} : { reasoning_effort: target.reasoning_effort }) }, requireOnline);
    return this.store.detail(actor, row);
  }
  start(actor: Actor, sessionId: string, raw: SharedAgentRequestInput, team?: SharedTeamReservation) {
    const input = SharedAgentRequestInputSchema.parse(raw);
    if (stableShareJson(redactJson(input as unknown as JsonValue)) !== stableShareJson(input)) throw new ApiError(400,
      "agent_share_sensitive_input", "Remove credentials before requesting a shared Agent");
    const session = this.service.requireSharedAgentWrite(actor, sessionId).session;
    if (session.state !== "active") throw conflict("Archived conversations cannot request shared Agents");
    if (session.mode === "solo" && !input.solo_transfer_ack) throw new ApiError(400, "agent_share_solo_disclosure_required",
      "Confirm that this Solo task and its conversation context will be sent to the sharing member's device");
    const digest = team ? shareDigest({ input, team: team.metadata, deadline: team.deadlineAt ?? null }) : shareDigest(input);
    // Derived context is bounded and current-authorized. Freeze its sequence; acceptance rechecks erasure revision.
    const context = team?.metadata.purpose === "test"
      ? { view: "original" as const, through_sequence: session.next_sequence, content_revision: session.content_revision ?? 0, items: [] }
      : this.service.readHistoryContext(actor, sessionId);
    const quoted = input.reply_to_event_id ? this.quotedMessage(sessionId, input.reply_to_event_id) : undefined;
    const contextJson = JSON.stringify(context);
    if (Buffer.byteLength(contextJson) > 262144 || Buffer.byteLength(contextJson) + Buffer.byteLength(JSON.stringify(quoted ?? null))
      + Buffer.byteLength(input.content) + 4096 > 294912) throw new ApiError(413, "agent_share_context_too_large", "The shared execution context exceeds its bound");
    const result = this.store.transaction(() => {
      this.service.database.assertActiveDevice(actor);
      const current = this.service.requireSharedAgentWrite(actor, sessionId).session;
      const previous = this.store.sql.prepare("SELECT * FROM agent_share_jobs WHERE session_id=? AND requester_user_id=? AND idempotency_key=?")
        .get(sessionId, actor.user_id, input.idempotency_key) as unknown as SharedJobRow | undefined;
      if (previous) {
        if (previous.input_digest !== digest) throw idempotencyConflict("Shared Agent retry must preserve its task and grant");
        return { job: this.store.summary(previous), event: this.service.database.getEvent(sessionId, previous.request_event_id), replayed: true };
      }
      if ((current.content_revision ?? 0) !== input.content_revision || (context.content_revision ?? 0) !== input.content_revision) {
        throw new ApiError(409, "context_changed", "Refresh before requesting the shared Agent");
      }
      const row = this.store.row(input.share_id);
      if (row.project_id !== current.project_id || row.revision !== input.share_revision || !row.enabled) throw new ApiError(409,
        "agent_share_revoked", "The shared Agent grant changed or is disabled");
      this.store.assertGrant(row, actor);
      // Legacy callers keep their saved exact default; a catalog edit must not
      // silently turn an omitted selection into another model/provider.
      const profile = input.execution_profile ?? this.store.profile(row);
      this.store.source({ user_id: row.owner_user_id, device_id: row.owner_device_id, display_name: "" },
        row.project_id, row.source_runtime_id, profile);
      const sourceQueued = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_jobs WHERE source_runtime_id=? AND (status IN ('queued','running') OR cleanup_pending=1)")
        .get(row.source_runtime_id)?.count ?? 0);
      const userCount = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_jobs WHERE requester_user_id=? AND created_at>=?")
        .get(actor.user_id, new Date(this.store.clock().getTime() - 14 * 86400000).toISOString())?.count ?? 0);
      const totalCount = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_jobs").get()?.count ?? 0);
      const activeCount = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_jobs WHERE status IN ('queued','running') OR cleanup_pending=1").get()?.count ?? 0);
      if (sourceQueued >= 32 || userCount >= 512 || totalCount >= 4096 || activeCount >= 128) throw new ApiError(429, "agent_share_storage_full", "Shared execution storage or queue capacity is full");
      const limits = this.store.limits(row), id = `shared-job-${randomUUID()}`, eventId = randomUUID();
      this.store.reserve(row, actor);
      const requestDeadline = new Date(this.store.clock().getTime() + limits.max_request_seconds * 1000).toISOString();
      if (team?.deadlineAt && (!Number.isFinite(Date.parse(team.deadlineAt)) || team.deadlineAt <= this.store.now())) throw conflict("The team execution deadline has elapsed");
      const deadline = team?.deadlineAt && team.deadlineAt < requestDeadline ? team.deadlineAt : requestDeadline;
      this.store.sql.prepare(`INSERT INTO agent_share_jobs(id,project_id,share_id,share_revision,owner_user_id,owner_device_id,source_runtime_id,
        requester_user_id,requester_device_id,requester_display_name,session_id,request_event_id,idempotency_key,input_digest,
        content_revision,through_sequence,content,context_json,context_digest,profile_json,max_request_seconds,status,utc_day,
        created_at,deadline_at,seconds_reserved) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`)
        .run(id, row.project_id, row.id, row.revision, row.owner_user_id, row.owner_device_id, row.source_runtime_id,
          actor.user_id, actor.device_id, actor.display_name, sessionId, eventId, input.idempotency_key, digest, input.content_revision,
          context.through_sequence, input.content, contextJson, shareDigest(context), JSON.stringify(profile), limits.max_request_seconds,
          this.store.now().slice(0, 10), this.store.now(), deadline, limits.max_request_seconds);
      const job = this.store.job(id), metadata = this.metadata(job);
      const event = this.service.database.appendSharedBrokerEventInsideTransaction(id, { event_id: eventId,
        idempotency_key: input.idempotency_key, type: "agent_request", visibility: "session", content_revision: input.content_revision,
        ...(input.reply_to_event_id === undefined ? {} : { reply_to_event_id: input.reply_to_event_id }),
        payload: { content: input.content, shared_agent: metadata as unknown as JsonValue,
          ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
          ...(team ? { agent_team: team.metadata as unknown as JsonValue } : {}) } });
      team?.onAccepted(event);
      return { job: this.store.summary(job), event, replayed: false };
    });
    if (!result.replayed) this.service.publishSharedAgentEvents([result.event]);
    return result;
  }
  private metadata(job: SharedJobRow): SharedAgentMetadata {
    const request = this.store.sql.prepare("SELECT payload_json FROM events WHERE id=? AND deleted_at IS NULL").get(job.request_event_id);
    if (request) {
      const known = SharedAgentMetadataSchema.safeParse((JSON.parse(String(request.payload_json)) as { shared_agent?: unknown }).shared_agent);
      if (known.success) return known.data;
    }
    const identity = this.store.sql.prepare("SELECT display_name FROM users WHERE id=?").get(job.owner_user_id);
    return { share_id: job.share_id, share_revision: job.share_revision, job_id: job.id,
      executor_owner_user_id: job.owner_user_id, executor_owner_display_name: String(identity?.display_name ?? "Member"), execution_profile: this.store.profile(job) };
  }
  listJobs(actor: Actor, projectId: string) {
    this.pump(); this.service.database.assertActiveDevice(actor);
    // A removed participant still needs content-free cancellation/exit instructions.
    const jobs = this.store.sql.prepare(`SELECT * FROM agent_share_jobs WHERE owner_user_id=? AND owner_device_id=? AND project_id=?
      AND (status IN ('queued','running') OR cleanup_pending=1) ORDER BY created_at,id LIMIT 64`)
      .all(actor.user_id, actor.device_id, projectId) as unknown as SharedJobRow[];
    return { jobs: jobs.map(job => this.store.summary(job)) };
  }
  private capsule(job: SharedJobRow): AgentShareExecutionCapsule {
    const request = this.service.database.getEvent(job.session_id, job.request_event_id);
    const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
    const capsule = AgentShareExecutionCapsuleSchema.parse({ version: 1, job: this.store.summary(job), source_runtime_id: job.source_runtime_id,
      owner_device_id: job.owner_device_id, content: job.content, context: JSON.parse(job.context_json), context_digest: job.context_digest,
      content_revision: job.content_revision, through_sequence: job.through_sequence, claim_attempt: job.claim_attempt,
      lease_expires_at: job.lease_expires_at, deadline_at: job.deadline_at, max_request_seconds: job.max_request_seconds, sandbox_scope: "project_only",
      reply_to_event_id: request.reply_to_event_id, ...(payload.mentions === undefined ? {} : { mentions: payload.mentions }),
      ...(request.reply_to_event_id ? { quoted_message: this.quotedMessage(job.session_id, request.reply_to_event_id) } : {}) });
    if (Buffer.byteLength(JSON.stringify(capsule)) > 294912) throw new ApiError(413, "agent_share_context_too_large", "The execution capsule exceeds its bound");
    return capsule;
  }
  private quotedMessage(sessionId: string, eventId: string) {
    const quote = this.service.database.getEvent(sessionId, eventId);
    if (quote.deleted) throw new ApiError(409, "message_deleted", "The quoted message was deleted; select another message");
    if (quote.visibility !== "session") throw forbidden("Shared requests cannot quote private history");
    const payload = quote.payload && typeof quote.payload === "object" && !Array.isArray(quote.payload) ? quote.payload : undefined;
    const content = typeof payload?.content === "string" ? payload.content : typeof payload?.text === "string" ? payload.text : "";
    const safe = redactJson(content) as string;
    if (Buffer.byteLength(safe) > 65536) throw new ApiError(413, "agent_share_context_too_large", "The quoted public source exceeds its transport bound");
    return { event_id: quote.id, sequence: quote.sequence, actor_user_id: quote.actor_user_id, content: safe };
  }
  claim(actor: Actor, id: string, raw: { idempotency_key: string }) {
    const input = ClaimAgentShareJobInputSchema.parse(raw); this.pump();
    return this.store.transaction(() => {
      let job = this.store.ownedJob(actor, id);
      if (job.status === "running" && job.claim_key === input.idempotency_key) {
        this.store.assertAttempt(job, job.claim_attempt); return { job: this.store.summary(job), capsule: this.capsule(job), replayed: true };
      }
      if (job.status !== "queued") throw conflict("This shared request is not queued");
      const row = this.store.assertJob(job), limits = this.store.limits(row);
      const running = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_jobs WHERE share_id=? AND (status='running' OR cleanup_pending=1)")
        .get(row.id)?.count ?? 0);
      const poolBusy = this.store.sql.prepare(`SELECT 1 FROM agent_share_jobs j WHERE j.project_id=? AND j.owner_device_id=?
        AND json_extract(j.profile_json,'$.harness')=? AND (j.status='running' OR j.cleanup_pending=1) LIMIT 1`)
        .get(job.project_id, job.owner_device_id, this.store.profile(job).harness);
      const ordinaryBusy = this.store.sql.prepare(`SELECT 1 FROM agent_request_claims c JOIN runtimes r ON r.id=c.runtime_id
        JOIN events e ON e.id=c.request_event_id JOIN sessions s ON s.id=e.session_id WHERE r.device_id=? AND r.harness=? AND s.project_id=?
        AND (c.execution_pending=1 OR (c.status='claimed' AND (c.lease_expires_at IS NULL OR c.lease_expires_at>?))) LIMIT 1`)
        .get(job.owner_device_id, this.store.profile(job).harness, job.project_id, this.store.now());
      const detachedBusy = this.store.sql.prepare(`SELECT 1 FROM agent_native_exit_holds
        WHERE owner_device_id=? AND harness=? AND (origin_verified=0 OR project_id=?) LIMIT 1`)
        .get(job.owner_device_id, this.store.profile(job).harness, job.project_id);
      if (running >= limits.max_concurrent || poolBusy || ordinaryBusy || detachedBusy) throw new ApiError(409, "agent_share_busy", "The native Agent is already executing work");
      const start = this.store.now(), ownDeadline = new Date(this.store.clock().getTime() + job.max_request_seconds * 1000).toISOString();
      const deadline = job.deadline_at && job.deadline_at < ownDeadline ? job.deadline_at : ownDeadline;
      const lease = new Date(Math.min(Date.parse(deadline), this.store.clock().getTime() + AGENT_SHARE_LEASE_MS)).toISOString();
      this.store.sql.prepare("UPDATE agent_share_jobs SET status='running',claim_attempt=1,claim_key=?,started_at=?,deadline_at=?,lease_expires_at=?,cleanup_pending=1 WHERE id=?")
        .run(input.idempotency_key, start, deadline, lease, id);
      job = this.store.job(id); return { job: this.store.summary(job), capsule: this.capsule(job), replayed: false };
    });
  }
  renewLease(actor: Actor, id: string, raw: AgentShareJobLeaseInput) {
    const input = AgentShareJobLeaseInputSchema.parse(raw); this.pump();
    return this.store.transaction(() => {
      const job = this.store.ownedJob(actor, id); this.store.assertAttempt(job, input.claim_attempt);
      const lease = new Date(Math.min(Date.parse(job.deadline_at!), this.store.clock().getTime() + AGENT_SHARE_LEASE_MS)).toISOString();
      this.store.sql.prepare("UPDATE agent_share_jobs SET lease_expires_at=? WHERE id=?").run(lease, id);
      return { job: this.store.summary(this.store.job(id)), lease_expires_at: lease, deadline_at: job.deadline_at! };
    });
  }
  private eventReceipt(job: SharedJobRow, key: string, input: unknown) {
    const row = this.store.sql.prepare("SELECT * FROM agent_share_job_receipts WHERE job_id=? AND idempotency_key=?").get(job.id, key);
    if (!row) return undefined;
    if (row.input_digest !== shareDigest(input)) throw idempotencyConflict("Shared output retry must preserve its content and attempt");
    return row;
  }
  private rememberEvent(job: SharedJobRow, key: string, input: unknown, eventId: string | null, terminal = false) {
    const count = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_job_receipts WHERE job_id=?").get(job.id)?.count ?? 0);
    if (count >= (terminal ? 256 : 254)) throw new ApiError(429, "agent_share_progress_limit", "This shared execution has reached its publication limit");
    this.store.sql.prepare("INSERT INTO agent_share_job_receipts(job_id,idempotency_key,input_digest,event_id,created_at) VALUES(?,?,?,?,?)")
      .run(job.id, key, shareDigest(input), eventId, this.store.now());
  }
  private rememberControl(job: SharedJobRow, key: string, input: unknown, eventId: string | null, emergency: boolean) {
    const count = Number(this.store.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_job_receipts WHERE job_id=?").get(job.id)?.count ?? 0);
    if (count >= 256 && !emergency || count >= 258) throw new ApiError(429, "agent_share_progress_limit", "Shared execution receipt capacity is full");
    this.store.sql.prepare("INSERT INTO agent_share_job_receipts(job_id,idempotency_key,input_digest,event_id,created_at) VALUES(?,?,?,?,?)")
      .run(job.id, key, shareDigest(input), eventId, this.store.now());
  }
  private outputPayload(job: SharedJobRow, raw: unknown, completed: boolean): JsonValue {
    const payload = JsonValueSchema.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError(400, "validation_error", "Shared output must be an object");
    if (payload.shared_agent !== undefined || payload.agent_team !== undefined || payload.history_summary !== undefined
      || payload.continue_from_event_id !== undefined) throw forbidden("Native shared output cannot forge server metadata");
    if (completed) SharedFinalAnswerSchema.parse(payload);
    else z.union([LiveOutputPayloadSchema, SharedLifecycleSchema]).parse(payload);
    const safe = redactJson(payload);
    if (Buffer.byteLength(JSON.stringify(safe)) > 65536) throw new ApiError(413, "agent_share_output_too_large", "The shared output exceeds its bound");
    return { ...(safe as Record<string, JsonValue>), shared_agent: this.metadata(job) as unknown as JsonValue };
  }
  private checkObserved(job: SharedJobRow, model: string, effort?: string) {
    const profile = this.store.profile(job);
    if (model !== profile.model || effort !== profile.reasoning_effort) throw new ApiError(409, "agent_share_profile_changed", "The executed model or effort differs from the granted profile");
  }
  progress(actor: Actor, id: string, raw: AgentShareJobProgressInput) {
    const input = AgentShareJobProgressInputSchema.parse(raw); this.pump();
    const result = this.store.transaction(() => {
      const job = this.store.ownedJob(actor, id), previous = this.eventReceipt(job, input.idempotency_key, input);
      if (previous && previous.event_id) return { event: this.service.database.getEvent(job.session_id, String(previous.event_id)), job: this.store.summary(job), replayed: true };
      this.store.assertAttempt(job, input.claim_attempt); this.checkObserved(job, input.observed_model, input.observed_reasoning_effort);
      const payload = this.outputPayload(job, input.payload, false);
      const event = this.service.database.appendSharedBrokerEventInsideTransaction(id, { type: "agent_progress", visibility: "session",
        idempotency_key: `shared-output:${shareDigest({ id, key: input.idempotency_key })}`, reply_to_event_id: job.request_event_id, payload },
        this.provenance(job, input.observed_model, input.observed_reasoning_effort));
      this.rememberEvent(job, input.idempotency_key, input, event.id);
      return { event, job: this.store.summary(job), replayed: false };
    });
    if (!result.replayed) this.service.publishSharedAgentEvents([result.event]); return result;
  }
  complete(actor: Actor, id: string, raw: CompleteAgentShareJobInput) {
    const input = CompleteAgentShareJobInputSchema.parse(raw); this.pump();
    let result: { event: CanonicalEvent; job: AgentShareJob; replayed: boolean };
    try { result = this.store.transaction(() => {
      const job = this.store.ownedJob(actor, id), previous = this.eventReceipt(job, input.idempotency_key, input);
      if (previous && previous.event_id) return { event: this.service.database.getEvent(job.session_id, String(previous.event_id)), job: this.store.summary(job), replayed: true };
      this.store.assertAttempt(job, input.claim_attempt); this.checkObserved(job, input.observed_model, input.observed_reasoning_effort);
      if (input.outcome !== "completed") {
        this.finish(job, input.outcome, input.outcome === "timed_out" ? "agent_share_timeout" : "agent_share_execution_failed", true);
        const settled = this.store.job(id), event = this.service.database.getEvent(job.session_id, settled.response_event_id!);
        this.rememberEvent(job, input.idempotency_key, input, event.id, true);
        return { event, job: this.store.summary(settled), replayed: false };
      }
      const payload = this.outputPayload(job, input.payload, true);
      const event = this.service.database.appendSharedBrokerEventInsideTransaction(id, { type: "agent_response", visibility: "session",
        idempotency_key: `shared-output:${shareDigest({ id, key: input.idempotency_key })}`, reply_to_event_id: job.request_event_id, payload },
        this.provenance(job, input.observed_model, input.observed_reasoning_effort));
      this.rememberEvent(job, input.idempotency_key, input, event.id, true);
      this.store.sql.prepare("UPDATE agent_share_jobs SET status='completed',response_event_id=?,finished_at=?,lease_expires_at=NULL,content='',context_json='{}' WHERE id=?")
        .run(event.id, this.store.now(), id);
      this.store.release(job, this.elapsed(job));
      return { event, job: this.store.summary(this.store.job(id)), replayed: false };
    }); } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "storage_quota_exceeded") throw error;
      // The model answer rolls back first. Confirmed native exit can then commit
      // exactly one bounded failure marker without leaving the executor slot stuck.
      result = this.store.transaction(() => {
        const job = this.store.ownedJob(actor, id); this.store.assertAttempt(job, input.claim_attempt);
        this.finish(job, "failed", "storage_quota_exceeded", true);
        const settled = this.store.job(id), event = this.service.database.getEvent(job.session_id, settled.response_event_id!);
        this.rememberEvent(job, input.idempotency_key, input, event.id, true);
        return { event, job: this.store.summary(settled), replayed: false };
      });
    }
    if (!result.replayed) this.service.publishSharedAgentEvents([result.event]); return result;
  }
  private elapsed(job: SharedJobRow) {
    return job.started_at ? Math.max(0, (this.store.clock().getTime() - Date.parse(job.started_at)) / 1000) : 0;
  }
  private provenance(job: SharedJobRow, model: string, effort?: string) {
    const source = this.service.database.getRuntime(job.source_runtime_id);
    const { runtime_id: _sourceRuntimeId, ...identity } = this.service.database.runtimeProvenance(source);
    // The source identifies a configured connection, not this fresh private
    // shared native projection. Never invent or borrow its ordinary runtime ID.
    return { ...identity, provider: this.store.profile(job).provider, model, capture_fidelity: "harness_transcript" as const,
      ...(effort === undefined ? {} : { reasoning_effort: effort }) };
  }
  private finish(job: SharedJobRow, status: "cancelled" | "failed" | "timed_out", code: string, stopped = false): CanonicalEvent | undefined {
    if (TERMINAL.has(job.status) && (job.status === "completed" || job.response_event_id)) return undefined;
    if (!TERMINAL.has(job.status)) {
      this.store.sql.prepare("UPDATE agent_share_jobs SET status=?,error_code=?,finished_at=?,lease_expires_at=NULL,content='',context_json='{}',cleanup_pending=? WHERE id=?")
        .run(status, code, this.store.now(), job.status === "running" && !stopped ? 1 : 0, job.id);
      if (job.status === "queued" || stopped) this.store.release(job, this.elapsed(job));
    }
    const request = this.store.sql.prepare("SELECT deleted_at FROM events WHERE id=?").get(job.request_event_id);
    const existing = this.store.sql.prepare("SELECT id FROM events WHERE reply_to_event_id=? AND type='agent_response' AND deleted_at IS NULL ORDER BY sequence LIMIT 1").get(job.request_event_id);
    if (existing) { this.store.sql.prepare("UPDATE agent_share_jobs SET response_event_id=? WHERE id=?").run(String(existing.id), job.id); return undefined; }
    if (!request || request.deleted_at !== null || !this.store.sql.prepare("SELECT 1 FROM sessions WHERE id=?").get(job.session_id)) {
      this.store.sql.prepare("UPDATE agent_share_jobs SET response_event_id='unavailable' WHERE id=?").run(job.id);
      return undefined;
    }
    const event = this.service.database.appendSharedBrokerEventInsideTransaction(job.id, { type: "agent_response", visibility: "session",
      idempotency_key: `server:shared-terminal:${randomUUID()}`, reply_to_event_id: job.request_event_id,
      payload: { content: "This shared Agent request ended.", status: "failed", outcome: status, error: { code } } }, null, true);
    this.store.sql.prepare("UPDATE agent_share_jobs SET response_event_id=? WHERE id=?").run(event.id, job.id); return event;
  }
  abortAck(actor: Actor, id: string, raw: AbortAgentShareJobInput) {
    const input = AbortAgentShareJobInputSchema.parse(raw); this.pump();
    return this.store.transaction(() => {
      const job = this.store.ownedJob(actor, id, true), previous = this.eventReceipt(job, input.idempotency_key, input);
      if (previous) return { job: this.store.summary(job), replayed: true };
      if (!TERMINAL.has(job.status) || job.claim_attempt !== input.claim_attempt) throw conflict("Only the exact cancelled executor may acknowledge cleanup");
      this.store.release(job, this.elapsed(job));
      // Cleanup is prepaid and cannot be blocked by saturated progress receipts.
      this.rememberControl(job, input.idempotency_key, input, null, Boolean(job.cleanup_pending));
      return { job: this.store.summary(this.store.job(id)), replayed: false };
    });
  }
  cancelRequest(actor: Actor, sessionId: string, requestEventId: string, input: { idempotency_key: string }) {
    ClaimAgentShareJobInputSchema.parse(input);
    const events: CanonicalEvent[] = [];
    const result = this.store.transaction(() => {
      this.service.requireSharedAgentWrite(actor, sessionId); this.service.database.assertActiveDevice(actor);
      const job = this.store.sql.prepare("SELECT * FROM agent_share_jobs WHERE session_id=? AND request_event_id=? AND requester_user_id=?")
        .get(sessionId, requestEventId, actor.user_id) as unknown as SharedJobRow | undefined;
      if (!job) throw notFound("Shared Agent request");
      const previous = this.eventReceipt(job, input.idempotency_key, { action: "cancel", ...input });
      if (previous) return { job: this.store.summary(job), replayed: true };
      if (!TERMINAL.has(job.status)) { const event = this.finish(job, "cancelled", "agent_share_request_cancelled"); if (event) events.push(event); }
      this.rememberControl(job, input.idempotency_key, { action: "cancel", ...input }, events[0]?.id ?? null, !TERMINAL.has(job.status));
      return { job: this.store.summary(this.store.job(job.id)), replayed: false };
    });
    this.service.publishSharedAgentEvents(events); return result;
  }
  availability(actor: Actor, id: string, raw: ReportAgentShareAvailabilityInput) {
    const input = ReportAgentShareAvailabilityInputSchema.parse(raw), selected = this.store.row(id);
    if (selected.owner_user_id !== actor.user_id || selected.owner_device_id !== actor.device_id) throw notFound("Shared Agent");
    return this.sourceAvailability(actor, { project_id: selected.project_id, source_runtime_id: selected.source_runtime_id,
      ...input });
  }
  sourceAvailability(actor: Actor, raw: ReportAgentShareSourceAvailabilityInput) {
    const input = ReportAgentShareSourceAvailabilityInputSchema.parse(raw), events: CanonicalEvent[] = [];
    const result = this.store.transaction(() => {
      this.service.database.assertActiveDevice(actor);
      const runtime = this.service.database.getRuntime(input.source_runtime_id);
      if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id || runtime.purpose !== "execution") throw notFound("Sharing source");
      const session = this.service.database.requireSession(runtime.session_id);
      if (session.project_id !== input.project_id) throw notFound("Sharing source");
      // Stop remains available after a role or source capability is removed. Ready
      // still requires the exact current writable source and native capability.
      if (input.state === "ready") this.store.sourceRuntime(actor, input.project_id, runtime.id);
      const rows = this.store.sql.prepare(`SELECT * FROM agent_shares WHERE owner_user_id=? AND owner_device_id=?
        AND ${input.state === "locked" ? "1=1" : "source_runtime_id=?"}`)
        .all(actor.user_id, actor.device_id, ...(input.state === "locked" ? [] : [runtime.id])) as unknown as ShareRow[];
      const prior = this.store.sql.prepare("SELECT input_digest FROM agent_share_source_receipts WHERE runtime_id=? AND idempotency_key=?")
        .get(runtime.id, input.idempotency_key);
      if (prior) {
        if (prior.input_digest !== shareDigest(input)) throw idempotencyConflict("Native availability retry must preserve its original state");
        return { shares: rows.map(row => this.store.detail(actor, row)) };
      }
      const counts = this.store.sql.prepare(`SELECT
        (SELECT COUNT(*) FROM agent_share_source_receipts WHERE runtime_id=?) AS source_count,
        (SELECT COUNT(*) FROM agent_share_source_receipts WHERE owner_user_id=?) AS owner_count,
        (SELECT COUNT(*) FROM agent_share_source_receipts) AS host_count`).get(runtime.id, actor.user_id)!;
      const full = Number(counts.source_count) >= 1024 || Number(counts.owner_count) >= 8192 || Number(counts.host_count) >= 65536;
      if (full && input.state === "ready") throw new ApiError(429, "agent_share_source_capacity", "Native sharing availability capacity is full; reconnect a fresh source");
      if (full) {
        // A saturated receipt store can never block an emergency stop. The
        // durable barrier forbids ready/re-enable for this source thereafter.
        this.store.sql.prepare("INSERT OR IGNORE INTO agent_share_source_barriers(runtime_id) VALUES(?)").run(runtime.id);
      } else this.store.sql.prepare(`INSERT INTO agent_share_source_receipts(runtime_id,owner_user_id,idempotency_key,input_digest,created_at)
        VALUES(?,?,?,?,?)`).run(runtime.id, actor.user_id, input.idempotency_key, shareDigest(input), this.store.now());
      this.store.sql.prepare(`UPDATE agent_share_runtime_capabilities SET availability=?,updated_at=? WHERE runtime_id IN
        (SELECT id FROM runtimes WHERE user_id=? AND device_id=? AND ${input.state === "locked" ? "1=1" : "id=?"})`)
        .run(input.state, this.store.now(), actor.user_id, actor.device_id, ...(input.state === "locked" ? [] : [runtime.id]));
      for (const row of rows) {
        if (input.state !== "ready") {
          this.store.disable(row, input.state);
          for (const key of this.store.sql.prepare("SELECT id FROM agent_share_jobs WHERE share_id=? AND status IN ('queued','running')")
            .all(row.id)) { const event = this.finish(this.store.job(String(key.id)), "cancelled", `agent_share_${input.state}`); if (event) events.push(event); }
        }
      }
      return { shares: rows.map(row => this.store.detail(actor, this.store.row(row.id))) };
    });
    this.service.publishSharedAgentEvents(events); return result;
  }
  pump() {
    const events: CanonicalEvent[] = [];
    this.store.transaction(() => {
      for (const row of this.store.sql.prepare("SELECT * FROM agent_shares WHERE enabled=1").all() as unknown as ShareRow[]) {
        try { this.store.assertGrant(row); }
        catch (error) { this.store.disable(row, error instanceof ApiError && error.code === "agent_share_offline" ? "offline" : "access_changed"); }
      }
      for (const key of this.store.sql.prepare("SELECT id FROM agent_share_jobs WHERE status IN ('queued','running')").all()) {
        const job = this.store.job(String(key.id));
        let code: string | undefined;
        try { this.store.assertJob(job); } catch (error) { code = error instanceof ApiError ? error.code : "agent_share_revoked"; }
        const timedOut = job.deadline_at !== null && job.deadline_at <= this.store.now();
        if (!code && !timedOut && job.status === "running" && (!job.lease_expires_at || job.lease_expires_at <= this.store.now())) {
          code = "agent_share_lease_expired";
          const row = this.store.sql.prepare("SELECT * FROM agent_shares WHERE id=?").get(job.share_id) as unknown as ShareRow | undefined;
          if (row) this.store.disable(row, "offline");
        }
        if (code || timedOut) { const event = this.finish(job, timedOut ? "timed_out" : "cancelled", timedOut ? "agent_share_timeout" : code!); if (event) events.push(event); }
      }
      for (const key of this.store.sql.prepare("SELECT id FROM agent_share_jobs WHERE status NOT IN ('queued','running') AND cleanup_pending=0 AND seconds_reserved>0").all()) {
        const job = this.store.job(String(key.id)); this.store.release(job, this.elapsed(job));
      }
      for (const key of this.store.sql.prepare("SELECT id FROM agent_share_jobs WHERE status IN ('cancelled','failed','timed_out') AND response_event_id IS NULL").all()) {
        const job = this.store.job(String(key.id)), event = this.finish(job, job.status as "cancelled" | "failed" | "timed_out", job.error_code ?? "agent_share_revoked"); if (event) events.push(event);
      }
      const cutoff = new Date(this.store.clock().getTime() - 14 * 86400000).toISOString();
      this.store.sql.prepare("DELETE FROM agent_share_jobs WHERE finished_at<? AND cleanup_pending=0").run(cutoff);
      this.store.sql.prepare("DELETE FROM agent_share_receipts WHERE created_at<?").run(cutoff);
      this.store.sql.prepare(`DELETE FROM agent_share_daily_usage WHERE utc_day<? AND NOT EXISTS
        (SELECT 1 FROM agent_share_jobs j WHERE j.owner_user_id=agent_share_daily_usage.owner_user_id
          AND j.project_id=agent_share_daily_usage.project_id AND j.source_runtime_id=agent_share_daily_usage.source_runtime_id
          AND j.utc_day=agent_share_daily_usage.utc_day AND j.seconds_reserved>0)`)
        .run(this.store.now().slice(0, 10));
    });
    this.service.publishSharedAgentEvents(events);
  }
}
