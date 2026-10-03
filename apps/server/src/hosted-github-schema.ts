export const HOSTED_GITHUB_SCHEMA = `
CREATE TABLE IF NOT EXISTS hosted_github_accounts (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 login TEXT NOT NULL, credentials TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_github_oauth (
 state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_github_bindings (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 repository TEXT NOT NULL, repository_id INTEGER NOT NULL, base_branch TEXT NOT NULL, revision TEXT NOT NULL,
 PRIMARY KEY(user_id,project_id)
) STRICT;
CREATE TABLE IF NOT EXISTS hosted_github_tasks (
 id TEXT PRIMARY KEY, request_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 repository TEXT NOT NULL, repository_id INTEGER NOT NULL, base_branch TEXT NOT NULL, binding_revision TEXT NOT NULL,
 input_json TEXT NOT NULL, input_fingerprint TEXT, state TEXT NOT NULL, base_sha TEXT, base_tree TEXT,
 initial_files TEXT, starting_files TEXT, result_files TEXT, revision TEXT, answer TEXT, error_code TEXT,
 pr_commit TEXT, pr_url TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS hosted_github_tasks_user ON hosted_github_tasks(user_id,project_id,created_at);
`;
