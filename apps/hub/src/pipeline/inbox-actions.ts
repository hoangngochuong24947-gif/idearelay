import {
  EVENT_TYPES,
  INBOX_KINDS,
  type InboxKind,
  type InboxStatus,
} from '@idearelay/contracts';
import { appendEvent } from '../db/repositories/events.js';
import { getInboxItem, type InboxItemRow } from '../db/repositories/inbox.js';
import type { SqliteDb } from '../db/types.js';

/**
 * Inbox human actions (spec §11 `POST /inbox/:id/{accept,reject,reroute}`) and
 * the §9 人工修正回流 annotation seam. Rows are truth (ADR-0002): every action
 * updates `inbox_items` and appends events in one transaction.
 *
 * **Annotation-store decision**: §9 asks for a `(文本, 标签)` pair per human
 * correction to later specialize Laya. The §5 schema has no dedicated
 * annotation table, so the pair is recorded as an append-only
 * `annotation.recorded` event on the `inbox_item` aggregate with payload
 * `{ text, label, action }` — queryable by `type` like any other event seam
 * row (§6), and no migration is needed. `text` comes from the item payload
 * (`transcriptExcerpt`, falling back to `summary`); `label` is the kind the
 * human confirmed (accept), refuted (reject — a negative example for the same
 * text), or substituted (reroute).
 */

export class InboxActionError extends Error {
  constructor(
    /** HTTP status the caller should map this to. */
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The JSON shape served by `GET /inbox` and `GET /changes` (spec §11 / §6). */
export interface InboxItemApi {
  id: string;
  kind: InboxKind;
  subject_type: string;
  subject_id: string;
  payload: unknown;
  confidence: number | null;
  abstained: boolean;
  status: InboxStatus;
  created_at: number;
}

/** Serialize a row to the wire shape; `payload` is the parsed `payload_json`. */
export function serializeInboxItem(row: InboxItemRow): InboxItemApi {
  let payload: unknown = null;
  if (row.payload_json !== null) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    payload,
    confidence: row.confidence,
    abstained: row.abstained === 1,
    status: row.status,
    created_at: row.created_at,
  };
}

/** Extract the annotation text from an item's payload (§9). */
function annotationText(row: InboxItemRow): string {
  if (row.payload_json === null) return '';
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (typeof payload.transcriptExcerpt === 'string') return payload.transcriptExcerpt;
    if (typeof payload.summary === 'string') return payload.summary;
  } catch {
    // Non-JSON payload → no text to annotate.
  }
  return '';
}

export interface ResolveInboxOptions {
  now?: () => number;
}

interface ResolveOutcome {
  item: InboxItemRow;
}

function loadPendingItem(sqlite: SqliteDb, id: string): InboxItemRow {
  const row = getInboxItem(sqlite, id);
  if (row === null) {
    throw new InboxActionError(404, 'not_found', `inbox item not found: ${id}`);
  }
  if (row.status !== 'pending') {
    throw new InboxActionError(
      409,
      'conflict',
      `inbox item ${id} is not pending (status: ${row.status})`,
    );
  }
  return row;
}

