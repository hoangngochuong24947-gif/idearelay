import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema for **all** §5 tables. Column names are snake_case to match the
 * spec verbatim; timestamps are epoch milliseconds stored as INTEGER.
 */

// §5.1
export const recordings = sqliteTable('recordings', {
  id: text('id').primaryKey(),
  created_at: integer('created_at').notNull(),
  source_device: text('source_device'),
  duration_ms: integer('duration_ms'),
  sample_rate: integer('sample_rate'),
  channels: integer('channels'),
  audio_path: text('audio_path'),
  audio_checksum: text('audio_checksum'),
  status: text('status').notNull(),
});

export const transcriptRevisions = sqliteTable('transcript_revisions', {
  id: text('id').primaryKey(),
  recording_id: text('recording_id').notNull(),
  kind: text('kind').notNull(),
  provider_id: text('provider_id'),
  model: text('model'),
  language_hints: text('language_hints'),
  is_current: integer('is_current').notNull().default(0),
  created_at: integer('created_at').notNull(),
});

export const segments = sqliteTable('segments', {
  id: text('id').primaryKey(),
  revision_id: text('revision_id').notNull(),
  idx: integer('idx').notNull(),
  start_ms: integer('start_ms').notNull(),
  end_ms: integer('end_ms').notNull(),
  text: text('text').notNull(),
  speaker: text('speaker'),
  confidence: real('confidence'),
});

// §5.2
export const requirements = sqliteTable('requirements', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body_path: text('body_path'),
  status: text('status').notNull(),
  created_at: integer('created_at').notNull(),
  source_revision_id: text('source_revision_id'),
});

export const requirementSourceRefs = sqliteTable('requirement_source_refs', {
  requirement_id: text('requirement_id').notNull(),
  recording_id: text('recording_id').notNull(),
  start_ms: integer('start_ms').notNull(),
  end_ms: integer('end_ms').notNull(),
  char_start: integer('char_start'),
  char_end: integer('char_end'),
  asr_revision_id: text('asr_revision_id'),
  quote_snippet: text('quote_snippet').notNull(),
});

// §5.3
export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  subject_type: text('subject_type').notNull(),
  subject_id: text('subject_id').notNull(),
  payload_json: text('payload_json'),
  confidence: real('confidence'),
  abstained: integer('abstained').notNull().default(0),
  status: text('status').notNull(),
  resolution_json: text('resolution_json'),
  created_at: integer('created_at').notNull(),
  resolved_at: integer('resolved_at'),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  subject_type: text('subject_type').notNull(),
  subject_id: text('subject_id').notNull(),
  primitive: text('primitive').notNull(),
  question: text('question').notNull(),
  options_json: text('options_json'),
  answer_json: text('answer_json'),
  confidence: real('confidence'),
  certainty: text('certainty'),
  provider: text('provider'),
  model_version: text('model_version'),
  created_at: integer('created_at').notNull(),
});

// §5.4
export const workflowSpecs = sqliteTable('workflow_specs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  definition_json: text('definition_json').notNull(),
  enabled: integer('enabled').notNull().default(0),
  schedule: text('schedule'),
});

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  spec_id: text('spec_id').notNull(),
  subject_type: text('subject_type').notNull(),
  subject_id: text('subject_id').notNull(),
  status: text('status').notNull(),
  grant_json: text('grant_json'),
  workspace_path: text('workspace_path'),
  created_at: integer('created_at').notNull(),
  finished_at: integer('finished_at'),
});

export const runStages = sqliteTable('run_stages', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  started_at: integer('started_at'),
  ended_at: integer('ended_at'),
  detail_json: text('detail_json'),
});

// §5.5
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload_json: text('payload_json').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  max_attempts: integer('max_attempts').notNull().default(5),
  run_at: integer('run_at').notNull(),
  locked_by: text('locked_by'),
  locked_at: integer('locked_at'),
  heartbeat_at: integer('heartbeat_at'),
  last_error: text('last_error'),
  idempotency_key: text('idempotency_key').unique(),
  created_at: integer('created_at').notNull(),
  finished_at: integer('finished_at'),
});

// §5.6
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  aggregate_type: text('aggregate_type').notNull(),
  aggregate_id: text('aggregate_id').notNull(),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  payload_json: text('payload_json'),
  created_at: integer('created_at').notNull(),
});

// §5.7
export const corpora = sqliteTable('corpora', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  config_json: text('config_json'),
});

export const corpusDocs = sqliteTable('corpus_docs', {
  id: text('id').primaryKey(),
  corpus_id: text('corpus_id').notNull(),
  path: text('path').notNull(),
  checksum: text('checksum'),
  mime: text('mime'),
  indexed_at: integer('indexed_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  run_id: text('run_id'),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  checksum: text('checksum'),
  created_at: integer('created_at').notNull(),
});

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  config_json: text('config_json'),
  capabilities_json: text('capabilities_json'),
  enabled: integer('enabled').notNull().default(1),
});

export const schema = {
  recordings,
  transcriptRevisions,
  segments,
  requirements,
  requirementSourceRefs,
  inboxItems,
  decisions,
  workflowSpecs,
  workflowRuns,
  runStages,
  jobs,
  events,
  corpora,
  corpusDocs,
  artifacts,
  providers,
};
