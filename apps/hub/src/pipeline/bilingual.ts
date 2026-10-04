import {
  EVENT_TYPES,
  type ModelProvider,
} from '@idearelay/contracts';
import { appendEvent, listEvents } from '../db/repositories/events.js';
import * as transcripts from '../db/repositories/transcripts.js';
import type { SqliteDb } from '../db/types.js';
import { writeBilingualProjection, type BilingualRow } from '../projections/bilingual.js';

/**
 * 中英对照 projection (spec §15: 转写层直接出双语). After a Final transcript is
 * ready **and enriched**, all segments are translated in ONE batched
 * `ModelProvider.complete` call and rendered as
 * `data/recordings/<id>/transcript.bilingual.md` (+ `.sha256`,
 * `projection.written` event). Deterministic under the mock provider; the
 * original rows remain truth and a re-run replaces the projection.
 */

/** Marker the mock ModelProvider keys on to answer as a translator (§7.2). */
export const BILINGUAL_SYSTEM_PROMPT =
  '你是 idearelay 的翻译器：把下面转写的每一行逐行翻译成英文，保持「序号| 译文」格式，行数与序号不变。';

/** Stable key so the same final revision is never translated twice (§5.5). */
export function bilingualIdempotencyKey(recordingId: string, revisionId: string): string {
  return `bilingual:${recordingId}:${revisionId}`;
}

export interface BilingualDeps {
  sqlite: SqliteDb;
  dataDir: string;
  /** Interface only — never a concrete class (ADR-0009). */
  model: ModelProvider;
  /** Model name passed to `ModelProvider.complete`. */
  modelName: string;
  now?: () => number;
  log?: (message: string) => void;
}

export interface BilingualOutcome {
  recordingId: string;
  revisionId: string;
  /** True when a prior run already wrote this projection. */
  skipped: boolean;
  path?: string;
  sha256?: string;
  translated?: number;
}

/** Parse `序号| 译文` lines from a batched translation completion. */
export function parseNumberedLines(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split('\n')) {
    const match = /^(\d+)\|\s?(.*)$/.exec(line.trim());
    if (match !== null) {
      map.set(Number.parseInt(match[1], 10), match[2].trim());
    }
  }
  return map;
}

export async function writeBilingualTranscript(
  deps: BilingualDeps,
  recordingId: string,
  revisionId?: string,
): Promise<BilingualOutcome> {
  const revision =
    revisionId !== undefined
      ? transcripts.getRevision(deps.sqlite, revisionId)
      : transcripts.getCurrentRevision(deps.sqlite, recordingId, 'final');
  if (revision === null || revision.recording_id !== recordingId) {
    throw new Error(`no final revision for recording: ${recordingId}`);
  }
  if (revision.kind !== 'final') {
    throw new Error(`bilingual projection requires a final revision, got: ${revision.kind}`);
  }

  // Idempotency: a completed bilingual projection for this revision is a no-op.
  const already = listEvents(deps.sqlite, {
    aggregateType: 'transcript_revision',
    aggregateId: revision.id,
    type: EVENT_TYPES.BilingualCompleted,
  });
  if (already.length > 0) {
    return { recordingId, revisionId: revision.id, skipped: true };
  }

  const segmentRows = transcripts.listSegments(deps.sqlite, revision.id);

  // ONE batched translate call (§15): numbered lines in, numbered lines out.
  const completion = await deps.model.complete({
    model: deps.modelName,
    temperature: 0,
    messages: [
      { role: 'system', content: BILINGUAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: segmentRows.map((s) => `${s.idx}| ${s.text}`).join('\n'),
      },
    ],
  });
  const translations = parseNumberedLines(completion.text);

  // Missing translations fall back to the original text — rows remain truth.
  const rows: BilingualRow[] = segmentRows.map((s) => ({
    idx: s.idx,
    startMs: s.start_ms,
    endMs: s.end_ms,
    text: s.text,
    english: translations.get(s.idx) ?? s.text,
  }));

  const projection = writeBilingualProjection({
    dataDir: deps.dataDir,
    recordingId,
    revision: {
      id: revision.id,
      providerId: revision.provider_id,
      model: completion.model,
      createdAt: revision.created_at,
    },
    rows,
  });

  const now = deps.now ?? ((): number => Date.now());
  appendEvent(deps.sqlite, {
    aggregateType: 'transcript_revision',
    aggregateId: revision.id,
    type: EVENT_TYPES.BilingualCompleted,
    payload: {
      recordingId,
      path: projection.path,
      sha256: projection.sha256,
      translated: rows.length,
      model: completion.model,
    },
    createdAt: now(),
  });
  appendEvent(deps.sqlite, {
    aggregateType: 'recording',
    aggregateId: recordingId,
    type: EVENT_TYPES.ProjectionWritten,
    payload: {
      kind: 'transcript.bilingual',
      path: projection.path,
      sha256: projection.sha256,
    },
    createdAt: now(),
  });

  deps.log?.(
    `bilingual: recording=${recordingId} segments=${rows.length} path=${projection.path}`,
  );
  return {
    recordingId,
    revisionId: revision.id,
    skipped: false,
    path: projection.path,
    sha256: projection.sha256,
    translated: rows.length,
  };
}
