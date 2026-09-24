import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  CanonicalEvent,
  CaptureFidelity,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CreateHistorySummaryInput,
  DeviceAuthorizationRecord,
  EventType,
  EventVisibility,
  HistoryContext,
  InvitationAuditRecord,
  InvitationRecord,
  InvitationRole,
  InvitationTtl,
  JsonValue,
  MembershipRole,
  ProjectInvitationAuditRecord,
  ProjectInvitationRecord,
  ProjectListItem,
  ReplayResponse,
  RuntimeExecutionProfile,
  RuntimeProvenance,
  SessionListItem,
  SessionMode,
  SnapshotFailure,
  SnapshotRequestRecord,
  SnapshotRequestKind,
  SnapshotRequestStatus,
} from "@gatherthread/protocol";
import {
  MAX_SNAPSHOT_RESULT_BYTES, RuntimeExecutionProfilesSchema, isCodeSyncRequestKind,
  HISTORY_SUMMARY_MAX_CONTEXT_BYTES, HistorySummaryError, buildHistoryContext,
  buildHistorySummaryPrompt, historySummaryMarker, historySummarySourceJson, historySummaryText,
  isHistorySummaryRequest, selectHistorySummarySources,
} from "@gatherthread/protocol";
import { CODE_REPOSITORY_SCHEMA } from "./code-repository-schema.js";
import { ApiError, agentRequestAlreadyClaimed, agentRequestAlreadyCompleted, conflict, forbidden, idempotencyConflict, notFound, runtimeBusy, sessionQuotaExceeded, snapshotStorageQuotaExceeded, storageQuotaExceeded, unauthorized } from "./errors.js";
import { redactJson } from "./redaction.js";

export interface Actor {
  user_id: string;
  display_name: string;
  device_id: string;
}

