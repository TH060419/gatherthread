import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  CanonicalEvent,
  CaptureFidelity,
  DeviceAuthorizationRecord,
  EventType,
  EventVisibility,
  InvitationAuditRecord,
  InvitationRecord,
  InvitationRole,
  InvitationTtl,
  JsonValue,
  MembershipRole,
  ReplayResponse,
  RuntimeProvenance,
  SessionListItem,
  SessionMode,
} from "@gatherthread/protocol";
import { conflict, idempotencyConflict, notFound, runtimeBusy, storageQuotaExceeded, unauthorized } from "./errors.js";

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

export interface SessionMemberRecord {
  user_id: string;
  display_name: string;
  role: MembershipRole;
  runtime: RuntimeRecord | null;
}

export interface DeviceRecord {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  token_created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  rotated_at: string | null;
  token_version: number;
}

export interface DatabaseOptions {
  authTokenPepper?: string | undefined;
  clock?: (() => Date) | undefined;
  maxUserEventBytes?: number | undefined;
  maxSessionEventBytes?: number | undefined;
  maxTotalEventBytes?: number | undefined;
  maxEventBytes?: number | undefined;
}

export interface CreateInvitationResult {
  invitation: InvitationRecord;
  invite_token: string;
}

export interface ClaimInvitationResult {
  actor: Actor;
  token: string;
  device: DeviceRecord;
  invitation: InvitationRecord;
  event: CanonicalEvent;
}

export interface AcceptInvitationResult {
  actor: Actor;
  invitation: InvitationRecord;
  event: CanonicalEvent;
}

export interface CreateDeviceAuthorizationResult {
  authorization: DeviceAuthorizationRecord;
  authorization_token: string;
}

