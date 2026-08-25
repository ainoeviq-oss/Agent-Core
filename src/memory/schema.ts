import type { DatabaseSync } from 'node:sqlite';

export const MEMORY_SCHEMA_VERSION = 1;
export const INITIAL_MEMORY_MIGRATION = '001_initial_memory';

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  project_id TEXT,
  thread_id TEXT,
  resource_id TEXT,
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  raw_text TEXT,
  redacted_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  project_id TEXT,
  canonical_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  enforcement TEXT NOT NULL DEFAULT 'none' CHECK (enforcement IN ('none', 'soft', 'hard')),
  current_revision_id TEXT REFERENCES memory_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  value_text TEXT NOT NULL,
  value_json TEXT,
  value_hash TEXT NOT NULL,
  source_event_id TEXT REFERENCES memory_events(id),
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  supersedes_revision_id TEXT REFERENCES memory_revisions(id),
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, revision_no)
);

CREATE TABLE IF NOT EXISTS memory_anchors (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  anchor TEXT NOT NULL,
  anchor_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, anchor, anchor_type)
);

CREATE TABLE IF NOT EXISTS memory_edges (
  from_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
  evidence_event_id TEXT REFERENCES memory_events(id),
  created_at INTEGER NOT NULL,
  CHECK (from_memory_id <> to_memory_id)
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY,
  left_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  right_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_contexts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  route_context_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  blocking_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_access_log (
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL REFERENCES memory_contexts(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  score REAL NOT NULL,
  reason_json TEXT NOT NULL,
  accessed_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, context_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_scope_key
  ON memory_items(principal_id, IFNULL(project_id, ''), canonical_key);
CREATE INDEX IF NOT EXISTS idx_memory_items_scope_state
  ON memory_items(principal_id, project_id, state, kind);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory_valid
  ON memory_revisions(memory_id, valid_to, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_scope_created
  ON memory_events(principal_id, project_id, thread_id, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_anchors_anchor
  ON memory_anchors(anchor, anchor_type, memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from
  ON memory_edges(from_memory_id, weight DESC, to_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to
  ON memory_edges(to_memory_id, weight DESC, from_memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_identity
  ON memory_edges(from_memory_id, to_memory_id, relation, IFNULL(evidence_event_id, ''));
CREATE INDEX IF NOT EXISTS idx_memory_contexts_route
  ON memory_contexts(principal_id, route_context_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_access_recent
  ON memory_access_log(memory_id, accessed_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  principal_id UNINDEXED,
  project_id UNINDEXED,
  canonical_key,
  anchors,
  value_text,
  state UNINDEXED,
  kind UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export function initializeMemorySchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  )`);

  const applied = db.prepare('SELECT 1 AS present FROM memory_schema_migrations WHERE version = ?').get(MEMORY_SCHEMA_VERSION);
  if (!applied) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(INITIAL_SCHEMA_SQL);
      db.prepare('INSERT INTO memory_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(MEMORY_SCHEMA_VERSION, INITIAL_MEMORY_MIGRATION, Date.now());
      db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
  }
}

export function rebuildMemoryFts(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM memory_fts');
    db.exec(`
      INSERT INTO memory_fts(memory_id, principal_id, project_id, canonical_key, anchors, value_text, state, kind)
      SELECT
        item.id,
        item.principal_id,
        COALESCE(item.project_id, ''),
        item.canonical_key,
        COALESCE((
          SELECT group_concat(anchor, ' ')
          FROM (
            SELECT anchor
            FROM memory_anchors
            WHERE memory_id = item.id
            ORDER BY anchor COLLATE BINARY
          )
        ), ''),
        revision.value_text,
        item.state,
        item.kind
      FROM memory_items AS item
      JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
      WHERE item.state <> 'tombstoned'
      ORDER BY item.id COLLATE BINARY
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
