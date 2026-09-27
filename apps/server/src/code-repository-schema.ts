/** Additive tables; code heads are committed atomically with retry receipts. */
export const CODE_REPOSITORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS code_repositories (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  main_commit TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  charged_bytes INTEGER NOT NULL DEFAULT 0,
  main_logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(main_logical_bytes >= -1),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS code_branches (
  project_id TEXT NOT NULL REFERENCES code_repositories(project_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  head_commit TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK(review_status IN ('draft','requested','merged')),
  logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(logical_bytes >= -1),
  PRIMARY KEY(project_id,id), UNIQUE(project_id,user_id)
);
CREATE TABLE IF NOT EXISTS code_mutations (
  project_id TEXT NOT NULL REFERENCES code_repositories(project_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  invalidated_at TEXT,
  PRIMARY KEY(project_id,idempotency_key)
);
`;
