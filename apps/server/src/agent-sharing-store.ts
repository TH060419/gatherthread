import { createHash, randomUUID } from "node:crypto";
import { AgentShareLimitsSchema, AgentShareSchema, SharedAgentProfileSchema, SharedExecutionCapabilitySchema,
  type AgentShare, type AgentShareJob, type AgentShareLimits, type SharedAgentProfile,
  type SaveAgentShareInput, type ControlAgentShareInput, type JsonValue } from "@gatherthread/protocol";
import type { Actor, RuntimeRecord } from "./database.js";
import type { CollaborationService } from "./service.js";
import { ApiError, conflict, forbidden, idempotencyConflict, notFound } from "./errors.js";
import { redactJson } from "./redaction.js";

export interface ShareRow { id: string; project_id: string; owner_user_id: string; owner_device_id: string;
  authorizing_device_id: string; source_runtime_id: string; revision: number; enabled: number;
  disabled_reason: string | null; profile_json: string; limits_json: string; created_at: string; updated_at: string }
export interface SharedJobRow { id: string; project_id: string; share_id: string; share_revision: number;
  owner_user_id: string; owner_device_id: string; source_runtime_id: string; requester_user_id: string;
  requester_device_id: string; requester_display_name: string; session_id: string; request_event_id: string;
  response_event_id: string | null; idempotency_key: string; input_digest: string; content_revision: number;
  through_sequence: number; content: string; context_json: string; context_digest: string; profile_json: string;
  max_request_seconds: number; status: AgentShareJob["status"]; claim_attempt: number; lease_expires_at: string | null;
  claim_key: string | null; utc_day: string; created_at: string; started_at: string | null; deadline_at: string | null;
  finished_at: string | null; error_code: string | null; cleanup_pending: number; seconds_reserved: number; seconds_used: number }
export const stableShareJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const shareDigest = (value: unknown) => createHash("sha256").update(stableShareJson(value)).digest("hex");

