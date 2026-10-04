import { randomUUID } from 'node:crypto';
import {
  DEFAULT_DECISION_THRESHOLDS,
  EVENT_TYPES,
  INBOX_KINDS,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type DecisionThresholds,
  type InboxKind,
  type ModelProvider,
} from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { insertDecision } from '../db/repositories/decisions.js';
import { appendEvent, listEvents } from '../db/repositories/events.js';
import { insertInboxItem } from '../db/repositories/inbox.js';
import * as transcripts from '../db/repositories/transcripts.js';
import { writeInboxItemProjection } from '../projections/inbox.js';
import { writeSummaryProjection } from '../projections/summary.js';
import type { JobQueue } from '../queue/job-queue.js';
import { splitIdempotencyKey } from '../worker/handlers/split.js';

// Declarative instructions (no trailing `？`) so a classifier never scores the
// instruction itself as content.
export const ENRICH_KIND_QUESTION = '把这段转写归入下面哪个顶层类目';
export const ENRICH_TAG_QUESTION = '为这段转写选择最相关的标签';

/** Default tag vocabulary offered to the DecisionProvider (打标). */
export const DEFAULT_TAG_OPTIONS: readonly string[] = [
  'product',
  'tech',
  'design',
  'ops',
  'personal',
];

/** Cap on transcript characters embedded in a decision question. */
const MAX_DECISION_CHARS = 6_000;

/** A tag is kept only when its calibrated probability clears the `low` threshold. */
const TAG_KEEP = 0.5;

export interface EnrichDeps {
  sqlite: SqliteDb;
  dataDir: string;
  /** Interface only — never a concrete class (ADR-0009). */
  model: ModelProvider;
  decision: DecisionProvider;
  /** Model name passed to `ModelProvider.complete`. */
  modelName: string;
  /** Default gate thresholds (§9). */
  thresholds?: DecisionThresholds;
  /**
   * Per-call threshold overrides — **mandatory** because Jev's defaults are
   * officially uncalibrated (ADR-0005). Applied to every decision call and the
   * gate.
   */
  thresholdOverrides?: DecisionRequest['thresholdOverrides'];
  kindOptions?: readonly string[];
  tagOptions?: readonly string[];
  /**
   * When present, content the gate auto-advances as `requirement` enqueues an
   * idempotent `split` job (M3, spec §13 step 6).
   */
  queue?: JobQueue;
  now?: () => number;
  log?: (message: string) => void;
}

export interface EnrichOutcome {
  recordingId: string;
  revisionId: string;
  /** True when a prior `enrich.completed` event made this run a no-op. */
  skipped: boolean;
  kind?: InboxKind;
  confidence?: number;
  abstained?: boolean;
  tags?: string[];
  gate?: 'auto_advanced' | 'inbox';
  inboxItemId?: string | null;
  reason?: string;
  summaryPath?: string;
  summarySha256?: string;
  inboxItemPath?: string;
  kindDecisionId?: string;
  tagDecisionId?: string;
}

/**
 * The `enrich` job body (spec §13 step 6, §9). After a Final Transcript is ready:
 * summarize through `ModelProvider`, classify + tag through `DecisionProvider`,
 * then apply the gate — high confidence auto-advances, otherwise an
 * `inbox_items` row is written. Every decision call is audited in `decisions`
 * (§5.3) and the outputs are materialized as deterministic file projections
 * (§5.8). Idempotent per final revision.
 */
