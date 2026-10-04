import { randomUUID } from 'node:crypto';
import {
  EVENT_TYPES,
  type CompletionRequest,
  type JsonObject,
  type ModelProvider,
} from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { appendEvent, listEvents } from '../db/repositories/events.js';
import {
  insertRequirement,
  insertSourceRef,
  listRequirementsBySourceRevision,
} from '../db/repositories/requirements.js';
import * as transcripts from '../db/repositories/transcripts.js';
import { anchorToSegments, buildCharMap } from './anchors.js';
import {
  requirementBodyPath,
  writeRequirementProjection,
} from '../projections/requirement.js';

/**
 * The `split` job body — 需求拆分与溯源 (spec §10, §13 step 6, ADR-0004).
 *
 * A Final Transcript's segments are offered to the `ModelProvider` as a
 * structured-output request; the model proposes N requirements, each anchored
 * to a `[startMs, endMs]` interval. The pipeline then derives every other
 * anchor field (char offsets, quote snippet) from the real segments and writes
 * the `requirements` + `requirement_source_refs` five-tuple rows, the
 * `requirement.created` events, and the deterministic file projections.
 * Idempotent per source revision: rows are truth, so a revision that already
 * has requirements is skipped.
 */

export const SPLIT_SYSTEM_PROMPT =
  '你是 idearelay 的需求拆分器：把这段长时语音转写拆成相互独立、可各自跟进的 Requirement。' +
  '每个 Requirement 用 startMs/endMs 锚定到转写的时间区间。只输出符合 schema 的 JSON。';

/** OpenAI-compatible structured-output format for the split call (§7.2). */
export const SPLIT_RESPONSE_FORMAT: JsonObject = {
  type: 'json_schema',
  json_schema: {
    name: 'requirement_split',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        requirements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              startMs: { type: 'integer' },
              endMs: { type: 'integer' },
            },
            required: ['title', 'body', 'startMs', 'endMs'],
            additionalProperties: false,
          },
        },
      },
      required: ['requirements'],
      additionalProperties: false,
    },
  },
};

export interface SplitDeps {
  sqlite: SqliteDb;
  dataDir: string;
  /** Interface only — never a concrete class (ADR-0009). */
  model: ModelProvider;
  modelName: string;
  now?: () => number;
  log?: (message: string) => void;
}

export interface SplitOutcome {
  recordingId: string;
  revisionId: string;
  /** True when this revision already produced requirements. */
  skipped: boolean;
  requirementIds: string[];
  requirementPaths: string[];
}

/** A validated model-proposed requirement before anchoring. */
interface ProposedRequirement {
  title: string;
  body: string;
  startMs: number;
  endMs: number;
}

/** Build the user prompt: instruction + the timed segments as JSON. */
export function buildSplitPrompt(
  segments: ReadonlyArray<{
    idx: number;
    start_ms: number;
    end_ms: number;
    text: string;
  }>,
): string {
  const payload = segments.map((s) => ({
    idx: s.idx,
    startMs: s.start_ms,
    endMs: s.end_ms,
    text: s.text,
  }));
  return [
    '把下面这份转写拆成若干独立的 Requirement。每个 Requirement 指出它覆盖的时间区间',
    '（startMs/endMs 必须落在转写给出的区间内）。不要遗漏需求类的段落，也不要把无关闲聊硬凑成需求。',
    '',
    '<transcript>',
    JSON.stringify({ segments: payload }),
    '</transcript>',
  ].join('\n');
}

/**
 * Recover a requirement's body from its `requirement.created` event (rows are
 * truth, the body is carried in the event payload — spec §6 seam). Used by the
 * realignment step to re-render the projection without reading files back.
 */
export function requirementBodyFromEvents(sqlite: SqliteDb, requirementId: string): string | null {
  const events = listEvents(sqlite, {
    aggregateType: 'requirement',
    aggregateId: requirementId,
    type: EVENT_TYPES.RequirementCreated,
  });
  for (const event of events) {
    try {
      const payload = JSON.parse(event.payloadJson) as { body?: unknown };
      if (typeof payload.body === 'string') return payload.body;
    } catch {
      // Malformed payload → keep scanning.
    }
  }
  return null;
}

/**
 * Parse the model completion tolerantly: strip code fences, take the outermost
 * JSON object, validate every entry. Deterministic given the same text.
 */
export function parseSplitCompletion(text: string): ProposedRequirement[] {
  let raw = text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('split completion contains no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(`split completion is not valid JSON: ${String(error)}`);
  }
  const list = (parsed as { requirements?: unknown }).requirements;
  if (!Array.isArray(list)) {
    throw new Error('split completion missing "requirements" array');
  }
  const out: ProposedRequirement[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const body = typeof rec.body === 'string' ? rec.body.trim() : '';
    if (body === '') continue;
    const startMs = typeof rec.startMs === 'number' ? rec.startMs : Number.NaN;
    const endMs = typeof rec.endMs === 'number' ? rec.endMs : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    out.push({
      title: typeof rec.title === 'string' && rec.title.trim() !== '' ? rec.title.trim() : body.slice(0, 40),
      body,
      startMs,
      endMs,
    });
  }
  return out;
}