export interface SessionRecord {
  id: string;
  project_id: string;
  owner_user_id: string;
  mode: SessionMode;
  title: string;
  state: "active" | "archived";
  next_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRecord {
  id: string;
  owner_user_id: string;
  title: string;
  state: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ProjectMemberRecord {
  user_id: string;
  display_name: string;
  role: MembershipRole;
}

export interface RuntimeRecord {
  id: string;
  session_id: string;
  user_id: string;
  device_id: string;
  purpose: "execution" | "snapshot_connector";
  harness: string;
  provider: string;
  model: string;
  execution_profiles?: RuntimeExecutionProfile[];
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
  maxSnapshotResultBytes?: number | undefined;
  maxUserSnapshotBytes?: number | undefined;
  maxSessionSnapshotBytes?: number | undefined;
  maxTotalSnapshotBytes?: number | undefined;
  maxUserActiveSnapshotRequests?: number | undefined;
  maxSessionActiveSnapshotRequests?: number | undefined;
  maxTotalActiveSnapshotRequests?: number | undefined;
  maxUserSessions?: number | undefined;
  maxProjectSessions?: number | undefined;
  maxTotalSessions?: number | undefined;
}

export interface CreateInvitationResult {
  invitation: InvitationRecord;
  invite_token: string;
}

export interface ClaimInvitationResult {
  actor: Actor;
  token: string;
  device: DeviceRecord;
  invitation: InvitationRecord | ProjectInvitationRecord;
  event: CanonicalEvent | null;
}

export interface ClaimInvitationWithBrowserSessionResult extends ClaimInvitationResult {
  browser_session: BrowserSessionIssue;
}

export interface ClaimTestAccessResult {
  actor: Actor;
  token: string;
  device: DeviceRecord;
}

export interface ClaimTestAccessWithBrowserSessionResult extends ClaimTestAccessResult {
  browser_session: BrowserSessionIssue;
}

export interface AcceptInvitationResult {
  actor: Actor;
  invitation: InvitationRecord | ProjectInvitationRecord;
  event: CanonicalEvent | null;
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

export interface BrowserSessionIssue {
  session_id: string;
  token: string;
  expires_at: string;
  remembered: boolean;
}

export interface BrowserSessionAuthentication {
  actor: Actor;
  session_id: string;
}

interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  idempotency_key: string;
  type: EventType;
  actor_user_id: string;
  actor_display_name: string;
  created_at: string;
  visibility: EventVisibility;
  reply_to_event_id: string | null;
  payload_json: string;
  runtime_provenance_json: string | null;
}

interface SessionRow extends SessionRecord {}
interface ProjectRow extends ProjectRecord { creation_idempotency_key: string }
interface ProjectMutationRow {
  project_id: string;
  idempotency_key: string;
  actor_user_id: string;
  title: string;
  created_at: string;
}
interface RuntimeRow extends Omit<RuntimeRecord, "execution_profiles"> {
  execution_profiles_json: string | null;
}
interface CountRow { count: number }
interface BytesRow { bytes: number }
interface SequenceRow { next_sequence: number }
interface MembershipRow { role: MembershipRole }
interface ClaimRow {
  runtime_id: string;
  status: "claimed" | "completed" | "failed";
  attempt_count?: number;
  lease_expires_at?: string | null;
}
export interface AgentClaimRecord {
  request_event_id: string;
  runtime_id: string;
  status: "claimed" | "completed";
  attempt_count: number;
}
export type AgentClaimOutcome =
  | { claim: AgentClaimRecord }
  | { failed: true; event?: CanonicalEvent };
interface InvitationRow extends InvitationRecord { token_digest: string }
interface ProjectInvitationRow extends ProjectInvitationRecord { token_digest: string }
interface DeviceAuthorizationRow extends DeviceAuthorizationRecord { token_digest: string }
interface BrowserSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  token_digest: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface LocalTurnCommitRow {
  input_digest: string;
  head_before_commit: number;
  request_event_id: string;
  response_event_id: string;
  tool_event_ids_json: string;
}
interface SnapshotRequestRow {
  id: string;
  session_id: string;
  requested_by_user_id: string;
  request_kind: SnapshotRequestKind;
  through_sequence: number;
  status: SnapshotRequestStatus;
  target_runtime_id: string | null;
  claimed_by_runtime_id: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  result_json: string | null;
  failure_json: string | null;
  storage_bytes: number;
}

const INVITATION_TTL_MS: Readonly<Record<InvitationTtl, number>> = {
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

const PROCESS_CREDENTIAL_PEPPER = randomBytes(32).toString("base64url");
const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const BROWSER_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const REMEMBERED_BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_USER_EVENT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SESSION_EVENT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_EVENT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_USER_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSION_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_LIST_BYTES = 128 * 1024;
// Covers every bounded pending/claimed field, including a maximum-length runtime ID,
// plus conservative SQLite row/index overhead. It remains charged for terminal audit rows.
const SNAPSHOT_REQUEST_METADATA_BYTES = 1_024;
const DEFAULT_MAX_USER_ACTIVE_SNAPSHOT_REQUESTS = 64;
const DEFAULT_MAX_SESSION_ACTIVE_SNAPSHOT_REQUESTS = 256;
const DEFAULT_MAX_TOTAL_ACTIVE_SNAPSHOT_REQUESTS = 4_096;
const RUNTIME_OFFLINE_AFTER_MS = 30_000;
/**
 * How long a claim survives without proof of work. The holder renews it by
 * appending `agent_progress`, so a claim lapses only when its runtime has
 * genuinely gone quiet — which covers a dead device and, just as importantly, a
 * live device whose execution has wedged. Runtime presence is a separate
 * question and deliberately does not extend a lease on its own.
 */
const AGENT_CLAIM_LEASE_MS = 5 * 60_000;
/** Exact-runtime recovery attempts before a request is terminally failed. */
const MAX_AGENT_CLAIM_ATTEMPTS = 3;
const MAX_HISTORY_CONTEXT_SCAN_EVENTS = 10_000;
const MAX_HISTORY_CONTEXT_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_SUMMARY_DEPENDENCY_EVENTS = 10_000;
const MAX_HISTORY_SUMMARY_DEPENDENCY_BYTES = 16 * 1024 * 1024;

function rejectHistorySummaryMetadata(payload: JsonValue): void {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.hasOwn(payload, "history_summary")) {
    throw forbidden("history_summary is server-owned metadata; use the history-summaries endpoint");
  }
}

function historySummaryOperation<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof HistorySummaryError) {
      throw new ApiError(error.code === "too_large" ? 413 : 400, `history_summary_${error.code}`, error.message);
    }
    throw error;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK (can_create_projects IN (0, 1))
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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  creation_idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_user_id, creation_idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS project_memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'participant', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS project_context_policies (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('summary', 'original')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, user_id) REFERENCES project_memberships(project_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS project_mutations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  purpose TEXT NOT NULL DEFAULT 'execution' CHECK (purpose IN ('execution', 'snapshot_connector')),
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  execution_profiles_json TEXT CHECK (execution_profiles_json IS NULL OR json_valid(execution_profiles_json)),
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
  type TEXT NOT NULL CHECK (type IN ('human_chat','agent_request','agent_progress','agent_response','tool_call','tool_result','attachment','context_snapshot','membership_change','session_state_change')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_display_name TEXT NOT NULL,
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
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  lease_expires_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS local_turn_commits (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  local_turn_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  head_before_commit INTEGER NOT NULL CHECK (head_before_commit >= 0),
  request_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  response_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tool_event_ids_json TEXT NOT NULL CHECK (json_valid(tool_event_ids_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, runtime_id, local_turn_id)
) STRICT;
CREATE TABLE IF NOT EXISTS snapshot_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_kind TEXT NOT NULL DEFAULT 'immutable' CHECK (request_kind IN ('immutable', 'visible_history_replace', 'local_sync_status', 'local_auto_upload_enable', 'local_auto_upload_disable', 'local_turn_upload', 'code_sync_status', 'code_upload', 'code_download', 'code_recover', 'code_auto_upload_enable', 'code_auto_upload_disable')),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  target_runtime_id TEXT REFERENCES runtimes(id),
  claimed_by_runtime_id TEXT REFERENCES runtimes(id),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  storage_bytes INTEGER NOT NULL DEFAULT ${SNAPSHOT_REQUEST_METADATA_BYTES} CHECK (storage_bytes >= 0),
  metadata_charged INTEGER NOT NULL DEFAULT 1 CHECK (metadata_charged IN (0, 1))
) STRICT;
CREATE INDEX IF NOT EXISTS snapshot_requests_user_status_idx
  ON snapshot_requests(requested_by_user_id, status, created_at, id);
CREATE TABLE IF NOT EXISTS snapshot_storage_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (session_id, user_id)
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
CREATE TABLE IF NOT EXISTS project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS project_invitations_project_idx ON project_invitations(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS project_invitation_audit (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES project_invitations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created', 'claimed', 'revoked', 'expired')),
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  subject_user_id TEXT REFERENCES users(id),
  subject_device_id TEXT REFERENCES devices(id),
  role TEXT NOT NULL CHECK (role IN ('participant', 'viewer')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS project_invitation_audit_project_idx
  ON project_invitation_audit(project_id, created_at, id);
CREATE TABLE IF NOT EXISTS test_access_grants (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  claimed_at TEXT,
  claimed_by_user_id TEXT REFERENCES users(id),
  claimed_by_device_id TEXT REFERENCES devices(id),
  CHECK (claimed_at IS NULL OR (claimed_by_user_id IS NOT NULL AND claimed_by_device_id IS NOT NULL))
) STRICT;
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
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS browser_sessions_device_idx
  ON browser_sessions(device_id, created_at DESC);
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

function payloadWithClientOccurredAt(payload: JsonValue, occurredAt: string): JsonValue {
  const clientMetadata = { occurred_at: occurredAt } satisfies JsonValue;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...payload, _gatherthread_client: clientMetadata };
  }
  return { value: payload, _gatherthread_client: clientMetadata };
}

function issueDeviceToken(): string {
  return `gta_${randomBytes(32).toString("base64url")}`;
}

function issueInvitationToken(): string {
  return `gti_${randomBytes(32).toString("base64url")}`;
}

function issueTestAccessToken(): string {
  return `gtq_${randomBytes(32).toString("base64url")}`;
}

function issueDeviceAuthorizationToken(): string {
  return `gtd_${randomBytes(32).toString("base64url")}`;
}

function issueBrowserSessionToken(): string {
  return `gtb_${randomBytes(32).toString("base64url")}`;
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

function runtimeStatus(
  value: string | null | undefined,
  lastSeenAt: string | null | undefined,
  now: number,
): RuntimeRecord["status"] {
  if (value === "revoked") return "revoked";
  if (value !== "online") return "offline";
  const lastSeen = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : Number.NaN;
  return Number.isFinite(lastSeen) && now - lastSeen <= RUNTIME_OFFLINE_AFTER_MS
    ? "online"
    : "offline";
}

function parseRuntimeExecutionProfiles(value: string | null | undefined): RuntimeExecutionProfile[] | undefined {
  if (value === null || value === undefined) return undefined;
  return RuntimeExecutionProfilesSchema.parse(JSON.parse(value));
}

function mapRuntimeRow(row: RuntimeRow, now?: number): RuntimeRecord {
  const { execution_profiles_json: executionProfilesJson, ...runtime } = row;
  const executionProfiles = parseRuntimeExecutionProfiles(executionProfilesJson);
  return {
    ...runtime,
    ...(executionProfiles === undefined ? {} : { execution_profiles: executionProfiles }),
    ...(now === undefined ? {} : { status: runtimeStatus(row.status, row.last_seen_at, now) }),
  };
}

/**
 * A claim with no lease was written before leases existed. Nothing renews such a
 * row, so it reads as expired: recovery is the safe interpretation of a claim no
 * live build can be working on.
 */
function claimLeaseLapsed(leaseExpiresAt: string | null | undefined, now: string): boolean {
  if (typeof leaseExpiresAt !== "string") return true;
  const expires = Date.parse(leaseExpiresAt);
  const current = Date.parse(now);
  return !Number.isFinite(expires) || !Number.isFinite(current) || expires <= current;
}

function isLocalSyncRequestKind(kind: SnapshotRequestKind): boolean {
  return isCodeSyncRequestKind(kind) || kind === "local_sync_status"
    || kind === "local_auto_upload_enable"
    || kind === "local_auto_upload_disable"
    || kind === "local_turn_upload";
}

interface AgentRequestTarget {
  harness: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  runtimeId?: string;
}

function agentRequestTarget(event: Pick<CanonicalEvent, "payload">): AgentRequestTarget {
  const payload = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue>
    : undefined;
  const raw = payload?.execution_profile;
  if (raw === undefined) return { harness: "codex" };
  const profile = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, JsonValue>
    : undefined;
  const harness = typeof profile?.harness === "string" ? profile.harness.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(harness)) {
    throw conflict("Agent request has an invalid harness target");
  }
  const rawProvider = profile?.provider;
  const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
  if (rawProvider !== undefined
    && (!provider || provider.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(provider))) {
    throw conflict("Agent request has an invalid provider target");
  }
  const rawModel = profile?.model;
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (rawModel !== undefined
    && (!model || model.length > 160 || /[\u0000-\u001f\u007f-\u009f]/u.test(model))) {
    throw conflict("Agent request has an invalid model target");
  }
  if (harness === "deepseek-harness" && !model) {
    throw conflict("DeepSeek Harness Agent request requires a model target");
  }
  const rawReasoningEffort = profile?.reasoning_effort;
  const reasoningEffort = typeof rawReasoningEffort === "string" ? rawReasoningEffort.trim() : "";
  if (rawReasoningEffort !== undefined
    && (!reasoningEffort || reasoningEffort.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(reasoningEffort))) {
    throw conflict("Agent request has an invalid reasoning effort target");
  }
  const rawRuntimeId = profile?.runtime_id;
  if (rawRuntimeId === undefined) {
    return {
      harness,
      ...(rawProvider === undefined ? {} : { provider }),
      ...(rawModel === undefined ? {} : { model }),
      ...(rawReasoningEffort === undefined ? {} : { reasoningEffort }),
    };
  }
  const runtimeId = typeof rawRuntimeId === "string" ? rawRuntimeId.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runtimeId)) {
    throw conflict("Agent request has an invalid runtime target");
  }
  return {
    harness,
    ...(rawProvider === undefined ? {} : { provider }),
    ...(rawModel === undefined ? {} : { model }),
    ...(rawReasoningEffort === undefined ? {} : { reasoningEffort }),
    runtimeId,
  };
}

function runtimeSupportsAgentTarget(runtime: RuntimeRecord, target: AgentRequestTarget): boolean {
  if (runtime.harness.trim().toLowerCase() !== target.harness) return false;
  if (target.harness === "codex") {
    return target.provider === undefined || runtime.provider === target.provider;
  }
  if (runtime.execution_profiles !== undefined) {
    if (target.runtimeId === undefined || target.runtimeId !== runtime.id
      || target.provider === undefined || target.model === undefined) return false;
    const advertised = runtime.execution_profiles.find((profile) =>
      profile.provider === target.provider && profile.model === target.model);
    if (advertised === undefined) return false;
    return target.reasoningEffort === undefined
      || advertised.reasoning_efforts?.includes(target.reasoningEffort) === true;
  }
  return (target.provider === undefined || runtime.provider === target.provider)
    && (target.model === undefined || runtime.model === target.model);
}

function mapEvent(row: EventRow): CanonicalEvent {
  const storedProvenance = row.runtime_provenance_json === null
    ? null
    : JSON.parse(row.runtime_provenance_json) as RuntimeProvenance;
  return {
    id: row.id,
    session_id: row.session_id,
    sequence: row.sequence,
    idempotency_key: row.idempotency_key,
    type: row.type,
    actor_user_id: row.actor_user_id,
    actor_display_name: row.actor_display_name,
    created_at: row.created_at,
    visibility: row.visibility,
    reply_to_event_id: row.reply_to_event_id,
    payload: JSON.parse(row.payload_json) as JsonValue,
    runtime_provenance: storedProvenance === null
      ? null
      : { ...storedProvenance, local_session_id: "private" },
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
  private readonly maxSnapshotResultBytes: number;
  private readonly maxUserSnapshotBytes: number;
  private readonly maxSessionSnapshotBytes: number;
  private readonly maxTotalSnapshotBytes: number;
  private readonly maxUserActiveSnapshotRequests: number;
  private readonly maxSessionActiveSnapshotRequests: number;
  private readonly maxTotalActiveSnapshotRequests: number;
  private readonly maxUserSessions: number;
  private readonly maxProjectSessions: number;
  private readonly maxTotalSessions: number;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.authTokenPepper = resolveAuthTokenPepper(path, options.authTokenPepper);
    this.clock = options.clock ?? (() => new Date());
    this.maxUserEventBytes = options.maxUserEventBytes ?? DEFAULT_MAX_USER_EVENT_BYTES;
    this.maxSessionEventBytes = options.maxSessionEventBytes ?? DEFAULT_MAX_SESSION_EVENT_BYTES;
    this.maxTotalEventBytes = options.maxTotalEventBytes ?? DEFAULT_MAX_TOTAL_EVENT_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxSnapshotResultBytes = options.maxSnapshotResultBytes ?? MAX_SNAPSHOT_RESULT_BYTES;
    this.maxUserSnapshotBytes = options.maxUserSnapshotBytes ?? DEFAULT_MAX_USER_SNAPSHOT_BYTES;
    this.maxSessionSnapshotBytes = options.maxSessionSnapshotBytes ?? DEFAULT_MAX_SESSION_SNAPSHOT_BYTES;
    this.maxTotalSnapshotBytes = options.maxTotalSnapshotBytes ?? DEFAULT_MAX_TOTAL_SNAPSHOT_BYTES;
    this.maxUserActiveSnapshotRequests = options.maxUserActiveSnapshotRequests ?? DEFAULT_MAX_USER_ACTIVE_SNAPSHOT_REQUESTS;
    this.maxSessionActiveSnapshotRequests = options.maxSessionActiveSnapshotRequests ?? DEFAULT_MAX_SESSION_ACTIVE_SNAPSHOT_REQUESTS;
    this.maxTotalActiveSnapshotRequests = options.maxTotalActiveSnapshotRequests ?? DEFAULT_MAX_TOTAL_ACTIVE_SNAPSHOT_REQUESTS;
    this.maxUserSessions = options.maxUserSessions ?? 512;
    this.maxProjectSessions = options.maxProjectSessions ?? 2_048;
    this.maxTotalSessions = options.maxTotalSessions ?? 8_192;
    for (const [name, value] of [
      ["maxUserEventBytes", this.maxUserEventBytes],
      ["maxSessionEventBytes", this.maxSessionEventBytes],
      ["maxTotalEventBytes", this.maxTotalEventBytes],
      ["maxEventBytes", this.maxEventBytes],
      ["maxSnapshotResultBytes", this.maxSnapshotResultBytes],
      ["maxUserSnapshotBytes", this.maxUserSnapshotBytes],
      ["maxSessionSnapshotBytes", this.maxSessionSnapshotBytes],
      ["maxTotalSnapshotBytes", this.maxTotalSnapshotBytes],
      ["maxUserActiveSnapshotRequests", this.maxUserActiveSnapshotRequests],
      ["maxSessionActiveSnapshotRequests", this.maxSessionActiveSnapshotRequests],
      ["maxTotalActiveSnapshotRequests", this.maxTotalActiveSnapshotRequests],
      ["maxUserSessions", this.maxUserSessions],
      ["maxProjectSessions", this.maxProjectSessions],
      ["maxTotalSessions", this.maxTotalSessions],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (this.maxEventBytes > Math.min(this.maxUserEventBytes, this.maxSessionEventBytes, this.maxTotalEventBytes)
      || this.maxUserEventBytes > this.maxTotalEventBytes || this.maxSessionEventBytes > this.maxTotalEventBytes) {
      throw new RangeError("Event storage limits are inconsistent");
    }
    if (this.maxSnapshotResultBytes > MAX_SNAPSHOT_RESULT_BYTES
      || this.maxSnapshotResultBytes > Math.min(
        this.maxUserSnapshotBytes, this.maxSessionSnapshotBytes, this.maxTotalSnapshotBytes,
      )
      || this.maxUserSnapshotBytes > this.maxTotalSnapshotBytes
      || this.maxSessionSnapshotBytes > this.maxTotalSnapshotBytes) {
      throw new RangeError("Snapshot storage limits are inconsistent");
    }
    if (SNAPSHOT_REQUEST_METADATA_BYTES > Math.min(
      this.maxUserSnapshotBytes, this.maxSessionSnapshotBytes, this.maxTotalSnapshotBytes,
    ) || this.maxUserActiveSnapshotRequests > this.maxTotalActiveSnapshotRequests
      || this.maxSessionActiveSnapshotRequests > this.maxTotalActiveSnapshotRequests) {
      throw new RangeError("Snapshot request metadata limits are inconsistent");
    }
    if (this.maxUserSessions > this.maxTotalSessions || this.maxProjectSessions > this.maxTotalSessions) {
      throw new RangeError("Session count limits are inconsistent");
    }
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_size_limit = 67108864;");
    const journalMode = (this.sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    if (journalMode !== "wal") this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec(SCHEMA);
    this.sqlite.exec(CODE_REPOSITORY_SCHEMA);
    this.migrateCodeRepositoryEnableColumn();
    this.migrateDeviceCredentialColumns();
    this.migrateProjectModel();
    this.migrateAccountCapabilities();
    this.migrateRuntimePurposeColumn();
    this.migrateRuntimeExecutionProfilesColumn();
    this.migrateEventActorDisplayNameColumn();
    this.migrateAgentProgressEventType();
    this.migrateCanonicalProvenancePrivacy();
    this.migrateSnapshotStorageLedger();
    this.migrateSnapshotControlRequests();
    this.migrateAgentClaimLease();
    this.initializeEventStorageUsage();
  }

  close(): void {
    this.sqlite.close();
  }

  journalMode(): string {
    const row = this.sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode;
  }

  readiness(): { journal_mode: string; foreign_keys: boolean; writable: boolean } {
    const journalMode = this.journalMode();
    const foreignKeys = (this.sqlite.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
    let transactionStarted = false;
    try {
      this.sqlite.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      this.sqlite.exec("ROLLBACK;");
      transactionStarted = false;
    } finally {
      if (transactionStarted) {
        try {
          this.sqlite.exec("ROLLBACK;");
        } catch {
          // Preserve the original readiness failure.
        }
      }
    }
    return { journal_mode: journalMode, foreign_keys: foreignKeys, writable: true };
  }

  bootstrapIdentity(input: {
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
  }): { actor: Actor; token: string } {
    const count = this.sqlite.prepare("SELECT count(*) AS count FROM users").get() as unknown as CountRow;
    if (count.count !== 0) throw conflict("Bootstrap is available only for an empty database");
    return this.createIdentity({ ...input, can_create_projects: true });
  }

  createIdentity(input: {
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
    can_create_projects?: boolean | undefined;
  }): { actor: Actor; token: string } {
    const userId = input.user_id ?? randomUUID();
    const deviceId = input.device_id ?? randomUUID();
    const token = issueDeviceToken();
    const createdAt = this.now();
    this.transaction(() => {
      this.sqlite.prepare("INSERT INTO users(id, display_name, created_at, can_create_projects) VALUES (?, ?, ?, ?)")
        .run(userId, input.display_name, createdAt, input.can_create_projects ? 1 : 0);
      this.sqlite.prepare(`
        INSERT INTO devices(id, user_id, name, token_hash, created_at, token_created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(deviceId, userId, input.device_name, this.tokenDigest(token), createdAt, createdAt);
    });
    return { actor: { user_id: userId, display_name: input.display_name, device_id: deviceId }, token };
  }

  canCreateProjects(userId: string): boolean {
    const row = this.sqlite.prepare("SELECT can_create_projects FROM users WHERE id = ?")
      .get(userId) as { can_create_projects: number } | undefined;
    if (!row) throw unauthorized("Account is unavailable");
    return row.can_create_projects === 1;
  }

  issueTestAccess(ttl: InvitationTtl = "7d"): { grant_id: string; access_token: string; expires_at: string } {
    const ttlMs = INVITATION_TTL_MS[ttl];
    if (ttlMs === undefined) throw new ApiError(400, "invalid_ttl", "Test access TTL must be 1h, 24h, or 7d");
    const count = this.sqlite.prepare("SELECT count(*) AS count FROM users").get() as unknown as CountRow;
    if (count.count === 0) throw conflict("Bootstrap the first owner before issuing test access");
    const grantId = randomUUID();
    const accessToken = issueTestAccessToken();
    const createdAt = this.clock();
    const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
    this.sqlite.prepare(`
      INSERT INTO test_access_grants(id, token_digest, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(grantId, this.tokenDigest(accessToken), createdAt.toISOString(), expiresAt);
    return { grant_id: grantId, access_token: accessToken, expires_at: expiresAt };
  }

  revokeTestAccess(grantId: string): void {
    this.transaction(() => {
      const result = this.sqlite.prepare(`
        UPDATE test_access_grants SET revoked_at = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL
      `).run(this.now(), grantId);
      if (Number(result.changes) === 1) return;
      const row = this.sqlite.prepare("SELECT claimed_at FROM test_access_grants WHERE id = ?")
        .get(grantId) as { claimed_at: string | null } | undefined;
      if (!row) throw notFound("Test access grant");
      if (row.claimed_at !== null) throw conflict("Claimed test access cannot be revoked; revoke the issued device instead");
      // An already revoked grant remains revoked; preserve idempotent CLI use.
    });
  }

  claimTestAccess(input: {
    access_token: string;
    display_name: string;
    device_name: string;
    remember_device?: boolean | undefined;
  }): ClaimTestAccessResult;
  claimTestAccess(input: {
    access_token: string;
    display_name: string;
    device_name: string;
    remember_device?: boolean | undefined;
  }, options: { browserSession: true }): ClaimTestAccessWithBrowserSessionResult;
  claimTestAccess(input: {
    access_token: string;
    display_name: string;
    device_name: string;
    remember_device?: boolean | undefined;
  }, options: { browserSession?: boolean } = {}): ClaimTestAccessResult | ClaimTestAccessWithBrowserSessionResult {
    const timestamp = this.now();
    return this.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT id FROM test_access_grants
        WHERE token_digest = ? AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at > ?
      `).get(this.tokenDigest(input.access_token), timestamp) as { id: string } | undefined;
      if (!row) throw unauthorized("Test access token is invalid or unavailable");
      const userId = randomUUID();
      const deviceId = randomUUID();
      const token = issueDeviceToken();
      this.sqlite.prepare(`
        INSERT INTO users(id, display_name, created_at, can_create_projects) VALUES (?, ?, ?, 1)
      `).run(userId, input.display_name, timestamp);
      this.sqlite.prepare(`
        INSERT INTO devices(id, user_id, name, token_hash, created_at, token_created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(deviceId, userId, input.device_name, this.tokenDigest(token), timestamp, timestamp);
      const claimed = this.sqlite.prepare(`
        UPDATE test_access_grants SET claimed_at = ?, claimed_by_user_id = ?, claimed_by_device_id = ?
        WHERE id = ? AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at > ?
      `).run(timestamp, userId, deviceId, row.id, timestamp);
      if (Number(claimed.changes) !== 1) throw unauthorized("Test access token is invalid or unavailable");
      const actor = { user_id: userId, display_name: input.display_name, device_id: deviceId };
      const result: ClaimTestAccessResult = { actor, token, device: this.getDeviceForUser(userId, deviceId) };
      return options.browserSession
        ? { ...result, browser_session: this.insertBrowserSession(actor, new Date(timestamp), input.remember_device === true) }
        : result;
    });
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
      this.sqlite.prepare(`
        UPDATE browser_sessions SET revoked_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
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

  createBrowserSession(
    actor: Actor,
    rememberDevice = false,
    profile: { display_name?: string | undefined; device_name?: string | undefined } = {},
  ): BrowserSessionIssue {
    return this.transaction(() => {
      this.assertActiveDevice(actor);
      if (profile.display_name !== undefined) {
        this.sqlite.prepare("UPDATE users SET display_name = ? WHERE id = ?")
          .run(profile.display_name, actor.user_id);
      }
      if (profile.device_name !== undefined) {
        this.sqlite.prepare("UPDATE devices SET name = ? WHERE id = ? AND user_id = ?")
          .run(profile.device_name, actor.device_id, actor.user_id);
      }
      return this.insertBrowserSession(actor, this.clock(), rememberDevice);
    });
  }

  authenticateBrowserSession(token: string): BrowserSessionAuthentication {
    const timestamp = this.now();
    const row = this.sqlite.prepare(`
      SELECT browser_sessions.*, users.display_name
      FROM browser_sessions
      JOIN devices ON devices.id = browser_sessions.device_id
      JOIN users ON users.id = browser_sessions.user_id
      WHERE browser_sessions.token_digest = ?
        AND browser_sessions.revoked_at IS NULL
        AND browser_sessions.expires_at > ?
        AND devices.user_id = browser_sessions.user_id
        AND devices.revoked_at IS NULL
        AND (devices.expires_at IS NULL OR devices.expires_at > ?)
    `).get(this.tokenDigest(token), timestamp, timestamp) as unknown as (BrowserSessionRow & { display_name: string }) | undefined;
    if (!row) throw unauthorized("Browser session is invalid, expired, or revoked");
    this.sqlite.prepare("UPDATE browser_sessions SET last_used_at = ? WHERE id = ?").run(timestamp, row.id);
    this.sqlite.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(timestamp, row.device_id);
    return {
      actor: { user_id: row.user_id, display_name: row.display_name, device_id: row.device_id },
      session_id: row.id,
    };
  }

  assertActiveBrowserSession(sessionId: string, actor: Actor): void {
    const timestamp = this.now();
    const row = this.sqlite.prepare(`
      SELECT browser_sessions.id
      FROM browser_sessions
      JOIN devices ON devices.id = browser_sessions.device_id
      WHERE browser_sessions.id = ?
        AND browser_sessions.user_id = ?
        AND browser_sessions.device_id = ?
        AND browser_sessions.revoked_at IS NULL
        AND browser_sessions.expires_at > ?
        AND devices.user_id = browser_sessions.user_id
        AND devices.revoked_at IS NULL
        AND (devices.expires_at IS NULL OR devices.expires_at > ?)
    `).get(sessionId, actor.user_id, actor.device_id, timestamp, timestamp);
    if (!row) throw unauthorized("Browser session is invalid, expired, or revoked");
  }

  revokeBrowserSession(sessionId: string, actor: Actor): void {
    const timestamp = this.now();
    const result = this.sqlite.prepare(`
      UPDATE browser_sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL
    `).run(timestamp, sessionId, actor.user_id, actor.device_id);
    if (Number(result.changes) === 0) throw unauthorized("Browser session is invalid, expired, or revoked");
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

  updateDeviceName(actor: Actor, deviceId: string, name: string): DeviceRecord {
    this.assertActiveDevice(actor);
    const result = this.sqlite.prepare(`
      UPDATE devices SET name = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(name, deviceId, actor.user_id);
    if (Number(result.changes) === 0) throw notFound("Device");
    return this.getDeviceForUser(actor.user_id, deviceId);
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
      this.sqlite.prepare(`
        UPDATE browser_sessions SET revoked_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(timestamp, deviceId);
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

  createProject(actor: Actor, input: {
    project_id?: string | undefined;
    idempotency_key: string;
    title: string;
  }): ProjectRecord & { role: "owner"; session_count: number } {
    const projectId = input.project_id ?? `project-${createHash("sha256")
      .update(`${actor.user_id}\0${input.idempotency_key}`)
      .digest("hex")
      .slice(0, 32)}`;
    const timestamp = this.now();
    return this.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT * FROM projects WHERE owner_user_id = ? AND creation_idempotency_key = ?
      `).get(actor.user_id, input.idempotency_key) as unknown as ProjectRow | undefined;
      if (existing) {
        if (existing.id !== projectId || existing.title !== input.title) {
          throw idempotencyConflict("Project creation retry does not match the original request");
        }
        return this.projectCreationResult(existing);
      }
      if (!this.canCreateProjects(actor.user_id)) {
        throw forbidden("This account can join invited projects but cannot create projects");
      }
      if (this.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw idempotencyConflict("Project ID already exists with another operation");
      }
      this.sqlite.prepare(`
        INSERT INTO projects(id, owner_user_id, title, state, creation_idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(projectId, actor.user_id, input.title, input.idempotency_key, timestamp, timestamp);
      this.sqlite.prepare(`
        INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, 'owner', ?, ?)
      `).run(projectId, actor.user_id, timestamp, timestamp);
      return this.projectCreationResult(this.requireProject(projectId));
    });
  }

  deleteProject(actor: Actor, projectId: string): { project_id: string; session_ids: string[] } {
    return this.transaction(() => {
      this.requireProjectOwnedBy(projectId, actor.user_id);
      const sessions = this.sqlite.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY id")
        .all(projectId) as Array<{ id: string }>;
      const result = this.sqlite.prepare("DELETE FROM projects WHERE id = ? AND owner_user_id = ?")
        .run(projectId, actor.user_id);
      if (Number(result.changes) !== 1) throw notFound("Project");
      return { project_id: projectId, session_ids: sessions.map((session) => session.id) };
    });
  }

  updateProject(actor: Actor, projectId: string, input: {
    title: string;
    idempotency_key: string;
  }): ProjectRecord {
    return this.transaction(() => {
      this.requireProjectOwnedBy(projectId, actor.user_id);
      const existing = this.sqlite.prepare(`
        SELECT * FROM project_mutations WHERE project_id = ? AND idempotency_key = ?
      `).get(projectId, input.idempotency_key) as unknown as ProjectMutationRow | undefined;
      if (existing) {
        if (existing.actor_user_id !== actor.user_id || existing.title !== input.title) {
          throw idempotencyConflict("Project update retry does not match the original request");
        }
        return this.requireProject(projectId);
      }
      const timestamp = this.now();
      this.sqlite.prepare(`
        UPDATE projects SET title = ?,
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
        WHERE id = ? AND owner_user_id = ?
      `).run(input.title, timestamp, timestamp, projectId, actor.user_id);
      this.sqlite.prepare(`
        INSERT INTO project_mutations(project_id, idempotency_key, actor_user_id, title, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, input.idempotency_key, actor.user_id, input.title, timestamp);
      return this.requireProject(projectId);
    });
  }

  requireProject(projectId: string): ProjectRecord {
    const row = this.sqlite.prepare("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as unknown as ProjectRow | undefined;
    if (!row) throw notFound("Project");
    return this.publicProject(row);
  }

  listProjects(userId: string): ProjectListItem[] {
    return this.sqlite.prepare(`
      SELECT projects.id, projects.title, projects.state, projects.created_at, projects.updated_at,
             project_memberships.role,
             (SELECT COUNT(*) FROM sessions WHERE sessions.project_id = projects.id) AS session_count
      FROM project_memberships
      JOIN projects ON projects.id = project_memberships.project_id
      WHERE project_memberships.user_id = ?
      ORDER BY projects.updated_at DESC, projects.id ASC
    `).all(userId) as unknown as ProjectListItem[];
  }

  projectMembershipRole(projectId: string, userId: string): MembershipRole | null {
    const row = this.sqlite.prepare(`
      SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?
    `).get(projectId, userId) as unknown as MembershipRow | undefined;
    return row?.role ?? null;
  }

  getProjectContextPolicy(actor: Actor, projectId: string): { mode: "summary" | "original" } {
    this.assertActiveDevice(actor);
    if (this.projectMembershipRole(projectId, actor.user_id) === null) throw notFound("Project");
    const row = this.sqlite.prepare("SELECT mode FROM project_context_policies WHERE project_id = ? AND user_id = ?")
      .get(projectId, actor.user_id) as { mode: "summary" | "original" } | undefined;
    return { mode: row?.mode ?? "summary" };
  }

  setProjectContextPolicy(actor: Actor, projectId: string, mode: "summary" | "original"): { mode: "summary" | "original" } {
    return this.transaction(() => {
      this.getProjectContextPolicy(actor, projectId);
      if (mode !== "summary" && mode !== "original") throw new ApiError(400, "invalid_context_policy", "Unknown context policy");
      // This is the authenticated user's preference, not a shared project mutation.
      this.sqlite.prepare(`
        INSERT INTO project_context_policies(project_id, user_id, mode, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
      `).run(projectId, actor.user_id, mode, this.now());
      return { mode };
    });
  }

  listProjectMembers(projectId: string): ProjectMemberRecord[] {
    return this.sqlite.prepare(`
      SELECT project_memberships.user_id, users.display_name, project_memberships.role
      FROM project_memberships
      JOIN users ON users.id = project_memberships.user_id
      WHERE project_memberships.project_id = ?
      ORDER BY CASE project_memberships.role WHEN 'owner' THEN 0 WHEN 'participant' THEN 1 ELSE 2 END,
               users.display_name ASC
    `).all(projectId) as unknown as ProjectMemberRecord[];
  }

  setProjectMembership(
    actor: Actor,
    projectId: string,
    userId: string,
    role: "participant" | "viewer",
  ): ProjectMemberRecord {
    this.requireProjectOwnedBy(projectId, actor.user_id);
    if (userId === actor.user_id) throw conflict("The project owner's role cannot be changed");
    if (!this.sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) throw notFound("User");
    const timestamp = this.now();
    return this.transaction(() => {
      const existing = this.projectMembershipRole(projectId, userId);
      if (existing === null) throw notFound("Project membership");
      if (existing === "owner") throw conflict("The project owner's role cannot be changed");
      this.sqlite.prepare(`
        UPDATE project_memberships SET role = ?, updated_at = ?
        WHERE project_id = ? AND user_id = ? AND role != 'owner'
      `).run(role, timestamp, projectId, userId);
      this.sqlite.prepare(`
        UPDATE memberships SET role = ?, updated_at = ?
        WHERE user_id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
          AND role != 'owner'
      `).run(role, timestamp, userId, projectId);
      if (role === "viewer") {
        this.sqlite.prepare(`
          UPDATE runtimes SET status = 'revoked'
          WHERE user_id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
            AND purpose = 'execution'
        `).run(userId, projectId);
      }
      this.touchProject(projectId, timestamp);
      return this.requireProjectMember(projectId, userId);
    });
  }

  removeProjectMembership(actor: Actor, projectId: string, userId: string): void {
    this.transaction(() => {
      const actorRole = this.projectMembershipRole(projectId, actor.user_id);
      if (!actorRole) throw notFound("Project");
      if (actorRole === "owner" && userId === actor.user_id) throw conflict("The project owner cannot leave the project");
      if (actorRole !== "owner" && userId !== actor.user_id) throw forbidden("Only the project owner can remove another member");
      const result = this.sqlite.prepare(`
        DELETE FROM project_memberships WHERE project_id = ? AND user_id = ? AND role != 'owner'
      `).run(projectId, userId);
      if (Number(result.changes) === 0) throw notFound("Project membership");
      this.sqlite.prepare(`
        DELETE FROM memberships
        WHERE user_id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
          AND role != 'owner'
      `).run(userId, projectId);
      this.sqlite.prepare(`
        UPDATE runtimes SET status = 'revoked'
        WHERE user_id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
      `).run(userId, projectId);
      this.touchProject(projectId);
    });
  }

  listProjectSessions(projectId: string, userId: string): SessionListItem[] {
    const role = this.projectMembershipRole(projectId, userId);
    if (!role) throw notFound("Project");
    return this.sqlite.prepare(`
      SELECT sessions.id, sessions.project_id, sessions.owner_user_id,
             sessions.title, sessions.mode, sessions.state,
             ? AS role, sessions.next_sequence AS current_sequence, sessions.updated_at,
             (SELECT COUNT(*) FROM project_memberships
              WHERE project_memberships.project_id = sessions.project_id) AS member_count
      FROM sessions
      WHERE sessions.project_id = ?
      ORDER BY sessions.updated_at DESC, sessions.id ASC
    `).all(role, projectId) as unknown as SessionListItem[];
  }

  deleteSession(actor: Actor, sessionId: string): { project_id: string; session_id: string } {
    return this.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT sessions.project_id, sessions.owner_user_id AS session_owner_user_id,
               projects.owner_user_id AS project_owner_user_id
        FROM sessions
        JOIN projects ON projects.id = sessions.project_id
        WHERE sessions.id = ?
      `).get(sessionId) as {
        project_id: string;
        session_owner_user_id: string;
        project_owner_user_id: string;
      } | undefined;
      if (!row || (row.session_owner_user_id !== actor.user_id && row.project_owner_user_id !== actor.user_id)) {
        throw notFound("Session");
      }
      const result = this.sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      if (Number(result.changes) !== 1) throw notFound("Session");
      this.touchProject(row.project_id);
      return { project_id: row.project_id, session_id: sessionId };
    });
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
    remember_device?: boolean | undefined;
  }): ClaimInvitationResult;
  claimInvitation(input: {
    invite_token: string;
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
    device_expires_at?: string | null | undefined;
    remember_device?: boolean | undefined;
  }, options: { browserSession: true }): ClaimInvitationWithBrowserSessionResult;
  claimInvitation(input: {
    invite_token: string;
    user_id?: string | undefined;
    display_name: string;
    device_id?: string | undefined;
    device_name: string;
    device_expires_at?: string | null | undefined;
    remember_device?: boolean | undefined;
  }, options: { browserSession?: boolean } = {}): ClaimInvitationResult | ClaimInvitationWithBrowserSessionResult {
    const projectInvitation = this.sqlite.prepare("SELECT id FROM project_invitations WHERE token_digest = ?")
      .get(this.tokenDigest(input.invite_token));
    if (projectInvitation) return this.claimProjectInvitation(input, options);
    const timestamp = this.now();
    const result = this.transaction((): ClaimInvitationResult | ClaimInvitationWithBrowserSessionResult | { failure: "invalid" | "expired" } => {
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
      const projectId = this.requireSession(row.session_id).project_id;
      this.sqlite.prepare(`
        INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, userId, row.role, timestamp, timestamp);
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
      const claimResult: ClaimInvitationResult = {
        actor,
        token: deviceToken,
        device: this.getDeviceForUser(userId, deviceId),
        invitation: this.requireInvitation(row.id),
        event,
      };
      return options.browserSession
        ? { ...claimResult, browser_session: this.insertBrowserSession(actor, new Date(timestamp), input.remember_device === true) }
        : claimResult;
    });
    if ("failure" in result) {
      throw unauthorized(result.failure === "expired" ? "Invitation is expired" : "Invitation is invalid or unavailable");
    }
    return result;
  }

  claimInvitationForActor(actor: Actor, inviteToken: string): AcceptInvitationResult {
    const projectInvitation = this.sqlite.prepare("SELECT id FROM project_invitations WHERE token_digest = ?")
      .get(this.tokenDigest(inviteToken));
    if (projectInvitation) return this.claimProjectInvitationForActor(actor, inviteToken);
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
      const projectId = this.requireSession(row.session_id).project_id;
      if (this.projectMembershipRole(projectId, actor.user_id) !== null) {
        throw conflict("User is already a member of this project");
      }
      this.sqlite.prepare(`
        INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, actor.user_id, row.role, timestamp, timestamp);
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

  createProjectInvitation(actor: Actor, projectId: string, input: {
    role: InvitationRole;
    ttl?: InvitationTtl | undefined;
  }): { invitation: ProjectInvitationRecord; invite_token: string } {
    const project = this.requireProjectOwnedBy(projectId, actor.user_id);
    if (project.state !== "active") throw conflict("Archived projects do not accept invitations");
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
        INSERT INTO project_invitations(
          id, project_id, inviter_user_id, role, token_digest, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        invitationId,
        projectId,
        actor.user_id,
        input.role,
        this.tokenDigest(inviteToken),
        createdAt,
        expiresAt,
      );
      this.appendProjectInvitationAudit({
        invitation_id: invitationId,
        project_id: projectId,
        action: "created",
        inviter_user_id: actor.user_id,
        subject_user_id: null,
        subject_device_id: null,
        role: input.role,
        created_at: createdAt,
      });
      return {
        invitation: this.requireProjectInvitation(invitationId),
        invite_token: inviteToken,
      };
    });
  }

  revokeProjectInvitation(actor: Actor, projectId: string, invitationId: string): ProjectInvitationRecord {
    this.requireProjectOwnedBy(projectId, actor.user_id);
    const timestamp = this.now();
    this.expirePendingProjectInvitations(projectId, timestamp);
    return this.transaction(() => {
      const invitation = this.requireProjectInvitation(invitationId, projectId);
      if (invitation.claimed_at !== null) throw conflict("Claimed invitations cannot be revoked");
      if (invitation.expired_at !== null) throw conflict("Expired invitations cannot be revoked");
      if (invitation.revoked_at !== null) return invitation;
      this.sqlite.prepare("UPDATE project_invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(timestamp, invitationId);
      this.appendProjectInvitationAudit({
        invitation_id: invitation.id,
        project_id: invitation.project_id,
        action: "revoked",
        inviter_user_id: invitation.inviter_user_id,
        subject_user_id: null,
        subject_device_id: null,
        role: invitation.role,
        created_at: timestamp,
      });
      return this.requireProjectInvitation(invitationId, projectId);
    });
  }

  listProjectInvitations(actor: Actor, projectId: string): ProjectInvitationRecord[] {
    this.requireProjectOwnedBy(projectId, actor.user_id);
    this.expirePendingProjectInvitations(projectId, this.now());
    const rows = this.sqlite.prepare(`
      SELECT * FROM project_invitations WHERE project_id = ? ORDER BY created_at DESC, id
    `).all(projectId) as unknown as ProjectInvitationRow[];
    return rows.map((row) => this.publicProjectInvitation(row));
  }

  listProjectInvitationAudit(actor: Actor, projectId: string): ProjectInvitationAuditRecord[] {
    this.requireProjectOwnedBy(projectId, actor.user_id);
    this.expirePendingProjectInvitations(projectId, this.now());
    return this.sqlite.prepare(`
      SELECT id, invitation_id, project_id, action, inviter_user_id,
             subject_user_id, subject_device_id, role, created_at
      FROM project_invitation_audit WHERE project_id = ? ORDER BY rowid
    `).all(projectId) as unknown as ProjectInvitationAuditRecord[];
  }

  private claimProjectInvitation(
    input: {
      invite_token: string;
      user_id?: string | undefined;
      display_name: string;
      device_id?: string | undefined;
      device_name: string;
      device_expires_at?: string | null | undefined;
      remember_device?: boolean | undefined;
    },
    options: { browserSession?: boolean },
  ): ClaimInvitationResult | ClaimInvitationWithBrowserSessionResult {
    const timestamp = this.now();
    const result = this.transaction((): ClaimInvitationResult | ClaimInvitationWithBrowserSessionResult | { failure: "invalid" | "expired" } => {
      const row = this.sqlite.prepare("SELECT * FROM project_invitations WHERE token_digest = ?")
        .get(this.tokenDigest(input.invite_token)) as unknown as ProjectInvitationRow | undefined;
      if (!row || row.revoked_at !== null || row.claimed_at !== null || row.expired_at !== null) {
        return { failure: "invalid" };
      }
      if (row.expires_at <= timestamp) {
        this.expireProjectInvitation(this.publicProjectInvitation(row), timestamp);
        return { failure: "expired" };
      }
      const project = this.requireProject(row.project_id);
      if (project.state !== "active") return { failure: "invalid" };
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
        INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.project_id, userId, row.role, timestamp, timestamp);
      const claimed = this.sqlite.prepare(`
        UPDATE project_invitations
        SET claimed_at = ?, claimed_by_user_id = ?, claimed_by_device_id = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?
      `).run(timestamp, userId, deviceId, row.id, timestamp);
      if (Number(claimed.changes) !== 1) throw conflict("Invitation was claimed concurrently");
      this.appendProjectInvitationAudit({
        invitation_id: row.id,
        project_id: row.project_id,
        action: "claimed",
        inviter_user_id: row.inviter_user_id,
        subject_user_id: userId,
        subject_device_id: deviceId,
        role: row.role,
        created_at: timestamp,
      });
      this.touchProject(row.project_id, timestamp);
      const actor = { user_id: userId, display_name: input.display_name, device_id: deviceId };
      const claimResult: ClaimInvitationResult = {
        actor,
        token: deviceToken,
        device: this.getDeviceForUser(userId, deviceId),
        invitation: this.requireProjectInvitation(row.id),
        event: null,
      };
      return options.browserSession
        ? { ...claimResult, browser_session: this.insertBrowserSession(actor, new Date(timestamp), input.remember_device === true) }
        : claimResult;
    });
    if ("failure" in result) {
      throw unauthorized(result.failure === "expired" ? "Invitation is expired" : "Invitation is invalid or unavailable");
    }
    return result;
  }

  private claimProjectInvitationForActor(actor: Actor, inviteToken: string): AcceptInvitationResult {
    const timestamp = this.now();
    const result = this.transaction((): AcceptInvitationResult | { failure: "invalid" | "expired" } => {
      const device = this.sqlite.prepare(`
        SELECT id FROM devices
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(actor.device_id, actor.user_id, timestamp);
      if (!device) return { failure: "invalid" };
      const row = this.sqlite.prepare("SELECT * FROM project_invitations WHERE token_digest = ?")
        .get(this.tokenDigest(inviteToken)) as unknown as ProjectInvitationRow | undefined;
      if (!row || row.revoked_at !== null || row.claimed_at !== null || row.expired_at !== null) {
        return { failure: "invalid" };
      }
      if (row.expires_at <= timestamp) {
        this.expireProjectInvitation(this.publicProjectInvitation(row), timestamp);
        return { failure: "expired" };
      }
      const project = this.requireProject(row.project_id);
      if (project.state !== "active") return { failure: "invalid" };
      if (this.projectMembershipRole(row.project_id, actor.user_id) !== null) {
        throw conflict("User is already a member of this project");
      }
      this.sqlite.prepare(`
        INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.project_id, actor.user_id, row.role, timestamp, timestamp);
      const claimed = this.sqlite.prepare(`
        UPDATE project_invitations
        SET claimed_at = ?, claimed_by_user_id = ?, claimed_by_device_id = ?
        WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?
      `).run(timestamp, actor.user_id, actor.device_id, row.id, timestamp);
      if (Number(claimed.changes) !== 1) throw conflict("Invitation was claimed concurrently");
      this.appendProjectInvitationAudit({
        invitation_id: row.id,
        project_id: row.project_id,
        action: "claimed",
        inviter_user_id: row.inviter_user_id,
        subject_user_id: actor.user_id,
        subject_device_id: actor.device_id,
        role: row.role,
        created_at: timestamp,
      });
      this.touchProject(row.project_id, timestamp);
      return { actor, invitation: this.requireProjectInvitation(row.id), event: null };
    });
    if ("failure" in result) {
      throw unauthorized(result.failure === "expired" ? "Invitation is expired" : "Invitation is invalid or unavailable");
    }
    return result;
  }

  createSession(actor: Actor, input: {
    project_id?: string | undefined;
    session_id?: string | undefined;
    idempotency_key: string;
    mode: SessionMode;
    title: string;
  }): { session: SessionRecord; event: CanonicalEvent } {
    const sessionId = input.session_id ?? `session-${createHash("sha256")
      .update(`${actor.user_id}\0${input.idempotency_key}`)
      .digest("hex")
      .slice(0, 32)}`;
    const projectId = input.project_id ?? `project-${createHash("sha256")
      .update(`legacy-session\0${sessionId}`)
      .digest("hex")
      .slice(0, 32)}`;
    const timestamp = this.now();
    return this.transaction(() => this.createSessionInsideTransaction(actor, {
      project_id: projectId,
      session_id: sessionId,
      idempotency_key: input.idempotency_key,
      mode: input.mode,
      title: input.title,
    }, timestamp, () => {
      if (input.project_id === undefined) {
        const project = this.sqlite.prepare("SELECT id FROM projects WHERE id = ?")
          .get(projectId);
        if (!project) {
          if (!this.canCreateProjects(actor.user_id)) {
            throw forbidden("This account can join invited projects but cannot create projects");
          }
          this.sqlite.prepare(`
            INSERT INTO projects(id, owner_user_id, title, state, creation_idempotency_key, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
          `).run(projectId, actor.user_id, input.title, `legacy-${input.idempotency_key}`, timestamp, timestamp);
          this.sqlite.prepare(`
            INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
            VALUES (?, ?, 'owner', ?, ?)
          `).run(projectId, actor.user_id, timestamp, timestamp);
        }
      } else {
        const project = this.requireProject(projectId);
        if (project.state !== "active") throw conflict("Archived projects do not accept new sessions");
      }
    }));
  }

  private createSessionInsideTransaction(
    actor: Actor,
    input: {
      project_id: string;
      session_id: string;
      event_id?: string | undefined;
      idempotency_key: string;
      mode: SessionMode;
      title: string;
    },
    timestamp: string,
    prepareProject: () => void = () => {},
  ): { session: SessionRecord; event: CanonicalEvent } {
    const creationPayload = { action: "created", mode: input.mode, title: input.title } satisfies JsonValue;
    prepareProject();
    const project = this.requireProject(input.project_id);
    if (project.state !== "active") throw conflict("Archived projects do not accept new sessions");
    const projectRole = this.projectMembershipRole(input.project_id, actor.user_id);
    if (projectRole === null) throw notFound("Project");
    if (projectRole === "viewer") throw forbidden("Viewers cannot create shared sessions");
    if (projectRole === "participant" && input.mode !== "solo") {
      throw forbidden("Participants may create only their own solo sessions");
    }
    const existingSession = this.sqlite.prepare("SELECT id FROM sessions WHERE id = ?").get(input.session_id);
    if (existingSession) {
      const session = this.requireSession(input.session_id);
      const existingEvent = this.findByIdempotencyKey(input.session_id, input.idempotency_key);
      if (session.project_id !== input.project_id || !existingEvent) {
        throw idempotencyConflict("Session ID already exists with another operation");
      }
      return {
        session,
        event: this.requireIdempotencyMatch(
          existingEvent,
          actor.user_id,
          "session_state_change",
          creationPayload,
        ),
      };
    }
    this.enforceSessionQuota(input.project_id, actor.user_id);
    this.sqlite.prepare(`
      INSERT INTO sessions(
        id, project_id, owner_user_id, mode, title, state, next_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)
    `).run(
      input.session_id,
      input.project_id,
      actor.user_id,
      input.mode,
      input.title,
      timestamp,
      timestamp,
    );
    this.sqlite.prepare(`
      INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, 'owner', ?, ?)
    `).run(input.session_id, actor.user_id, timestamp, timestamp);
    const event = this.appendInsideTransaction(actor.user_id, input.session_id, {
      event_id: input.event_id,
      idempotency_key: input.idempotency_key,
      type: "session_state_change",
      visibility: "session",
      payload: creationPayload,
    }, null);
    return { session: this.requireSession(input.session_id), event };
  }

  requireSession(sessionId: string): SessionRecord {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as unknown as SessionRow | undefined;
    if (!row) throw notFound("Session");
    return row;
  }

  listSessions(userId: string): SessionListItem[] {
    return this.sqlite.prepare(`
      SELECT sessions.id, sessions.project_id, sessions.owner_user_id,
             sessions.title, sessions.mode, sessions.state,
             project_memberships.role, sessions.next_sequence AS current_sequence,
             sessions.updated_at,
             (SELECT COUNT(*) FROM project_memberships AS project_members
              WHERE project_members.project_id = sessions.project_id) AS member_count
      FROM project_memberships
      JOIN sessions ON sessions.project_id = project_memberships.project_id
      WHERE project_memberships.user_id = ?
      ORDER BY sessions.updated_at DESC, sessions.id ASC
    `).all(userId) as unknown as SessionListItem[];
  }

  listSessionMembers(sessionId: string): SessionMemberRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT project_memberships.user_id, users.display_name, project_memberships.role,
             runtimes.id AS runtime_id, runtimes.session_id AS runtime_session_id,
             runtimes.user_id AS runtime_user_id, runtimes.device_id,
             runtimes.purpose,
             runtimes.harness, runtimes.provider, runtimes.model,
             runtimes.local_session_id, runtimes.capture_fidelity,
             runtimes.status, runtimes.last_seen_at
      FROM sessions
      JOIN project_memberships ON project_memberships.project_id = sessions.project_id
      JOIN users ON users.id = project_memberships.user_id
      LEFT JOIN runtimes ON runtimes.id = (
        SELECT candidate.id FROM runtimes AS candidate
        WHERE candidate.session_id = sessions.id
          AND candidate.user_id = project_memberships.user_id
          AND candidate.status != 'revoked'
        ORDER BY CASE WHEN candidate.purpose = 'execution' THEN 0 ELSE 1 END,
                 CASE WHEN candidate.status = 'online' THEN 0 ELSE 1 END,
                 candidate.last_seen_at DESC
        LIMIT 1
      )
      WHERE sessions.id = ?
      ORDER BY CASE project_memberships.role WHEN 'owner' THEN 0 WHEN 'participant' THEN 1 ELSE 2 END,
               users.display_name ASC
    `).all(sessionId) as Array<Record<string, string | null>>;

    const now = this.clock().getTime();
    return rows.map((row) => ({
      user_id: String(row.user_id),
      display_name: String(row.display_name),
      role: row.role as MembershipRole,
      runtime: row.runtime_id === null ? null : {
        id: String(row.runtime_id),
        session_id: String(row.runtime_session_id),
        user_id: String(row.runtime_user_id),
        device_id: String(row.device_id),
        purpose: row.purpose as RuntimeRecord["purpose"],
        harness: String(row.harness),
        provider: String(row.provider),
        model: String(row.model),
        local_session_id: String(row.local_session_id),
        capture_fidelity: row.capture_fidelity as CaptureFidelity,
        status: runtimeStatus(row.status, row.last_seen_at, now),
        last_seen_at: String(row.last_seen_at),
      },
    }));
  }

  listSessionRuntimesForUser(sessionId: string, userId: string): RuntimeRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT id, session_id, user_id, device_id, purpose, harness, provider,
             model, execution_profiles_json, local_session_id, capture_fidelity, status, last_seen_at
      FROM runtimes
      WHERE session_id = ? AND user_id = ? AND status != 'revoked'
      ORDER BY CASE WHEN status = 'online' THEN 0 ELSE 1 END,
               last_seen_at DESC, id ASC
    `).all(sessionId, userId) as unknown as RuntimeRow[];
    const now = this.clock().getTime();
    return rows.map((row) => mapRuntimeRow(row, now));
  }

  membershipRole(sessionId: string, userId: string): MembershipRole | null {
    const row = this.sqlite.prepare(`
      SELECT project_memberships.role
      FROM sessions
      JOIN project_memberships ON project_memberships.project_id = sessions.project_id
      WHERE sessions.id = ? AND project_memberships.user_id = ?
    `)
      .get(sessionId, userId) as unknown as MembershipRow | undefined;
    return row?.role ?? null;
  }

  setMembership(actor: Actor, sessionId: string, userId: string, role: "participant" | "viewer", idempotencyKey: string): CanonicalEvent {
    return this.transaction(() => {
      const existing = this.findByIdempotencyKey(sessionId, idempotencyKey);
      const payload = { action: "set", user_id: userId, role } satisfies JsonValue;
      if (existing) return this.requireIdempotencyMatch(existing, actor.user_id, "membership_change", payload);
      const timestamp = this.now();
      const session = this.requireSession(sessionId);
      const project = this.requireProject(session.project_id);
      if (userId === project.owner_user_id) throw conflict("The project owner's role cannot be changed");
      this.sqlite.prepare(`
        INSERT INTO project_memberships(project_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
      `).run(session.project_id, userId, role, timestamp, timestamp);
      this.sqlite.prepare(`
        INSERT INTO memberships(session_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
      `).run(sessionId, userId, role, timestamp, timestamp);
      if (role === "viewer") {
        this.sqlite.prepare(`
          UPDATE runtimes SET status = 'revoked'
          WHERE user_id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
            AND purpose = 'execution'
        `).run(userId, session.project_id);
      }
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
      const session = this.requireSession(sessionId);
      const result = this.sqlite.prepare(`
        DELETE FROM project_memberships WHERE project_id = ? AND user_id = ? AND role != 'owner'
      `).run(session.project_id, userId);
      if (Number(result.changes) === 0) throw notFound("Membership");
      this.sqlite.prepare(`
        DELETE FROM memberships WHERE user_id = ?
          AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
          AND role != 'owner'
      `).run(userId, session.project_id);
      this.sqlite.prepare(`
        UPDATE runtimes SET status = 'revoked' WHERE user_id = ?
          AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)
      `).run(userId, session.project_id);
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
      const manageableSession = this.requireSessionManageableInsideTransaction(actor, sessionId);
      if (manageableSession.mode === "solo"
        && this.membershipRole(sessionId, actor.user_id) !== "owner"
        && input.mode !== undefined && input.mode !== "solo") {
        throw forbidden("Only the project owner can convert a solo session to multi");
      }
      const payload: Record<string, JsonValue> = {
        action: input.title !== undefined && input.mode === undefined && input.state === undefined ? "renamed" : "updated",
      };
      if (input.mode !== undefined) payload.mode = input.mode;
      if (input.state !== undefined) payload.state = input.state;
      if (input.title !== undefined) payload.title = input.title;
      const existing = this.findByIdempotencyKey(sessionId, input.idempotency_key);
      if (existing) return {
        session: this.requireSession(sessionId),
        event: this.requireIdempotencyMatch(existing, actor.user_id, "session_state_change", payload),
      };
      const session = this.requireSession(sessionId);
      const next = {
        mode: input.mode ?? session.mode,
        state: input.state ?? session.state,
        title: input.title ?? session.title,
      };
      const timestamp = this.now();
      this.sqlite.prepare(`
        UPDATE sessions SET mode = ?, state = ?, title = ?,
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
        WHERE id = ?
      `).run(next.mode, next.state, next.title, timestamp, timestamp, sessionId);
      if (next.mode === "solo") {
        this.sqlite.prepare(`
          UPDATE runtimes SET status = 'revoked'
          WHERE session_id = ? AND user_id != ?
        `).run(sessionId, session.owner_user_id);
      }
      const event = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: input.idempotency_key,
        type: "session_state_change",
        visibility: "session",
        payload,
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

  createHistorySummary(actor: Actor, sessionId: string, input: CreateHistorySummaryInput): CanonicalEvent {
    return historySummaryOperation(() => this.transaction(() => {
      this.assertActiveDevice(actor);
      const session = this.requireWritableSessionInsideTransaction(actor, sessionId);
      if (session.state !== "active") throw conflict("Archived sessions do not accept summary requests");
      // Fetch the bounded selection and its canonical relationships, not a replay
      // page. A missing or foreign-session ID must never produce a partial summary.
      if (input.source_event_ids.length < 1 || input.source_event_ids.length > 100) {
        throw new HistorySummaryError("invalid_selection", "Select between 1 and 100 history messages");
      }
      const selectedIds = new Set(input.source_event_ids);
      const related = new Map<string, CanonicalEvent>();
      const queue: CanonicalEvent[] = [];
      let dependencyBytes = 0;
      const include = (event: CanonicalEvent) => {
        if (related.has(event.id)) return;
        dependencyBytes += Buffer.byteLength(JSON.stringify(event));
        if (related.size >= MAX_HISTORY_SUMMARY_DEPENDENCY_EVENTS || dependencyBytes > MAX_HISTORY_SUMMARY_DEPENDENCY_BYTES) {
          throw new HistorySummaryError("too_large", "Summary source ancestry exceeds the validation limit; select fewer sources");
        }
        related.set(event.id, event);
        queue.push(event);
      };
      for (const id of input.source_event_ids) include(this.getEvent(sessionId, id));
      for (let index = 0; index < queue.length; index += 1) {
        const event = queue[index]!;
        if (event.reply_to_event_id !== null) {
          include(this.getEvent(sessionId, event.reply_to_event_id));
        }
        if (event.type !== "agent_request") continue;
        const marker = historySummaryMarker(event);
        for (const id of marker?.source_event_ids ?? []) include(this.getEvent(sessionId, id));
        const responses = this.sqlite.prepare(`
          SELECT * FROM events WHERE session_id = ? AND reply_to_event_id = ? AND type = 'agent_response'
          ORDER BY sequence ASC LIMIT 2
        `).all(sessionId, event.id) as unknown as EventRow[];
        if (selectedIds.has(event.id) && responses.length === 0 && event.visibility === "session"
          && !isHistorySummaryRequest(event) && historySummaryText(event.payload).trim()) {
          throw conflict("Unfinished Agent requests cannot be selected for a history summary");
        }
        for (const row of responses) include(mapEvent(row));
      }
      const sources = selectHistorySummarySources(
        [...related.values()].map((event) => ({ ...event, payload: redactJson(event.payload) })), input.source_event_ids,
      );
      const instructions = input.instructions === undefined ? undefined : redactJson(input.instructions) as string;
      const content = buildHistorySummaryPrompt(sources, instructions);
      if (Buffer.byteLength(JSON.stringify(content)) >= 32 * 1024) {
        throw new HistorySummaryError("too_large", "Serialized summary prompt exceeds the 32 KiB transport boundary; no text was shortened");
      }
      const payload: JsonValue = {
        content,
        execution_profile: {
          harness: input.execution_profile.harness,
          model: input.execution_profile.model,
          runtime_id: input.execution_profile.runtime_id,
          ...(input.execution_profile.provider === undefined ? {} : { provider: input.execution_profile.provider }),
          ...(input.execution_profile.reasoning_effort === undefined ? {} : { reasoning_effort: input.execution_profile.reasoning_effort }),
        },
        history_summary: {
          version: 1,
          source_event_ids: sources.map((event) => event.id),
          source_digest: createHash("sha256").update(historySummarySourceJson(sources)).digest("hex"),
        },
      };
      const existing = this.findByIdempotencyKey(sessionId, input.idempotency_key);
      if (existing) return this.requireIdempotencyMatch(existing, actor.user_id, "agent_request", payload, null, "session", null);
      const target = agentRequestTarget({ payload });
      const runtime = this.listSessionRuntimesForUser(sessionId, actor.user_id)
        .find((candidate) => candidate.id === input.execution_profile.runtime_id);
      if (!runtime || runtime.purpose !== "execution" || runtime.status !== "online" || !runtimeSupportsAgentTarget(runtime, target)) {
        throw conflict("Select your own exact online execution runtime and supported execution profile");
      }
      if (!this.sqlite.prepare(`
        SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(runtime.device_id, actor.user_id, this.now())) {
        throw conflict("The selected execution runtime's device is expired or revoked");
      }
      return this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: input.idempotency_key, type: "agent_request", visibility: "session", payload,
      }, null);
    }));
  }

  readHistoryContext(actor: Actor, sessionId: string, view?: "summary" | "original", throughSequence?: number): HistoryContext {
    return historySummaryOperation(() => this.transaction(() => {
      this.assertActiveDevice(actor);
      const session = this.requireReadableSessionInsideTransaction(actor, sessionId);
      const through = throughSequence ?? session.next_sequence;
      if (!Number.isSafeInteger(through) || through < 0 || through > session.next_sequence) {
        throw new ApiError(400, "invalid_context_sequence", "through_sequence must be between zero and the current session head");
      }
      const resolvedView = view ?? this.getProjectContextPolicy(actor, session.project_id).mode;
      if (resolvedView !== "summary" && resolvedView !== "original") throw new ApiError(400, "invalid_context_view", "Unknown context view");
      const events: CanonicalEvent[] = [];
      let scannedBytes = 0;
      const query = this.sqlite.prepare(`
        SELECT * FROM events WHERE session_id = ? AND sequence <= ? AND visibility = 'session' ORDER BY sequence ASC
      `);
      for (const value of query.iterate(sessionId, through)) {
        const row = value as unknown as EventRow;
        scannedBytes += Buffer.byteLength(row.payload_json) + Buffer.byteLength(row.runtime_provenance_json ?? "") + 512;
        if (events.length >= MAX_HISTORY_CONTEXT_SCAN_EVENTS || scannedBytes > MAX_HISTORY_CONTEXT_SCAN_BYTES) {
          throw new HistorySummaryError("too_large", "Context scan limit exceeded. Use paginated canonical history; no context was silently omitted");
        }
        const event = mapEvent(row);
        events.push({ ...event, payload: redactJson(event.payload) });
      }
      const context = buildHistoryContext(events, resolvedView);
      // The frozen canonical head includes invisible/control events; it is not
      // the sequence of the last conversational item returned by the projection.
      context.through_sequence = through;
      if (Buffer.byteLength(JSON.stringify(context)) > HISTORY_SUMMARY_MAX_CONTEXT_BYTES) {
        throw new HistorySummaryError("too_large", "Context view exceeds 256 KiB; use paginated canonical history");
      }
      return context;
    }));
  }

  appendEvent(actor: Actor, sessionId: string, input: AppendEventInput, provenance: RuntimeProvenance | null): CanonicalEvent {
    this.assertActiveDevice(actor);
    rejectHistorySummaryMetadata(input.payload);
    return this.transaction(() => {
      const replyTarget = input.reply_to_event_id === undefined || input.reply_to_event_id === null
        ? undefined
        : this.getEvent(sessionId, input.reply_to_event_id);
      if (input.type === "agent_response" && replyTarget?.type === "agent_request") {
        throw conflict("Request-linked Agent responses require the dedicated completion endpoint");
      }
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
      if ((input.type === "tool_call" || input.type === "tool_result")
        && replyTarget !== undefined) {
        if (replyTarget.type === "agent_request") {
          const runtimeId = provenance?.runtime_id;
          const claim = this.sqlite.prepare(
            "SELECT runtime_id, status, attempt_count, lease_expires_at FROM agent_request_claims WHERE request_event_id = ?",
          ).get(replyTarget.id) as unknown as ClaimRow | undefined;
          if (runtimeId === undefined
            || !this.isCurrentClaimAttempt(claim, runtimeId, input.claim_attempt, this.now())) {
            throw conflict("A matching active claim is required to append request-linked tool events");
          }
        }
      }
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
    purpose?: "execution" | "snapshot_connector" | undefined;
    harness: string;
    provider: string;
    model: string;
    execution_profiles?: RuntimeExecutionProfile[] | undefined;
    local_session_id: string;
    capture_fidelity: CaptureFidelity;
  }): RuntimeRecord {
    if (input.device_id !== actor.device_id) throw unauthorized("Runtime device must match the authenticated device");
    this.assertActiveDevice(actor);
    const runtimeId = input.runtime_id ?? randomUUID();
    const timestamp = this.now();
    const executionProfiles = input.execution_profiles === undefined
      ? null
      : JSON.stringify(RuntimeExecutionProfilesSchema.parse(input.execution_profiles));
    this.sqlite.prepare(`
      INSERT INTO runtimes(id, session_id, user_id, device_id, purpose, harness, provider, model, execution_profiles_json, local_session_id, capture_fidelity, status, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)
      ON CONFLICT(device_id, harness, local_session_id) DO UPDATE SET
        session_id = excluded.session_id,
        purpose = excluded.purpose,
        provider = excluded.provider,
        model = excluded.model,
        execution_profiles_json = excluded.execution_profiles_json,
        capture_fidelity = excluded.capture_fidelity,
        status = 'online',
        last_seen_at = excluded.last_seen_at
    `).run(runtimeId, input.session_id, actor.user_id, input.device_id, input.purpose ?? "execution", input.harness, input.provider, input.model, executionProfiles, input.local_session_id, input.capture_fidelity, timestamp, timestamp);
    return this.getRuntimeByIdentity(input.device_id, input.harness, input.local_session_id);
  }

  getRuntime(runtimeId: string): RuntimeRecord {
    const row = this.sqlite.prepare("SELECT id, session_id, user_id, device_id, purpose, harness, provider, model, execution_profiles_json, local_session_id, capture_fidelity, status, last_seen_at FROM runtimes WHERE id = ?")
      .get(runtimeId) as unknown as RuntimeRow | undefined;
    if (!row) throw notFound("Runtime");
    return mapRuntimeRow(row);
  }

  heartbeatRuntime(actor: Actor, runtimeId: string): RuntimeRecord {
    this.assertActiveDevice(actor);
    const result = this.sqlite.prepare("UPDATE runtimes SET status = 'online', last_seen_at = ? WHERE id = ? AND user_id = ? AND device_id = ? AND status != 'revoked'")
      .run(this.now(), runtimeId, actor.user_id, actor.device_id);
    if (Number(result.changes) === 0) throw notFound("Runtime");
    return this.getRuntime(runtimeId);
  }

  claimAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string): AgentClaimOutcome {
    this.assertActiveDevice(actor);
    // The transaction returns terminal failure to the service instead of
    // throwing. That lets the canonical failure commit before the service
    // publishes it and raises the HTTP conflict.
    return this.transaction((): AgentClaimOutcome => {
      const event = this.getEvent(sessionId, requestEventId);
      if (event.type !== "agent_request") throw conflict("Only agent_request events can be claimed");
      if (this.sqlite.prepare("SELECT 1 FROM local_turn_commits WHERE request_event_id = ?").get(requestEventId)) {
        throw agentRequestAlreadyCompleted();
      }
      const runtime = this.getRuntime(runtimeId);
      if (runtime.session_id !== sessionId || runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
        || event.actor_user_id !== actor.user_id || runtime.status === "revoked" || runtime.purpose !== "execution") {
        throw conflict("The request is eligible only for the initiating user's active runtime");
      }
      const target = agentRequestTarget(event);
      const matching = this.listSessionRuntimesForUser(sessionId, actor.user_id).filter((candidate) =>
        candidate.purpose === "execution"
        && candidate.status === "online"
        && runtimeSupportsAgentTarget(candidate, target));
      const selectedRuntimeId = target.runtimeId
        ?? (target.harness === "codex" ? runtime.id : matching.length === 1 ? matching[0]?.id : undefined);
      if (!runtimeSupportsAgentTarget(runtime, target)
        || selectedRuntimeId === undefined
        || runtime.id !== selectedRuntimeId
        || !matching.some((candidate) => candidate.id === runtime.id)) {
        throw conflict(`A matching online ${target.harness} runtime is required for this Agent request`);
      }
      const now = this.now();
      const leaseExpiresAt = new Date(Date.parse(now) + AGENT_CLAIM_LEASE_MS).toISOString();
      const existing = this.sqlite.prepare("SELECT runtime_id, status, attempt_count, lease_expires_at FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (existing) {
        if (existing.status === "failed") return { failed: true };
        if (existing.status === "completed" || !claimLeaseLapsed(existing.lease_expires_at, now)) {
          if (existing.runtime_id !== runtimeId) throw agentRequestAlreadyClaimed();
          return { claim: {
            request_event_id: requestEventId,
            runtime_id: runtimeId,
            status: existing.status,
            attempt_count: existing.attempt_count ?? 1,
          } };
        }
        // The lease lapsed, so no accepted work is arriving. Exact-runtime
        // reclaim is bounded: past the budget the request ends visibly instead
        // of executing forever.
        if ((existing.attempt_count ?? 1) >= MAX_AGENT_CLAIM_ATTEMPTS) {
          const failure = this.failAbandonedClaim(sessionId, event, target.harness);
          return failure === undefined ? { failed: true } : { failed: true, event: failure };
        }
        this.assertRuntimeClaimSlotAvailable(runtimeId, requestEventId, now);
        this.sqlite.prepare(`
          UPDATE agent_request_claims
          SET runtime_id = ?, claimed_at = ?, attempt_count = attempt_count + 1, lease_expires_at = ?
          WHERE request_event_id = ?
        `).run(runtimeId, now, leaseExpiresAt, requestEventId);
        return { claim: {
          request_event_id: requestEventId,
          runtime_id: runtimeId,
          status: "claimed",
          attempt_count: (existing.attempt_count ?? 1) + 1,
        } };
      }
      this.assertRuntimeClaimSlotAvailable(runtimeId, requestEventId, now);
      this.sqlite.prepare(`
        INSERT INTO agent_request_claims(request_event_id, runtime_id, claimed_at, status, attempt_count, lease_expires_at)
        VALUES (?, ?, ?, 'claimed', 1, ?)
      `).run(requestEventId, runtimeId, now, leaseExpiresAt);
      return { claim: {
        request_event_id: requestEventId,
        runtime_id: runtimeId,
        status: "claimed",
        attempt_count: 1,
      } };
    });
  }

  private assertRuntimeClaimSlotAvailable(runtimeId: string, requestEventId: string, now: string): void {
    const active = this.sqlite.prepare(`
      SELECT request_event_id FROM agent_request_claims
      WHERE runtime_id = ? AND status = 'claimed' AND request_event_id != ? AND lease_expires_at > ?
      LIMIT 1
    `).get(runtimeId, requestEventId, now) as { request_event_id: string } | undefined;
    if (active) throw runtimeBusy();
  }

  /**
   * End an abandoned request in a terminal failure the timeline can show, rather
   * than leaving it pending for ever.
   *
   * The response is attributed to the requesting user because that is whose
   * runtime held it, exactly as a harness-reported execution failure already is.
   * It carries no runtime provenance and claims no capture fidelity: no harness
   * produced it, and saying otherwise would overstate what the server observed.
   */
  private failAbandonedClaim(sessionId: string, request: CanonicalEvent, harness: string): CanonicalEvent | undefined {
    this.sqlite.prepare(`
      UPDATE agent_request_claims
      SET status = 'failed', completed_at = ?, lease_expires_at = NULL
      WHERE request_event_id = ?
    `).run(this.now(), request.id);
    // This key is generated inside the same transaction that marks the claim
    // failed. It is therefore unforgeable in advance and does not let a public,
    // client-chosen idempotency key suppress the canonical failure response.
    const idempotencyKey = `server:agent-claim-abandoned:${randomUUID()}`;
    return this.appendInsideTransaction(request.actor_user_id, sessionId, {
      idempotency_key: idempotencyKey,
      type: "agent_response",
      visibility: "session",
      reply_to_event_id: request.id,
      payload: {
        text: "This Agent request was interrupted and could not be recovered.",
        status: "failed",
        source_harness: harness,
        error: {
          code: "agent_request_abandoned",
          message: "The exact runtime for this request stopped reporting progress.",
        },
      },
    }, null);
  }

  completeAgentRequest(
    actor: Actor,
    sessionId: string,
    requestEventId: string,
    runtimeId: string,
    idempotencyKey: string,
    payload: JsonValue,
    observedModel?: string,
    observedReasoningEffort?: string,
    claimAttempt?: number,
  ): CanonicalEvent {
    this.assertActiveDevice(actor);
    rejectHistorySummaryMetadata(payload);
    return this.transaction(() => {
      const runtime = this.getRuntime(runtimeId);
      if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
        || runtime.session_id !== sessionId || runtime.status === "revoked" || runtime.purpose !== "execution") {
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
      const claim = this.sqlite.prepare("SELECT runtime_id, status, attempt_count, lease_expires_at FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (!this.isCurrentClaimAttempt(claim, runtimeId, claimAttempt, this.now())) {
        throw conflict("A matching active claim is required to complete this request");
      }
      const provenance = {
        ...this.runtimeProvenance(runtime),
        ...(observedModel === undefined ? {} : { model: observedModel }),
        ...(observedReasoningEffort === undefined ? {} : { reasoning_effort: observedReasoningEffort }),
      };
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

  appendAgentProgress(
    actor: Actor,
    sessionId: string,
    requestEventId: string,
    runtimeId: string,
    idempotencyKey: string,
    payload: JsonValue,
    observedModel?: string,
    observedReasoningEffort?: string,
    claimAttempt?: number,
  ): CanonicalEvent {
    this.assertActiveDevice(actor);
    rejectHistorySummaryMetadata(payload);
    return this.transaction(() => {
      const runtime = this.getRuntime(runtimeId);
      if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
        || runtime.session_id !== sessionId || runtime.status === "revoked" || runtime.purpose !== "execution") {
        throw conflict("A matching active runtime on the authenticated device is required");
      }
      const existingEvent = this.findByIdempotencyKey(sessionId, idempotencyKey);
      if (existingEvent) return this.requireIdempotencyMatch(
        existingEvent,
        actor.user_id,
        "agent_progress",
        payload,
        requestEventId,
        "session",
        runtimeId,
      );
      const claim = this.sqlite.prepare("SELECT runtime_id, status, attempt_count, lease_expires_at FROM agent_request_claims WHERE request_event_id = ?")
        .get(requestEventId) as unknown as ClaimRow | undefined;
      if (!this.isCurrentClaimAttempt(claim, runtimeId, claimAttempt, this.now())) {
        throw conflict("A matching active claim is required to append progress for this request");
      }
      const provenance = {
        ...this.runtimeProvenance(runtime),
        ...(observedModel === undefined ? {} : { model: observedModel }),
        ...(observedReasoningEffort === undefined ? {} : { reasoning_effort: observedReasoningEffort }),
      };
      const progress = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: idempotencyKey,
        type: "agent_progress",
        visibility: "session",
        reply_to_event_id: requestEventId,
        payload,
        runtime_id: runtimeId,
      }, provenance);
      // Reporting accepted progress is what proves the claimant is still working,
      // so it — not a device heartbeat — is what extends the lease. A runtime that
      // is merely switched on cannot keep a dead execution alive.
      this.sqlite.prepare("UPDATE agent_request_claims SET lease_expires_at = ? WHERE request_event_id = ?")
        .run(new Date(Date.parse(this.now()) + AGENT_CLAIM_LEASE_MS).toISOString(), requestEventId);
      return progress;
    });
  }

  private isCurrentClaimAttempt(
    claim: ClaimRow | undefined,
    runtimeId: string,
    claimAttempt: number | undefined,
    now: string,
  ): boolean {
    if (!claim || claim.runtime_id !== runtimeId || claim.status !== "claimed"
      || claimLeaseLapsed(claim.lease_expires_at, now)) return false;
    const currentAttempt = claim.attempt_count ?? 1;
    if (claimAttempt !== undefined) return claimAttempt === currentAttempt;
    return currentAttempt === 1;
  }

  commitLocalTurn(actor: Actor, sessionId: string, input: CommitLocalTurnInput): CommitLocalTurnResult {
    return this.transaction(() => {
      this.assertActiveDevice(actor);
      rejectHistorySummaryMetadata(input.request_payload);
      rejectHistorySummaryMetadata(input.response_payload);
      for (const event of input.tool_events ?? []) rejectHistorySummaryMetadata(event.payload);
      const session = this.requireWritableSessionInsideTransaction(actor, sessionId);
      const runtime = this.requireRuntimeForActor(actor, sessionId, input.runtime_id, "execution");
      if (session.state !== "active") throw conflict("Archived sessions do not accept completed local turns");
      if (input.based_on_sequence > session.next_sequence) {
        throw conflict("based_on_sequence cannot be ahead of the canonical session head");
      }
      const digestPayload: JsonValue = {
        local_turn_id: input.local_turn_id,
        runtime_id: input.runtime_id,
        based_on_sequence: input.based_on_sequence,
        occurred_at: input.occurred_at,
        ...(input.observed_model === undefined ? {} : { observed_model: input.observed_model }),
        ...(input.observed_reasoning_effort === undefined ? {} : { observed_reasoning_effort: input.observed_reasoning_effort }),
        request_payload: input.request_payload,
        response_payload: input.response_payload,
        tool_events: (input.tool_events ?? []).map((event) => ({
          type: event.type,
          payload: event.payload,
          ...(event.occurred_at === undefined ? {} : { occurred_at: event.occurred_at }),
        })),
      };
      const inputDigest = createHash("sha256").update(stableJson(digestPayload)).digest("hex");
      const existing = this.sqlite.prepare(`
        SELECT input_digest, head_before_commit, request_event_id, response_event_id, tool_event_ids_json
        FROM local_turn_commits WHERE session_id = ? AND runtime_id = ? AND local_turn_id = ?
      `).get(sessionId, input.runtime_id, input.local_turn_id) as unknown as LocalTurnCommitRow | undefined;
      if (existing) {
        if (existing.input_digest !== inputDigest) throw idempotencyConflict("Local turn retry body does not match the committed turn");
        return this.localTurnResult(input.local_turn_id, input.runtime_id, input.based_on_sequence, existing);
      }
      const headBeforeCommit = session.next_sequence;
      const keyBase = `local-turn-${createHash("sha256")
        .update(`${sessionId}\0${input.runtime_id}\0${input.local_turn_id}`)
        .digest("hex")}`;
      const provenance = {
        ...this.runtimeProvenance(runtime),
        ...(input.observed_model === undefined ? {} : { model: input.observed_model }),
        ...(input.observed_reasoning_effort === undefined ? {} : { reasoning_effort: input.observed_reasoning_effort }),
      };
      const requestEvent = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: `${keyBase}-request`, type: "agent_request", visibility: "session",
        payload: payloadWithClientOccurredAt(input.request_payload, input.occurred_at), runtime_id: input.runtime_id,
      }, provenance);
      const toolEvents = (input.tool_events ?? []).map((event, index) => this.appendInsideTransaction(
        actor.user_id, sessionId, {
          idempotency_key: `${keyBase}-tool-${index}`, type: event.type, visibility: "session",
          reply_to_event_id: requestEvent.id,
          payload: payloadWithClientOccurredAt(event.payload, event.occurred_at ?? input.occurred_at),
          runtime_id: input.runtime_id,
        }, provenance,
      ));
      const responseEvent = this.appendInsideTransaction(actor.user_id, sessionId, {
        idempotency_key: `${keyBase}-response`, type: "agent_response", visibility: "session",
        reply_to_event_id: requestEvent.id,
        payload: payloadWithClientOccurredAt(input.response_payload, input.occurred_at),
        runtime_id: input.runtime_id,
      }, provenance);
      this.sqlite.prepare(`
        INSERT INTO local_turn_commits(
          session_id, runtime_id, local_turn_id, input_digest, head_before_commit,
          request_event_id, response_event_id, tool_event_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, input.runtime_id, input.local_turn_id, inputDigest, headBeforeCommit,
        requestEvent.id, responseEvent.id, JSON.stringify(toolEvents.map((event) => event.id)), this.now());
      return {
        local_turn_id: input.local_turn_id,
        runtime_id: input.runtime_id,
        head_before_commit: headBeforeCommit,
        reconciliation_required: headBeforeCommit > input.based_on_sequence,
        request_event: requestEvent,
        response_event: responseEvent,
        tool_events: toolEvents,
      };
    });
  }

  createSnapshotRequest(
    actor: Actor,
    sessionId: string,
    kind: SnapshotRequestKind = "immutable",
    targetRuntimeId?: string,
  ): SnapshotRequestRecord {
    return this.transaction(() => {
      this.assertActiveDevice(actor);
      const localControl = isLocalSyncRequestKind(kind);
      const session = kind === "visible_history_replace" || localControl
        ? this.requireWritableSessionInsideTransaction(actor, sessionId)
        : this.requireReadableSessionInsideTransaction(actor, sessionId);
      let targetRuntime: RuntimeRecord | undefined;
      if (localControl) {
        this.assertCodeControlEnabled(kind, session.project_id);
        targetRuntime = this.listSessionRuntimesForUser(sessionId, actor.user_id)
          .find((runtime) => runtime.id === targetRuntimeId);
        if (!targetRuntime || targetRuntime.purpose !== "execution"
          || targetRuntime.status !== "online" || !this.supportsControlHarness(kind, targetRuntime.harness)) {
          throw conflict("An exact online supported execution runtime owned by this user is required");
        }
      } else if (targetRuntimeId !== undefined) {
        throw conflict("Only local sync controls can target an execution runtime");
      }
      this.enforceActiveSnapshotRequestQuota(sessionId, actor.user_id);
      this.enforceSnapshotStorageQuota(sessionId, actor.user_id, SNAPSHOT_REQUEST_METADATA_BYTES);
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO snapshot_requests(
          id, session_id, requested_by_user_id, request_kind, through_sequence, status, target_runtime_id, created_at,
          storage_bytes, metadata_charged
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)
      `).run(id, sessionId, actor.user_id, kind, session.next_sequence, targetRuntime?.id ?? null, this.now(), SNAPSHOT_REQUEST_METADATA_BYTES);
      this.sqlite.prepare(`
        INSERT INTO snapshot_storage_usage(session_id, user_id, bytes) VALUES (?, ?, ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET bytes = bytes + excluded.bytes
      `).run(sessionId, actor.user_id, SNAPSHOT_REQUEST_METADATA_BYTES);
      return this.requireSnapshotRequest(id);
    });
  }

  getSnapshotRequest(actor: Actor, requestId: string): SnapshotRequestRecord {
    this.assertActiveDevice(actor);
    const request = this.requireSnapshotRequest(requestId);
    if (request.requested_by_user_id !== actor.user_id) throw notFound("Snapshot request");
    if (request.status !== "completed" && this.membershipRole(request.session_id, actor.user_id) === null) {
      throw notFound("Snapshot request");
    }
    return request;
  }

  listSnapshotRequests(
    actor: Actor,
    status: SnapshotRequestStatus | undefined,
    sessionId: string | undefined,
    limit: number,
    maxBytes = DEFAULT_MAX_SNAPSHOT_LIST_BYTES,
  ): SnapshotRequestRecord[] {
    this.assertActiveDevice(actor);
    const rows = this.sqlite.prepare(`
      SELECT snapshot_requests.* FROM snapshot_requests
      WHERE requested_by_user_id = ? AND (? IS NULL OR status = ?)
        AND (? IS NULL OR session_id = ?)
        AND (status = 'completed' OR EXISTS (
          SELECT 1 FROM project_memberships JOIN sessions
            ON sessions.project_id = project_memberships.project_id
          WHERE sessions.id = snapshot_requests.session_id
            AND project_memberships.user_id = snapshot_requests.requested_by_user_id
        ))
      ORDER BY created_at DESC, snapshot_requests.rowid DESC LIMIT ?
    `).all(
      actor.user_id, status ?? null, status ?? null, sessionId ?? null, sessionId ?? null, limit,
    ) as unknown as SnapshotRequestRow[];
    const results: SnapshotRequestRecord[] = [];
    let encodedBytes = 2;
    for (const row of rows) {
      const record = this.mapSnapshotRequest(row);
      const recordBytes = Buffer.byteLength(JSON.stringify(record)) + (results.length === 0 ? 0 : 1);
      if (results.length > 0 && encodedBytes + recordBytes > maxBytes) break;
      results.push(record);
      encodedBytes += recordBytes;
    }
    return results;
  }

  claimSnapshotRequest(actor: Actor, requestId: string, runtimeId: string): SnapshotRequestRecord {
    return this.transaction(() => {
      this.assertActiveDevice(actor);
      const request = this.requireSnapshotRequest(requestId);
      if (request.requested_by_user_id !== actor.user_id) throw notFound("Snapshot request");
      const localControl = isLocalSyncRequestKind(request.kind);
      if (request.kind === "visible_history_replace" || localControl) {
        const session = this.requireWritableSessionInsideTransaction(actor, request.session_id);
        this.assertCodeControlEnabled(request.kind, session.project_id);
      } else {
        this.requireReadableSessionInsideTransaction(actor, request.session_id);
      }
      const runtime = this.requireRuntimeForActor(
        actor,
        request.session_id,
        runtimeId,
        localControl ? "execution" : "snapshot_connector",
      );
      if (localControl && (request.target_runtime_id !== runtime.id || !this.supportsControlHarness(request.kind, runtime.harness))) {
        throw forbidden("This local sync control targets a different execution runtime");
      }
      if (request.status === "claimed" && request.claimed_by_runtime_id === runtimeId) return request;
      if (request.status !== "pending") throw conflict("Snapshot request is not pending");
      const changed = this.sqlite.prepare(`
        UPDATE snapshot_requests SET status = 'claimed', claimed_by_runtime_id = ?, claimed_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(runtimeId, this.now(), requestId);
      if (Number(changed.changes) !== 1) throw conflict("Snapshot request was claimed concurrently");
      return this.requireSnapshotRequest(requestId);
    });
  }

  completeSnapshotRequest(actor: Actor, requestId: string, runtimeId: string, result: JsonValue): SnapshotRequestRecord {
    return this.finishSnapshotRequest(actor, requestId, runtimeId, { result });
  }

  failSnapshotRequest(actor: Actor, requestId: string, runtimeId: string, failure: SnapshotFailure): SnapshotRequestRecord {
    return this.finishSnapshotRequest(actor, requestId, runtimeId, { failure });
  }

  runtimeProvenance(runtime: RuntimeRecord): RuntimeProvenance {
    return {
      user_id: runtime.user_id,
      device_id: runtime.device_id,
      runtime_id: runtime.id,
      harness: runtime.harness,
      provider: runtime.provider,
      model: runtime.model,
      local_session_id: "private",
      capture_fidelity: runtime.capture_fidelity,
    };
  }

  private getRuntimeByIdentity(deviceId: string, harness: string, localSessionId: string): RuntimeRecord {
    const row = this.sqlite.prepare(`
      SELECT id, session_id, user_id, device_id, purpose, harness, provider, model, execution_profiles_json, local_session_id, capture_fidelity, status, last_seen_at
      FROM runtimes WHERE device_id = ? AND harness = ? AND local_session_id = ?
    `).get(deviceId, harness, localSessionId) as unknown as RuntimeRow;
    return mapRuntimeRow(row);
  }

  private requireRuntimeForActor(actor: Actor, sessionId: string, runtimeId: string, purpose: RuntimeRecord["purpose"]): RuntimeRecord {
    const runtime = this.getRuntime(runtimeId);
    if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
      || runtime.session_id !== sessionId || runtime.status === "revoked" || runtime.purpose !== purpose) {
      throw forbidden(`A matching ${purpose} runtime on the authenticated device is required`);
    }
    return runtime;
  }

  private requireReadableSessionInsideTransaction(actor: Actor, sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (this.membershipRole(sessionId, actor.user_id) === null) throw notFound("Session");
    return session;
  }

  private requireWritableSessionInsideTransaction(actor: Actor, sessionId: string): SessionRecord {
    const session = this.requireReadableSessionInsideTransaction(actor, sessionId);
    const role = this.membershipRole(sessionId, actor.user_id);
    if (role === "viewer") throw forbidden("Viewers cannot append events");
    if (session.mode === "solo" && session.owner_user_id !== actor.user_id) {
      throw forbidden("Only the solo creator can write to this session");
    }
    return session;
  }

  private requireSessionManageableInsideTransaction(actor: Actor, sessionId: string): SessionRecord {
    const session = this.requireReadableSessionInsideTransaction(actor, sessionId);
    const role = this.membershipRole(sessionId, actor.user_id);
    if (session.mode === "solo") {
      if (role === "viewer" || session.owner_user_id !== actor.user_id) {
        throw forbidden("Only the solo creator can manage this session");
      }
      return session;
    }
    if (role !== "owner") throw forbidden("Only the project owner can manage a multi session");
    return session;
  }

  private localTurnResult(localTurnId: string, runtimeId: string, basedOnSequence: number, row: LocalTurnCommitRow): CommitLocalTurnResult {
    const toolEventIds = JSON.parse(row.tool_event_ids_json) as string[];
    return {
      local_turn_id: localTurnId,
      runtime_id: runtimeId,
      head_before_commit: row.head_before_commit,
      reconciliation_required: row.head_before_commit > basedOnSequence,
      request_event: this.getEventById(row.request_event_id),
      response_event: this.getEventById(row.response_event_id),
      tool_events: toolEventIds.map((id) => this.getEventById(id)),
    };
  }

  private getEventById(eventId: string): CanonicalEvent {
    const row = this.sqlite.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as unknown as EventRow | undefined;
    if (!row) throw notFound("Event");
    return mapEvent(row);
  }

  private mapSnapshotRequest(row: SnapshotRequestRow): SnapshotRequestRecord {
    return {
      id: row.id, session_id: row.session_id, requested_by_user_id: row.requested_by_user_id,
      kind: row.request_kind,
      through_sequence: row.through_sequence, status: row.status,
      target_runtime_id: row.target_runtime_id,
      claimed_by_runtime_id: row.claimed_by_runtime_id, created_at: row.created_at,
      claimed_at: row.claimed_at, completed_at: row.completed_at, failed_at: row.failed_at,
      result: row.result_json === null ? null : JSON.parse(row.result_json) as JsonValue,
      failure: row.failure_json === null ? null : JSON.parse(row.failure_json) as SnapshotFailure,
    };
  }

  private requireSnapshotRequest(requestId: string): SnapshotRequestRecord {
    const row = this.sqlite.prepare("SELECT * FROM snapshot_requests WHERE id = ?")
      .get(requestId) as unknown as SnapshotRequestRow | undefined;
    if (!row) throw notFound("Snapshot request");
    return this.mapSnapshotRequest(row);
  }

  private finishSnapshotRequest(
    actor: Actor,
    requestId: string,
    runtimeId: string,
    outcome: { result: JsonValue } | { failure: SnapshotFailure },
  ): SnapshotRequestRecord {
    return this.transaction(() => {
      this.assertActiveDevice(actor);
      const request = this.requireSnapshotRequest(requestId);
      if (request.requested_by_user_id !== actor.user_id) throw notFound("Snapshot request");
      const localControl = isLocalSyncRequestKind(request.kind);
      if (isCodeSyncRequestKind(request.kind)) {
        const session = this.requireWritableSessionInsideTransaction(actor, request.session_id);
        this.assertCodeControlEnabled(request.kind, session.project_id);
      }
      const runtime = this.requireRuntimeForActor(
        actor,
        request.session_id,
        runtimeId,
        localControl ? "execution" : "snapshot_connector",
      );
      if (localControl && (request.target_runtime_id !== runtime.id || !this.supportsControlHarness(request.kind, runtime.harness))) {
        throw forbidden("This local sync control targets a different execution runtime");
      }
      const targetStatus = "result" in outcome ? "completed" : "failed";
      if (request.status === targetStatus && request.claimed_by_runtime_id === runtimeId) {
        const matches = "result" in outcome
          ? stableJson(request.result as JsonValue) === stableJson(outcome.result)
          : stableJson(request.failure as unknown as JsonValue) === stableJson(outcome.failure as unknown as JsonValue);
        if (!matches) throw idempotencyConflict("Snapshot request outcome does not match the stored outcome");
        return request;
      }
      if (request.status !== "claimed" || request.claimed_by_runtime_id !== runtimeId) {
        throw conflict("Snapshot request must be claimed by this runtime");
      }
      const timestamp = this.now();
      const storedJson = JSON.stringify("result" in outcome ? outcome.result : outcome.failure);
      const storageBytes = Buffer.byteLength(storedJson);
      if (storageBytes > this.maxSnapshotResultBytes) {
        throw snapshotStorageQuotaExceeded("result", this.maxSnapshotResultBytes);
      }
      this.enforceSnapshotStorageQuota(request.session_id, actor.user_id, storageBytes);
      if ("result" in outcome) {
        this.sqlite.prepare(`UPDATE snapshot_requests SET status = 'completed', completed_at = ?, result_json = ?, storage_bytes = storage_bytes + ?
          WHERE id = ? AND status = 'claimed' AND claimed_by_runtime_id = ?`)
          .run(timestamp, storedJson, storageBytes, requestId, runtimeId);
      } else {
        this.sqlite.prepare(`UPDATE snapshot_requests SET status = 'failed', failed_at = ?, failure_json = ?, storage_bytes = storage_bytes + ?
          WHERE id = ? AND status = 'claimed' AND claimed_by_runtime_id = ?`)
          .run(timestamp, storedJson, storageBytes, requestId, runtimeId);
      }
      this.sqlite.prepare(`
        INSERT INTO snapshot_storage_usage(session_id, user_id, bytes) VALUES (?, ?, ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET bytes = bytes + excluded.bytes
      `).run(request.session_id, actor.user_id, storageBytes);
      return this.requireSnapshotRequest(requestId);
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private supportsControlHarness(kind: SnapshotRequestKind, harness: string): boolean {
    const normalized = harness.trim().toLowerCase();
    return normalized === "codex" || (isCodeSyncRequestKind(kind) && normalized === "deepseek-harness");
  }

  private assertCodeControlEnabled(kind: SnapshotRequestKind, projectId: string): void {
    // Local status and disabling automatic upload remain available while the
    // cloud repository is paused, so a member can turn off an existing local
    // upload preference without first re-enabling cloud transfers.
    if (isCodeSyncRequestKind(kind) && kind !== "code_sync_status" && kind !== "code_auto_upload_disable"
      && !this.sqlite.prepare("SELECT 1 FROM code_repositories WHERE project_id=? AND enabled=1").get(projectId)) {
      throw conflict("Enable project code collaboration before changing local code sync");
    }
  }

  private touchProject(projectId: string, timestamp = this.now()): void {
    this.sqlite.prepare(`
      UPDATE projects SET updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE id = ?
    `).run(timestamp, timestamp, projectId);
  }

  private actorDisplayName(actorUserId: string): string {
    const row = this.sqlite.prepare("SELECT display_name FROM users WHERE id = ?")
      .get(actorUserId) as { display_name: string } | undefined;
    return row?.display_name.trim() || actorUserId;
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
    const row = this.sqlite.prepare(`
      SELECT sessions.* FROM sessions
      JOIN projects ON projects.id = sessions.project_id
      WHERE sessions.id = ? AND projects.owner_user_id = ?
    `)
      .get(sessionId, userId) as unknown as SessionRow | undefined;
    if (!row) throw notFound("Session");
    return row;
  }

  private requireProjectOwnedBy(projectId: string, userId: string): ProjectRecord {
    const row = this.sqlite.prepare("SELECT * FROM projects WHERE id = ? AND owner_user_id = ?")
      .get(projectId, userId) as unknown as ProjectRow | undefined;
    if (!row) throw notFound("Project");
    return this.publicProject(row);
  }

  private requireProjectMember(projectId: string, userId: string): ProjectMemberRecord {
    const row = this.sqlite.prepare(`
      SELECT project_memberships.user_id, users.display_name, project_memberships.role
      FROM project_memberships JOIN users ON users.id = project_memberships.user_id
      WHERE project_memberships.project_id = ? AND project_memberships.user_id = ?
    `).get(projectId, userId) as unknown as ProjectMemberRecord | undefined;
    if (!row) throw notFound("Project membership");
    return row;
  }

  private publicProject(row: ProjectRow | ProjectRecord): ProjectRecord {
    return {
      id: row.id,
      owner_user_id: row.owner_user_id,
      title: row.title,
      state: row.state,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private projectCreationResult(
    project: ProjectRow | ProjectRecord,
  ): ProjectRecord & { role: "owner"; session_count: number } {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?")
      .get(project.id) as unknown as CountRow;
    return { ...this.publicProject(project), role: "owner", session_count: row.count };
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

  private publicProjectInvitation(row: ProjectInvitationRow): ProjectInvitationRecord {
    return {
      id: row.id,
      project_id: row.project_id,
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

  private requireProjectInvitation(invitationId: string, projectId?: string): ProjectInvitationRecord {
    const row = (projectId === undefined
      ? this.sqlite.prepare("SELECT * FROM project_invitations WHERE id = ?").get(invitationId)
      : this.sqlite.prepare("SELECT * FROM project_invitations WHERE id = ? AND project_id = ?")
        .get(invitationId, projectId)
    ) as unknown as ProjectInvitationRow | undefined;
    if (!row) throw notFound("Invitation");
    return this.publicProjectInvitation(row);
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

  private appendProjectInvitationAudit(input: Omit<ProjectInvitationAuditRecord, "id">): void {
    this.sqlite.prepare(`
      INSERT INTO project_invitation_audit(
        id, invitation_id, project_id, action, inviter_user_id,
        subject_user_id, subject_device_id, role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.invitation_id,
      input.project_id,
      input.action,
      input.inviter_user_id,
      input.subject_user_id,
      input.subject_device_id,
      input.role,
      input.created_at,
    );
  }

  private insertBrowserSession(actor: Actor, createdAtDate: Date, rememberDevice = false): BrowserSessionIssue {
    const createdAt = createdAtDate.toISOString();
    const ttl = rememberDevice ? REMEMBERED_BROWSER_SESSION_TTL_MS : BROWSER_SESSION_TTL_MS;
    const expiresAt = new Date(createdAtDate.getTime() + ttl).toISOString();
    const sessionId = randomUUID();
    const token = issueBrowserSessionToken();
    this.sqlite.prepare(`
      UPDATE browser_sessions SET revoked_at = ?
      WHERE device_id = ? AND revoked_at IS NULL
    `).run(createdAt, actor.device_id);
    this.sqlite.prepare(`
      INSERT INTO browser_sessions(id, user_id, device_id, token_digest, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, actor.user_id, actor.device_id, this.tokenDigest(token), createdAt, expiresAt);
    return { session_id: sessionId, token, expires_at: expiresAt, remembered: rememberDevice };
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

  private expireProjectInvitation(invitation: ProjectInvitationRecord, timestamp: string): void {
    const result = this.sqlite.prepare(`
      UPDATE project_invitations SET expired_at = ?
      WHERE id = ? AND expired_at IS NULL AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at <= ?
    `).run(timestamp, invitation.id, timestamp);
    if (Number(result.changes) === 0) return;
    this.appendProjectInvitationAudit({
      invitation_id: invitation.id,
      project_id: invitation.project_id,
      action: "expired",
      inviter_user_id: invitation.inviter_user_id,
      subject_user_id: null,
      subject_device_id: null,
      role: invitation.role,
      created_at: timestamp,
    });
  }

  private expirePendingProjectInvitations(projectId: string, timestamp: string): void {
    this.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT * FROM project_invitations
        WHERE project_id = ? AND expired_at IS NULL AND revoked_at IS NULL
          AND claimed_at IS NULL AND expires_at <= ?
      `).all(projectId, timestamp) as unknown as ProjectInvitationRow[];
      for (const row of rows) this.expireProjectInvitation(this.publicProjectInvitation(row), timestamp);
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

  private migrateCodeRepositoryEnableColumn(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(code_repositories)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("enabled")) {
      this.sqlite.exec("ALTER TABLE code_repositories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))");
    }
  }

  private migrateAccountCapabilities(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (columns.has("can_create_projects")) return;
    this.transaction(() => {
      this.sqlite.exec("ALTER TABLE users ADD COLUMN can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK (can_create_projects IN (0, 1))");
      // Preserve the bootstrap operator and everyone who already owns a project.
      // Other legacy invitation-only identities become project-scoped guests.
      this.sqlite.exec(`
        UPDATE users SET can_create_projects = 1
        WHERE id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1)
           OR id IN (SELECT owner_user_id FROM projects)
      `);
    });
  }

  private migrateProjectModel(): void {
    const sessionColumns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!sessionColumns.has("project_id")) {
      this.sqlite.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE");
    }
    const legacySessions = this.sqlite.prepare(`
      SELECT id, owner_user_id, title, created_at, updated_at
      FROM sessions WHERE project_id IS NULL
      ORDER BY id
    `).all() as Array<{
      id: string;
      owner_user_id: string;
      title: string;
      created_at: string;
      updated_at: string;
    }>;
    if (legacySessions.length > 0) {
      this.transaction(() => {
        for (const session of legacySessions) {
          const projectId = `project-${createHash("sha256")
            .update(`legacy-session\0${session.id}`)
            .digest("hex")
            .slice(0, 32)}`;
          this.sqlite.prepare(`
            INSERT OR IGNORE INTO projects(
              id, owner_user_id, title, state, creation_idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, ?, ?)
          `).run(
            projectId,
            session.owner_user_id,
            session.title,
            `migration-${session.id}`,
            session.created_at,
            session.updated_at,
          );
          this.sqlite.prepare(`
            INSERT OR IGNORE INTO project_memberships(project_id, user_id, role, created_at, updated_at)
            SELECT ?, user_id, role, created_at, updated_at FROM memberships WHERE session_id = ?
          `).run(projectId, session.id);
          this.sqlite.prepare(`
            INSERT OR IGNORE INTO project_memberships(project_id, user_id, role, created_at, updated_at)
            VALUES (?, ?, 'owner', ?, ?)
          `).run(projectId, session.owner_user_id, session.created_at, session.updated_at);
          this.sqlite.prepare("UPDATE sessions SET project_id = ? WHERE id = ? AND project_id IS NULL")
            .run(projectId, session.id);
        }
      });
    }
    this.sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_project_required_insert
      BEFORE INSERT ON sessions
      WHEN NEW.project_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'project_id is required');
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_project_required_update
      BEFORE UPDATE OF project_id ON sessions
      WHEN NEW.project_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'project_id is required');
      END;
    `);
  }

  private migrateRuntimePurposeColumn(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(runtimes)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("purpose")) {
      this.sqlite.exec("ALTER TABLE runtimes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution' CHECK (purpose IN ('execution', 'snapshot_connector'))");
    }
  }

  private migrateRuntimeExecutionProfilesColumn(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(runtimes)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("execution_profiles_json")) {
      this.sqlite.exec("ALTER TABLE runtimes ADD COLUMN execution_profiles_json TEXT CHECK (execution_profiles_json IS NULL OR json_valid(execution_profiles_json))");
    }
  }

  private migrateEventActorDisplayNameColumn(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("actor_display_name")) {
      this.sqlite.exec("ALTER TABLE events ADD COLUMN actor_display_name TEXT");
    }
    this.sqlite.exec(`
      UPDATE events
      SET actor_display_name = COALESCE(
        NULLIF((SELECT display_name FROM users WHERE users.id = events.actor_user_id), ''),
        actor_user_id
      )
      WHERE actor_display_name IS NULL OR actor_display_name = '';

      CREATE TRIGGER IF NOT EXISTS events_actor_display_name_required_insert
      BEFORE INSERT ON events
      WHEN NEW.actor_display_name IS NULL OR NEW.actor_display_name = ''
      BEGIN
        SELECT RAISE(ABORT, 'actor_display_name is required');
      END;

      CREATE TRIGGER IF NOT EXISTS events_actor_display_name_required_update
      BEFORE UPDATE OF actor_display_name ON events
      WHEN NEW.actor_display_name IS NULL OR NEW.actor_display_name = ''
      BEGIN
        SELECT RAISE(ABORT, 'actor_display_name is required');
      END;
    `);
  }

  private migrateAgentProgressEventType(): void {
    const table = this.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get() as { sql?: string } | undefined;
    if (table?.sql?.includes("'agent_progress'")) return;
    this.sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      this.sqlite.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE events_next (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          idempotency_key TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('human_chat','agent_request','agent_progress','agent_response','tool_call','tool_result','attachment','context_snapshot','membership_change','session_state_change')),
          actor_user_id TEXT NOT NULL REFERENCES users(id),
          actor_display_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          visibility TEXT NOT NULL CHECK (visibility IN ('session', 'owner_only')),
          reply_to_event_id TEXT REFERENCES events_next(id),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          runtime_provenance_json TEXT CHECK (runtime_provenance_json IS NULL OR json_valid(runtime_provenance_json)),
          UNIQUE (session_id, sequence),
          UNIQUE (session_id, idempotency_key)
        ) STRICT;
        INSERT INTO events_next(
          id, session_id, sequence, idempotency_key, type, actor_user_id, actor_display_name,
          created_at, visibility, reply_to_event_id, payload_json, runtime_provenance_json
        ) SELECT
          id, session_id, sequence, idempotency_key, type, actor_user_id, actor_display_name,
          created_at, visibility, reply_to_event_id, payload_json, runtime_provenance_json
        FROM events;
        DROP TABLE events;
        ALTER TABLE events_next RENAME TO events;
        CREATE INDEX events_replay_idx ON events(session_id, sequence);
        CREATE INDEX events_actor_idx ON events(actor_user_id);
        CREATE TRIGGER events_actor_display_name_required_insert
        BEFORE INSERT ON events
        WHEN NEW.actor_display_name IS NULL OR NEW.actor_display_name = ''
        BEGIN
          SELECT RAISE(ABORT, 'actor_display_name is required');
        END;
        CREATE TRIGGER events_actor_display_name_required_update
        BEFORE UPDATE OF actor_display_name ON events
        WHEN NEW.actor_display_name IS NULL OR NEW.actor_display_name = ''
        BEGIN
          SELECT RAISE(ABORT, 'actor_display_name is required');
        END;
        COMMIT;
      `);
    } catch (error) {
      try { this.sqlite.exec("ROLLBACK"); } catch { /* The migration may have failed before BEGIN. */ }
      throw error;
    } finally {
      this.sqlite.exec("PRAGMA foreign_keys = ON");
    }
    const violations = this.sqlite.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("Agent progress migration failed foreign-key validation");
  }

  /**
   * Give agent claims a lease and a bounded recovery budget, and let them end in a
   * terminal `failed` rather than sitting `claimed` forever.
   *
   * Pre-lease rows are inserted with a null `lease_expires_at`, which the claim
   * path reads as "already expired". That is deliberate: a claim written by an
   * older build is by definition one nothing is renewing, so recovery is the
   * safe reading of it.
   */
  private migrateAgentClaimLease(): void {
    const table = this.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_request_claims'")
      .get() as { sql?: string } | undefined;
    if (table?.sql === undefined || table.sql.includes("lease_expires_at")) return;
    this.sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      this.sqlite.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE agent_request_claims_next (
          request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
          runtime_id TEXT NOT NULL REFERENCES runtimes(id),
          claimed_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
          lease_expires_at TEXT
        ) STRICT;
        INSERT INTO agent_request_claims_next(
          request_event_id, runtime_id, claimed_at, completed_at, status, attempt_count, lease_expires_at
        ) SELECT
          request_event_id, runtime_id, claimed_at, completed_at, status, 1, NULL
        FROM agent_request_claims;
        DROP TABLE agent_request_claims;
        ALTER TABLE agent_request_claims_next RENAME TO agent_request_claims;
        COMMIT;
      `);
    } catch (error) {
      try { this.sqlite.exec("ROLLBACK"); } catch { /* The migration may have failed before BEGIN. */ }
      throw error;
    } finally {
      this.sqlite.exec("PRAGMA foreign_keys = ON");
    }
    const violations = this.sqlite.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("Agent claim lease migration failed foreign-key validation");
  }

  private migrateSnapshotStorageLedger(): void {
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(snapshot_requests)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("storage_bytes")) {
      this.sqlite.exec("ALTER TABLE snapshot_requests ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0)");
    }
    if (!columns.has("metadata_charged")) {
      this.sqlite.exec("ALTER TABLE snapshot_requests ADD COLUMN metadata_charged INTEGER NOT NULL DEFAULT 0 CHECK (metadata_charged IN (0, 1))");
    }
    if (!columns.has("request_kind")) {
      this.sqlite.exec("ALTER TABLE snapshot_requests ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'immutable' CHECK (request_kind IN ('immutable', 'visible_history_replace'))");
    }
    this.transaction(() => {
      this.sqlite.exec(`
        UPDATE snapshot_requests
        SET storage_bytes = storage_bytes + ${SNAPSHOT_REQUEST_METADATA_BYTES}, metadata_charged = 1
        WHERE metadata_charged = 0
      `);
      this.sqlite.exec("DELETE FROM snapshot_storage_usage");
      this.sqlite.exec(`
        INSERT INTO snapshot_storage_usage(session_id, user_id, bytes)
        SELECT session_id, requested_by_user_id, SUM(storage_bytes)
        FROM snapshot_requests
        WHERE storage_bytes > 0
        GROUP BY session_id, requested_by_user_id
      `);
    });
  }

  private migrateSnapshotControlRequests(): void {
    const table = this.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_requests'")
      .get() as { sql?: string } | undefined;
    const columns = new Set(
      (this.sqlite.prepare("PRAGMA table_info(snapshot_requests)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (table?.sql?.includes("'code_sync_status'") && columns.has("target_runtime_id")) return;
    this.sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      this.sqlite.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE snapshot_requests_next (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          request_kind TEXT NOT NULL DEFAULT 'immutable' CHECK (request_kind IN ('immutable', 'visible_history_replace', 'local_sync_status', 'local_auto_upload_enable', 'local_auto_upload_disable', 'local_turn_upload', 'code_sync_status', 'code_upload', 'code_download', 'code_recover', 'code_auto_upload_enable', 'code_auto_upload_disable')),
          through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
          target_runtime_id TEXT REFERENCES runtimes(id),
          claimed_by_runtime_id TEXT REFERENCES runtimes(id),
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          failed_at TEXT,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
          storage_bytes INTEGER NOT NULL DEFAULT ${SNAPSHOT_REQUEST_METADATA_BYTES} CHECK (storage_bytes >= 0),
          metadata_charged INTEGER NOT NULL DEFAULT 1 CHECK (metadata_charged IN (0, 1))
        ) STRICT;
        INSERT INTO snapshot_requests_next(
          id, session_id, requested_by_user_id, request_kind, through_sequence, status,
          target_runtime_id, claimed_by_runtime_id, created_at, claimed_at, completed_at,
          failed_at, result_json, failure_json, storage_bytes, metadata_charged
        ) SELECT
          id, session_id, requested_by_user_id, request_kind, through_sequence, status,
          ${columns.has("target_runtime_id") ? "target_runtime_id" : "NULL"}, claimed_by_runtime_id, created_at, claimed_at, completed_at,
          failed_at, result_json, failure_json, storage_bytes, metadata_charged
        FROM snapshot_requests;
        DROP TABLE snapshot_requests;
        ALTER TABLE snapshot_requests_next RENAME TO snapshot_requests;
        CREATE INDEX snapshot_requests_user_status_idx
          ON snapshot_requests(requested_by_user_id, status, created_at, id);
        COMMIT;
      `);
    } catch (error) {
      try { this.sqlite.exec("ROLLBACK"); } catch { /* The migration may have failed before BEGIN. */ }
      throw error;
    } finally {
      this.sqlite.exec("PRAGMA foreign_keys = ON");
    }
    const violations = this.sqlite.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("Snapshot control migration failed foreign-key validation");
  }

  private migrateCanonicalProvenancePrivacy(): void {
    const changed = this.sqlite.prepare(`
      UPDATE events
      SET runtime_provenance_json = json_set(runtime_provenance_json, '$.local_session_id', 'private')
      WHERE runtime_provenance_json IS NOT NULL
        AND COALESCE(json_extract(runtime_provenance_json, '$.local_session_id'), '') != 'private'
    `).run();
    if (Number(changed.changes) > 0) this.sqlite.exec("DELETE FROM event_storage_usage");
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

  private enforceSnapshotStorageQuota(sessionId: string, userId: string, storageBytes: number): void {
    const sessionUsage = this.sqlite.prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM snapshot_storage_usage WHERE session_id = ?",
    ).get(sessionId) as unknown as BytesRow;
    if (sessionUsage.bytes + storageBytes > this.maxSessionSnapshotBytes) {
      throw snapshotStorageQuotaExceeded("session", this.maxSessionSnapshotBytes);
    }
    const userUsage = this.sqlite.prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM snapshot_storage_usage WHERE user_id = ?",
    ).get(userId) as unknown as BytesRow;
    if (userUsage.bytes + storageBytes > this.maxUserSnapshotBytes) {
      throw snapshotStorageQuotaExceeded("user", this.maxUserSnapshotBytes);
    }
    const totalUsage = this.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM snapshot_storage_usage")
      .get() as unknown as BytesRow;
    if (totalUsage.bytes + storageBytes > this.maxTotalSnapshotBytes) {
      throw snapshotStorageQuotaExceeded("deployment", this.maxTotalSnapshotBytes);
    }
  }

  private enforceActiveSnapshotRequestQuota(sessionId: string, userId: string): void {
    const activePredicate = "status IN ('pending', 'claimed')";
    const user = this.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM snapshot_requests WHERE requested_by_user_id = ? AND ${activePredicate}`,
    ).get(userId) as unknown as CountRow;
    if (user.count >= this.maxUserActiveSnapshotRequests) {
      throw conflict("User has too many active snapshot requests");
    }
    const session = this.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM snapshot_requests WHERE session_id = ? AND ${activePredicate}`,
    ).get(sessionId) as unknown as CountRow;
    if (session.count >= this.maxSessionActiveSnapshotRequests) {
      throw conflict("Session has too many active snapshot requests");
    }
    const deployment = this.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM snapshot_requests WHERE ${activePredicate}`,
    ).get() as unknown as CountRow;
    if (deployment.count >= this.maxTotalActiveSnapshotRequests) {
      throw conflict("Deployment has too many active snapshot requests");
    }
  }

  private enforceSessionQuota(projectId: string, ownerUserId: string): void {
    const user = this.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE owner_user_id = ?")
      .get(ownerUserId) as unknown as CountRow;
    if (user.count >= this.maxUserSessions) throw sessionQuotaExceeded("user", this.maxUserSessions);
    const project = this.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?")
      .get(projectId) as unknown as CountRow;
    if (project.count >= this.maxProjectSessions) throw sessionQuotaExceeded("project", this.maxProjectSessions);
    const total = this.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get() as unknown as CountRow;
    if (total.count >= this.maxTotalSessions) throw sessionQuotaExceeded("deployment", this.maxTotalSessions);
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

  private appendInsideTransaction(
    actorUserId: string,
    sessionId: string,
    input: Omit<AppendEventInput, "visibility"> & { visibility?: EventVisibility },
    provenance: RuntimeProvenance | null,
  ): CanonicalEvent {
    const session = this.requireSession(sessionId);
    const sequence = session.next_sequence + 1;
    const actorDisplayName = this.actorDisplayName(actorUserId);
    const event: CanonicalEvent = {
      id: input.event_id ?? randomUUID(),
      session_id: sessionId,
      sequence,
      idempotency_key: input.idempotency_key,
      type: input.type,
      actor_user_id: actorUserId,
      actor_display_name: actorDisplayName,
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
      INSERT INTO events(id, session_id, sequence, idempotency_key, type, actor_user_id, actor_display_name, created_at, visibility, reply_to_event_id, payload_json, runtime_provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.session_id,
      event.sequence,
      event.idempotency_key,
      event.type,
      event.actor_user_id,
      actorDisplayName,
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
    this.sqlite.prepare(`
      UPDATE sessions SET next_sequence = ?,
        updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE id = ?
    `).run(sequence, event.created_at, event.created_at, sessionId);
    this.sqlite.prepare(`
      UPDATE projects SET updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE id = ?
    `).run(event.created_at, event.created_at, session.project_id);
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
