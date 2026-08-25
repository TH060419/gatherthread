import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  CanonicalEvent,
  CaptureFidelity,
  EventType,
  EventVisibility,
  JsonValue,
  MembershipRole,
  ReplayResponse,
  RuntimeProvenance,
  SessionListItem,
  SessionMode,
} from "@agent-cooperation/protocol";
import { conflict, notFound, unauthorized } from "./errors.js";

export interface Actor {
  user_id: string;
  display_name: string;
  device_id: string;
}

export interface SessionRecord {
  id: string;
  owner_user_id: string;
  mode: SessionMode;
  title: string;
  state: "active" | "archived";
  next_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface RuntimeRecord {
  id: string;
  session_id: string;
  user_id: string;
  device_id: string;
  harness: string;
  provider: string;
  model: string;
  local_session_id: string;
  capture_fidelity: CaptureFidelity;
  status: "online" | "offline" | "revoked";
  last_seen_at: string;
}

interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  idempotency_key: string;
  type: EventType;
  actor_user_id: string;
  created_at: string;
  visibility: EventVisibility;
  reply_to_event_id: string | null;
  payload_json: string;
  runtime_provenance_json: string | null;
}

interface SessionRow extends SessionRecord {}
interface RuntimeRow extends RuntimeRecord {}
interface CountRow { count: number }
interface SequenceRow { next_sequence: number }
interface MembershipRow { role: MembershipRole }
interface DeviceOwnerRow { user_id: string; revoked_at: string | null }
interface ClaimRow { runtime_id: string; status: "claimed" | "completed" }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('solo', 'multi')),
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  next_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memberships (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'participant', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  local_session_id TEXT NOT NULL,
  capture_fidelity TEXT NOT NULL CHECK (capture_fidelity IN ('canonical_history', 'harness_transcript', 'provider_request')),
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'revoked')),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (device_id, harness, local_session_id)
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('human_chat','agent_request','agent_response','tool_call','tool_result','attachment','context_snapshot','membership_change','session_state_change')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('session', 'owner_only')),
  reply_to_event_id TEXT REFERENCES events(id),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  runtime_provenance_json TEXT CHECK (runtime_provenance_json IS NULL OR json_valid(runtime_provenance_json)),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS events_replay_idx ON events(session_id, sequence);
