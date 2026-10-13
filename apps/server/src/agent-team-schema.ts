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
  state_json TEXT NOT NULL CHECK(json_valid(state_json)), next_attempt_at TEXT,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 525312), UNIQUE(session_id,user_id,idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_team_runs_owner_idx ON agent_team_runs(user_id,session_id,created_at);
CREATE TABLE IF NOT EXISTS agent_team_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, node_label TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','paused','timed_out')),
  request_event_id TEXT UNIQUE REFERENCES events(id) ON DELETE SET NULL,
  response_event_id TEXT UNIQUE REFERENCES events(id) ON DELETE SET NULL,
  parent_step_id TEXT, context_response_id TEXT, created_at TEXT NOT NULL, finished_at TEXT
) STRICT;
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
`;
