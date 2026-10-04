import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase, listTables, type Db } from '../db/index.js';
import { M0_TABLES } from '../db/tables.js';
import { JobQueue } from './job-queue.js';
import { Worker } from '../worker/worker.js';

const WORKER_OPTS = {
  workerId: 'test-worker',
  pollIntervalMs: 10,
  stallTimeoutMs: 30_000,
};

interface Harness {
  db: Db;
  queue: JobQueue;
  worker: Worker;
  cleanup(): void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'idearelay-m0-'));
  const db = openDatabase(join(dir, 'test.db'));
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, WORKER_OPTS);
  return {
    db,
    queue,
    worker,
    cleanup(): void {
      db.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('migration creates every §5 table', () => {
  const h = harness();
  try {
    const tables = listTables(h.db.sqlite);
    for (const expected of M0_TABLES) {
      assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }
    assert.equal(tables.length, M0_TABLES.length);
  } finally {
    h.cleanup();
  }
});

test('echo worker claims a job and it ends succeeded', async () => {
  const h = harness();
  try {
    h.worker.register('echo', async (job) => JSON.parse(job.payload_json) as unknown);
    h.queue.enqueue({ kind: 'echo', payload: { hello: 'world', n: 42 } });

    const outcome = await h.worker.runOnce();
    assert.ok(outcome !== null, 'worker should have claimed a job');
    assert.equal(outcome.job.kind, 'echo');
    assert.equal(outcome.job.status, 'succeeded');
    assert.equal(outcome.job.attempts, 1);
    assert.deepEqual(outcome.result, { hello: 'world', n: 42 });
    assert.ok(outcome.job.finished_at !== null);
  } finally {
    h.cleanup();
  }
});

test('enqueueing the same idempotency_key twice yields one job', () => {
  const h = harness();
  try {
    const first = h.queue.enqueue({
      kind: 'echo',
      payload: { n: 1 },
      idempotencyKey: 'dedupe-me',
    });
    const second = h.queue.enqueue({
      kind: 'echo',
      payload: { n: 2 },
      idempotencyKey: 'dedupe-me',
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(first.id, second.id);
    assert.equal(h.queue.countByStatus().pending, 1);
  } finally {
    h.cleanup();
  }
});

test('a job exceeding max_attempts ends dead', async () => {
  const h = harness();
  try {
    h.worker.register('boom', async () => {
      throw new Error('kaboom');
    });
    const { id } = h.queue.enqueue({ kind: 'boom', maxAttempts: 1 });

    const outcome = await h.worker.runOnce();
    assert.ok(outcome !== null);
    assert.equal(outcome.job.status, 'dead');

    const job = h.queue.get(id);
    assert.ok(job !== null);
    assert.equal(job.status, 'dead');
    assert.equal(job.attempts, 1);
    assert.equal(job.last_error, 'kaboom');
    assert.equal(h.queue.countByStatus().dead, 1);
  } finally {
    h.cleanup();
  }
});

test('an exhausted max_attempts job is dead after repeated failures', async () => {
  const h = harness();
  try {
    h.worker.register('flaky', async () => {
      throw new Error('nope');
    });
    const { id } = h.queue.enqueue({ kind: 'flaky', maxAttempts: 2 });

    await h.worker.runOnce(); // attempt 1 → requeued pending with backoff
    const afterFirst = h.queue.get(id);
    assert.ok(afterFirst !== null);
    assert.equal(afterFirst.status, 'pending');
    assert.equal(afterFirst.attempts, 1);

    await delay(350); // let the backoff elapse so the retry is eligible
    await h.worker.runOnce(); // attempt 2 → dead
    const afterSecond = h.queue.get(id);
    assert.ok(afterSecond !== null);
    assert.equal(afterSecond.status, 'dead');
    assert.equal(afterSecond.attempts, 2);
  } finally {
    h.cleanup();
  }
});
