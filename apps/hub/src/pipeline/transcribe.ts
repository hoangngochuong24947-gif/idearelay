import { randomUUID } from 'node:crypto';
import {
  EVENT_TYPES,
  type AsrProvider,
  type TranscribeOpts,
} from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { appendEvent } from '../db/repositories/events.js';
import * as recordings from '../db/repositories/recordings.js';
import * as transcripts from '../db/repositories/transcripts.js';
import {
  writeTranscriptFinalProjection,
  type ProjectionSegment,
} from '../projections/transcript.js';
import { mimeForPath } from '../util/media.js';

/** provider_id used by the Provisional placeholder revision (§7.1 占位). */
export const PLACEHOLDER_PROVIDER_ID = 'placeholder';

export interface TranscribeDeps {
  sqlite: SqliteDb;
  dataDir: string;
  /** Pipeline depends on the interface only — never a concrete class (ADR-0009). */
  asr: AsrProvider;
  transcribeOpts?: TranscribeOpts;
  now?: () => number;
  log?: (message: string) => void;
}

export interface TranscribeOutcome {
  recordingId: string;
  finalRevisionId: string;
  provisionalRevisionId: string;
  segmentCount: number;
  projectionPath: string;
  projectionSha256: string;
}

/**
 * The `transcribe` job body (spec §13 steps 4–5). Calls the ASR Final provider,
 * writes the final + provisional revisions and their segments in ONE transaction,
 * then materializes the file projection and records the events (§5.6/§6).
 */
export async function transcribeRecording(
  deps: TranscribeDeps,
  recordingId: string,
): Promise<TranscribeOutcome> {
  const now = deps.now ?? ((): number => Date.now());
  const recording = recordings.getRecording(deps.sqlite, recordingId);
  if (recording === null) {
    throw new Error(`recording not found: ${recordingId}`);
  }
  if (recording.audio_path === null) {
    throw new Error(`recording has no audio_path: ${recordingId}`);
  }

  recordings.setRecordingStatus(deps.sqlite, recordingId, 'transcribing');

  const result = await deps.asr.transcribe(
    {
      recordingId,
      path: recording.audio_path,
      mime: mimeForPath(recording.audio_path),
      durationMs: recording.duration_ms,
    },
    deps.transcribeOpts ?? {},
  );

  const segments: ProjectionSegment[] = result.segments.map((s) => ({
    idx: s.idx,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text,
    speaker: s.speaker ?? null,
    confidence: s.confidence ?? null,
  }));

  const finalRevisionId = randomUUID();
  const provisionalRevisionId = randomUUID();
  const createdAt = now();
  const languageHints =
    result.languageHints !== null ? JSON.stringify(result.languageHints) : null;

  // ONE transaction: revisions + segments + their events.
  const writeRevisions = deps.sqlite.transaction(() => {
    transcripts.clearCurrentRevision(deps.sqlite, recordingId, 'final');
    transcripts.insertTranscriptRevision(deps.sqlite, {
      id: finalRevisionId,
      recordingId,
      kind: 'final',
      providerId: result.providerId,
      model: result.model,
      languageHints,
      isCurrent: true,
      createdAt,
    });
    for (const seg of segments) {
      transcripts.insertSegment(deps.sqlite, {
        id: randomUUID(),
        revisionId: finalRevisionId,
        idx: seg.idx,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
        speaker: seg.speaker,
        confidence: seg.confidence,
      });
    }
    appendEvent(deps.sqlite, {
      aggregateType: 'transcript_revision',
      aggregateId: finalRevisionId,
      type: EVENT_TYPES.TranscriptRevisionCreated,
      payload: {
        recordingId,
        kind: 'final',
        providerId: result.providerId,
        model: result.model,
        segmentCount: segments.length,
      },
      createdAt,
    });

    // Provisional placeholder so §18's "two revisions" holds (§7.1 占位).
    transcripts.clearCurrentRevision(deps.sqlite, recordingId, 'provisional');
    transcripts.insertTranscriptRevision(deps.sqlite, {
      id: provisionalRevisionId,
      recordingId,
      kind: 'provisional',
      providerId: PLACEHOLDER_PROVIDER_ID,
      model: null,
      languageHints: null,
      isCurrent: true,
      createdAt,
    });
    appendEvent(deps.sqlite, {
      aggregateType: 'transcript_revision',
      aggregateId: provisionalRevisionId,
      type: EVENT_TYPES.TranscriptRevisionCreated,
      payload: { recordingId, kind: 'provisional', placeholder: true },
      createdAt,
    });
  });
  writeRevisions();

  // Deterministic file projection, then its event (ADR-0002).
  const projection = writeTranscriptFinalProjection({
    dataDir: deps.dataDir,
    recordingId,
    revision: {
      id: finalRevisionId,
      providerId: result.providerId,
      model: result.model,
      languageHints,
      createdAt,
    },
    segments,
  });
  appendEvent(deps.sqlite, {
    aggregateType: 'recording',
    aggregateId: recordingId,
    type: EVENT_TYPES.ProjectionWritten,
    payload: {
      kind: 'transcript.final',
      path: projection.path,
      sha256: projection.sha256,
    },
    createdAt: now(),
  });

  recordings.setRecordingStatus(deps.sqlite, recordingId, 'ready');
  deps.log?.(
    `transcribe: recording=${recordingId} segments=${segments.length} → ${projection.path}`,
  );

  return {
    recordingId,
    finalRevisionId,
    provisionalRevisionId,
    segmentCount: segments.length,
    projectionPath: projection.path,
    projectionSha256: projection.sha256,
  };
}
