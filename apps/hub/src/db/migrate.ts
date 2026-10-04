import type { SqliteDb } from './types.js';

/**
 * Deterministic migration runner. For M0 a set of idempotent
 * `CREATE TABLE IF NOT EXISTS` statements is enough (spec §17). Order matters
 * only for foreign-key references.
 */
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source_device TEXT,
  duration_ms INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  audio_path TEXT,
  audio_checksum TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_revisions (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  kind TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  language_hints TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES transcript_revisions(id),
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  confidence REAL
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body_path TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_revision_id TEXT
);

CREATE TABLE IF NOT EXISTS requirement_source_refs (
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  recording_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  char_start INTEGER,
  char_end INTEGER,
  asr_revision_id TEXT,
  quote_snippet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_refs_requirement
  ON requirement_source_refs(requirement_id);

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload_json TEXT,
  confidence REAL,
  abstained INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  resolution_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  primitive TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT,
  answer_json TEXT,
  confidence REAL,
  certainty TEXT,
  provider TEXT,
  model_version TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_specs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  schedule TEXT
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES workflow_specs(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  grant_json TEXT,
  workspace_path TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS run_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL,
  locked_by TEXT,
  locked_at INTEGER,
  heartbeat_at INTEGER,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, seq)
);

CREATE TABLE IF NOT EXISTS corpora (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT
);

CREATE TABLE IF NOT EXISTS corpus_docs (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL REFERENCES corpora(id),
  path TEXT NOT NULL,
  checksum TEXT,
  mime TEXT,
  indexed_at INTEGER
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  checksum TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT,
  capabilities_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
`;

export function migrate(sqlite: SqliteDb): void {
  sqlite.exec(MIGRATION_SQL);
}