export async function enrichRecording(
  deps: EnrichDeps,
  recordingId: string,
  revisionId?: string,
): Promise<EnrichOutcome> {
  const now = deps.now ?? ((): number => Date.now());
  const thresholds = deps.thresholds ?? DEFAULT_DECISION_THRESHOLDS;

  const revision =
    revisionId !== undefined
      ? transcripts.getRevision(deps.sqlite, revisionId)
      : transcripts.getCurrentRevision(deps.sqlite, recordingId, 'final');
  if (revision === null) {
    throw new Error(`no final revision for recording: ${recordingId}`);
  }
  if (revision.kind !== 'final') {
    throw new Error(`enrich requires a final revision, got: ${revision.kind}`);
  }
  if (revision.recording_id !== recordingId) {
    throw new Error(
      `revision ${revision.id} does not belong to recording ${recordingId}`,
    );
  }

  // Idempotency: a completed enrich for this revision is a no-op.
  const already = listEvents(deps.sqlite, {
    aggregateType: 'transcript_revision',
    aggregateId: revision.id,
    type: EVENT_TYPES.EnrichCompleted,
  });
  if (already.length > 0) {
    deps.log?.(`enrich: revision=${revision.id} already enriched; skipping`);
    return { recordingId, revisionId: revision.id, skipped: true };
  }

  const segmentRows = transcripts.listSegments(deps.sqlite, revision.id);
  const transcriptText = segmentRows.map((s) => s.text).join('\n');
  const decisionExcerpt = truncate(transcriptText, MAX_DECISION_CHARS);

  // 1. Summarize (ModelProvider.complete only — ADR-0009).
  const completion = await deps.model.complete({
    model: deps.modelName,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '你是 idearelay 的总结器：用简洁中文总结这段长时语音转写。',
      },
      { role: 'user', content: transcriptText },
    ],
  });
  const summary = completion.text.trim();

  // 2. Classify into the 7 top-level kinds (§9).
  const kindOptions = deps.kindOptions ?? INBOX_KINDS;
  const kindRequest: DecisionRequest = {
    primitive: 'choice',
    question: `${ENRICH_KIND_QUESTION}\n\n${decisionExcerpt}`,
    options: [...kindOptions],
    thresholdOverrides: deps.thresholdOverrides,
  };
  const kindResult = await deps.decision.decide(kindRequest);
  const kind = normalizeKind(kindResult.choice);

  // 3. Derive tags from the choice distribution.
  const tagOptions = deps.tagOptions ?? DEFAULT_TAG_OPTIONS;
  const tagRequest: DecisionRequest = {
    primitive: 'choice',
    question: `${ENRICH_TAG_QUESTION}\n\n${decisionExcerpt}`,
    options: [...tagOptions],
    thresholdOverrides: deps.thresholdOverrides,
  };
  const tagResult = await deps.decision.decide(tagRequest);
  const tags = deriveTags(tagResult, deps.thresholdOverrides?.low ?? thresholds.low);

  // 4. The gate (§9): confidence ≥ high AND not abstained → auto-advance.
  const effectiveHigh = deps.thresholdOverrides?.high ?? thresholds.high;
  const autoAdvance = kindResult.confidence >= effectiveHigh && !kindResult.abstained;
  const reason = autoAdvance
    ? `confidence ${fmt(kindResult.confidence)} ≥ ${fmt(effectiveHigh)} and not abstained → auto-advanced`
    : kindResult.abstained
      ? 'decision layer abstained → Inbox'
      : `confidence ${fmt(kindResult.confidence)} < ${fmt(effectiveHigh)} → Inbox`;

  const createdAt = now();
  const kindDecisionId = randomUUID();
  const tagDecisionId = randomUUID();
  const inboxItemId = autoAdvance ? null : randomUUID();

  const payloadJson = JSON.stringify({
    recordingId,
    revisionId: revision.id,
    kind,
    summary,
    tags,
    confidence: kindResult.confidence,
    abstained: kindResult.abstained,
    reason,
    transcriptExcerpt: truncate(transcriptText, 280),
    segments: segmentRows.map((s) => ({
      idx: s.idx,
      startMs: s.start_ms,
      endMs: s.end_ms,
      text: s.text,
    })),
    decisionIds: { kind: kindDecisionId, tags: tagDecisionId },
  });

  // 5. Persist rows + events in ONE transaction.
  const subjectType = 'transcript_revision';
  const writeOnce = deps.sqlite.transaction(() => {
    recordDecision(deps, {
      id: kindDecisionId,
      subjectType,
      subjectId: revision.id,
      request: kindRequest,
      result: kindResult,
      createdAt,
    });
    appendEvent(deps.sqlite, {
      aggregateType: 'decision',
      aggregateId: kindDecisionId,
      type: EVENT_TYPES.DecisionRecorded,
      payload: {
        subjectType,
        subjectId: revision.id,
        primitive: kindRequest.primitive,
        confidence: kindResult.confidence,
        abstained: kindResult.abstained,
      },
      createdAt,
    });

    recordDecision(deps, {
      id: tagDecisionId,
      subjectType,
      subjectId: revision.id,
      request: tagRequest,
      result: tagResult,
      createdAt,
    });
    appendEvent(deps.sqlite, {
      aggregateType: 'decision',
      aggregateId: tagDecisionId,
      type: EVENT_TYPES.DecisionRecorded,
      payload: {
        subjectType,
        subjectId: revision.id,
        primitive: tagRequest.primitive,
        confidence: tagResult.confidence,
        abstained: tagResult.abstained,
      },
      createdAt,
    });

    if (autoAdvance) {
      appendEvent(deps.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: revision.id,
        type: EVENT_TYPES.ItemAutoAccepted,
        payload: { recordingId, kind, confidence: kindResult.confidence, tags },
        createdAt,
      });
    } else {
      insertInboxItem(deps.sqlite, {
        id: inboxItemId as string,
        kind,
        subjectType,
        subjectId: revision.id,
        payloadJson,
        confidence: kindResult.confidence,
        abstained: kindResult.abstained,
        status: 'pending',
        createdAt,
      });
      appendEvent(deps.sqlite, {
        aggregateType: 'inbox_item',
        aggregateId: inboxItemId as string,
        type: EVENT_TYPES.InboxItemCreated,
        payload: { recordingId, revisionId: revision.id, kind, confidence: kindResult.confidence },
        createdAt,
      });
    }

    appendEvent(deps.sqlite, {
      aggregateType: 'transcript_revision',
      aggregateId: revision.id,
      type: EVENT_TYPES.EnrichCompleted,
      payload: {
        recordingId,
        kind,
        confidence: kindResult.confidence,
        abstained: kindResult.abstained,
        tags,
        gate: autoAdvance ? 'auto_advanced' : 'inbox',
        inboxItemId,
      },
      createdAt,
    });
  });
  writeOnce();

  // M3: auto-advanced requirement content continues into the split stage.
  if (autoAdvance && kind === 'requirement' && deps.queue !== undefined) {
    deps.queue.enqueue({
      kind: 'split',
      payload: { recordingId, revisionId: revision.id },
      idempotencyKey: splitIdempotencyKey(recordingId, revision.id),
    });
  }

  // 6. Deterministic file projections (write-only; ADR-0002).
  const summaryProjection = writeSummaryProjection({
    dataDir: deps.dataDir,
    recordingId,
    revisionId: revision.id,
    kind,
    confidence: kindResult.confidence,
    abstained: kindResult.abstained,
    tags,
    summary,
    model: completion.model,
    createdAt,
  });
  appendEvent(deps.sqlite, {
    aggregateType: 'recording',
    aggregateId: recordingId,
    type: EVENT_TYPES.ProjectionWritten,
    payload: { kind: 'summary', path: summaryProjection.path, sha256: summaryProjection.sha256 },
    createdAt: now(),
  });

  let inboxItemPath: string | undefined;
  if (inboxItemId !== null) {
    const inboxProjection = writeInboxItemProjection({
      dataDir: deps.dataDir,
      itemId: inboxItemId,
      kind,
      status: 'pending',
      recordingId,
      revisionId: revision.id,
      summary,
      tags,
      confidence: kindResult.confidence,
      abstained: kindResult.abstained,
      reason,
      createdAt,
    });
    inboxItemPath = inboxProjection.path;
    appendEvent(deps.sqlite, {
      aggregateType: 'inbox_item',
      aggregateId: inboxItemId,
      type: EVENT_TYPES.ProjectionWritten,
      payload: { kind: 'inbox_item', path: inboxProjection.path, sha256: inboxProjection.sha256 },
      createdAt: now(),
    });
  }

  deps.log?.(
    `enrich: recording=${recordingId} kind=${kind} confidence=${fmt(kindResult.confidence)} gate=${
      autoAdvance ? 'auto_advanced' : 'inbox'
    }`,
  );

  return {
    recordingId,
    revisionId: revision.id,
    skipped: false,
    kind,
    confidence: kindResult.confidence,
    abstained: kindResult.abstained,
    tags,
    gate: autoAdvance ? 'auto_advanced' : 'inbox',
    inboxItemId,
    reason,
    summaryPath: summaryProjection.path,
    summarySha256: summaryProjection.sha256,
    inboxItemPath,
    kindDecisionId,
    tagDecisionId,
  };
}

