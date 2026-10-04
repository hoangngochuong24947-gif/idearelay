import {
  EVENT_TYPES,
  type JsonObject,
} from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { appendEvent } from '../db/repositories/events.js';
import {
  getRequirement,
  listSourceRefsByRecording,
  updateSourceRefAlignment,
} from '../db/repositories/requirements.js';
import * as transcripts from '../db/repositories/transcripts.js';
import { anchorToSegments, buildCharMap } from './anchors.js';
import { requirementBodyFromEvents } from './split.js';
import { writeRequirementProjection } from '../projections/requirement.js';

/**
 * The `realign` step (spec §10 / §18, ADR-0004). When a newer Final revision
 * supersedes the old one for the same recording, existing Requirements
 * automatically re-align to it: the **primary** anchor is the timestamp, so
 * `start_ms`/`end_ms` never move — only the secondary char offsets, the
 * `quote_snippet`, and `asr_revision_id` are recomputed from the new segments
 * by time overlap. No reference is ever dropped: intervals that no longer
 * overlap anything fall back to the nearest segment inside `anchorToSegments`.
 */

export interface RealignDeps {
  sqlite: SqliteDb;
  dataDir: string;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RealignOutcome {
  recordingId: string;
  revisionId: string;
  /** Requirements that had at least one ref refreshed. */
  realigned: number;
  /** Requirements scanned (all with refs on this recording). */
  scanned: number;
  projectionPaths: string[];
}

/**
 * Re-align every Requirement anchored to `recordingId` onto `revisionId`
 * (default: the recording's current final revision). Idempotent: refs already
 * aligned to the target revision are left untouched, producing no events and
 * no projection rewrites.
 */
export function realignRequirements(
  deps: RealignDeps,
  recordingId: string,
  revisionId?: string,
): RealignOutcome {
  const now = deps.now ?? ((): number => Date.now());

  const revision =
    revisionId !== undefined
      ? transcripts.getRevision(deps.sqlite, revisionId)
      : transcripts.getCurrentRevision(deps.sqlite, recordingId, 'final');
  if (revision === null) {
    throw new Error(`no final revision for recording: ${recordingId}`);
  }
  if (revision.kind !== 'final') {
    throw new Error(`realign requires a final revision, got: ${revision.kind}`);
  }
  if (revision.recording_id !== recordingId) {
    throw new Error(
      `revision ${revision.id} does not belong to recording ${recordingId}`,
    );
  }

  const segmentRows = transcripts.listSegments(deps.sqlite, revision.id);
  if (segmentRows.length === 0) {
    throw new Error(`final revision has no segments: ${revision.id}`);
  }
  const charMap = buildCharMap(segmentRows.map((s) => s.text));

  const refs = listSourceRefsByRecording(deps.sqlite, recordingId);
  if (refs.length === 0) {
    deps.log?.(`realign: recording=${recordingId} has no requirements; nothing to do`);
    return { recordingId, revisionId: revision.id, realigned: 0, scanned: 0, projectionPaths: [] };
  }

  // Group refs by requirement and compute the refreshed anchor for each.
  const byRequirement = new Map<string, typeof refs>();
  for (const ref of refs) {
    const list = byRequirement.get(ref.requirement_id) ?? [];
    list.push(ref);
    byRequirement.set(ref.requirement_id, list);
  }

  interface RefUpdate {
    requirementId: string;
    recordingId: string;
    startMs: number;
    endMs: number;
    charStart: number;
    charEnd: number;
    asrRevisionId: string;
    quoteSnippet: string;
  }
  const updates: RefUpdate[] = [];
  for (const ref of refs) {
    const anchor = anchorToSegments(
      segmentRows,
      charMap,
      ref.start_ms,
      ref.end_ms,
    );
    const unchanged =
      ref.asr_revision_id === revision.id &&
      ref.char_start === anchor.charStart &&
      ref.char_end === anchor.charEnd &&
      ref.quote_snippet === anchor.quote;
    if (unchanged) continue;
    updates.push({
      requirementId: ref.requirement_id,
      recordingId,
      startMs: ref.start_ms,
      endMs: ref.end_ms,
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
      asrRevisionId: revision.id,
      quoteSnippet: anchor.quote,
    });
  }

  if (updates.length === 0) {
    deps.log?.(
      `realign: recording=${recordingId} revision=${revision.id} already aligned (${byRequirement.size} requirements)`,
    );
    return {
      recordingId,
      revisionId: revision.id,
      realigned: 0,
      scanned: byRequirement.size,
      projectionPaths: [],
    };
  }

  // ONE transaction: refreshed refs + requirement.realigned events.
  const touchedRequirements = new Set(updates.map((u) => u.requirementId));
  const writeOnce = deps.sqlite.transaction(() => {
    for (const update of updates) {
      updateSourceRefAlignment(deps.sqlite, update);
      appendEvent(deps.sqlite, {
        aggregateType: 'requirement',
        aggregateId: update.requirementId,
        type: EVENT_TYPES.RequirementRealigned,
        payload: {
          recordingId,
          revisionId: revision.id,
          startMs: update.startMs,
          endMs: update.endMs,
          charStart: update.charStart,
          charEnd: update.charEnd,
          quoteSnippet: update.quoteSnippet,
        },
        createdAt: now(),
      });
    }
  });
  writeOnce();

  // Re-render projections for touched requirements (quote changed → bytes change).
  const paths: string[] = [];
  for (const requirementId of touchedRequirements) {
    const requirement = getRequirement(deps.sqlite, requirementId);
    if (requirement === null) continue;
    const body = requirementBodyFromEvents(deps.sqlite, requirementId);
    if (body === null) {
      deps.log?.(`realign: requirement=${requirementId} has no body event; skipping projection`);
      continue;
    }
    const freshRefs = (byRequirement.get(requirementId) ?? []).map((old) => {
      const update = updates.find(
        (u) => u.startMs === old.start_ms && u.endMs === old.end_ms,
      );
      return {
        recordingId: old.recording_id,
        startMs: old.start_ms,
        endMs: old.end_ms,
        charStart: update !== undefined ? update.charStart : old.char_start,
        charEnd: update !== undefined ? update.charEnd : old.char_end,
        asrRevisionId: update !== undefined ? update.asrRevisionId : old.asr_revision_id,
        quoteSnippet: update !== undefined ? update.quoteSnippet : old.quote_snippet,
      };
    });
    const projection = writeRequirementProjection({
      dataDir: deps.dataDir,
      requirement: {
        id: requirement.id,
        title: requirement.title,
        status: requirement.status,
        createdAt: requirement.created_at,
        sourceRevisionId: requirement.source_revision_id,
      },
      body,
      refs: freshRefs,
    });
    paths.push(projection.path);
    appendEvent(deps.sqlite, {
      aggregateType: 'requirement',
      aggregateId: requirementId,
      type: EVENT_TYPES.ProjectionWritten,
      payload: {
        kind: 'requirement',
        path: projection.path,
        sha256: projection.sha256,
        reason: 'realigned',
      } satisfies JsonObject,
      createdAt: now(),
    });
  }

  deps.log?.(
    `realign: recording=${recordingId} revision=${revision.id} realigned=${touchedRequirements.size}/${byRequirement.size}`,
  );

  return {
    recordingId,
    revisionId: revision.id,
    realigned: touchedRequirements.size,
    scanned: byRequirement.size,
    projectionPaths: paths,
  };
}
