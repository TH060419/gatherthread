/** Private credentials and exact-run pins; no canonical payload contains the key. */
export const CLOUD_API_SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_api_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  key_ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cloud_api_configs_user_idx ON cloud_api_configs(user_id);
CREATE TABLE IF NOT EXISTS cloud_api_run_bindings (
  request_event_id TEXT PRIMARY KEY REFERENCES hosted_agent_runs(request_event_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config_id TEXT NOT NULL,
  config_revision TEXT NOT NULL
) STRICT;
`;
