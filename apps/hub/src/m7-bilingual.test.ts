import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EVENT_TYPES } from '@idearelay/contracts';
import { openDatabase, type Db } from './db/index.js';
import { listEvents } from './db/repositories/events.js';
import {
  insertSegment,
  insertTranscriptRevision,
} from './db/repositories/transcripts.js';
import { writeBilingualTranscript } from './pipeline/bilingual.js';
import { createMockDecisionProvider } from './providers/decision/mock.js';
import {
  createMockModelProvider,
  MOCK_MODEL_ID,
} from './providers/model/mock.js';
import { JobQueue } from './queue/job-queue.js';
import { registerBilingualHandler } from './worker/handlers/bilingual.js';
import { registerEnrichHandler } from './worker/handlers/enrich.js';
import { enrichIdempotencyKey } from './worker/handlers/enrich.js';
import { Worker } from './worker/worker.js';

interface Harness {
  root: string;
  dataDir: string;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  cleanup(): Promise<void>;
}

async function harness(workerId: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m7-bilingual-'));
  const dataDir = join(root, 'data');
  const db = openDatabase(join(dataDir, 'idea-relay.db'));
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, {
    workerId,
    pollIntervalMs: 20,
    stallTimeoutMs: 30_000,
  });
  return {
    root,
    dataDir,
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

function seedFinalTranscript(
  h: Harness,
  segments: Array<{ startMs: number; endMs: number; text: string }>,
): { recordingId: string; revisionId: string } {
  const recordingId = randomUUID();
  const revisionId = randomUUID();
  const now = Date.now();
  h.db.sqlite
    .prepare(
      `INSERT INTO recordings
         (id, created_at, source_device, duration_ms, sample_rate, channels,
          audio_path, audio_checksum, status)
       VALUES (?, ?, NULL, 60000, 16000, 1, NULL, NULL, 'ready')`,
    )
    .run(recordingId, now);
  insertTranscriptRevision(h.db.sqlite, {
    id: revisionId,
    recordingId,
    kind: 'final',
    providerId: 'seed',
    model: 'seed-v1',
    languageHints: JSON.stringify(['zh']),
    isCurrent: true,
    createdAt: now,
  });
  segments.forEach((seg, idx) => {
    insertSegment(h.db.sqlite, {
      id: randomUUID(),
      revisionId,
      idx,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text,
      speaker: null,
      confidence: 0.98,
    });
  });
  return { recordingId, revisionId };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SEGMENTS = [
  { startMs: 0, endMs: 1_800, text: '我们需要支持后台录音，锁屏也要持续录制。' },
  { startMs: 1_800, endMs: 3_600, text: 'RAG 检索用 sqlite-vec 加 FTS5 做混合检索。' },
];

test('M7 bilingual: projection exists, sidecar matches, original+EN lines, idempotent re-run', async () => {
  const h = await harness('m7-bilingual');
  try {
    const { recordingId, revisionId } = seedFinalTranscript(h, SEGMENTS);
    const deps = {
      sqlite: h.db.sqlite,
      dataDir: h.dataDir,
      model: createMockModelProvider(MOCK_MODEL_ID),
      modelName: MOCK_MODEL_ID,
    };

    const outcome = await writeBilingualTranscript(deps, recordingId);
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.translated, 2);
    const path = join(h.dataDir, 'recordings', recordingId, 'transcript.bilingual.md');
    assert.equal(outcome.path, path);
    assert.ok(existsSync(path));

    // .sha256 sidecar matches the bytes.
    const sidecar = `${path}.sha256`;
    assert.ok(existsSync(sidecar));
    assert.equal(readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0], sha256File(path));
    assert.equal(outcome.sha256, sha256File(path));

    // Content: header notes it is derived; each segment has original + EN line.
    const md = readFileSync(path, 'utf8');
    assert.ok(md.includes('# Bilingual Transcript (中英对照)'));
    assert.ok(md.includes('remain truth'), 'header states rows remain truth');
    assert.ok(md.includes('replaces it'), 'header states re-run replaces');
    for (const seg of SEGMENTS) {
      assert.ok(md.includes(seg.text), 'original line present');
      const enLine = md
        .split('\n')
        .find((l) => l.startsWith('  EN: [en] ') && l.endsWith(seg.text));
      assert.ok(enLine !== undefined, `EN rendering for: ${seg.text}`);
    }

    // Events: bilingual.completed on the revision + projection.written on the recording.
    assert.equal(
      listEvents(h.db.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: revisionId,
        type: EVENT_TYPES.BilingualCompleted,
      }).length,
      1,
    );
    const projEvents = listEvents(h.db.sqlite, {
      aggregateType: 'recording',
      aggregateId: recordingId,
      type: EVENT_TYPES.ProjectionWritten,
    });
    assert.ok(
      projEvents.some(
        (e) => (JSON.parse(e.payloadJson) as Record<string, unknown>)['kind'] ===
          'transcript.bilingual',
      ),
    );

    // Idempotent re-run: skipped, file byte-identical, no extra events.
    const shaBefore = sha256File(path);
    const replay = await writeBilingualTranscript(deps, recordingId);
    assert.equal(replay.skipped, true);
    assert.equal(sha256File(path), shaBefore);
    assert.equal(
      listEvents(h.db.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: revisionId,
        type: EVENT_TYPES.BilingualCompleted,
      }).length,
      1,
    );
  } finally {
    await h.cleanup();
  }
});

test('M7 wiring: enrich → bilingual job runs after enrichment (queue-driven)', async () => {
  const h = await harness('m7-bilingual-wiring');
  try {
    const { recordingId, revisionId } = seedFinalTranscript(h, SEGMENTS);
    registerEnrichHandler(h.worker, {
      sqlite: h.db.sqlite,
      dataDir: h.dataDir,
      model: createMockModelProvider(MOCK_MODEL_ID),
      decision: createMockDecisionProvider(),
      modelName: MOCK_MODEL_ID,
      queue: h.queue,
    });
    registerBilingualHandler(h.worker, {
      sqlite: h.db.sqlite,
      dataDir: h.dataDir,
      model: createMockModelProvider(MOCK_MODEL_ID),
      modelName: MOCK_MODEL_ID,
    });
    h.worker.start();

    h.queue.enqueue({
      kind: 'enrich',
      payload: { recordingId, revisionId },
      idempotencyKey: enrichIdempotencyKey(recordingId, revisionId),
    });

    const deadline = Date.now() + 15_000;
    while (
      listEvents(h.db.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: revisionId,
        type: EVENT_TYPES.BilingualCompleted,
      }).length === 0 &&
      Date.now() < deadline
    ) {
      await delay(25);
    }
    assert.equal(
      listEvents(h.db.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: revisionId,
        type: EVENT_TYPES.EnrichCompleted,
      }).length,
      1,
      'enrich completed first',
    );
    assert.equal(
      listEvents(h.db.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: revisionId,
        type: EVENT_TYPES.BilingualCompleted,
      }).length,
      1,
      'bilingual ran after enrich via the queue',
    );
    assert.ok(
      existsSync(join(h.dataDir, 'recordings', recordingId, 'transcript.bilingual.md')),
    );
  } finally {
    await h.cleanup();
  }
});
