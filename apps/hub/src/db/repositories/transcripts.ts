import type { TranscriptRevisionKind } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

/** Raw `transcript_revisions` row (§5.1). */
export interface TranscriptRevisionRow {
  id: string;
  recording_id: string;
  kind: TranscriptRevisionKind;
  provider_id: string | null;
  model: string | null;
  language_hints: string | null;
  is_current: number;
  created_at: number;
}

/** Raw `segments` row (§5.1). */
export interface SegmentRow {
  id: string;
  revision_id: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
}

export interface NewTranscriptRevision {
  id: string;
  recordingId: string;
  kind: TranscriptRevisionKind;
  providerId: string | null;
  model: string | null;
  /** JSON-encoded language hints, or null. */
  languageHints: string | null;
  isCurrent: boolean;
  createdAt: number;
}

export interface NewSegment {
  id: string;
  revisionId: string;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
}

export function insertTranscriptRevision(
  sqlite: SqliteDb,
  rev: NewTranscriptRevision,
): void {
  sqlite
    .prepare(
      `INSERT INTO transcript_revisions
         (id, recording_id, kind, provider_id, model, language_hints, is_current, created_at)
       VALUES (@id, @recording_id, @kind, @provider_id, @model, @language_hints,
               @is_current, @created_at)`,
    )
    .run({
      id: rev.id,
      recording_id: rev.recordingId,
      kind: rev.kind,
      provider_id: rev.providerId,
      model: rev.model,
      language_hints: rev.languageHints,
      is_current: rev.isCurrent ? 1 : 0,
      created_at: rev.createdAt,
    });
}

/** Flip the current revision of a given kind off (at most one current per kind). */
export function clearCurrentRevision(
  sqlite: SqliteDb,
  recordingId: string,
  kind: TranscriptRevisionKind,
): void {
  sqlite
    .prepare(
      'UPDATE transcript_revisions SET is_current = 0 WHERE recording_id = ? AND kind = ? AND is_current = 1',
    )
    .run(recordingId, kind);
}

export function insertSegment(sqlite: SqliteDb, seg: NewSegment): void {
  sqlite
    .prepare(
      `INSERT INTO segments
         (id, revision_id, idx, start_ms, end_ms, text, speaker, confidence)
       VALUES (@id, @revision_id, @idx, @start_ms, @end_ms, @text, @speaker, @confidence)`,
    )
    .run({
      id: seg.id,
      revision_id: seg.revisionId,
      idx: seg.idx,
      start_ms: seg.startMs,
      end_ms: seg.endMs,
      text: seg.text,
      speaker: seg.speaker,
      confidence: seg.confidence,
    });
}

export function listRevisions(
  sqlite: SqliteDb,
  recordingId: string,
): TranscriptRevisionRow[] {
  return sqlite
    .prepare(
      'SELECT * FROM transcript_revisions WHERE recording_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(recordingId) as TranscriptRevisionRow[];
}

export function getCurrentRevision(
  sqlite: SqliteDb,
  recordingId: string,
  kind: TranscriptRevisionKind,
): TranscriptRevisionRow | null {
  const row = sqlite
    .prepare(
      'SELECT * FROM transcript_revisions WHERE recording_id = ? AND kind = ? AND is_current = 1 LIMIT 1',
    )
    .get(recordingId, kind) as TranscriptRevisionRow | undefined;
  return row ?? null;
}

export function listSegments(sqlite: SqliteDb, revisionId: string): SegmentRow[] {
  return sqlite
    .prepare('SELECT * FROM segments WHERE revision_id = ? ORDER BY idx ASC')
    .all(revisionId) as SegmentRow[];
}
