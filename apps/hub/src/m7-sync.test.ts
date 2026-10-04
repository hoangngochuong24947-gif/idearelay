import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EVENT_TYPES } from '@idearelay/contracts';
import { openDatabase, type Db } from './db/index.js';
import { listEvents } from './db/repositories/events.js';
import { LocalDirSyncProvider } from './providers/sync/index.js';
import { JobQueue } from './queue/job-queue.js';
import { collectProjectedFiles, registerSyncHandler } from './worker/handlers/sync.js';
import { Worker } from './worker/worker.js';

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

interface SyncHarness {
  dataDir: string;
  targetDir: string;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  cleanup(): Promise<void>;
}

async function syncHarness(targetDir: string | null): Promise<SyncHarness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m7-sync-'));
  const dataDir = join(root, 'data');
  const target = targetDir === null ? null : join(root, targetDir);
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'idea-relay.db'));
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, {
    workerId: 'm7-sync',
    pollIntervalMs: 20,
    stallTimeoutMs: 30_000,
  });
  registerSyncHandler(worker, {
    sqlite: db.sqlite,
    dataDir,
    sync: new LocalDirSyncProvider({ dataDir }),
    targetDir: target,
  });
  return {
    dataDir,
    targetDir: target as string,
    db,
    queue,
    worker,
    async cleanup(): Promise<void> {
      await worker.stop();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeProjection(h: SyncHarness, relPath: string, content: string): Buffer {
  const path = join(h.dataDir, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return Buffer.from(content, 'utf8');
}

test('M7 LocalDirSyncProvider: push mirrors the tree, re-push skips, change re-pushes', async () => {
  const h = await syncHarness('mirror');
  try {
    const a = writeProjection(h, 'recordings/r1/transcript.final.md', 'v1\n');
    const b = writeProjection(h, 'requirements/req-1.md', 'req\n');
    const provider = new LocalDirSyncProvider({ dataDir: h.dataDir });
    const target = { id: 't', kind: 'local-dir', config: { dir: h.targetDir } };

    // 1. First push → mirror tree appears.
    const first = await provider.push(target, [
      { path: 'recordings/r1/transcript.final.md', checksum: sha256(a) },
      { path: 'requirements/req-1.md', checksum: sha256(b) },
    ]);
    assert.deepEqual(
      { pushed: first.pushed, skipped: first.skipped, errors: first.errors },
      { pushed: 2, skipped: 0, errors: [] },
    );
    assert.equal(
      readFileSync(join(h.targetDir, 'recordings/r1/transcript.final.md'), 'utf8'),
      'v1\n',
    );
    assert.equal(readFileSync(join(h.targetDir, 'requirements/req-1.md'), 'utf8'), 'req\n');

    // 2. Unchanged re-push → everything skipped (idempotent mirror).
    const second = await provider.push(target, [
      { path: 'recordings/r1/transcript.final.md', checksum: sha256(a) },
      { path: 'requirements/req-1.md', checksum: sha256(b) },
    ]);
    assert.deepEqual(
      { pushed: second.pushed, skipped: second.skipped, errors: second.errors },
      { pushed: 0, skipped: 2, errors: [] },
    );

    // 3. Changed file → only that file re-pushes.
    const a2 = writeProjection(h, 'recordings/r1/transcript.final.md', 'v2 (realigned)\n');
    const third = await provider.push(target, [
      { path: 'recordings/r1/transcript.final.md', checksum: sha256(a2) },
      { path: 'requirements/req-1.md', checksum: sha256(b) },
    ]);
    assert.deepEqual(
      { pushed: third.pushed, skipped: third.skipped, errors: third.errors },
      { pushed: 1, skipped: 1, errors: [] },
    );
    assert.equal(
      readFileSync(join(h.targetDir, 'recordings/r1/transcript.final.md'), 'utf8'),
      'v2 (realigned)\n',
    );

    // 4. Missing source → an error entry, never a crash.
    const fourth = await provider.push(target, [{ path: 'recordings/ghost.md', checksum: 'x' }]);
    assert.equal(fourth.pushed, 0);
    assert.equal(fourth.errors.length, 1);
    assert.ok(fourth.errors[0].includes('ghost.md'));
  } finally {
    await h.cleanup();
  }
});

test('M7 sync job: collects projections (excludes inbox/tus/db), mirrors, disabled when unset', async () => {
  const h = await syncHarness('mirror');
  try {
    writeProjection(h, 'recordings/r1/transcript.final.md', 'final\n');
    writeProjection(h, 'recordings/r1/transcript.final.md.sha256', 'abc\n');
    writeProjection(h, 'inbox/raw-upload.m4a', 'consume folder — NOT a projection\n');
    writeProjection(h, 'tus-uploads/part.bin', 'partial upload\n');
    // idea-relay.db already exists (opened by the harness).

    const files = collectProjectedFiles(h.dataDir);
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('recordings/r1/transcript.final.md'));
    assert.ok(paths.includes('recordings/r1/transcript.final.md.sha256'));
    assert.ok(!paths.some((p) => p.startsWith('inbox/')), 'consume folder excluded');
    assert.ok(!paths.some((p) => p.startsWith('tus-uploads/')), 'tus store excluded');
    assert.ok(!paths.some((p) => p === 'idea-relay.db'), 'db rows are truth, not projection');

    // Run the sync job through the worker handler: mirror appears + event.
    h.queue.enqueue({ kind: 'sync' });
    const first = (await h.worker.runOnce())!;
    assert.equal(first.job.kind, 'sync');
    const events = listEvents(h.db.sqlite, { type: EVENT_TYPES.SyncCompleted });
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payloadJson) as { pushed: number; skipped: number };
    assert.ok(payload.pushed >= 2, 'both projection files pushed');
    assert.ok(existsSync(join(h.targetDir, 'recordings/r1/transcript.final.md.sha256')));

    // Idempotent: a second run skips everything.
    h.queue.enqueue({ kind: 'sync' });
    const second = (await h.worker.runOnce())!;
    const result = second.result as { pushed: number; skipped: number };
    assert.equal(result.pushed, 0);
    assert.equal(result.skipped, 2);
  } finally {
    await h.cleanup();
  }
});

test('M7 sync job: no-op when IDEA_RELAY_SYNC_TARGET_DIR is unset', async () => {
  const h = await syncHarness(null);
  try {
    writeProjection(h, 'recordings/r1/transcript.final.md', 'final\n');
    h.queue.enqueue({ kind: 'sync' });
    const run = await h.worker.runOnce();
    assert.ok(run !== null);
    const result = run.result as { disabled: boolean; pushed: number };
    assert.equal(result.disabled, true);
    assert.equal(result.pushed, 0);
  } finally {
    await h.cleanup();
  }
});
