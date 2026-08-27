export const EXECUTION_SCHEMA_VERSION = 4;
export const INITIAL_EXECUTION_MIGRATION = '001_initial_execution_fabric';
export const EVIDENCE_EXECUTION_MIGRATION = '002_declared_artifact_evidence';
export const PARSED_OUTPUT_EXECUTION_MIGRATION = '003_structured_output_evidence';
export const ARTIFACT_INDEX_EXECUTION_MIGRATION = '004_execution_artifact_index';

export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_runs (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  project_id TEXT,
  continuity_task_id TEXT,
  origin_route_context_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned','running','completed','failed','blocked','interrupted','cancelled')),
  objective TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 1),
  last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_nodes (
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  command_text TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','ready','running','succeeded','failed','blocked','interrupted','cancelled')),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 1),
  continue_on_failure INTEGER NOT NULL DEFAULT 0 CHECK (continue_on_failure IN (0,1)),
  expected_artifacts_json TEXT NOT NULL DEFAULT '[]',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY(run_id, node_id)
);

CREATE TABLE IF NOT EXISTS execution_dependencies (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  depends_on_node_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'hard' CHECK (dependency_type = 'hard'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, node_id, depends_on_node_id, dependency_type),
  FOREIGN KEY(run_id, node_id) REFERENCES execution_nodes(run_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY(run_id, depends_on_node_id) REFERENCES execution_nodes(run_id, node_id) ON DELETE CASCADE,
  CHECK (node_id <> depends_on_node_id)
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed','interrupted','cancelled')),
  process_pid INTEGER,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  result_path TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code INTEGER,
  signal TEXT,
  stdout_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stdout_bytes >= 0),
  stderr_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stderr_bytes >= 0),
  stdout_sha256 TEXT,
  stderr_sha256 TEXT,
  error_json TEXT,
  UNIQUE(run_id, node_id, attempt_no),
  FOREIGN KEY(run_id, node_id) REFERENCES execution_nodes(run_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_events (
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, sequence),
  FOREIGN KEY(run_id, node_id) REFERENCES execution_nodes(run_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_memory_sync_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  event_sequence INTEGER,
  sync_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','syncing','synced','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_parsed_outputs (
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','degraded')),
  source_stdout_sha256 TEXT,
  source_stderr_sha256 TEXT,
  parsed_json TEXT,
  confidence REAL,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, parser_version),
  FOREIGN KEY(run_id, node_id) REFERENCES execution_nodes(run_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  path TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('build','test_report','log','data','other')),
  verification TEXT NOT NULL CHECK (verification = 'verified'),
  sha256 TEXT,
  size INTEGER,
  modified_at REAL,
  source_result_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, node_id, attempt_no, path),
  FOREIGN KEY(run_id, node_id) REFERENCES execution_nodes(run_id, node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_execution_runs_scope_state
  ON execution_runs(principal_id, project_id, state, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_execution_runs_continuity_task
  ON execution_runs(principal_id, project_id, continuity_task_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_execution_nodes_run_state
  ON execution_nodes(run_id, state, node_id);
CREATE INDEX IF NOT EXISTS idx_execution_dependencies_target
  ON execution_dependencies(run_id, depends_on_node_id, node_id);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_node
  ON execution_attempts(run_id, node_id, attempt_no DESC);
CREATE INDEX IF NOT EXISTS idx_execution_events_type
  ON execution_events(run_id, event_type, sequence);
CREATE INDEX IF NOT EXISTS idx_execution_sync_state
  ON execution_memory_sync_queue(state, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_execution_parsed_run_node
  ON execution_parsed_outputs(run_id, node_id, attempt_no DESC, parser_version);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_hash
  ON execution_artifacts(sha256, created_at DESC, artifact_id);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_type
  ON execution_artifacts(artifact_type, created_at DESC, artifact_id);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_run_node
  ON execution_artifacts(run_id, node_id, attempt_no DESC, artifact_id);
`;
