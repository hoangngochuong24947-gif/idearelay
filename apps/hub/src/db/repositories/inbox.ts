import type { InboxKind, InboxStatus } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

/** Raw `inbox_items` row (§5.3). Rows are truth (ADR-0002). */
export interface InboxItemRow {
  id: string;
  kind: InboxKind;
  subject_type: string;
  subject_id: string;
  payload_json: string | null;
  confidence: number | null;
  abstained: number;
  status: InboxStatus;
  resolution_json: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface NewInboxItem {
  id: string;
  kind: InboxKind;
  subjectType: string;
  subjectId: string;
  payloadJson: string;
  confidence: number | null;
  abstained: boolean;
  status: InboxStatus;
  createdAt: number;
}

export function insertInboxItem(sqlite: SqliteDb, item: NewInboxItem): void {
  sqlite
    .prepare(
      `INSERT INTO inbox_items
         (id, kind, subject_type, subject_id, payload_json, confidence, abstained,
          status, resolution_json, created_at, resolved_at)
       VALUES (@id, @kind, @subject_type, @subject_id, @payload_json, @confidence,
               @abstained, @status, NULL, @created_at, NULL)`,
    )
    .run({
      id: item.id,
      kind: item.kind,
      subject_type: item.subjectType,
      subject_id: item.subjectId,
      payload_json: item.payloadJson,
      confidence: item.confidence,
      abstained: item.abstained ? 1 : 0,
      status: item.status,
      created_at: item.createdAt,
    });
}

export function getInboxItem(sqlite: SqliteDb, id: string): InboxItemRow | null {
  const row = sqlite
    .prepare('SELECT * FROM inbox_items WHERE id = ?')
    .get(id) as InboxItemRow | undefined;
  return row ?? null;
}

export function listInboxItems(
  sqlite: SqliteDb,
  filter: { status?: InboxStatus; kind?: InboxKind; subjectId?: string } = {},
): InboxItemRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.subjectId !== undefined) {
    clauses.push('subject_id = ?');
    params.push(filter.subjectId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return sqlite
    .prepare(`SELECT * FROM inbox_items ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params) as InboxItemRow[];
}

export function countInboxItems(sqlite: SqliteDb): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM inbox_items').get() as {
    n: number;
  };
  return row.n;
}
