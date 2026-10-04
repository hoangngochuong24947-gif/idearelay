import { randomUUID } from 'node:crypto';
import type { JobStatus } from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';

export interface JobRow {
  id: string;
  kind: string;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: number;
  locked_by: string | null;
  locked_at: number | null;
  heartbeat_at: number | null;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface EnqueueOptions {
  kind: string;
  payload?: unknown;
  /** Unique key → idempotent enqueue (INSERT OR IGNORE). */
  idempotencyKey?: string | null;
  maxAttempts?: number;
  /** Absolute epoch ms at which the job becomes eligible. */
  runAt?: number;
  /** Relative delay in ms (alternative to runAt). */
  delayMs?: number;
}

export interface EnqueueResult {
  id: string;
  inserted: boolean;
}

export interface ReclaimResult {
  requeued: number;
  dead: number;
}

/**
 * Self-built durable job queue (spec §5.5; stack-survey §二). Copies liteque's
 * atomic claim + idempotent enqueue and vardiya's heartbeat / stall-reclaim /
 * dead-letter behaviour.
 */
export class JobQueue {
  constructor(
    private readonly sqlite: SqliteDb,
    private readonly defaultMaxAttempts = 5,
  ) {}

  enqueue(opts: EnqueueOptions): EnqueueResult {
    const id = randomUUID();
    const now = Date.now();
    const runAt = opts.runAt ?? now + (opts.delayMs ?? 0);
    const maxAttempts = opts.maxAttempts ?? this.defaultMaxAttempts;
    const payloadJson = JSON.stringify(opts.payload ?? {});
    const idempotencyKey = opts.idempotencyKey ?? null;

    const info = this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO jobs
           (id, kind, payload_json, status, attempts, max_attempts, run_at,
            locked_by, locked_at, heartbeat_at, last_error, idempotency_key,
            created_at, finished_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(id, opts.kind, payloadJson, maxAttempts, runAt, idempotencyKey, now);

    if (info.changes === 0 && idempotencyKey !== null) {
      const existing = this.findIdempotent(idempotencyKey);
      if (existing !== null) return { id: existing, inserted: false };
    }
    return { id, inserted: info.changes > 0 };
  }

  /**
   * Atomically claim the oldest eligible pending job. `attempts` is incremented
   * as the lease is taken so a crash still consumes an attempt.
   */
  claim(workerId: string, now: number = Date.now()): JobRow | null {
    const row = this.sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'claimed',
                attempts = attempts + 1,
                locked_by = ?,
                locked_at = ?,
                heartbeat_at = ?
          WHERE id = (
            SELECT id FROM jobs
             WHERE status = 'pending' AND run_at <= ?
             ORDER BY run_at ASC, created_at ASC
             LIMIT 1
          )
          RETURNING *`,
      )
      .get(workerId, now, now, now) as JobRow | undefined;
    return row ?? null;
  }

  heartbeat(jobId: string, now: number = Date.now()): void {
    this.sqlite
      .prepare(
        "UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'claimed'",
      )
      .run(now, jobId);
  }

  complete(jobId: string, now: number = Date.now()): void {
    this.sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'succeeded',
                finished_at = ?,
                locked_by = NULL,
                locked_at = NULL,
                heartbeat_at = NULL,
                last_error = NULL
          WHERE id = ?`,
      )
      .run(now, jobId);
  }

  /** Mark an attempt failed; requeue with backoff or dead-letter at max. */
  fail(jobId: string, error: string, now: number = Date.now()): JobRow {
    const job = this.get(jobId);
    if (job === null) throw new Error(`job not found: ${jobId}`);
    if (job.attempts >= job.max_attempts) {
      this.markDead(jobId, error, now);
    } else {
      this.sqlite
        .prepare(
          `UPDATE jobs
              SET status = 'pending',
                  last_error = ?,
                  run_at = ?,
                  locked_by = NULL,
                  locked_at = NULL,
                  heartbeat_at = NULL
            WHERE id = ?`,
        )
        .run(error, now + backoffMs(job.attempts), jobId);
    }
    return this.get(jobId) as JobRow;
  }

  markDead(jobId: string, error: string, now: number = Date.now()): void {
    this.sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'dead',
                last_error = ?,
                finished_at = ?,
                locked_by = NULL,
                locked_at = NULL,
                heartbeat_at = NULL
          WHERE id = ?`,
      )
      .run(error, now, jobId);
  }

  /**
   * Reclaim claimed jobs whose heartbeat is older than `stallTimeoutMs`: back to
   * pending, or dead once attempts are exhausted.
   */
  reclaimStalled(stallTimeoutMs: number, now: number = Date.now()): ReclaimResult {
    const cutoff = now - stallTimeoutMs;
    const dead = this.sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'dead',
                last_error = 'stalled',
                finished_at = ?,
                locked_by = NULL,
                locked_at = NULL,
                heartbeat_at = NULL
          WHERE status = 'claimed'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at < ?
            AND attempts >= max_attempts`,
      )
      .run(now, cutoff);
    const requeued = this.sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'pending',
                last_error = 'stalled',
                run_at = ?,
                locked_by = NULL,
                locked_at = NULL,
                heartbeat_at = NULL
          WHERE status = 'claimed'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at < ?
            AND attempts < max_attempts`,
      )
      .run(now, cutoff);
    return { requeued: requeued.changes, dead: dead.changes };
  }

  get(jobId: string): JobRow | null {
    const row = this.sqlite
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(jobId) as JobRow | undefined;
    return row ?? null;
  }

  findIdempotent(idempotencyKey: string): string | null {
    const row = this.sqlite
      .prepare('SELECT id FROM jobs WHERE idempotency_key = ?')
      .get(idempotencyKey) as { id: string } | undefined;
    return row?.id ?? null;
  }

  countByStatus(): Record<JobStatus, number> {
    const rows = this.sqlite
      .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
      .all() as Array<{ status: JobStatus; n: number }>;
    const counts: Record<JobStatus, number> = {
      pending: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    };
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 250 * 2 ** Math.max(0, attempts - 1));
}