/** Project and canonical session ACLs are unchanged. This private plane brokers one execution. */
export class AgentSharingStore {
  constructor(readonly service: CollaborationService, readonly clock: () => Date = () => new Date()) {}
  get sql() { return this.service.database.sqlite; }
  now() { return this.clock().toISOString(); }
  transaction<T>(work: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.sql.exec("COMMIT"); return result; }
    catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
  project(actor: Actor, projectId: string, write = false) {
    this.service.database.assertActiveDevice(actor);
    const role = this.service.requireProjectMembership(actor, projectId);
    if (write && role === "viewer") throw forbidden("Only project writers may share or call an Agent");
    if (this.service.database.requireProject(projectId).state !== "active") throw conflict("Archived projects cannot use shared Agents");
  }
  row(id: string): ShareRow {
    const row = this.sql.prepare("SELECT * FROM agent_shares WHERE id=?").get(id) as unknown as ShareRow | undefined;
    if (!row) throw notFound("Shared Agent"); return row;
  }
  job(id: string): SharedJobRow {
    const row = this.sql.prepare("SELECT * FROM agent_share_jobs WHERE id=?").get(id) as unknown as SharedJobRow | undefined;
    if (!row) throw notFound("Shared Agent job"); return row;
  }
  profile(row: ShareRow | SharedJobRow) { return SharedAgentProfileSchema.parse(JSON.parse(row.profile_json)); }
  limits(row: ShareRow) { return AgentShareLimitsSchema.parse(JSON.parse(row.limits_json)); }
  catalog(row: ShareRow) {
    const runtime = this.service.database.getRuntime(row.source_runtime_id);
    return (runtime.execution_profiles ?? [{ provider: runtime.provider, model: runtime.model }])
      .filter(profile => stableShareJson(redactJson(profile as unknown as JsonValue)) === stableShareJson(profile));
  }
  defaultProfile(row: ShareRow): SharedAgentProfile {
    const previous = this.profile(row), catalog = this.catalog(row);
    const profile = catalog.find(item => item.provider === previous.provider && item.model === previous.model) ?? catalog[0];
    if (!profile) throw new ApiError(409, "agent_share_profile_changed", "No model is currently advertised");
    const effort = previous.reasoning_effort && profile.reasoning_efforts?.includes(previous.reasoning_effort)
      ? previous.reasoning_effort : profile.default_reasoning_effort;
    return { harness: previous.harness, provider: profile.provider, model: profile.model,
      ...(effort ? { reasoning_effort: effort } : {}) };
  }
  members(row: ShareRow): string[] { return this.sql.prepare("SELECT user_id FROM agent_share_members WHERE share_id=? ORDER BY user_id")
    .all(row.id).map(value => String(value.user_id)); }
  sourceRuntime(actor: Actor, projectId: string, runtimeId: string): RuntimeRecord {
    this.project(actor, projectId, true);
    const runtime = this.service.database.getRuntime(runtimeId);
    if (runtime.user_id !== actor.user_id || runtime.purpose !== "execution" || runtime.status === "revoked"
      || !["codex", "deepseek-harness"].includes(runtime.harness)) throw forbidden("Select your own supported execution runtime");
    const session = this.service.requireSharedAgentWrite({ ...actor, device_id: runtime.device_id }, runtime.session_id).session;
    if (session.project_id !== projectId || session.state !== "active") throw forbidden("The source runtime belongs to another project or inactive session");
    this.service.database.assertActiveDevice({ ...actor, device_id: runtime.device_id });
    if (!SharedExecutionCapabilitySchema.safeParse(runtime.sharing_capability).success || runtime.context_deletion_version !== 1) {
      throw new ApiError(409, "agent_share_unsupported", "Update the native connector: isolated project-only sharing and cancellation are required");
    }
    if (this.sql.prepare("SELECT 1 FROM agent_share_source_barriers WHERE runtime_id=?").get(runtimeId)) {
      throw new ApiError(409, "agent_share_source_capacity", "Reconnect a fresh native source after sharing availability capacity is exhausted");
    }
    return runtime;
  }
  assertOnline(runtime: RuntimeRecord) {
    const capability = this.sql.prepare("SELECT availability FROM agent_share_runtime_capabilities WHERE runtime_id=?").get(runtime.id);
    if (runtime.status !== "online" || this.clock().getTime() - Date.parse(runtime.last_seen_at) > 30000
      || capability?.availability !== "ready") throw new ApiError(409, "agent_share_offline", "The shared Agent connection must be online");
  }
  source(actor: Actor, projectId: string, runtimeId: string, profile: SharedAgentProfile, online = true): RuntimeRecord {
    const runtime = this.sourceRuntime(actor, projectId, runtimeId);
    if (stableShareJson(redactJson(profile as unknown as JsonValue)) !== stableShareJson(profile)) {
      throw new ApiError(400, "agent_share_sensitive_input", "Remove credentials from the shared Agent profile");
    }
    if (runtime.harness !== profile.harness) throw forbidden("Select your own exact execution runtime");
    if (online) this.assertOnline(runtime);
    const advertised = runtime.execution_profiles?.find(value => value.provider === profile.provider && value.model === profile.model);
    const supports = runtime.execution_profiles ? Boolean(advertised && (profile.reasoning_effort === undefined
      || advertised.reasoning_efforts?.includes(profile.reasoning_effort)))
      : runtime.provider === profile.provider && runtime.model === profile.model && profile.reasoning_effort === undefined;
    if (!supports) throw new ApiError(409, "agent_share_profile_changed", "The exact model or reasoning effort is no longer advertised");
    return runtime;
  }
  assertGrant(row: ShareRow, recipient?: Actor, online = true) {
    // Sharing is intentionally long-lived. The initial browser is audit data;
    // current owner membership and the exact native device remain authoritative.
    const actor = { user_id: row.owner_user_id, device_id: row.owner_device_id, display_name: "" };
    const runtime = this.sourceRuntime(actor, row.project_id, row.source_runtime_id);
    if (runtime.harness !== this.profile(row).harness) throw forbidden("The source Agent harness changed");
    if (online) this.assertOnline(runtime);
    if (runtime.device_id !== row.owner_device_id) throw forbidden("The sharing source device changed");
    if (recipient) {
      this.project(recipient, row.project_id, true);
      if (row.owner_user_id === recipient.user_id || !this.sql.prepare("SELECT 1 FROM agent_share_members WHERE share_id=? AND user_id=?")
        .get(row.id, recipient.user_id)) throw notFound("Shared Agent");
    }
    return runtime;
  }
  owner(actor: Actor, projectId: string, id: string): ShareRow {
    this.project(actor, projectId, true); const row = this.row(id);
    if (row.project_id !== projectId || row.owner_user_id !== actor.user_id) throw notFound("Shared Agent"); return row;
  }
  usage(row: ShareRow, member: string) {
    const day = this.now().slice(0, 10);
    const current = this.sql.prepare(`SELECT calls,seconds_used,seconds_reserved FROM agent_share_daily_usage
      WHERE owner_user_id=? AND project_id=? AND source_runtime_id=? AND utc_day=? AND member_user_id=?`)
      .get(row.owner_user_id, row.project_id, row.source_runtime_id, day, member);
    const count = this.sql.prepare(`SELECT COUNT(*) AS count FROM agent_share_jobs WHERE owner_user_id=? AND project_id=?
      AND source_runtime_id=? AND (status IN ('queued','running') OR cleanup_pending=1) ${member ? "AND requester_user_id=?" : ""}`)
      .get(...[row.owner_user_id, row.project_id, row.source_runtime_id, ...(member ? [member] : [])]);
    return { utc_day: day, calls: Number(current?.calls ?? 0), seconds_used: Number(current?.seconds_used ?? 0),
      seconds_reserved: Number(current?.seconds_reserved ?? 0), active_jobs: Number(count?.count ?? 0) };
  }
  detail(actor: Actor, row: ShareRow): AgentShare {
    const owner = row.owner_user_id === actor.user_id;
    const identity = this.sql.prepare("SELECT display_name,avatar_id FROM users WHERE id=?").get(row.owner_user_id);
    let available = false;
    try { this.assertGrant(row, owner ? undefined : actor); available = Boolean(row.enabled); } catch { /* Status is not a grant. */ }
    const limits = this.limits(row), usage = this.usage(row, actor.user_id), total = this.usage(row, ""), catalog = this.catalog(row);
    available = available && catalog.length > 0;
    const budgetAvailable = total.calls < limits.total_daily_calls
      && total.seconds_used + total.seconds_reserved + limits.max_request_seconds <= limits.total_daily_seconds
      && (owner || usage.calls < limits.per_member_daily_calls
        && usage.seconds_used + usage.seconds_reserved + limits.max_request_seconds <= limits.per_member_daily_seconds);
    return AgentShareSchema.parse({ id: row.id, project_id: row.project_id, owner_user_id: row.owner_user_id,
      owner_display_name: String(identity?.display_name ?? "Member"), owner_avatar_id: identity?.avatar_id ?? null,
      revision: row.revision, enabled: Boolean(row.enabled), available: available && budgetAvailable,
      disabled_reason: row.disabled_reason ?? (available && !budgetAvailable ? "daily_limit" : null),
      execution_profile: catalog.length ? this.defaultProfile(row) : this.profile(row),
      ...(catalog.length ? { execution_profiles: catalog } : {}), limits, usage,
      created_at: row.created_at, updated_at: row.updated_at,
      ...(owner ? { allowed_user_ids: this.members(row), source_runtime_id: row.source_runtime_id,
        owner_device_id: row.owner_device_id, total_usage: total } : {}) });
  }
  list(actor: Actor, projectId: string) {
    this.project(actor, projectId);
    const rows = this.sql.prepare(`SELECT s.* FROM agent_shares s WHERE s.project_id=?
      AND (s.owner_user_id=? OR EXISTS(SELECT 1 FROM agent_share_members m WHERE m.share_id=s.id AND m.user_id=?))
      ORDER BY s.created_at,s.id LIMIT 128`).all(projectId, actor.user_id, actor.user_id) as unknown as ShareRow[];
    return { shares: rows.filter(row => row.owner_user_id === actor.user_id || this.service.requireProjectMembership(actor, projectId) !== "viewer")
      .map(row => this.detail(actor, row)) };
  }
  receipt(actor: Actor, projectId: string, key: string, input: unknown): ShareRow | undefined {
    const row = this.sql.prepare("SELECT * FROM agent_share_receipts WHERE owner_user_id=? AND project_id=? AND idempotency_key=?")
      .get(actor.user_id, projectId, key);
    if (!row) return undefined;
    if (row.input_digest !== shareDigest(input)) throw idempotencyConflict("Shared Agent retry must preserve the original action");
    return this.owner(actor, projectId, String(row.share_id));
  }
  remember(actor: Actor, projectId: string, key: string, input: unknown, id: string, emergency = false) {
    const count = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_receipts WHERE owner_user_id=? AND project_id=?")
      .get(actor.user_id, projectId)?.count ?? 0);
    const account = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_receipts WHERE owner_user_id=?").get(actor.user_id)?.count ?? 0);
    const host = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_share_receipts").get()?.count ?? 0);
    // One reserve per existing grant remains available after ordinary growth is
    // full; fresh enable/save cannot replenish that reserve through another project.
    if ((!emergency && (count >= 1024 || account >= 8192 || host >= 65536))
      || count >= 1152 || account >= 8320 || host >= 67584) throw new ApiError(429, "agent_share_storage_full", "Too many sharing changes; wait for retention cleanup");
    this.sql.prepare("INSERT INTO agent_share_receipts(owner_user_id,project_id,idempotency_key,input_digest,share_id,created_at) VALUES(?,?,?,?,?,?)")
      .run(actor.user_id, projectId, key, shareDigest(input), id, this.now());
  }
  save(actor: Actor, projectId: string, input: SaveAgentShareInput) {
    if (input.execution_profile && stableShareJson(redactJson(input.execution_profile as unknown as JsonValue)) !== stableShareJson(input.execution_profile)) {
      throw new ApiError(400, "agent_share_sensitive_input", "Remove credentials from the shared Agent profile");
    }
    return this.transaction(() => {
      this.project(actor, projectId, true); const replay = this.receipt(actor, projectId, input.idempotency_key, input);
      if (replay) return { share: this.detail(actor, replay), replayed: true };
      const previous = input.share_id ? this.owner(actor, projectId, input.share_id) : undefined;
      if (previous && previous.revision !== input.expected_revision) throw conflict("Shared Agent settings changed; reload before saving");
      const runtime = this.sourceRuntime(actor, projectId, input.source_runtime_id);
      if (input.enabled !== false) this.assertOnline(runtime);
      const first = runtime.execution_profiles?.[0];
      const profile = input.execution_profile ?? { harness: runtime.harness as SharedAgentProfile["harness"],
        provider: first?.provider ?? runtime.provider, model: first?.model ?? runtime.model,
        ...(first?.default_reasoning_effort ? { reasoning_effort: first.default_reasoning_effort } : {}) };
      this.source(actor, projectId, runtime.id, profile, input.enabled !== false);
      if (previous && this.sql.prepare("SELECT 1 FROM agent_shares WHERE project_id=? AND owner_user_id=? AND source_runtime_id=? AND id!=?")
        .get(projectId, actor.user_id, runtime.id, previous.id)) throw conflict("Another share already uses this exact source runtime");
      for (const userId of input.allowed_user_ids) {
        const member = this.sql.prepare("SELECT role FROM project_memberships WHERE project_id=? AND user_id=?").get(projectId, userId);
        if (userId === actor.user_id || !member || member.role === "viewer") throw forbidden("Allow only other current project writers");
      }
      if (!previous) {
        const ownCount = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_shares WHERE owner_user_id=? AND project_id=?")
          .get(actor.user_id, projectId)?.count ?? 0);
        const projectCount = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_shares WHERE project_id=?").get(projectId)?.count ?? 0);
        const accountCount = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_shares WHERE owner_user_id=?").get(actor.user_id)?.count ?? 0);
        const hostCount = Number(this.sql.prepare("SELECT COUNT(*) AS count FROM agent_shares").get()?.count ?? 0);
        if (ownCount >= 32 || projectCount >= 128 || accountCount >= 128 || hostCount >= 2048) throw new ApiError(429, "agent_share_storage_full", "Sharing configuration capacity is full");
        if (this.sql.prepare("SELECT 1 FROM agent_shares WHERE project_id=? AND owner_user_id=? AND source_runtime_id=?")
          .get(projectId, actor.user_id, runtime.id)) throw conflict("Edit the existing share for this source runtime");
      }
      const id = previous?.id ?? `share-${randomUUID()}`, timestamp = this.now();
      this.remember(actor, projectId, input.idempotency_key, input, id);
      this.sql.prepare(`INSERT INTO agent_shares(id,project_id,owner_user_id,owner_device_id,authorizing_device_id,source_runtime_id,
        revision,enabled,disabled_reason,profile_json,limits_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'manual',?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET owner_device_id=excluded.owner_device_id,authorizing_device_id=excluded.authorizing_device_id,
        source_runtime_id=excluded.source_runtime_id,revision=excluded.revision,enabled=0,disabled_reason='source_changed',
        profile_json=excluded.profile_json,limits_json=excluded.limits_json,updated_at=excluded.updated_at`)
        .run(id, projectId, actor.user_id, runtime.device_id, actor.device_id, runtime.id, (previous?.revision ?? 0) + 1,
          JSON.stringify(profile), JSON.stringify(input.limits), previous?.created_at ?? timestamp, timestamp);
      if (input.enabled) this.sql.prepare("UPDATE agent_shares SET enabled=1,disabled_reason=NULL WHERE id=?").run(id);
      this.sql.prepare("DELETE FROM agent_share_members WHERE share_id=?").run(id);
      for (const userId of input.allowed_user_ids) this.sql.prepare("INSERT INTO agent_share_members(share_id,user_id) VALUES(?,?)").run(id, userId);
      return { share: this.detail(actor, this.row(id)), replayed: false };
    });
  }
  control(actor: Actor, projectId: string, id: string, input: ControlAgentShareInput) {
    return this.transaction(() => {
      const row = this.owner(actor, projectId, id), replay = this.receipt(actor, projectId, input.idempotency_key, { id, ...input });
      if (replay) return { share: this.detail(actor, replay), replayed: true };
      if (input.action === "enable" || input.expected_revision !== undefined) {
        if (row.revision !== input.expected_revision) throw conflict("The sharing revision changed; reload before continuing");
      }
      // A fresh explicit owner action creates a new grant epoch. It may bind the
      // owner's current browser device, while the exact native source stays fixed.
      if (input.action === "enable") this.assertGrant({ ...row, authorizing_device_id: actor.device_id });
      if (input.action === "enable" && !this.members(row).length) throw conflict("Select at least one sharing recipient before starting");
      this.remember(actor, projectId, input.idempotency_key, { id, ...input }, id, input.action === "disable" && Boolean(row.enabled));
      this.sql.prepare("UPDATE agent_shares SET revision=revision+1,enabled=?,disabled_reason=?,authorizing_device_id=?,updated_at=? WHERE id=?")
        .run(input.action === "enable" ? 1 : 0, input.action === "enable" ? null : "manual", actor.device_id, this.now(), id);
      return { share: this.detail(actor, this.row(id)), replayed: false };
    });
  }
  disable(row: ShareRow, reason: string) {
    if (!row.enabled) return;
    this.sql.prepare("UPDATE agent_shares SET revision=revision+1,enabled=0,disabled_reason=?,updated_at=? WHERE id=?")
      .run(reason, this.now(), row.id);
  }
  reserve(row: ShareRow, actor: Actor) {
    const limits = this.limits(row), day = this.now().slice(0, 10);
    for (const member of ["", actor.user_id]) {
      const usage = this.usage(row, member), calls = member ? limits.per_member_daily_calls : limits.total_daily_calls,
        seconds = member ? limits.per_member_daily_seconds : limits.total_daily_seconds;
      if (usage.calls >= calls || usage.seconds_used + usage.seconds_reserved + limits.max_request_seconds > seconds) {
        throw new ApiError(429, "agent_share_daily_limit", "This shared Agent's daily call or duration allowance is exhausted");
      }
      this.sql.prepare(`INSERT INTO agent_share_daily_usage(owner_user_id,project_id,source_runtime_id,utc_day,member_user_id,calls,seconds_used,seconds_reserved)
        VALUES(?,?,?,?,?,1,0,?) ON CONFLICT(owner_user_id,project_id,source_runtime_id,utc_day,member_user_id)
        DO UPDATE SET calls=calls+1,seconds_reserved=seconds_reserved+excluded.seconds_reserved`)
        .run(row.owner_user_id, row.project_id, row.source_runtime_id, day, member, limits.max_request_seconds);
    }
  }
  release(job: SharedJobRow, seconds: number) {
    if (job.seconds_reserved === 0) return;
    const used = Math.min(job.max_request_seconds, Math.max(0, Math.ceil(seconds)));
    for (const member of ["", job.requester_user_id]) this.sql.prepare(`UPDATE agent_share_daily_usage
      SET seconds_reserved=MAX(0,seconds_reserved-?),seconds_used=seconds_used+?
      WHERE owner_user_id=? AND project_id=? AND source_runtime_id=? AND utc_day=? AND member_user_id=?`)
      .run(job.seconds_reserved, used, job.owner_user_id, job.project_id, job.source_runtime_id, job.utc_day, member);
    this.sql.prepare("UPDATE agent_share_jobs SET seconds_reserved=0,seconds_used=?,cleanup_pending=0 WHERE id=?").run(used, job.id);
  }
  summary(job: SharedJobRow): AgentShareJob {
    return { id: job.id, project_id: job.project_id, share_id: job.share_id, share_revision: job.share_revision,
      session_id: job.session_id, request_event_id: job.request_event_id, status: job.status,
      requester_user_id: job.requester_user_id, requester_display_name: job.requester_display_name,
      execution_profile: this.profile(job), created_at: job.created_at, deadline_at: job.deadline_at,
      finished_at: job.finished_at, error_code: job.error_code, cleanup_pending: Boolean(job.cleanup_pending) };
  }
  requester(job: SharedJobRow): Actor { return { user_id: job.requester_user_id, device_id: job.requester_device_id, display_name: job.requester_display_name }; }
  ownedJob(actor: Actor, id: string, cleanup = false) {
    this.service.database.assertActiveDevice(actor); const job = this.job(id);
    if (job.owner_user_id !== actor.user_id || job.owner_device_id !== actor.device_id) throw notFound("Shared Agent job");
    if (!cleanup) this.project(actor, job.project_id, true);
    return job;
  }
  assertJob(job: SharedJobRow) {
    if (!this.service.database.teamRequestMayExecute(job.request_event_id)) throw new ApiError(409,
      "agent_team_stopped", "The bounded team execution no longer authorizes this request");
    const row = this.row(job.share_id);
    if (!row.enabled || row.revision !== job.share_revision || row.source_runtime_id !== job.source_runtime_id
      || row.owner_device_id !== job.owner_device_id) throw new ApiError(409, "agent_share_revoked", "This sharing grant is no longer active");
    this.assertGrant(row, this.requester(job));
    this.source({ user_id: row.owner_user_id, device_id: row.owner_device_id, display_name: "" },
      row.project_id, row.source_runtime_id, this.profile(job));
    const session = this.service.requireSharedAgentWrite(this.requester(job), job.session_id).session;
    if (session.state !== "active" || session.project_id !== row.project_id || (session.content_revision ?? 0) !== job.content_revision) {
      throw new ApiError(409, "context_changed", "The request's conversation changed");
    }
    this.service.database.assertRequestContextCurrent(job.session_id, job.request_event_id, job.content_revision);
    return row;
  }
  assertAttempt(job: SharedJobRow, attempt: number) {
    if (job.status !== "running" || job.claim_attempt !== attempt || !job.lease_expires_at || job.lease_expires_at <= this.now()
      || !job.deadline_at || job.deadline_at <= this.now()) throw new ApiError(409, "agent_share_lease_expired", "This execution lease is no longer active");
    this.assertJob(job);
  }
}