CREATE TABLE IF NOT EXISTS agent_request_claims (
  request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL REFERENCES runtimes(id),
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed'))
) STRICT;
`;

function now(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueToken(): string {
  return `acp_${randomBytes(32).toString("base64url")}`;
}

function mapEvent(row: EventRow): CanonicalEvent {
  return {
    id: row.id,
    session_id: row.session_id,
    sequence: row.sequence,
    idempotency_key: row.idempotency_key,
    type: row.type,
    actor_user_id: row.actor_user_id,
    created_at: row.created_at,
    visibility: row.visibility,
    reply_to_event_id: row.reply_to_event_id,
    payload: JSON.parse(row.payload_json) as JsonValue,
    runtime_provenance: row.runtime_provenance_json === null
      ? null
      : JSON.parse(row.runtime_provenance_json) as RuntimeProvenance,
  };
}

export class CollaborationDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.sqlite.exec(SCHEMA);
  }

  close(): void {
    this.sqlite.close();
  }

  journalMode(): string {
    const row = this.sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode;
  }

  bootstrapIdentity(input: {
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
  }): { actor: Actor; token: string } {
    const count = this.sqlite.prepare("SELECT count(*) AS count FROM users").get() as unknown as CountRow;
    if (count.count !== 0) throw conflict("Bootstrap is available only for an empty database");
    return this.createIdentity(input);
  }

  createIdentity(input: {
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
  }): { actor: Actor; token: string } {
    const userId = input.user_id ?? randomUUID();
    const deviceId = input.device_id ?? randomUUID();
    const token = issueToken();
    const createdAt = now();
    this.transaction(() => {
      this.sqlite.prepare("INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)")
        .run(userId, input.display_name, createdAt);
      this.sqlite.prepare("INSERT INTO devices(id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(deviceId, userId, input.device_name, hashToken(token), createdAt);
    });
    return { actor: { user_id: userId, display_name: input.display_name, device_id: deviceId }, token };
  }

  createDevice(userId: string, name: string, deviceId: string = randomUUID()): { device_id: string; token: string } {
    const token = issueToken();
    this.sqlite.prepare("INSERT INTO devices(id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(deviceId, userId, name, hashToken(token), now());
    return { device_id: deviceId, token };
  }

  revokeDevice(actor: Actor, deviceId: string): void {
    const result = this.sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(now(), deviceId, actor.user_id);
    if (Number(result.changes) === 0) throw notFound("Device");
    this.sqlite.prepare("UPDATE runtimes SET status = 'revoked' WHERE device_id = ?").run(deviceId);
  }

  authenticate(token: string): Actor {
    const row = this.sqlite.prepare(`
      SELECT users.id AS user_id, users.display_name, devices.id AS device_id
      FROM devices JOIN users ON users.id = devices.user_id
      WHERE devices.token_hash = ? AND devices.revoked_at IS NULL
    `).get(hashToken(token)) as unknown as Actor | undefined;
    if (!row) throw unauthorized("Bearer token is invalid or revoked");
    return row;
  }

  createSession(actor: Actor, input: {
    session_id?: string | undefined;
    idempotency_key: string;
    mode: SessionMode;
    title: string;
  }): { session: SessionRecord; event: CanonicalEvent } {
    const sessionId = input.session_id ?? randomUUID();
    const timestamp = now();
    return this.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO sessions(id, owner_user_id, mode, title, state, next_sequence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 0, ?, ?)
      `).run(sessionId, actor.user_id, input.mode, input.title, timestamp, timestamp);
      this.sqlite.prepare(`
        INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, 'owner', ?, ?)
      `).run(sessionId, actor.user_id, timestamp, timestamp);
      const event = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: input.idempotency_key,
        type: "session_state_change",
        visibility: "session",
        payload: { action: "created", mode: input.mode, title: input.title },
      }, null);
      return { session: this.requireSession(sessionId), event };
    });
  }

  requireSession(sessionId: string): SessionRecord {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as unknown as SessionRow | undefined;
    if (!row) throw notFound("Session");
    return row;
  }

  listSessions(userId: string): SessionListItem[] {
    return this.sqlite.prepare(`
      SELECT sessions.id, sessions.title, sessions.mode, sessions.state,
             memberships.role, sessions.next_sequence AS current_sequence,
             sessions.updated_at
      FROM memberships
      JOIN sessions ON sessions.id = memberships.session_id
      WHERE memberships.user_id = ?
      ORDER BY sessions.updated_at DESC, sessions.id ASC
    `).all(userId) as unknown as SessionListItem[];
  }

  membershipRole(sessionId: string, userId: string): MembershipRole | null {
    const row = this.sqlite.prepare("SELECT role FROM memberships WHERE session_id = ? AND user_id = ?")
      .get(sessionId, userId) as unknown as MembershipRow | undefined;
    return row?.role ?? null;
  }

  setMembership(actor: Actor, sessionId: string, userId: string, role: "participant" | "viewer", idempotencyKey: string): CanonicalEvent {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, idempotencyKey);
      if (existing) return this.requireIdempotencyActor(existing, actor.user_id);
      const timestamp = now();
      this.sqlite.prepare(`
        INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
      `).run(sessionId, userId, role, timestamp, timestamp);
      return this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: idempotencyKey,
        type: "membership_change",
        visibility: "session",
        payload: { action: "set", user_id: userId, role },
      }, null);
    });
  }

  removeMembership(actor: Actor, sessionId: string, userId: string, idempotencyKey: string): CanonicalEvent {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, idempotencyKey);
      if (existing) return this.requireIdempotencyActor(existing, actor.user_id);
      const result = this.sqlite.prepare("DELETE FROM memberships WHERE session_id = ? AND user_id = ? AND role != 'owner'")
        .run(sessionId, userId);
      if (Number(result.changes) === 0) throw notFound("Membership");
      return this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: idempotencyKey,
        type: "membership_change",
        visibility: "session",
        payload: { action: "removed", user_id: userId },
      }, null);
    });
  }

  updateSession(actor: Actor, sessionId: string, input: {
    mode?: SessionMode | undefined;
    state?: "active" | "archived" | undefined;
    title?: string | undefined;
    idempotency_key: string;
  }): { session: SessionRecord; event: CanonicalEvent } {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, input.idempotency_key);
      if (existing) return {
        session: this.requireSession(sessionId),
        event: this.requireIdempotencyActor(existing, actor.user_id),
      };
      const session = this.requireSession(sessionId);
      const next = {
        mode: input.mode ?? session.mode,
        state: input.state ?? session.state,
        title: input.title ?? session.title,
      };
      this.sqlite.prepare("UPDATE sessions SET mode = ?, state = ?, title = ?, updated_at = ? WHERE id = ?")
        .run(next.mode, next.state, next.title, now(), sessionId);
      const event = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: input.idempotency_key,
        type: "session_state_change",
        visibility: "session",
        payload: { action: "updated", ...next },
      }, null);
      return { session: this.requireSession(sessionId), event };
    });
  }

  getEvent(sessionId: string, eventId: string): CanonicalEvent {
    const row = this.sqlite.prepare("SELECT * FROM events WHERE session_id = ? AND id = ?")
      .get(sessionId, eventId) as unknown as EventRow | undefined;
    if (!row) throw notFound("Event");
    return mapEvent(row);
  }

  appendEvent(actor: Actor, sessionId: string, input: AppendEventInput, provenance: RuntimeProvenance | null): CanonicalEvent {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, input.idempotency_key);
      if (existing) return this.requireIdempotencyActor(existing, actor.user_id);
      return this.appendInsideTransaction(actor.user_id, sessionId, input, provenance);
    });
  }

  replay(sessionId: string, afterSequence: number, limit: number, canSeeOwnerOnly: boolean): ReplayResponse {
    const session = this.requireSession(sessionId);
    const rows = this.sqlite.prepare(`
      SELECT * FROM events
      WHERE session_id = ? AND sequence > ? AND (visibility = 'session' OR ? = 1)
      ORDER BY sequence ASC LIMIT ?
    `).all(sessionId, afterSequence, canSeeOwnerOnly ? 1 : 0, limit + 1) as unknown as EventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(mapEvent);
    const cursor = hasMore
      ? events.at(-1)?.sequence ?? afterSequence
      : session.next_sequence;
    return { events, cursor, has_more: hasMore };
  }

  registerRuntime(actor: Actor, input: {
    runtime_id?: string | undefined;
    session_id: string;
    device_id: string;
    harness: string;
    provider: string;
    model: string;
    local_session_id: string;
    capture_fidelity: CaptureFidelity;
  }): RuntimeRecord {
    const device = this.sqlite.prepare("SELECT user_id, revoked_at FROM devices WHERE id = ?")
      .get(input.device_id) as unknown as DeviceOwnerRow | undefined;
    if (!device || device.user_id !== actor.user_id || device.revoked_at !== null) throw unauthorized("Device is not active for this actor");
    const runtimeId = input.runtime_id ?? randomUUID();
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT INTO runtimes(id, session_id, user_id, device_id, harness, provider, model, local_session_id, capture_fidelity, status, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)
      ON CONFLICT(device_id, harness, local_session_id) DO UPDATE SET
        session_id = excluded.session_id,
        provider = excluded.provider,
        model = excluded.model,
        capture_fidelity = excluded.capture_fidelity,
        status = 'online',
        last_seen_at = excluded.last_seen_at
    `).run(runtimeId, input.session_id, actor.user_id, input.device_id, input.harness, input.provider, input.model, input.local_session_id, input.capture_fidelity, timestamp, timestamp);
    return this.getRuntimeByIdentity(input.device_id, input.harness, input.local_session_id);
  }

  getRuntime(runtimeId: string): RuntimeRecord {
    const row = this.sqlite.prepare("SELECT id, session_id, user_id, device_id, harness, provider, model, local_session_id, capture_fidelity, status, last_seen_at FROM runtimes WHERE id = ?")
      .get(runtimeId) as unknown as RuntimeRow | undefined;
    if (!row) throw notFound("Runtime");
    return row;
  }

  heartbeatRuntime(actor: Actor, runtimeId: string): RuntimeRecord {
    const result = this.sqlite.prepare("UPDATE runtimes SET status = 'online', last_seen_at = ? WHERE id = ? AND user_id = ? AND status != 'revoked'")
      .run(now(), runtimeId, actor.user_id);
    if (Number(result.changes) === 0) throw notFound("Runtime");
    return this.getRuntime(runtimeId);
  }

  claimAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string): { request_event_id: string; runtime_id: string; status: string } {
    return this.transaction(() => {
      const event = this.getEvent(sessionId, requestEventId);
      if (event.type !== "agent_request") throw conflict("Only agent_request events can be claimed");
      const runtime = this.getRuntime(runtimeId);
      if (runtime.session_id !== sessionId || runtime.user_id !== actor.user_id || event.actor_user_id !== actor.user_id || runtime.status === "revoked") {
        throw conflict("The request is eligible only for the initiating user's active runtime");
      }
      const existing = this.sqlite.prepare("SELECT runtime_id, status FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (existing) {
        if (existing.runtime_id !== runtimeId) throw conflict("Agent request is already claimed by another runtime");
        return { request_event_id: requestEventId, runtime_id: runtimeId, status: existing.status };
      }
      this.sqlite.prepare("INSERT INTO agent_request_claims(request_event_id, runtime_id, claimed_at, status) VALUES (?, ?, ?, 'claimed')")
        .run(requestEventId, runtimeId, now());
      return { request_event_id: requestEventId, runtime_id: runtimeId, status: "claimed" };
    });
  }

  completeAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string, idempotencyKey: string, payload: JsonValue): CanonicalEvent {
    return this.transaction(() => {
      const existingEvent = this.findByIdempotencyKey(sessionId, idempotencyKey);
      if (existingEvent) return this.requireIdempotencyActor(existingEvent, actor.user_id);
      const runtime = this.getRuntime(runtimeId);
      const claim = this.sqlite.prepare("SELECT runtime_id, status FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (!claim || claim.runtime_id !== runtimeId || claim.status !== "claimed" || runtime.user_id !== actor.user_id || runtime.session_id !== sessionId) {
        throw conflict("A matching active claim is required to complete this request");
      }
      const provenance = this.runtimeProvenance(runtime);
      const response = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: idempotencyKey,
        type: "agent_response",
        visibility: "session",
        reply_to_event_id: requestEventId,
        payload,
        runtime_id: runtimeId,
      }, provenance);
      this.sqlite.prepare("UPDATE agent_request_claims SET status = 'completed', completed_at = ? WHERE request_event_id = ?")
        .run(now(), requestEventId);
      return response;
    });
  }

  runtimeProvenance(runtime: RuntimeRecord): RuntimeProvenance {
    return {
      user_id: runtime.user_id,
      device_id: runtime.device_id,
      runtime_id: runtime.id,
      harness: runtime.harness,
      provider: runtime.provider,
      model: runtime.model,
      local_session_id: runtime.local_session_id,
      capture_fidelity: runtime.capture_fidelity,
    };
  }

  private getRuntimeByIdentity(deviceId: string, harness: string, localSessionId: string): RuntimeRecord {
    const row = this.sqlite.prepare(`
      SELECT id, session_id, user_id, device_id, harness, provider, model, local_session_id, capture_fidelity, status, last_seen_at
      FROM runtimes WHERE device_id = ? AND harness = ? AND local_session_id = ?
    `).get(deviceId, harness, localSessionId) as unknown as RuntimeRow;
    return row;
  }

  private findByIdempotencyKey(sessionId: string, key: string): CanonicalEvent | null {
    const row = this.sqlite.prepare("SELECT * FROM events WHERE session_id = ? AND idempotency_key = ?")
      .get(sessionId, key) as unknown as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  private requireIdempotencyActor(event: CanonicalEvent, actorUserId: string): CanonicalEvent {
    if (event.actor_user_id !== actorUserId) {
      throw conflict("Idempotency key is already owned by another actor in this session");
    }
    return event;
  }

  private appendInsideTransaction(actorUserId: string, sessionId: string, input: Omit<AppendEventInput, "visibility"> & { visibility?: EventVisibility }, provenance: RuntimeProvenance | null): CanonicalEvent {
    const session = this.requireSession(sessionId);
    const sequence = session.next_sequence + 1;
    const event: CanonicalEvent = {
      id: input.event_id ?? randomUUID(),
      session_id: sessionId,
      sequence,
      idempotency_key: input.idempotency_key,
      type: input.type,
      actor_user_id: actorUserId,
      created_at: now(),
      visibility: input.visibility ?? "session",
      reply_to_event_id: input.reply_to_event_id ?? null,
      payload: input.payload,
      runtime_provenance: provenance,
    };
    this.sqlite.prepare(`
      INSERT INTO events(id, session_id, sequence, idempotency_key, type, actor_user_id, created_at, visibility, reply_to_event_id, payload_json, runtime_provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.session_id,
      event.sequence,
      event.idempotency_key,
      event.type,
      event.actor_user_id,
      event.created_at,
      event.visibility,
      event.reply_to_event_id,
      JSON.stringify(event.payload),
      event.runtime_provenance === null ? null : JSON.stringify(event.runtime_provenance),
    );
    this.sqlite.prepare("UPDATE sessions SET next_sequence = ?, updated_at = ? WHERE id = ?")
      .run(sequence, event.created_at, sessionId);
    return event;
  }

  private transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