export interface ClaimDeviceAuthorizationResult {
  actor: Actor;
  device: DeviceRecord;
  token: string;
  authorization: DeviceAuthorizationRecord;
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
interface BytesRow { bytes: number }
interface SequenceRow { next_sequence: number }
interface MembershipRow { role: MembershipRole }
interface ClaimRow { runtime_id: string; status: "claimed" | "completed" }
interface InvitationRow extends InvitationRecord { token_digest: string }
interface DeviceAuthorizationRow extends DeviceAuthorizationRecord { token_digest: string }

const INVITATION_TTL_MS: Readonly<Record<InvitationTtl, number>> = {
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

const PROCESS_CREDENTIAL_PEPPER = randomBytes(32).toString("base64url");
const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_USER_EVENT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SESSION_EVENT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_EVENT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

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
  token_created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  rotated_at TEXT,
  token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version > 0)
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
CREATE INDEX IF NOT EXISTS events_actor_idx ON events(actor_user_id);
CREATE TABLE IF NOT EXISTS event_storage_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (session_id, actor_user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_request_claims (
  request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL REFERENCES runtimes(id),
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed'))
) STRICT;
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('participant', 'viewer')),
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  expired_at TEXT,
  claimed_at TEXT,
  claimed_by_user_id TEXT REFERENCES users(id),
  claimed_by_device_id TEXT REFERENCES devices(id),
  CHECK (claimed_at IS NULL OR (claimed_by_user_id IS NOT NULL AND claimed_by_device_id IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS invitations_session_idx ON invitations(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS invitation_audit (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created', 'claimed', 'revoked', 'expired')),
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  subject_user_id TEXT REFERENCES users(id),
  subject_device_id TEXT REFERENCES devices(id),
  role TEXT NOT NULL CHECK (role IN ('participant', 'viewer')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS invitation_audit_session_idx ON invitation_audit(session_id, created_at, id);
CREATE TABLE IF NOT EXISTS device_authorizations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  authorizer_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  expired_at TEXT,
  claimed_at TEXT,
  claimed_by_device_id TEXT REFERENCES devices(id)
) STRICT;
CREATE INDEX IF NOT EXISTS device_authorizations_user_idx
  ON device_authorizations(user_id, created_at DESC);
`;

function stableJson(value: JsonValue): string {
  const normalize = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, normalize(item[key] as JsonValue)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function issueDeviceToken(): string {
  return `gta_${randomBytes(32).toString("base64url")}`;
}

function issueInvitationToken(): string {
  return `gti_${randomBytes(32).toString("base64url")}`;
}

function issueDeviceAuthorizationToken(): string {
  return `gtd_${randomBytes(32).toString("base64url")}`;
}

function resolveAuthTokenPepper(path: string, configured?: string): string {
  const explicit = configured ?? process.env.GATHERTHREAD_AUTH_TOKEN_PEPPER;
  if (explicit) return explicit;
  if (path === ":memory:") return PROCESS_CREDENTIAL_PEPPER;
  const pepperPath = `${path}.auth-token-pepper`;
  try {
    const existing = readFileSync(pepperPath, "utf8").trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32).toString("base64url");
  try {
    writeFileSync(pepperPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readFileSync(pepperPath, "utf8").trim();
    if (!raced) throw new Error("Authentication token pepper file is empty");
    return raced;
  }
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
  private readonly authTokenPepper: string;
  private readonly clock: () => Date;
  private readonly maxUserEventBytes: number;
  private readonly maxSessionEventBytes: number;
  private readonly maxTotalEventBytes: number;
  private readonly maxEventBytes: number;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.authTokenPepper = resolveAuthTokenPepper(path, options.authTokenPepper);
    this.clock = options.clock ?? (() => new Date());
    this.maxUserEventBytes = options.maxUserEventBytes ?? DEFAULT_MAX_USER_EVENT_BYTES;
    this.maxSessionEventBytes = options.maxSessionEventBytes ?? DEFAULT_MAX_SESSION_EVENT_BYTES;
    this.maxTotalEventBytes = options.maxTotalEventBytes ?? DEFAULT_MAX_TOTAL_EVENT_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    for (const [name, value] of [
      ["maxUserEventBytes", this.maxUserEventBytes],
      ["maxSessionEventBytes", this.maxSessionEventBytes],
      ["maxTotalEventBytes", this.maxTotalEventBytes],
      ["maxEventBytes", this.maxEventBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (this.maxEventBytes > Math.min(this.maxUserEventBytes, this.maxSessionEventBytes, this.maxTotalEventBytes)
      || this.maxUserEventBytes > this.maxTotalEventBytes || this.maxSessionEventBytes > this.maxTotalEventBytes) {
      throw new RangeError("Event storage limits are inconsistent");
    }
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_size_limit = 67108864;");
    const journalMode = (this.sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    if (journalMode !== "wal") this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec(SCHEMA);
    this.migrateDeviceCredentialColumns();
    this.initializeEventStorageUsage();
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
    const token = issueDeviceToken();
    const createdAt = this.now();
    this.transaction(() => {
      this.sqlite.prepare("INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)")
        .run(userId, input.display_name, createdAt);
      this.sqlite.prepare(`
        INSERT INTO devices(id, user_id, name, token_hash, created_at, token_created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(deviceId, userId, input.device_name, this.tokenDigest(token), createdAt, createdAt);
    });
    return { actor: { user_id: userId, display_name: input.display_name, device_id: deviceId }, token };
  }

  createDevice(
    userId: string,
    name: string,
    deviceId: string = randomUUID(),
    expiresAt: string | null = null,
  ): { device_id: string; token: string; device: DeviceRecord } {
    const token = issueDeviceToken();
    const timestamp = this.now();
    this.sqlite.prepare(`
      INSERT INTO devices(id, user_id, name, token_hash, created_at, token_created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, userId, name, this.tokenDigest(token), timestamp, timestamp, expiresAt);
    return { device_id: deviceId, token, device: this.getDeviceForUser(userId, deviceId) };
  }

  revokeDevice(actor: Actor, deviceId: string): void {
    this.transaction(() => {
      const timestamp = this.now();
      const result = this.sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
        .run(timestamp, deviceId, actor.user_id);
      if (Number(result.changes) === 0) throw notFound("Device");
      this.sqlite.prepare("UPDATE runtimes SET status = 'revoked' WHERE device_id = ?").run(deviceId);
      this.sqlite.prepare(`
        UPDATE device_authorizations SET revoked_at = ?
        WHERE authorizer_device_id = ? AND claimed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL
      `).run(timestamp, deviceId);
    });
  }

  assertActiveDevice(actor: Actor): void {
    const row = this.sqlite.prepare(`
      SELECT id FROM devices
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(actor.device_id, actor.user_id, this.now());
    if (!row) throw unauthorized("Device credential is expired or revoked");
  }

  authenticate(token: string): Actor {
    const timestamp = this.now();
    const row = this.sqlite.prepare(`
      SELECT users.id AS user_id, users.display_name, devices.id AS device_id
      FROM devices JOIN users ON users.id = devices.user_id
      WHERE devices.token_hash = ?
        AND devices.revoked_at IS NULL
        AND (devices.expires_at IS NULL OR devices.expires_at > ?)
    `).get(this.tokenDigest(token), timestamp) as unknown as Actor | undefined;
    if (!row) throw unauthorized("Bearer token is invalid, expired, or revoked");
    this.sqlite.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(timestamp, row.device_id);
    return { user_id: row.user_id, display_name: row.display_name, device_id: row.device_id };
  }

  getDevice(actor: Actor, deviceId: string): DeviceRecord {
    return this.getDeviceForUser(actor.user_id, deviceId);
  }

  listDevices(actor: Actor): DeviceRecord[] {
    return this.sqlite.prepare(`
      SELECT id, user_id, name, created_at, COALESCE(token_created_at, created_at) AS token_created_at,
             last_used_at, expires_at, revoked_at, rotated_at, token_version
      FROM devices WHERE user_id = ? ORDER BY created_at, id
    `).all(actor.user_id) as unknown as DeviceRecord[];
  }

  rotateDeviceToken(actor: Actor, deviceId: string, expiresAt: string | null = null): {
    device: DeviceRecord;
    token: string;
  } {
    if (deviceId !== actor.device_id) {
      throw unauthorized("A device may rotate only its own credential");
    }
    const token = issueDeviceToken();
    const timestamp = this.now();
    return this.transaction(() => {
      const result = this.sqlite.prepare(`
        UPDATE devices
        SET token_hash = ?, token_created_at = ?, last_used_at = NULL, expires_at = ?,
            rotated_at = ?, token_version = token_version + 1
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(this.tokenDigest(token), timestamp, expiresAt, timestamp, deviceId, actor.user_id);
      if (Number(result.changes) === 0) throw notFound("Device");
      return { device: this.getDeviceForUser(actor.user_id, deviceId), token };
    });
  }

  createDeviceAuthorization(actor: Actor): CreateDeviceAuthorizationResult {
    const createdAtDate = this.clock();
    const timestamp = createdAtDate.toISOString();
    const activeDevice = this.sqlite.prepare(`
      SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(actor.device_id, actor.user_id, timestamp);
    if (!activeDevice) throw unauthorized("Authorizing device is not active");
    const token = issueDeviceAuthorizationToken();
    const id = randomUUID();
    const expiresAt = new Date(createdAtDate.getTime() + DEVICE_AUTHORIZATION_TTL_MS).toISOString();
    this.sqlite.prepare(`
      INSERT INTO device_authorizations(
        id, user_id, authorizer_device_id, token_digest, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, actor.user_id, actor.device_id, this.tokenDigest(token), timestamp, expiresAt);
    return { authorization: this.requireDeviceAuthorization(id), authorization_token: token };
  }

  claimDeviceAuthorization(input: {
    authorization_token: string;
    device_id?: string | undefined;
    device_name: string;
    expires_at?: string | null | undefined;
  }): ClaimDeviceAuthorizationResult {
    const timestamp = this.now();
    const result = this.transaction((): ClaimDeviceAuthorizationResult | { failure: "invalid" | "expired" } => {
      const row = this.sqlite.prepare(`
        SELECT device_authorizations.* FROM device_authorizations
        JOIN devices ON devices.id = device_authorizations.authorizer_device_id
        WHERE device_authorizations.token_digest = ?
          AND devices.user_id = device_authorizations.user_id
          AND devices.revoked_at IS NULL
          AND (devices.expires_at IS NULL OR devices.expires_at > ?)
      `).get(this.tokenDigest(input.authorization_token), timestamp) as unknown as DeviceAuthorizationRow | undefined;
      if (!row || row.revoked_at !== null || row.claimed_at !== null || row.expired_at !== null) {
        return { failure: "invalid" };
      }
      if (row.expires_at <= timestamp) {
        this.sqlite.prepare("UPDATE device_authorizations SET expired_at = ? WHERE id = ? AND expired_at IS NULL")
          .run(timestamp, row.id);
        return { failure: "expired" };
      }
      const deviceId = input.device_id ?? randomUUID();
      const deviceToken = issueDeviceToken();
      this.sqlite.prepare(`
        INSERT INTO devices(id, user_id, name, token_hash, created_at, token_created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        row.user_id,
        input.device_name,
        this.tokenDigest(deviceToken),
        timestamp,
        timestamp,
        input.expires_at ?? null,
      );
      const claimed = this.sqlite.prepare(`
        UPDATE device_authorizations SET claimed_at = ?, claimed_by_device_id = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?
      `).run(timestamp, deviceId, row.id, timestamp);
      if (Number(claimed.changes) !== 1) throw conflict("Device authorization was claimed concurrently");
      const user = this.sqlite.prepare("SELECT display_name FROM users WHERE id = ?")
        .get(row.user_id) as { display_name: string };
      const actor = { user_id: row.user_id, display_name: user.display_name, device_id: deviceId };
      return {
        actor,
        device: this.getDeviceForUser(row.user_id, deviceId),
        token: deviceToken,
        authorization: this.requireDeviceAuthorization(row.id),
      };
    });
    if ("failure" in result) {
      throw unauthorized(result.failure === "expired"
        ? "Device authorization is expired"
        : "Device authorization is invalid or unavailable");
    }
    return result;
  }

  revokeDeviceAuthorization(actor: Actor, authorizationId: string): DeviceAuthorizationRecord {
    const timestamp = this.now();
    const current = this.requireDeviceAuthorization(authorizationId, actor.user_id);
    if (current.expired_at === null && current.expires_at <= timestamp
      && current.revoked_at === null && current.claimed_at === null) {
      this.sqlite.prepare("UPDATE device_authorizations SET expired_at = ? WHERE id = ? AND expired_at IS NULL")
        .run(timestamp, current.id);
    }
    return this.transaction(() => {
      const authorization = this.requireDeviceAuthorization(authorizationId, actor.user_id);
      if (authorization.claimed_at !== null) throw conflict("Claimed device authorizations cannot be revoked");
      if (authorization.expired_at !== null) throw conflict("Expired device authorizations cannot be revoked");
      if (authorization.revoked_at !== null) return authorization;
      this.sqlite.prepare("UPDATE device_authorizations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(timestamp, authorization.id);
      return this.requireDeviceAuthorization(authorization.id, actor.user_id);
    });
  }

  listDeviceAuthorizations(actor: Actor): DeviceAuthorizationRecord[] {
    const timestamp = this.now();
    this.sqlite.prepare(`
      UPDATE device_authorizations SET expired_at = ?
      WHERE user_id = ? AND expired_at IS NULL AND revoked_at IS NULL
        AND claimed_at IS NULL AND expires_at <= ?
    `).run(timestamp, actor.user_id, timestamp);
    const rows = this.sqlite.prepare("SELECT * FROM device_authorizations WHERE user_id = ? ORDER BY created_at DESC, id")
      .all(actor.user_id) as unknown as DeviceAuthorizationRow[];
    return rows.map((row) => this.publicDeviceAuthorization(row));
  }

  createInvitation(actor: Actor, sessionId: string, input: {
    role: InvitationRole;
    ttl?: InvitationTtl | undefined;
  }): CreateInvitationResult {
    const session = this.requireSessionOwnedBy(sessionId, actor.user_id);
    if (session.state !== "active") throw conflict("Archived sessions do not accept invitations");
    const ttl = input.ttl ?? "24h";
    const ttlMs = INVITATION_TTL_MS[ttl];
    if (ttlMs === undefined) throw conflict("Invitation TTL must be 1h, 24h, or 7d");
    const invitationId = randomUUID();
    const inviteToken = issueInvitationToken();
    const createdAtDate = this.clock();
    const createdAt = createdAtDate.toISOString();
    const expiresAt = new Date(createdAtDate.getTime() + ttlMs).toISOString();
    return this.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO invitations(id, session_id, inviter_user_id, role, token_digest, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        invitationId,
        sessionId,
        actor.user_id,
        input.role,
        this.tokenDigest(inviteToken),
        createdAt,
        expiresAt,
      );
      this.appendInvitationAudit({
        invitation_id: invitationId,
        session_id: sessionId,
        action: "created",
        inviter_user_id: actor.user_id,
        subject_user_id: null,
        subject_device_id: null,
        role: input.role,
        created_at: createdAt,
      });
      return {
        invitation: this.requireInvitation(invitationId),
        invite_token: inviteToken,
      };
    });
  }

  claimInvitation(input: {
    invite_token: string;
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
    device_expires_at?: string | null | undefined;
  }): ClaimInvitationResult {
    const timestamp = this.now();
    const result = this.transaction((): ClaimInvitationResult | { failure: "invalid" | "expired" } => {
      const row = this.sqlite.prepare("SELECT * FROM invitations WHERE token_digest = ?")
        .get(this.tokenDigest(input.invite_token)) as unknown as InvitationRow | undefined;
      if (!row || row.revoked_at !== null || row.claimed_at !== null || row.expired_at !== null) {
        return { failure: "invalid" };
      }
      if (row.expires_at <= timestamp) {
        this.sqlite.prepare("UPDATE invitations SET expired_at = ? WHERE id = ? AND expired_at IS NULL")
          .run(timestamp, row.id);
        this.appendInvitationAudit({
          invitation_id: row.id,
          session_id: row.session_id,
          action: "expired",
          inviter_user_id: row.inviter_user_id,
          subject_user_id: null,
          subject_device_id: null,
          role: row.role,
          created_at: timestamp,
        });
        return { failure: "expired" };
      }
      const session = this.requireSession(row.session_id);
      if (session.state !== "active") return { failure: "invalid" };

      const userId = input.user_id ?? randomUUID();
      const deviceId = input.device_id ?? randomUUID();
      const deviceToken = issueDeviceToken();
      this.sqlite.prepare("INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)")
        .run(userId, input.display_name, timestamp);
      this.sqlite.prepare(`
        INSERT INTO devices(id, user_id, name, token_hash, created_at, token_created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        userId,
        input.device_name,
        this.tokenDigest(deviceToken),
        timestamp,
        timestamp,
        input.device_expires_at ?? null,
      );
      this.sqlite.prepare(`
        INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.session_id, userId, row.role, timestamp, timestamp);
      const claimed = this.sqlite.prepare(`
        UPDATE invitations
        SET claimed_at = ?, claimed_by_user_id = ?, claimed_by_device_id = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?
      `).run(timestamp, userId, deviceId, row.id, timestamp);
      if (Number(claimed.changes) !== 1) throw conflict("Invitation was claimed concurrently");
      this.appendInvitationAudit({
        invitation_id: row.id,
        session_id: row.session_id,
        action: "claimed",
        inviter_user_id: row.inviter_user_id,
        subject_user_id: userId,
        subject_device_id: deviceId,
        role: row.role,
        created_at: timestamp,
      });
      const event = this.appendInsideTransaction(userId, row.session_id, {
        idempotency_key: `invitation-claim-${row.id}`,
        type: "membership_change",
        visibility: "session",
        payload: {
          action: "joined",
          invitation_id: row.id,
          inviter_user_id: row.inviter_user_id,
          user_id: userId,
          role: row.role,
        },
      }, null);
      const actor = { user_id: userId, display_name: input.display_name, device_id: deviceId };
      return {
        actor,
        token: deviceToken,
        device: this.getDeviceForUser(userId, deviceId),
        invitation: this.requireInvitation(row.id),
        event,
      };
    });
    if ("failure" in result) {
      throw unauthorized(result.failure === "expired" ? "Invitation is expired" : "Invitation is invalid or unavailable");
    }
    return result;
  }

  claimInvitationForActor(actor: Actor, inviteToken: string): AcceptInvitationResult {
    const timestamp = this.now();
    const result = this.transaction((): AcceptInvitationResult | { failure: "invalid" | "expired" } => {
      const device = this.sqlite.prepare(`
        SELECT id FROM devices
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(actor.device_id, actor.user_id, timestamp);
      if (!device) return { failure: "invalid" };
      const row = this.sqlite.prepare("SELECT * FROM invitations WHERE token_digest = ?")
        .get(this.tokenDigest(inviteToken)) as unknown as InvitationRow | undefined;
      if (!row || row.revoked_at !== null || row.claimed_at !== null || row.expired_at !== null) {
        return { failure: "invalid" };
      }
      if (row.expires_at <= timestamp) {
        this.expireInvitation(this.publicInvitation(row), timestamp);
        return { failure: "expired" };
      }
      const session = this.requireSession(row.session_id);
      if (session.state !== "active") return { failure: "invalid" };
      if (this.membershipRole(row.session_id, actor.user_id) !== null) {
        throw conflict("User is already a member of this session");
      }
      this.sqlite.prepare(`
        INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.session_id, actor.user_id, row.role, timestamp, timestamp);
      const claimed = this.sqlite.prepare(`
        UPDATE invitations
        SET claimed_at = ?, claimed_by_user_id = ?, claimed_by_device_id = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?
      `).run(timestamp, actor.user_id, actor.device_id, row.id, timestamp);
      if (Number(claimed.changes) !== 1) throw conflict("Invitation was claimed concurrently");
      this.appendInvitationAudit({
        invitation_id: row.id,
        session_id: row.session_id,
        action: "claimed",
        inviter_user_id: row.inviter_user_id,
        subject_user_id: actor.user_id,
        subject_device_id: actor.device_id,
        role: row.role,
        created_at: timestamp,
      });
      const event = this.appendInsideTransaction(actor.user_id, row.session_id, {
        idempotency_key: `invitation-claim-${row.id}`,
        type: "membership_change",
        visibility: "session",
        payload: {
          action: "joined",
          invitation_id: row.id,
          inviter_user_id: row.inviter_user_id,
          user_id: actor.user_id,
          role: row.role,
        },
      }, null);
      return { actor, invitation: this.requireInvitation(row.id), event };
    });
    if ("failure" in result) {
      throw unauthorized(result.failure === "expired" ? "Invitation is expired" : "Invitation is invalid or unavailable");
    }
    return result;
  }

  revokeInvitation(actor: Actor, sessionId: string, invitationId: string): InvitationRecord {
    this.requireSessionOwnedBy(sessionId, actor.user_id);
    const timestamp = this.now();
    this.expirePendingInvitations(sessionId, timestamp);
    return this.transaction(() => {
      const invitation = this.requireInvitation(invitationId, sessionId);
      if (invitation.claimed_at !== null) throw conflict("Claimed invitations cannot be revoked");
      if (invitation.expired_at !== null) throw conflict("Expired invitations cannot be revoked");
      if (invitation.revoked_at !== null) return invitation;
      this.sqlite.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(timestamp, invitationId);
      this.appendInvitationAudit({
        invitation_id: invitation.id,
        session_id: invitation.session_id,
        action: "revoked",
        inviter_user_id: invitation.inviter_user_id,
        subject_user_id: null,
        subject_device_id: null,
        role: invitation.role,
        created_at: timestamp,
      });
      return this.requireInvitation(invitationId, sessionId);
    });
  }

  listInvitations(actor: Actor, sessionId: string): InvitationRecord[] {
    this.requireSessionOwnedBy(sessionId, actor.user_id);
    this.expirePendingInvitations(sessionId, this.now());
    const rows = this.sqlite.prepare("SELECT * FROM invitations WHERE session_id = ? ORDER BY created_at DESC, id")
      .all(sessionId) as unknown as InvitationRow[];
    return rows.map((row) => this.publicInvitation(row));
  }

  listInvitationAudit(actor: Actor, sessionId: string): InvitationAuditRecord[] {
    this.requireSessionOwnedBy(sessionId, actor.user_id);
    this.expirePendingInvitations(sessionId, this.now());
    return this.sqlite.prepare(`
      SELECT id, invitation_id, session_id, action, inviter_user_id,
             subject_user_id, subject_device_id, role, created_at
      FROM invitation_audit WHERE session_id = ? ORDER BY rowid
    `).all(sessionId) as unknown as InvitationAuditRecord[];
  }

  createSession(actor: Actor, input: {
    session_id?: string | undefined;
    idempotency_key: string;
    mode: SessionMode;
    title: string;
  }): { session: SessionRecord; event: CanonicalEvent } {
    const sessionId = input.session_id ?? `session-${createHash("sha256")
      .update(`${actor.user_id}\0${input.idempotency_key}`)
      .digest("hex")
      .slice(0, 32)}`;
    const timestamp = this.now();
    return this.transaction(() => {
      const creationPayload = { action: "created", mode: input.mode, title: input.title } satisfies JsonValue;
      const existingSession = this.sqlite.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
      if (existingSession) {
        const existingEvent = this.findByIdempotencyKey(sessionId, input.idempotency_key);
        if (!existingEvent) throw idempotencyConflict("Session ID already exists with another operation");
        return {
          session: this.requireSession(sessionId),
          event: this.requireIdempotencyMatch(
            existingEvent,
            actor.user_id,
            "session_state_change",
            creationPayload,
          ),
        };
      }
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
        payload: creationPayload,
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
             sessions.updated_at,
             (SELECT COUNT(*) FROM memberships AS session_members
              WHERE session_members.session_id = sessions.id) AS member_count
      FROM memberships
      JOIN sessions ON sessions.id = memberships.session_id
      WHERE memberships.user_id = ?
      ORDER BY sessions.updated_at DESC, sessions.id ASC
    `).all(userId) as unknown as SessionListItem[];
  }

  listSessionMembers(sessionId: string): SessionMemberRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT memberships.user_id, users.display_name, memberships.role,
             runtimes.id AS runtime_id, runtimes.session_id AS runtime_session_id,
             runtimes.user_id AS runtime_user_id, runtimes.device_id,
             runtimes.harness, runtimes.provider, runtimes.model,
             runtimes.local_session_id, runtimes.capture_fidelity,
             runtimes.status, runtimes.last_seen_at
      FROM memberships
      JOIN users ON users.id = memberships.user_id
      LEFT JOIN runtimes ON runtimes.id = (
        SELECT candidate.id FROM runtimes AS candidate
        WHERE candidate.session_id = memberships.session_id
          AND candidate.user_id = memberships.user_id
          AND candidate.status != 'revoked'
        ORDER BY CASE WHEN candidate.status = 'online' THEN 0 ELSE 1 END,
                 candidate.last_seen_at DESC
        LIMIT 1
      )
      WHERE memberships.session_id = ?
      ORDER BY CASE memberships.role WHEN 'owner' THEN 0 WHEN 'participant' THEN 1 ELSE 2 END,
               users.display_name ASC
    `).all(sessionId) as Array<Record<string, string | null>>;

    return rows.map((row) => ({
      user_id: String(row.user_id),
      display_name: String(row.display_name),
      role: row.role as MembershipRole,
      runtime: row.runtime_id === null ? null : {
        id: String(row.runtime_id),
        session_id: String(row.runtime_session_id),
        user_id: String(row.runtime_user_id),
        device_id: String(row.device_id),
        harness: String(row.harness),
        provider: String(row.provider),
        model: String(row.model),
        local_session_id: String(row.local_session_id),
        capture_fidelity: row.capture_fidelity as CaptureFidelity,
        status: row.status as RuntimeRecord["status"],
        last_seen_at: String(row.last_seen_at),
      },
    }));
  }

  membershipRole(sessionId: string, userId: string): MembershipRole | null {
    const row = this.sqlite.prepare("SELECT role FROM memberships WHERE session_id = ? AND user_id = ?")
      .get(sessionId, userId) as unknown as MembershipRow | undefined;
    return row?.role ?? null;
  }

  setMembership(actor: Actor, sessionId: string, userId: string, role: "participant" | "viewer", idempotencyKey: string): CanonicalEvent {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, idempotencyKey);
      const payload = { action: "set", user_id: userId, role } satisfies JsonValue;
      if (existing) return this.requireIdempotencyMatch(existing, actor.user_id, "membership_change", payload);
      const timestamp = this.now();
      this.sqlite.prepare(`
        INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
      `).run(sessionId, userId, role, timestamp, timestamp);
      return this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: idempotencyKey,
        type: "membership_change",
        visibility: "session",
        payload,
      }, null);
    });
  }