interface RecordDecisionInput {
  id: string;
  subjectType: string;
  subjectId: string;
  request: DecisionRequest;
  result: DecisionResult;
  createdAt: number;
}

function recordDecision(deps: EnrichDeps, input: RecordDecisionInput): void {
  insertDecision(deps.sqlite, {
    id: input.id,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    primitive: input.request.primitive,
    question: input.request.question,
    optionsJson:
      input.request.options !== undefined ? JSON.stringify(input.request.options) : null,
    answerJson: JSON.stringify(input.result),
    confidence: input.result.confidence,
    certainty: input.result.certainty,
    provider: deps.decision.id,
    modelVersion: input.result.modelVersion,
    createdAt: input.createdAt,
  });
}

/** Only accept a choice that names one of the 7 top-level kinds. */
function normalizeKind(choice: string | undefined): InboxKind {
  const found = INBOX_KINDS.find((k) => k === choice);
  return found ?? 'unknown';
}

/** Keep every tag whose calibrated probability clears the low threshold. */
function deriveTags(result: DecisionResult, low: number): string[] {
  if (result.abstained) return [];
  const probabilities = result.probabilities ?? {};
  const cutoff = Math.max(TAG_KEEP, low);
  return Object.entries(probabilities)
    .filter(([, p]) => p >= cutoff)
    .map(([tag]) => tag)
    .sort();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function fmt(n: number): string {
  return n.toFixed(4);
}
