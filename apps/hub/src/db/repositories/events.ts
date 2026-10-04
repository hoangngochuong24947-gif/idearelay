import type { EventAggregateType, EventRecord } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

export interface AppendEventInput<P = unknown> {
  aggregateType: EventAggregateType;
  aggregateId: string;
  type: string;
  payload?: P;
  createdAt?: number;
}

/**
 * Append an event with a per-aggregate monotonic `seq` (spec §5.6 / §6). Safe to
 * call inside a `sqlite.transaction(...)`: the `MAX(seq)+1` read and the insert
 * share one connection and are serialized.
 */
export function appendEvent<P>(sqlite: SqliteDb, input: AppendEventInput<P>): number {
  const next = sqlite
    .prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE aggregate_type = ? AND aggregate_id = ?',
    )
    .get(input.aggregateType, input.aggregateId) as { seq: number };
  const createdAt = input.createdAt ?? Date.now();
  sqlite
    .prepare(
      `INSERT INTO events (aggregate_type, aggregate_id, seq, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.aggregateType,
      input.aggregateId,
      next.seq,
      input.type,
      JSON.stringify(input.payload ?? null),
      createdAt,
    );
  return next.seq;
}

export function listEvents(
  sqlite: SqliteDb,
  filter: { aggregateType?: string; aggregateId?: string; type?: string } = {},
): EventRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.aggregateType !== undefined) {
    clauses.push('aggregate_type = ?');
    params.push(filter.aggregateType);
  }
  if (filter.aggregateId !== undefined) {
    clauses.push('aggregate_id = ?');
    params.push(filter.aggregateId);
  }
  if (filter.type !== undefined) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = sqlite
    .prepare(`SELECT * FROM events ${where} ORDER BY id ASC`)
    .all(...params) as Array<{
    id: number;
    aggregate_type: string;
    aggregate_id: string;
    seq: number;
    type: string;
    payload_json: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    seq: r.seq,
    type: r.type,
    payloadJson: r.payload_json ?? 'null',
    createdAt: r.created_at,
  }));
}
