import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { EVENT_TYPES } from '@idearelay/contracts';
import { openDatabase, type Db } from './db/index.js';
import { listEvents } from './db/repositories/events.js';
import {
  countRecordings,
  getRecording,
} from './db/repositories/recordings.js';
import {
  getCurrentRevision,
  listRevisions,
  listSegments,
} from './db/repositories/transcripts.js';
import { JobQueue } from './queue/job-queue.js';
import { createMockAsrProvider, mockSegmentCount } from './providers/asr/mock.js';
import { createIntake } from './watcher/intake.js';
import { startWatcher, type WatcherHandle } from './watcher/watcher.js';
import { registerTranscribeHandler } from './worker/handlers/transcribe.js';
import { Worker } from './worker/worker.js';

const FIXTURE = fileURLToPath(new URL('../test-fixtures/sample.m4a', import.meta.url));

interface Harness {
  root: string;
  dataDir: string;
  inboxDir: string;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  watcher: WatcherHandle;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m1-'));
  const dataDir = join(root, 'data');
  const inboxDir = join(dataDir, 'inbox');

  const db = openDatabase(join(dataDir, 'idea-relay.db'));
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, {
    workerId: 'm1-test',
    pollIntervalMs: 20,
    stallTimeoutMs: 30_000,
  });
  registerTranscribeHandler(worker, {
    sqlite: db.sqlite,
    dataDir,
    asr: createMockAsrProvider(),
    transcribeOpts: { languageHints: ['zh'], hotwords: [] },
  });
  worker.start();

  const intake = createIntake({ sqlite: db.sqlite, queue, dataDir });
  const watcher = await startWatcher({
    inboxDir,
    onFile: async (filePath) => {
      await intake.handleFile(filePath);
    },
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });

  return {
    root,
    dataDir,
    inboxDir,
    db,
    queue,
    worker,
    watcher,
    async cleanup(): Promise<void> {
      await worker.stop();
      await watcher.stop();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Simulate a mobile upload: land a `.part`, then atomically `mv` it. */
async function dropFinalized(h: Harness, finalName = 'sample.m4a'): Promise<void> {
  const partPath = join(h.inboxDir, `${finalName}.part`);
  copyFileSync(FIXTURE, partPath);
  await delay(50);
  renameSync(partPath, join(h.inboxDir, finalName));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error('waitFor: predicate not satisfied before timeout');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('M1 e2e: inbox audio → transcript revisions → projection, idempotent re-drop', async () => {
  const h = await harness();
  try {
    const fixtureChecksum = sha256File(FIXTURE);

    // --- first drop ---------------------------------------------------------
    await dropFinalized(h);
    await waitFor(() => getRecording(h.db.sqlite, recordingId(h))?.status === 'ready', 15_000);

    // recording: received → ready, archived with checksum.
    const rows = h.db.sqlite
      .prepare('SELECT * FROM recordings')
      .all() as Array<{ id: string }>;
    assert.equal(rows.length, 1, 'exactly one recording');
    const rec = getRecording(h.db.sqlite, rows[0].id);
    assert.ok(rec !== null);
    assert.equal(rec.status, 'ready');
    assert.equal(rec.audio_checksum, fixtureChecksum);
    assert.ok(rec.audio_path !== null && existsSync(rec.audio_path), 'audio archived on disk');

    // two revisions, both current; final carries the mock provider.
    const revisions = listRevisions(h.db.sqlite, rec.id);
    assert.equal(revisions.length, 2);
    const final = getCurrentRevision(h.db.sqlite, rec.id, 'final');
    const provisional = getCurrentRevision(h.db.sqlite, rec.id, 'provisional');
    assert.ok(final !== null, 'final revision current');
    assert.ok(provisional !== null, 'provisional placeholder current');
    assert.equal(final.provider_id, 'mock');
    assert.equal(final.model, 'mock-asr-v1');
    assert.equal(provisional.provider_id, 'placeholder');

    // segments for the final revision.
    const segments = listSegments(h.db.sqlite, final.id);
    assert.equal(segments.length, mockSegmentCount());
    assert.deepEqual(
      segments.map((s) => s.idx),
      [0, 1, 2],
    );
    assert.equal(segments[0].start_ms, 0);
    assert.ok(segments[0].end_ms > segments[0].start_ms);
    assert.ok(segments.every((s) => s.text.length > 0));
    assert.equal(listSegments(h.db.sqlite, provisional.id).length, 0, 'placeholder has no segments');

    // projection file + sha256 sidecar on disk.
    const projectionPath = join(h.dataDir, 'recordings', rec.id, 'transcript.final.md');
    const sidecarPath = `${projectionPath}.sha256`;
    assert.ok(existsSync(projectionPath), 'transcript.final.md written');
    assert.ok(existsSync(sidecarPath), 'transcript.final.md.sha256 written');
    const md = readFileSync(projectionPath, 'utf8');
    for (const seg of segments) assert.ok(md.includes(seg.text), `md contains: ${seg.text}`);
    const sidecarHash = readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
    assert.equal(sidecarHash, sha256File(projectionPath), 'sidecar matches md bytes');

    // events: received / revision.created (per revision) / projection.written.
    const received = listEvents(h.db.sqlite, { type: EVENT_TYPES.RecordingReceived });
    assert.equal(received.length, 1);
    assert.equal(received[0].aggregateType, 'recording');
    assert.equal(received[0].aggregateId, rec.id);
    assert.equal(received[0].seq, 1);

    const revEvents = listEvents(h.db.sqlite, {
      type: EVENT_TYPES.TranscriptRevisionCreated,
    });
    assert.equal(revEvents.length, 2);
    assert.deepEqual(
      revEvents.map((e) => e.aggregateId).sort(),
      [final.id, provisional.id].sort(),
    );
    assert.ok(revEvents.every((e) => e.seq === 1), 'per-aggregate seq starts at 1');

    const projected = listEvents(h.db.sqlite, { type: EVENT_TYPES.ProjectionWritten });
    assert.equal(projected.length, 1);
    assert.equal(projected[0].aggregateId, rec.id);
    assert.equal(projected[0].seq, 2, 'recording seq continues 1 → 2');

    // exactly one transcribe job, succeeded.
    assert.deepEqual(h.queue.countByStatus(), {
      pending: 0,
      claimed: 0,
      succeeded: 1,
      failed: 0,
      dead: 0,
    });

    // --- re-drop the identical file: no duplicates --------------------------
    await dropFinalized(h);
    await delay(500);

    assert.equal(countRecordings(h.db.sqlite), 1, 'no second recording');
    assert.equal(listRevisions(h.db.sqlite, rec.id).length, 2, 'no extra revisions');
    assert.equal(listSegments(h.db.sqlite, final.id).length, mockSegmentCount());
    assert.equal(h.queue.countByStatus().succeeded, 1, 'no duplicate transcribe job');
    assert.equal(
      listEvents(h.db.sqlite, { type: EVENT_TYPES.RecordingReceived }).length,
      1,
      'no duplicate received event',
    );
  } finally {
    await h.cleanup();
  }
});

/** Resolve the single recording id, or empty string before it exists. */
function recordingId(h: Harness): string {
  const row = h.db.sqlite
    .prepare('SELECT id FROM recordings LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? '';
}