function applyResolution(
  sqlite: SqliteDb,
  row: InboxItemRow,
  opts: {
    status: InboxStatus;
    kind?: InboxKind;
    resolution: Record<string, unknown>;
    eventType: string;
    eventPayload: Record<string, unknown>;
    annotationLabel: string;
    now: number;
  },
): ResolveOutcome {
  const nextKind = opts.kind ?? row.kind;
  const writeOnce = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE inbox_items
            SET status = ?, kind = ?, resolution_json = ?, resolved_at = ?
          WHERE id = ?`,
      )
      .run(opts.status, nextKind, JSON.stringify(opts.resolution), opts.now, row.id);
    appendEvent(sqlite, {
      aggregateType: 'inbox_item',
      aggregateId: row.id,
      type: opts.eventType,
      payload: opts.eventPayload,
      createdAt: opts.now,
    });
    appendEvent(sqlite, {
      aggregateType: 'inbox_item',
      aggregateId: row.id,
      type: EVENT_TYPES.AnnotationRecorded,
      payload: {
        text: annotationText(row),
        label: opts.annotationLabel,
        action: opts.eventType,
      },
      createdAt: opts.now,
    });
  });
  writeOnce();
  const updated = getInboxItem(sqlite, row.id);
  if (updated === null) {
    throw new Error(`inbox item vanished during update: ${row.id}`);
  }
  return { item: updated };
}

/** `POST /inbox/:id/accept` (§11): the human confirms the system's kind. */
export function acceptInboxItem(
  sqlite: SqliteDb,
  id: string,
  opts: ResolveInboxOptions = {},
): ResolveOutcome {
  const row = loadPendingItem(sqlite, id);
  const now = opts.now !== undefined ? opts.now() : Date.now();
  return applyResolution(sqlite, row, {
    status: 'accepted',
    resolution: { action: 'accept', from_kind: row.kind, at: now },
    eventType: EVENT_TYPES.InboxItemAccepted,
    eventPayload: { from_kind: row.kind, confidence: row.confidence },
    annotationLabel: row.kind,
    now,
  });
}

/** `POST /inbox/:id/reject` (§11): the human refutes the classification. */
export function rejectInboxItem(
  sqlite: SqliteDb,
  id: string,
  opts: ResolveInboxOptions = {},
): ResolveOutcome {
  const row = loadPendingItem(sqlite, id);
  const now = opts.now !== undefined ? opts.now() : Date.now();
  return applyResolution(sqlite, row, {
    status: 'rejected',
    resolution: { action: 'reject', from_kind: row.kind, at: now },
    eventType: EVENT_TYPES.InboxItemRejected,
    eventPayload: { from_kind: row.kind, confidence: row.confidence },
    // A rejection is a negative example: the text does NOT carry this label.
    annotationLabel: row.kind,
    now,
  });
}

/** `POST /inbox/:id/reroute` (§11): the human substitutes a different kind. */
export function rerouteInboxItem(
  sqlite: SqliteDb,
  id: string,
  toKind: unknown,
  opts: ResolveInboxOptions = {},
): ResolveOutcome {
  if (typeof toKind !== 'string' || !INBOX_KINDS.includes(toKind as InboxKind)) {
    throw new InboxActionError(
      400,
      'invalid_kind',
      `reroute requires to_kind to be one of: ${INBOX_KINDS.join(', ')}`,
    );
  }
  const row = loadPendingItem(sqlite, id);
  const now = opts.now !== undefined ? opts.now() : Date.now();
  return applyResolution(sqlite, row, {
    status: 'rerouted',
    kind: toKind as InboxKind,
    resolution: { action: 'reroute', from_kind: row.kind, to_kind: toKind, at: now },
    eventType: EVENT_TYPES.InboxItemRerouted,
    eventPayload: { from_kind: row.kind, to_kind: toKind },
    annotationLabel: toKind,
    now,
  });
}

/**
 * `GET /changes?since=<ms>` (§6, WatermelonDB shape): items created or updated
 * after `since`. An item's update time is `resolved_at` once resolved and
 * `created_at` before that; `resolved_at` is set by every accept/reject/reroute,
 * so all human actions surface as changes. There is no deletion path for
 * `inbox_items` yet, so `deletions` is empty by construction.
 */
export function listInboxChanges(
  sqlite: SqliteDb,
  since: number,
): { changes: InboxItemRow[]; deletions: string[] } {
  const changes = sqlite
    .prepare(
      `SELECT * FROM inbox_items WHERE COALESCE(resolved_at, created_at) > ?
        ORDER BY COALESCE(resolved_at, created_at) ASC, id ASC`,
    )
    .all(since) as InboxItemRow[];
  return { changes, deletions: [] };
}
