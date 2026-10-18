import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const teamStartDigest = (value: string) => createHash("sha256").update(value).digest("hex");
// The pre-clock preview allocated small counters per Team. Its already-deleted
// definitions leave no maximum to recover, so new allocations use a separate
// opaque safe-integer namespace while existing live revisions remain valid.
export const AGENT_TEAM_REVISION_EPOCH = 2 ** 40;

/** Bounded requester-private control plane; canonical messages remain in events. */
export const AGENT_TEAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_team_plans (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0), plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 65536), updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_team_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT NOT NULL,
  display_name TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  content_revision INTEGER NOT NULL DEFAULT 0 CHECK(content_revision>=0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed','stopped','timed_out','call_limit')),
  calls_used INTEGER NOT NULL DEFAULT 0 CHECK(calls_used BETWEEN 0 AND 48),
  max_calls INTEGER NOT NULL CHECK(max_calls BETWEEN 1 AND 48),
  max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes BETWEEN 1 AND 120),
  created_at TEXT NOT NULL, deadline_at TEXT NOT NULL, finished_at TEXT,
  current_node_id TEXT, current_step_id TEXT, error_code TEXT,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)), next_attempt_at TEXT, wait_reason TEXT,
  purpose TEXT NOT NULL DEFAULT 'task' CHECK(purpose IN ('task','test')),
  definition_id TEXT, definition_revision INTEGER, library_request_digest TEXT,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 525312), UNIQUE(session_id,user_id,idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_team_runs_owner_idx ON agent_team_runs(user_id,session_id,created_at);
CREATE INDEX IF NOT EXISTS agent_team_runs_expiry_idx ON agent_team_runs(finished_at)
  WHERE status NOT IN ('running','paused');
CREATE TABLE IF NOT EXISTS agent_team_start_receipts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_digest TEXT NOT NULL CHECK(length(key_digest)=64), run_id TEXT NOT NULL UNIQUE,
  input_digest TEXT CHECK(input_digest IS NULL OR length(input_digest)=64),
  purpose TEXT NOT NULL CHECK(purpose IN ('task','test')),
  definition_id TEXT, library_request_digest TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(session_id,user_id,key_digest)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_team_start_receipts_owner_idx ON agent_team_start_receipts(user_id);
CREATE TABLE IF NOT EXISTS agent_team_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, node_label TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','paused','timed_out')),
  request_event_id TEXT UNIQUE REFERENCES events(id) ON DELETE SET NULL,
  response_event_id TEXT UNIQUE REFERENCES events(id) ON DELETE SET NULL,
  parent_step_id TEXT, context_response_id TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  cancellation_retry_at TEXT
) STRICT;
CREATE TRIGGER IF NOT EXISTS agent_team_runs_native_claim_cleanup BEFORE DELETE ON agent_team_runs
BEGIN
  UPDATE agent_request_claims SET status='paused',lease_expires_at=NULL
    WHERE status='claimed' AND request_event_id IN
      (SELECT request_event_id FROM agent_team_steps WHERE run_id=OLD.id);
END;
CREATE INDEX IF NOT EXISTS agent_team_canonical_run_idx ON events(session_id,json_extract(payload_json,'$.agent_team.run_id'),sequence)
  WHERE type='agent_request' AND json_type(payload_json,'$.agent_team.run_id')='text';
CREATE INDEX IF NOT EXISTS agent_team_final_response_idx ON events(session_id,reply_to_event_id) WHERE type='agent_response';
CREATE INDEX IF NOT EXISTS agent_team_steps_run_idx ON agent_team_steps(run_id,created_at,id);
CREATE TABLE IF NOT EXISTS agent_team_controls (
  run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved IN (0,1)),
  PRIMARY KEY(run_id,idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_team_definitions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0), config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  tested_revision INTEGER, test_run_id TEXT, test_session_id TEXT, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_team_definitions_owner_idx ON agent_team_definitions(user_id,id);
CREATE TABLE IF NOT EXISTS agent_team_revision_clocks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_revision INTEGER NOT NULL CHECK(last_revision>0)
) STRICT;
INSERT INTO agent_team_revision_clocks(user_id,last_revision)
  SELECT id,MAX(${AGENT_TEAM_REVISION_EPOCH},COALESCE((SELECT MAX(revision) FROM agent_team_definitions WHERE user_id=users.id),0))
  FROM users WHERE id<>'deleted-account'
  ON CONFLICT(user_id) DO UPDATE SET last_revision=MAX(agent_team_revision_clocks.last_revision,excluded.last_revision);
CREATE TABLE IF NOT EXISTS agent_team_favorites (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_json TEXT NOT NULL CHECK(json_valid(module_json)), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_team_favorites_owner_idx ON agent_team_favorites(user_id,id);
CREATE TABLE IF NOT EXISTS agent_team_library_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,idempotency_key)
) STRICT;
`;

/** Additive preview migrations retain existing private state without copying task content. */
export function migrateAgentTeamStartReceipts(sql: DatabaseSync) {
  const insert = sql.prepare(`INSERT OR IGNORE INTO agent_team_start_receipts
    (session_id,user_id,key_digest,run_id,input_digest,purpose,definition_id,library_request_digest,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  sql.exec("BEGIN IMMEDIATE");
  try {
    if (!sql.prepare("PRAGMA table_info(agent_team_runs)").all().some(column => column.name === "wait_reason")) {
      sql.exec("ALTER TABLE agent_team_runs ADD COLUMN wait_reason TEXT");
    }
    if (!sql.prepare("PRAGMA table_info(agent_team_steps)").all().some(column => column.name === "cancellation_retry_at")) {
      sql.exec("ALTER TABLE agent_team_steps ADD COLUMN cancellation_retry_at TEXT");
    }
    for (const row of sql.prepare(`SELECT r.* FROM agent_team_runs r
      WHERE NOT EXISTS(SELECT 1 FROM agent_team_start_receipts k WHERE k.run_id=r.id)`).all()) {
      insert.run(row.session_id!, row.user_id!, teamStartDigest(String(row.idempotency_key)), row.id!,
        teamStartDigest(String(row.input_json)), row.purpose!, row.definition_id!, row.library_request_digest!, row.created_at!);
    }
    // A preview database may already have cleared its private run. The canonical
    // accepted key still proves consumption, but cannot recover an exact digest.
    for (const row of sql.prepare(`SELECT session_id,actor_user_id,
      json_extract(payload_json,'$.agent_team.run_id') AS run_id,
      json_extract(payload_json,'$.agent_team.start_idempotency_key') AS start_key,
      COALESCE(json_extract(payload_json,'$.agent_team.purpose'),'task') AS purpose,created_at
      FROM events WHERE type='agent_request' AND actor_user_id<>'deleted-account'
      AND json_type(payload_json,'$.agent_team.start_idempotency_key')='text'
      AND json_type(payload_json,'$.agent_team.run_id')='text'
      AND NOT EXISTS(SELECT 1 FROM agent_team_start_receipts k WHERE k.run_id=json_extract(events.payload_json,'$.agent_team.run_id'))
      ORDER BY sequence`).all()) {
      insert.run(row.session_id!, row.actor_user_id!, teamStartDigest(String(row.start_key)), row.run_id!,
        null, row.purpose!, null, null, row.created_at!);
    }
    sql.exec("COMMIT");
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}