/**
 * Run the split for a Final revision. `revisionId` optional → uses the
 * recording's current final revision (also the on-demand entry point).
 */
export async function splitRequirements(
  deps: SplitDeps,
  recordingId: string,
  revisionId?: string,
): Promise<SplitOutcome> {
  const now = deps.now ?? ((): number => Date.now());

  const revision =
    revisionId !== undefined
      ? transcripts.getRevision(deps.sqlite, revisionId)
      : transcripts.getCurrentRevision(deps.sqlite, recordingId, 'final');
  if (revision === null) {
    throw new Error(`no final revision for recording: ${recordingId}`);
  }
  if (revision.kind !== 'final') {
    throw new Error(`split requires a final revision, got: ${revision.kind}`);
  }
  if (revision.recording_id !== recordingId) {
    throw new Error(
      `revision ${revision.id} does not belong to recording ${recordingId}`,
    );
  }

  // Idempotency (rows are truth): this source revision already split → no-op.
  const existing = listRequirementsBySourceRevision(deps.sqlite, revision.id);
  if (existing.length > 0) {
    deps.log?.(`split: revision=${revision.id} already split into ${existing.length}; skipping`);
    return {
      recordingId,
      revisionId: revision.id,
      skipped: true,
      requirementIds: existing.map((r) => r.id),
      requirementPaths: existing.map((r) => r.body_path ?? ''),
    };
  }

  const segmentRows = transcripts.listSegments(deps.sqlite, revision.id);
  if (segmentRows.length === 0) {
    throw new Error(`final revision has no segments: ${revision.id}`);
  }

  // 1. Structured-output call through the ModelProvider interface (§7.2).
  const completion = await deps.model.complete({
    model: deps.modelName,
    temperature: 0,
    messages: [
      { role: 'system', content: SPLIT_SYSTEM_PROMPT },
      { role: 'user', content: buildSplitPrompt(segmentRows) },
    ],
    responseFormatJsonSchema: SPLIT_RESPONSE_FORMAT,
  });
  const proposed = parseSplitCompletion(completion.text);
  if (proposed.length === 0) {
    throw new Error(`model proposed no usable requirements for revision ${revision.id}`);
  }

  // 2. Anchor every proposal to the real segments (ADR-0004).
  const charMap = buildCharMap(segmentRows.map((s) => s.text));
  const anchored = proposed.map((p) => ({
    proposed: p,
    anchor: anchorToSegments(segmentRows, charMap, p.startMs, p.endMs),
  }));

  // 3. ONE transaction: requirement rows + source refs + requirement.created.
  const createdAt = now();
  const rows = anchored.map(({ proposed: p, anchor }) => ({
    id: randomUUID(),
    title: p.title,
    body: p.body,
    bodyPath: '',
    anchor,
  }));
  for (const row of rows) {
    row.bodyPath = requirementBodyPath(row.id, row.title);
  }

  const writeOnce = deps.sqlite.transaction(() => {
    for (const row of rows) {
      insertRequirement(deps.sqlite, {
        id: row.id,
        title: row.title,
        bodyPath: row.bodyPath,
        status: 'draft',
        createdAt,
        sourceRevisionId: revision.id,
      });
      insertSourceRef(deps.sqlite, {
        requirementId: row.id,
        recordingId,
        startMs: row.anchor.startMs,
        endMs: row.anchor.endMs,
        charStart: row.anchor.charStart,
        charEnd: row.anchor.charEnd,
        asrRevisionId: revision.id,
        quoteSnippet: row.anchor.quote,
      });
      appendEvent(deps.sqlite, {
        aggregateType: 'requirement',
        aggregateId: row.id,
        type: EVENT_TYPES.RequirementCreated,
        payload: {
          recordingId,
          revisionId: revision.id,
          title: row.title,
          body: row.body,
          startMs: row.anchor.startMs,
          endMs: row.anchor.endMs,
          quoteSnippet: row.anchor.quote,
        },
        createdAt,
      });
    }
  });
  writeOnce();

  // 4. Deterministic file projections + their events (ADR-0002, write-only).
  const paths: string[] = [];
  for (const row of rows) {
    const projection = writeRequirementProjection({
      dataDir: deps.dataDir,
      requirement: {
        id: row.id,
        title: row.title,
        status: 'draft',
        createdAt,
        sourceRevisionId: revision.id,
      },
      body: row.body,
      refs: [
        {
          recordingId,
          startMs: row.anchor.startMs,
          endMs: row.anchor.endMs,
          charStart: row.anchor.charStart,
          charEnd: row.anchor.charEnd,
          asrRevisionId: revision.id,
          quoteSnippet: row.anchor.quote,
        },
      ],
    });
    paths.push(projection.path);
    appendEvent(deps.sqlite, {
      aggregateType: 'requirement',
      aggregateId: row.id,
      type: EVENT_TYPES.ProjectionWritten,
      payload: {
        kind: 'requirement',
        path: projection.path,
        sha256: projection.sha256,
      },
      createdAt: now(),
    });
  }

  deps.log?.(
    `split: recording=${recordingId} revision=${revision.id} requirements=${rows.length}`,
  );

  return {
    recordingId,
    revisionId: revision.id,
    skipped: false,
    requirementIds: rows.map((r) => r.id),
    requirementPaths: paths,
  };
}