  removeMembership(actor: Actor, sessionId: string, userId: string, idempotencyKey: string): CanonicalEvent {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, idempotencyKey);
      const payload = { action: "removed", user_id: userId } satisfies JsonValue;
      if (existing) return this.requireIdempotencyMatch(existing, actor.user_id, "membership_change", payload);
      const result = this.sqlite.prepare("DELETE FROM memberships WHERE session_id = ? AND user_id = ? AND role != 'owner'")
        .run(sessionId, userId);
      if (Number(result.changes) === 0) throw notFound("Membership");
      return this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: idempotencyKey,
        type: "membership_change",
        visibility: "session",
        payload,
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
        event: this.requireIdempotencyMatch(existing, actor.user_id, "session_state_change"),
      };
      const session = this.requireSession(sessionId);
      const next = {
        mode: input.mode ?? session.mode,
        state: input.state ?? session.state,
        title: input.title ?? session.title,
      };
      this.sqlite.prepare("UPDATE sessions SET mode = ?, state = ?, title = ?, updated_at = ? WHERE id = ?")
        .run(next.mode, next.state, next.title, this.now(), sessionId);
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
    this.assertActiveDevice(actor);
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, input.idempotency_key);
      if (existing) return this.requireIdempotencyMatch(
        existing,
        actor.user_id,
        input.type,
        input.payload,
        input.reply_to_event_id ?? null,
        input.visibility ?? "session",
        provenance?.runtime_id ?? null,
      );
      return this.appendInsideTransaction(actor.user_id, sessionId, input, provenance);
    });
  }

  replay(
    sessionId: string,
    afterSequence: number,
    limit: number,
    canSeeOwnerOnly: boolean,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): ReplayResponse {
    const session = this.requireSession(sessionId);
    const query = this.sqlite.prepare(`
      SELECT * FROM events
      WHERE session_id = ? AND sequence > ? AND (visibility = 'session' OR ? = 1)
      ORDER BY sequence ASC LIMIT ?
    `);
    const events: CanonicalEvent[] = [];
    let encodedBytes = 0;
    let scanCursor = afterSequence;
    let stoppedForBudget = false;
    while (events.length < limit) {
      const batchSize = Math.min(4, limit - events.length);
      const rows = query.all(sessionId, scanCursor, canSeeOwnerOnly ? 1 : 0, batchSize) as unknown as EventRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = mapEvent(row);
        const eventBytes = Buffer.byteLength(JSON.stringify(event));
        if (events.length > 0 && encodedBytes + eventBytes > maxBytes) {
          stoppedForBudget = true;
          break;
        }
        events.push(event);
        encodedBytes += eventBytes;
        scanCursor = event.sequence;
      }
      if (stoppedForBudget || rows.length < batchSize) break;
    }
    const lastVisibleSequence = events.at(-1)?.sequence ?? afterSequence;
    const hasMoreVisible = stoppedForBudget || Boolean(this.sqlite.prepare(`
      SELECT 1 FROM events
      WHERE session_id = ? AND sequence > ? AND (visibility = 'session' OR ? = 1)
      LIMIT 1
    `).get(sessionId, lastVisibleSequence, canSeeOwnerOnly ? 1 : 0));
    const hasMore = hasMoreVisible;
    const cursor = hasMore
      ? lastVisibleSequence
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
    if (input.device_id !== actor.device_id) throw unauthorized("Runtime device must match the authenticated device");
    this.assertActiveDevice(actor);
    const runtimeId = input.runtime_id ?? randomUUID();
    const timestamp = this.now();
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
    this.assertActiveDevice(actor);
    const result = this.sqlite.prepare("UPDATE runtimes SET status = 'online', last_seen_at = ? WHERE id = ? AND user_id = ? AND device_id = ? AND status != 'revoked'")
      .run(this.now(), runtimeId, actor.user_id, actor.device_id);
    if (Number(result.changes) === 0) throw notFound("Runtime");
    return this.getRuntime(runtimeId);
  }

  claimAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string): { request_event_id: string; runtime_id: string; status: string } {
    this.assertActiveDevice(actor);
    return this.transaction(() => {
      const event = this.getEvent(sessionId, requestEventId);
      if (event.type !== "agent_request") throw conflict("Only agent_request events can be claimed");
      const runtime = this.getRuntime(runtimeId);
      if (runtime.session_id !== sessionId || runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
        || event.actor_user_id !== actor.user_id || runtime.status === "revoked") {
        throw conflict("The request is eligible only for the initiating user's active runtime");
      }
      const existing = this.sqlite.prepare("SELECT runtime_id, status FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (existing) {
        if (existing.runtime_id !== runtimeId) throw conflict("Agent request is already claimed by another runtime");
        return { request_event_id: requestEventId, runtime_id: runtimeId, status: existing.status };
      }
      const active = this.sqlite.prepare(`
        SELECT request_event_id FROM agent_request_claims
        WHERE runtime_id = ? AND status = 'claimed' AND request_event_id != ?
        LIMIT 1
      `).get(runtimeId, requestEventId) as { request_event_id: string } | undefined;
      if (active) throw runtimeBusy();
      this.sqlite.prepare("INSERT INTO agent_request_claims(request_event_id, runtime_id, claimed_at, status) VALUES (?, ?, ?, 'claimed')")
        .run(requestEventId, runtimeId, this.now());
      return { request_event_id: requestEventId, runtime_id: runtimeId, status: "claimed" };
    });
  }

  completeAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string, idempotencyKey: string, payload: JsonValue): CanonicalEvent {
    this.assertActiveDevice(actor);
    return this.transaction(() => {
      const runtime = this.getRuntime(runtimeId);
      if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
        || runtime.session_id !== sessionId || runtime.status === "revoked") {
        throw conflict("A matching active runtime on the authenticated device is required");
      }
      const existingEvent = this.findByIdempotencyKey(sessionId, idempotencyKey);
      if (existingEvent) return this.requireIdempotencyMatch(
        existingEvent,
        actor.user_id,
        "agent_response",
        payload,
        requestEventId,
        "session",
        runtimeId,
      );
      const claim = this.sqlite.prepare("SELECT runtime_id, status FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (!claim || claim.runtime_id !== runtimeId || claim.status !== "claimed") {
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
        .run(this.now(), requestEventId);
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

  private now(): string {
    return this.clock().toISOString();
  }

  private tokenDigest(token: string): string {
    return createHmac("sha256", this.authTokenPepper).update(token).digest("hex");
  }

  private getDeviceForUser(userId: string, deviceId: string): DeviceRecord {
    const row = this.sqlite.prepare(`
      SELECT id, user_id, name, created_at, COALESCE(token_created_at, created_at) AS token_created_at,
             last_used_at, expires_at, revoked_at, rotated_at, token_version
      FROM devices WHERE id = ? AND user_id = ?
    `).get(deviceId, userId) as unknown as DeviceRecord | undefined;
    if (!row) throw notFound("Device");
    return row;
  }

  private requireSessionOwnedBy(sessionId: string, userId: string): SessionRecord {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE id = ? AND owner_user_id = ?")
      .get(sessionId, userId) as unknown as SessionRow | undefined;
    if (!row) throw notFound("Session");
    return row;
  }

  private publicInvitation(row: InvitationRow): InvitationRecord {
    return {
      id: row.id,
      session_id: row.session_id,
      inviter_user_id: row.inviter_user_id,
      role: row.role,
      created_at: row.created_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      expired_at: row.expired_at,
      claimed_at: row.claimed_at,
      claimed_by_user_id: row.claimed_by_user_id,
      claimed_by_device_id: row.claimed_by_device_id,
    };
  }

  private publicDeviceAuthorization(row: DeviceAuthorizationRow): DeviceAuthorizationRecord {
    return {
      id: row.id,
      user_id: row.user_id,
      authorizer_device_id: row.authorizer_device_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      expired_at: row.expired_at,
      claimed_at: row.claimed_at,
      claimed_by_device_id: row.claimed_by_device_id,
    };
  }

  private requireDeviceAuthorization(authorizationId: string, userId?: string): DeviceAuthorizationRecord {
    const row = (userId === undefined
      ? this.sqlite.prepare("SELECT * FROM device_authorizations WHERE id = ?").get(authorizationId)
      : this.sqlite.prepare("SELECT * FROM device_authorizations WHERE id = ? AND user_id = ?")
        .get(authorizationId, userId)
    ) as unknown as DeviceAuthorizationRow | undefined;
    if (!row) throw notFound("Device authorization");
    return this.publicDeviceAuthorization(row);
  }

  private requireInvitation(invitationId: string, sessionId?: string): InvitationRecord {
    const row = (sessionId === undefined
      ? this.sqlite.prepare("SELECT * FROM invitations WHERE id = ?").get(invitationId)
      : this.sqlite.prepare("SELECT * FROM invitations WHERE id = ? AND session_id = ?").get(invitationId, sessionId)
    ) as unknown as InvitationRow | undefined;
    if (!row) throw notFound("Invitation");
    return this.publicInvitation(row);
  }

  private appendInvitationAudit(input: Omit<InvitationAuditRecord, "id">): void {
    this.sqlite.prepare(`
      INSERT INTO invitation_audit(
        id, invitation_id, session_id, action, inviter_user_id,
        subject_user_id, subject_device_id, role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.invitation_id,
      input.session_id,
      input.action,
      input.inviter_user_id,
      input.subject_user_id,
      input.subject_device_id,
      input.role,
      input.created_at,
    );
  }

  private expireInvitation(invitation: InvitationRecord, timestamp: string): void {
    const result = this.sqlite.prepare(`
      UPDATE invitations SET expired_at = ?
      WHERE id = ? AND expired_at IS NULL AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at <= ?
    `).run(timestamp, invitation.id, timestamp);
    if (Number(result.changes) === 0) return;
    this.appendInvitationAudit({
      invitation_id: invitation.id,
      session_id: invitation.session_id,
      action: "expired",
      inviter_user_id: invitation.inviter_user_id,
      subject_user_id: null,
      subject_device_id: null,
      role: invitation.role,
      created_at: timestamp,
    });
  }

  private expirePendingInvitations(sessionId: string, timestamp: string): void {
    this.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT * FROM invitations
        WHERE session_id = ? AND expired_at IS NULL AND revoked_at IS NULL
          AND claimed_at IS NULL AND expires_at <= ?
      `).all(sessionId, timestamp) as unknown as InvitationRow[];
      for (const row of rows) this.expireInvitation(this.publicInvitation(row), timestamp);
    });
  }

  private migrateDeviceCredentialColumns(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const additions: Array<[string, string]> = [
      ["token_created_at", "TEXT"],
      ["last_used_at", "TEXT"],
      ["expires_at", "TEXT"],
      ["rotated_at", "TEXT"],
      ["token_version", "INTEGER NOT NULL DEFAULT 1"],
    ];
    let addedTokenCreatedAt = false;
    for (const [name, declaration] of additions) {
      if (!columns.has(name)) {
        this.sqlite.exec(`ALTER TABLE devices ADD COLUMN ${name} ${declaration}`);
        if (name === "token_created_at") addedTokenCreatedAt = true;
      }
    }
    if (addedTokenCreatedAt) {
      this.sqlite.exec("UPDATE devices SET token_created_at = created_at WHERE token_created_at IS NULL");
    }
  }

  private initializeEventStorageUsage(): void {
    const usageRows = this.sqlite.prepare("SELECT count(*) AS count FROM event_storage_usage").get() as unknown as CountRow;
    if (usageRows.count !== 0) return;
    this.sqlite.exec(`
      INSERT INTO event_storage_usage(session_id, actor_user_id, bytes)
      SELECT session_id, actor_user_id,
        SUM(length(CAST(payload_json AS BLOB))
          + COALESCE(length(CAST(runtime_provenance_json AS BLOB)), 0) + 512)
      FROM events GROUP BY session_id, actor_user_id
    `);
  }

  private enforceEventStorageQuota(sessionId: string, actorUserId: string, eventBytes: number): void {
    const sessionUsage = this.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM event_storage_usage WHERE session_id = ?")
      .get(sessionId) as unknown as BytesRow;
    if (sessionUsage.bytes + eventBytes > this.maxSessionEventBytes) {
      throw storageQuotaExceeded("session", this.maxSessionEventBytes);
    }
    const userUsage = this.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM event_storage_usage WHERE actor_user_id = ?")
      .get(actorUserId) as unknown as BytesRow;
    if (userUsage.bytes + eventBytes > this.maxUserEventBytes) {
      throw storageQuotaExceeded("user", this.maxUserEventBytes);
    }
    const totalUsage = this.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM event_storage_usage")
      .get() as unknown as BytesRow;
    if (totalUsage.bytes + eventBytes > this.maxTotalEventBytes) {
      throw storageQuotaExceeded("deployment", this.maxTotalEventBytes);
    }
  }

  private findByIdempotencyKey(sessionId: string, key: string): CanonicalEvent | null {
    const row = this.sqlite.prepare("SELECT * FROM events WHERE session_id = ? AND idempotency_key = ?")
      .get(sessionId, key) as unknown as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  private requireIdempotencyMatch(
    event: CanonicalEvent,
    actorUserId: string,
    type: EventType,
    payload?: JsonValue,
    replyTo: string | null = event.reply_to_event_id,
    visibility: EventVisibility = event.visibility,
    runtimeId: string | null = event.runtime_provenance?.runtime_id ?? null,
  ): CanonicalEvent {
    const matches = event.actor_user_id === actorUserId
      && event.type === type
      && event.reply_to_event_id === replyTo
      && event.visibility === visibility
      && (payload === undefined || stableJson(event.payload) === stableJson(payload))
      && (event.runtime_provenance?.runtime_id ?? null) === runtimeId;
    if (!matches) throw idempotencyConflict();
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
      created_at: this.now(),
      visibility: input.visibility ?? "session",
      reply_to_event_id: input.reply_to_event_id ?? null,
      payload: input.payload,
      runtime_provenance: provenance,
    };
    const payloadJson = JSON.stringify(event.payload);
    const provenanceJson = event.runtime_provenance === null ? null : JSON.stringify(event.runtime_provenance);
    const eventBytes = Buffer.byteLength(payloadJson) + (provenanceJson === null ? 0 : Buffer.byteLength(provenanceJson)) + 512;
    if (eventBytes > this.maxEventBytes) throw storageQuotaExceeded("event", this.maxEventBytes);
    this.enforceEventStorageQuota(sessionId, actorUserId, eventBytes);
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
      payloadJson,
      provenanceJson,
    );
    this.sqlite.prepare(`
      INSERT INTO event_storage_usage(session_id, actor_user_id, bytes) VALUES (?, ?, ?)
      ON CONFLICT(session_id, actor_user_id) DO UPDATE SET bytes = bytes + excluded.bytes
    `).run(sessionId, actorUserId, eventBytes);
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
