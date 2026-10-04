import type { RequirementStatus } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

/** Raw `requirements` row (§5.2). Rows are truth (ADR-0002). */
export interface RequirementRow {
  id: string;
  title: string;
  body_path: string | null;
  status: RequirementStatus;
  created_at: number;
  source_revision_id: string | null;
}

/** Raw `requirement_source_refs` row — the ADR-0004 hybrid anchor five-tuple. */
export interface SourceRefRow {
  requirement_id: string;
  recording_id: string;
  start_ms: number;
  end_ms: number;
  char_start: number | null;
  char_end: number | null;
  asr_revision_id: string | null;
  quote_snippet: string;
}

export interface NewRequirement {
  id: string;
  title: string;
  bodyPath: string | null;
  status: RequirementStatus;
  createdAt: number;
  sourceRevisionId: string | null;
}

export interface NewSourceRef {
  requirementId: string;
  recordingId: string;
  startMs: number;
  endMs: number;
  charStart: number | null;
  charEnd: number | null;
  asrRevisionId: string | null;
  quoteSnippet: string;
}

export function insertRequirement(sqlite: SqliteDb, req: NewRequirement): void {
  sqlite
    .prepare(
      `INSERT INTO requirements
         (id, title, body_path, status, created_at, source_revision_id)
       VALUES (@id, @title, @body_path, @status, @created_at, @source_revision_id)`,
    )
    .run({
      id: req.id,
      title: req.title,
      body_path: req.bodyPath,
      status: req.status,
      created_at: req.createdAt,
      source_revision_id: req.sourceRevisionId,
    });
}

export function insertSourceRef(sqlite: SqliteDb, ref: NewSourceRef): void {
  sqlite
    .prepare(
      `INSERT INTO requirement_source_refs
         (requirement_id, recording_id, start_ms, end_ms, char_start, char_end,
          asr_revision_id, quote_snippet)
       VALUES (@requirement_id, @recording_id, @start_ms, @end_ms, @char_start,
               @char_end, @asr_revision_id, @quote_snippet)`,
    )
    .run({
      requirement_id: ref.requirementId,
      recording_id: ref.recordingId,
      start_ms: ref.startMs,
      end_ms: ref.endMs,
      char_start: ref.charStart,
      char_end: ref.charEnd,
      asr_revision_id: ref.asrRevisionId,
      quote_snippet: ref.quoteSnippet,
    });
}

export function getRequirement(sqlite: SqliteDb, id: string): RequirementRow | null {
  const row = sqlite
    .prepare('SELECT * FROM requirements WHERE id = ?')
    .get(id) as RequirementRow | undefined;
  return row ?? null;
}

export function listRequirements(sqlite: SqliteDb): RequirementRow[] {
  return sqlite
    .prepare('SELECT * FROM requirements ORDER BY created_at ASC, id ASC')
    .all() as RequirementRow[];
}

/** Requirements generated from a given transcript revision (split idempotency). */
export function listRequirementsBySourceRevision(
  sqlite: SqliteDb,
  revisionId: string,
): RequirementRow[] {
  return sqlite
    .prepare(
      'SELECT * FROM requirements WHERE source_revision_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(revisionId) as RequirementRow[];
}

export function listSourceRefs(sqlite: SqliteDb, requirementId: string): SourceRefRow[] {
  return sqlite
    .prepare(
      'SELECT * FROM requirement_source_refs WHERE requirement_id = ? ORDER BY start_ms ASC, end_ms ASC',
    )
    .all(requirementId) as SourceRefRow[];
}

/** Every ref anchored to a recording — the realignment input set (spec §10). */
export function listSourceRefsByRecording(
  sqlite: SqliteDb,
  recordingId: string,
): SourceRefRow[] {
  return sqlite
    .prepare(
      'SELECT * FROM requirement_source_refs WHERE recording_id = ? ORDER BY requirement_id ASC, start_ms ASC, end_ms ASC',
    )
    .all(recordingId) as SourceRefRow[];
}

/**
 * Re-align one ref to a new ASR revision: the time anchor (`start_ms/end_ms`)
 * is the primary key of the anchor and never moves; only the secondary
 * char offsets, the revision pointer, and the human snapshot are refreshed.
 */
export function updateSourceRefAlignment(
  sqlite: SqliteDb,
  ref: {
    requirementId: string;
    recordingId: string;
    startMs: number;
    endMs: number;
    charStart: number | null;
    charEnd: number | null;
    asrRevisionId: string | null;
    quoteSnippet: string;
  },
): void {
  sqlite
    .prepare(
      `UPDATE requirement_source_refs
          SET char_start = ?, char_end = ?, asr_revision_id = ?, quote_snippet = ?
        WHERE requirement_id = ? AND recording_id = ? AND start_ms = ? AND end_ms = ?`,
    )
    .run(
      ref.charStart,
      ref.charEnd,
      ref.asrRevisionId,
      ref.quoteSnippet,
      ref.requirementId,
      ref.recordingId,
      ref.startMs,
      ref.endMs,
    );
}
