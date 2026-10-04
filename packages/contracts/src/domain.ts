/**
 * Domain types implied by the SQLite schema in spec §5.
 *
 * Rows are truth, files are projections (ADR-0002). Every entity here maps to a
 * table in §5 and every timestamp is epoch milliseconds (`INTEGER` in SQLite).
 * Vocabulary is locked to CONTEXT.md — no synonym drift.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Epoch milliseconds. */
export type EpochMs = number;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// §5.1 recordings / transcript_revisions / segments
// ---------------------------------------------------------------------------

export type RecordingStatus =
  | 'queued'
  | 'received'
  | 'transcribing'
  | 'ready'
  | 'failed';

export interface Recording {
  id: string;
  createdAt: EpochMs;
  sourceDevice: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  audioPath: string | null;
  audioChecksum: string | null;
  status: RecordingStatus;
}

export type TranscriptRevisionKind = 'provisional' | 'final';

export interface TranscriptRevision {
  id: string;
  recordingId: string;
  kind: TranscriptRevisionKind;
  providerId: string | null;
  model: string | null;
  languageHints: string | null;
  /** At most one current revision per (recording, kind). */
  isCurrent: boolean;
  createdAt: EpochMs;
}

export interface Segment {
  id: string;
  revisionId: string;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
}

// ---------------------------------------------------------------------------
// §5.2 requirements / requirement_source_refs (ADR-0004 hybrid anchor)
// ---------------------------------------------------------------------------

/**
 * Hybrid SourceRef, the five-tuple:
 *   recording_id                      — primary anchor, survives ASR re-runs
 *   [start_ms, end_ms]                — primary anchor
 *   [char_start, char_end]            — secondary, finer precision
 *   asr_revision_id                   — the revision it was derived from
 *   quote_snippet                     — self-explaining snapshot for humans
 */
export interface SourceRef {
  recordingId: string;
  startMs: number;
  endMs: number;
  charStart: number | null;
  charEnd: number | null;
  asrRevisionId: string | null;
  quoteSnippet: string;
}

export type RequirementStatus = 'draft' | 'open' | 'running' | 'done' | 'rejected';

export interface Requirement {
  id: string;
  title: string;
  /** Projection file path, e.g. `requirements/<id>-<slug>.md`. */
  bodyPath: string | null;
  status: RequirementStatus;
  createdAt: EpochMs;
  sourceRevisionId: string | null;
  sourceRefs?: SourceRef[];
}

// ---------------------------------------------------------------------------
// §5.3 inbox_items / decisions
// ---------------------------------------------------------------------------

/** The top-level Inbox categories (§9, ≤7). */
export type InboxKind =
  | 'requirement'
  | 'idea'
  | 'log'
  | 'task'
  | 'reference'
  | 'question'
  | 'unknown';

/** Canonical, ordered list of the 7 top-level kinds (spec §9). */
export const INBOX_KINDS: readonly InboxKind[] = [
  'requirement',
  'idea',
  'log',
  'task',
  'reference',
  'question',
  'unknown',
];

export type InboxStatus = 'pending' | 'accepted' | 'rejected' | 'rerouted';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  subjectType: string;
  subjectId: string;
  /** Structured content for UI rendering. */
  payloadJson: string;
  /** Calibrated probability from the DecisionProvider. */
  confidence: number | null;
  /** Abstention is a first-class outcome, not "low confidence". */
  abstained: boolean;
  status: InboxStatus;
  resolutionJson: string | null;
  createdAt: EpochMs;
  resolvedAt: EpochMs | null;
}

/** Decision primitives (ADR-0005): choice / score / noul. */
export type DecisionPrimitive = 'choice' | 'score' | 'noul';

export type Certainty = 'high' | 'medium' | 'low';

/** Audit row for every DecisionProvider call. */
export interface Decision {
  id: string;
  subjectType: string;
  subjectId: string;
  primitive: DecisionPrimitive;
  question: string;
  optionsJson: string | null;
  answerJson: string | null;
  confidence: number | null;
  certainty: Certainty | null;
  provider: string | null;
  modelVersion: string | null;
  createdAt: EpochMs;
}

// ---------------------------------------------------------------------------
// §5.4 workflow_specs / workflow_runs / run_stages
// ---------------------------------------------------------------------------

export interface WorkflowSpec {
  id: string;
  name: string;
  /** Stage order, tools, prompt templates (§8.1). */
  definitionJson: string;
  enabled: boolean;
  schedule: string | null;
}

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

export interface WorkflowRun {
  id: string;
  specId: string;
  subjectType: string;
  subjectId: string;
  status: WorkflowRunStatus;
  /** Run-scoped grant (ADR-0006). */
  grantJson: string | null;
  workspacePath: string | null;
  createdAt: EpochMs;
  finishedAt: EpochMs | null;
}

export type StageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface RunStage {
  id: string;
  runId: string;
  name: string;
  status: StageStatus;
  startedAt: EpochMs | null;
  endedAt: EpochMs | null;
  detailJson: string | null;
}

// ---------------------------------------------------------------------------
// §5.5 jobs (self-built queue)
// ---------------------------------------------------------------------------

export type JobStatus = 'pending' | 'claimed' | 'succeeded' | 'failed' | 'dead';

export interface Job {
  id: string;
  kind: string;
  payloadJson: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: EpochMs;
  lockedBy: string | null;
  lockedAt: EpochMs | null;
  heartbeatAt: EpochMs | null;
  lastError: string | null;
  /** Idempotent enqueue key (`idempotency_key UNIQUE`). */
  idempotencyKey: string | null;
  createdAt: EpochMs;
  finishedAt: EpochMs | null;
}

// ---------------------------------------------------------------------------
// §5.7 corpora / corpus_docs / artifacts / providers
// ---------------------------------------------------------------------------

export interface Corpus {
  id: string;
  name: string;
  kind: string;
  configJson: string | null;
}

export interface CorpusDoc {
  id: string;
  corpusId: string;
  path: string;
  checksum: string | null;
  mime: string | null;
  indexedAt: EpochMs | null;
}

export interface Artifact {
  id: string;
  runId: string | null;
  kind: string;
  path: string;
  checksum: string | null;
  createdAt: EpochMs;
}

// ---------------------------------------------------------------------------
// §7 preamble — provider registration record
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'asr'
  | 'model'
  | 'decision'
  | 'storage'
  | 'sync'
  | 'rag'
  | 'executor';

/** Credentials live in env, never in the DB (ADR-0009). */
export type CredentialSource =
  | { kind: 'env'; name: string }
  | { kind: 'none' };

export interface ProviderRegistration {
  id: string;
  kind: ProviderKind;
  name: string;
  credentialSource: CredentialSource;
  /** Capability declaration (the sole basis for UI show/hide). */
  capabilities: JsonObject;
  enabled: boolean;
}
