/** The reservation and the canonical request are committed in one SQLite write. */
export const HOSTED_AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS hosted_agent_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_neurons INTEGER NOT NULL CHECK(daily_neurons >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_agent_jobs (
  request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  reserved_neurons INTEGER NOT NULL CHECK(reserved_neurons > 0),
  metered_neurons INTEGER CHECK(metered_neurons >= 0),
  input_tokens INTEGER CHECK(input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens >= 0),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS hosted_agent_jobs_day_idx ON hosted_agent_jobs(utc_day,status);
CREATE INDEX IF NOT EXISTS hosted_agent_jobs_user_day_idx ON hosted_agent_jobs(user_id,utc_day);

-- Version 2 counts bounded runs across providers. Preserve the earlier preview's
-- tables and canonical IDs; copying is idempotent and never resets daily usage.
CREATE TABLE IF NOT EXISTS hosted_agent_run_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_runs INTEGER NOT NULL CHECK(daily_runs >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_agent_runs (
  request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  quota_group TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS hosted_agent_runs_day_idx ON hosted_agent_runs(utc_day,status);
CREATE INDEX IF NOT EXISTS hosted_agent_runs_user_day_idx ON hosted_agent_runs(user_id,utc_day);
CREATE INDEX IF NOT EXISTS hosted_agent_runs_group_day_idx ON hosted_agent_runs(quota_group,utc_day,status);
INSERT OR IGNORE INTO hosted_agent_run_limits SELECT user_id, daily_neurons / 2000 FROM hosted_agent_limits;
INSERT OR IGNORE INTO hosted_agent_runs
  SELECT request_event_id,session_id,user_id,device_id,utc_day,'default','legacy','legacy',
    'cloudflare-workers-ai','@cf/qwen/qwen3-30b-a3b-fp8',status,created_at,finished_at
  FROM hosted_agent_jobs;
`;
