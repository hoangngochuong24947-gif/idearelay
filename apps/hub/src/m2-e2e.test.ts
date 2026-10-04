import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import {
  DEFAULT_DECISION_THRESHOLDS,
  EVENT_TYPES,
  type DecisionThresholds,
} from '@idearelay/contracts';
import { openDatabase, type Db } from './db/index.js';
import { listDecisions } from './db/repositories/decisions.js';
import { listEvents } from './db/repositories/events.js';
import { listInboxItems } from './db/repositories/inbox.js';
import { countRecordings, getRecording } from './db/repositories/recordings.js';
import {
  getCurrentRevision,
  insertSegment,
  insertTranscriptRevision,
} from './db/repositories/transcripts.js';
import { enrichRecording, type EnrichDeps } from './pipeline/enrich.js';
import { createMockAsrProvider } from './providers/asr/mock.js';
import { createMockDecisionProvider } from './providers/decision/mock.js';
import { createMockModelProvider, MOCK_MODEL_ID } from './providers/model/mock.js';
import { JobQueue } from './queue/job-queue.js';
import { registerEnrichHandler, enrichIdempotencyKey } from './worker/handlers/enrich.js';
import { registerTranscribeHandler } from './worker/handlers/transcribe.js';
import { Worker } from './worker/worker.js';
import { createIntake } from './watcher/intake.js';
import { startWatcher, type WatcherHandle } from './watcher/watcher.js';

const FIXTURE = fileURLToPath(new URL('../test-fixtures/sample.m4a', import.meta.url));

/** A transcript that clearly reads as a requirement and mentions 技术 (tag: tech). */
const CLEAR_REQUIREMENT_TEXT =
  '我们需要支持后台录音的技术方案，这是核心需求，应该优先实现。';

const GATE: DecisionThresholds = { ...DEFAULT_DECISION_THRESHOLDS };

interface Harness {
  root: string;
  dataDir: string;
  inboxDir: string;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  watcher: WatcherHandle;
  decision: ReturnType<typeof createMockDecisionProvider>;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m2-'));
  const dataDir = join(root, 'data');
  const inboxDir = join(dataDir, 'inbox');

  const db = openDatabase(join(dataDir, 'idea-relay.db'));
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, {
    workerId: 'm2-test',
    pollIntervalMs: 20,
    stallTimeoutMs: 30_000,
  });
  const decision = createMockDecisionProvider();
  const model = createMockModelProvider();

  registerTranscribeHandler(worker, {
    sqlite: db.sqlite,
    dataDir,
    asr: createMockAsrProvider(),
    transcribeOpts: { languageHints: ['zh'], hotwords: [] },
    queue,
  });
  registerEnrichHandler(worker, {
    sqlite: db.sqlite,
    dataDir,
    model,
    decision,
    modelName: MOCK_MODEL_ID,
    thresholds: GATE,
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
    decision,
    async cleanup(): Promise<void> {
      await worker.stop();
      await watcher.stop();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Simulate a mobile upload: land a `.part`, then atomically `mv` it. */
async function dropFinalized(h: Harness): Promise<void> {
  const partPath = join(h.inboxDir, 'sample.m4a.part');
  copyFileSync(FIXTURE, partPath);
  await delay(50);
  renameSync(partPath, join(h.inboxDir, 'sample.m4a'));
}

function enrichDeps(
  h: Harness,
  overrides: {
    decision?: ReturnType<typeof createMockDecisionProvider>;
    thresholdOverrides?: EnrichDeps['thresholdOverrides'];
  } = {},
): EnrichDeps {
  return {
    sqlite: h.db.sqlite,
    dataDir: h.dataDir,
    model: createMockModelProvider(),
    decision: overrides.decision ?? h.decision,
    modelName: MOCK_MODEL_ID,
    thresholds: GATE,
    thresholdOverrides: overrides.thresholdOverrides,
  };
}

/** Seed a Final transcript (as if M1 produced it) to drive the enrich stage. */
function seedFinalTranscript(
  h: Harness,
  text: string,
): { recordingId: string; revisionId: string } {
  const recordingId = randomUUID();
  const revisionId = randomUUID();
  const now = Date.now();
  h.db.sqlite
    .prepare(
      `INSERT INTO recordings
         (id, created_at, source_device, duration_ms, sample_rate, channels,
          audio_path, audio_checksum, status)
       VALUES (?, ?, NULL, 5000, 16000, 1, NULL, NULL, 'ready')`,
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
  insertSegment(h.db.sqlite, {
    id: randomUUID(),
    revisionId,
    idx: 0,
    startMs: 0,
    endMs: 5000,
    text,
    speaker: null,
    confidence: 0.99,
  });
  return { recordingId, revisionId };
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

function assertSidecar(path: string): void {
  const sidecar = `${path}.sha256`;
  assert.ok(existsSync(path), `projection exists: ${path}`);
  assert.ok(existsSync(sidecar), `sidecar exists: ${sidecar}`);
  const recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
  assert.equal(recorded, sha256File(path), `sidecar matches bytes: ${path}`);
}

function enrichCompletedCount(sqlite: Db['sqlite'], revisionId: string): number {
  return listEvents(sqlite, {
    aggregateType: 'transcript_revision',
    aggregateId: revisionId,
    type: EVENT_TYPES.EnrichCompleted,
  }).length;
}

test('M2 e2e: gate routes low confidence to Inbox, high confidence auto-advances', async () => {
  const h = await harness();
  try {
    // ------------------------------------------------------------------
    // Part A — full chain: mock ASR text carries no cue → low confidence →
    // Inbox. Proves transcribe enqueues enrich and the gate writes a row.
    // ------------------------------------------------------------------
    await dropFinalized(h);
    await waitFor(() => listInboxItems(h.db.sqlite, { status: 'pending' }).length === 1);
    await waitFor(() => h.queue.countByStatus().succeeded >= 2);

    const recA = getRecording(
      h.db.sqlite,
      (
        h.db.sqlite.prepare('SELECT id FROM recordings LIMIT 1').get() as {
          id: string;
        }
      ).id,
    );
    assert.ok(recA !== null && recA.status === 'ready');
    const finalA = getCurrentRevision(h.db.sqlite, recA.id, 'final');
    assert.ok(finalA !== null);

    // (b) ambiguous transcript → exactly one pending InboxItem.
    const inboxA = listInboxItems(h.db.sqlite, { status: 'pending' });
    assert.equal(inboxA.length, 1, 'one pending InboxItem');
    const item = inboxA[0];
    assert.equal(item.subject_id, finalA.id);
    assert.equal(item.status, 'pending');
    assert.equal(item.kind, 'unknown');
    assert.equal(item.abstained, 0);
    assert.ok(item.confidence !== null && item.confidence < GATE.high);
    const payload = JSON.parse(item.payload_json ?? '{}') as Record<string, unknown>;
    assert.equal(payload.recordingId, recA.id);
    assert.equal(payload.kind, 'unknown');
    assert.ok(Array.isArray(payload.segments));
    assert.equal(typeof payload.summary, 'string');
    assert.ok((payload.summary as string).length > 0);

    // (c) the decisions audit has a row per DecisionProvider call (kind + tags).
    const decisionsA = listDecisions(h.db.sqlite, { subjectId: finalA.id });
    assert.equal(decisionsA.length, 2, 'two audited decisions');
    const kindDecision = decisionsA.find((d) => d.question.includes('类目'));
    assert.ok(kindDecision !== undefined, 'kind classification audited');
    assert.equal(kindDecision.primitive, 'choice');
    assert.equal(kindDecision.provider, 'mock');
    assert.equal(kindDecision.model_version, 'mock-decision-v1');
    assert.equal(kindDecision.confidence, 0.4);
    assert.equal(kindDecision.certainty, 'low');
    assert.ok(kindDecision.options_json !== null);
    assert.deepEqual(JSON.parse(kindDecision.options_json as string), [
      'requirement',
      'idea',
      'log',
      'task',
      'reference',
      'question',
      'unknown',
    ]);
    assert.ok(kindDecision.answer_json !== null);
    assert.equal(kindDecision.subject_type, 'transcript_revision');

    // (d) projections: summary.md + per-InboxItem md, each with a matching sha256.
    const summaryPathA = join(h.dataDir, 'recordings', recA.id, 'summary.md');
    const inboxPathA = join(h.dataDir, 'inbox-items', `${item.id}.md`);
    assertSidecar(summaryPathA);
    assertSidecar(inboxPathA);
    assert.ok(readFileSync(summaryPathA, 'utf8').includes('kind: `unknown`'));

    // events: two decision.recorded, one inbox.item.created, one enrich.completed.
    assert.equal(
      listEvents(h.db.sqlite, { type: EVENT_TYPES.DecisionRecorded }).length,
      2,
    );
    assert.equal(
      listEvents(h.db.sqlite, { type: EVENT_TYPES.InboxItemCreated }).length,
      1,
    );
    assert.equal(enrichCompletedCount(h.db.sqlite, finalA.id), 1);
    const projEventsA = listEvents(h.db.sqlite, { type: EVENT_TYPES.ProjectionWritten });
    const projKindsA = projEventsA.map(
      (e) => (JSON.parse(e.payloadJson) as { kind: string }).kind,
    );
    assert.ok(projKindsA.includes('summary'));
    assert.ok(projKindsA.includes('inbox_item'));

    // ------------------------------------------------------------------
    // (a) high confidence auto-advances: seed a clearly-typed Final transcript.
    // ------------------------------------------------------------------
    const B = seedFinalTranscript(h, CLEAR_REQUIREMENT_TEXT);
    h.queue.enqueue({
      kind: 'enrich',
      payload: { recordingId: B.recordingId, revisionId: B.revisionId },
      idempotencyKey: enrichIdempotencyKey(B.recordingId, B.revisionId),
    });
    await waitFor(() => enrichCompletedCount(h.db.sqlite, B.revisionId) === 1);

    // no InboxItem for the high-confidence revision.
    assert.equal(
      listInboxItems(h.db.sqlite, { subjectId: B.revisionId }).length,
      0,
      'high confidence → no InboxItem',
    );
    const decisionsB = listDecisions(h.db.sqlite, { subjectId: B.revisionId });
    assert.equal(decisionsB.length, 2);
    const kindB = decisionsB.find((d) => d.question.includes('类目'));
    assert.ok(kindB !== undefined);
    assert.equal(kindB.confidence, 0.9);
    assert.equal(kindB.certainty, 'high');
    // auto-advance is recorded as a first-class event + summary projection.
    assert.equal(
      listEvents(h.db.sqlite, {
        aggregateType: 'transcript_revision',
        aggregateId: B.revisionId,
        type: EVENT_TYPES.ItemAutoAccepted,
      }).length,
      1,
      'auto-advance event recorded',
    );
    assertSidecar(join(h.dataDir, 'recordings', B.recordingId, 'summary.md'));

    // idempotent: re-running enrich for the same revision is a no-op.
    const replay = await enrichRecording(enrichDeps(h), B.recordingId, B.revisionId);
    assert.equal(replay.skipped, true);
    assert.equal(listDecisions(h.db.sqlite, { subjectId: B.revisionId }).length, 2);

    // ------------------------------------------------------------------
    // (e) per-call threshold override flips the gate: same 0.9 result, but the
    //     high threshold is raised to 0.95 → Inbox.
    // ------------------------------------------------------------------
    const C = seedFinalTranscript(h, CLEAR_REQUIREMENT_TEXT);
    const outcomeC = await enrichRecording(
      enrichDeps(h, { thresholdOverrides: { high: 0.95 } }),
      C.recordingId,
      C.revisionId,
    );
    assert.equal(outcomeC.gate, 'inbox', 'override raised the bar → Inbox');
    assert.equal(outcomeC.confidence, 0.9);
    const inboxC = listInboxItems(h.db.sqlite, { subjectId: C.revisionId });
    assert.equal(inboxC.length, 1);
    assert.equal(inboxC[0].confidence, 0.9);
    assertSidecar(join(h.dataDir, 'inbox-items', `${inboxC[0].id}.md`));

    // ------------------------------------------------------------------
    // Abstention is first-class: a high-confidence result that abstained still
    // lands in Inbox (confidence ≥ gate, abstained = 1).
    // ------------------------------------------------------------------
    const D = seedFinalTranscript(h, CLEAR_REQUIREMENT_TEXT);
    const outcomeD = await enrichRecording(
      enrichDeps(h, { decision: createMockDecisionProvider({ alwaysAbstain: true }) }),
      D.recordingId,
      D.revisionId,
    );
    assert.equal(outcomeD.abstained, true);
    assert.equal(outcomeD.gate, 'inbox');
    assert.equal(outcomeD.confidence, 0.9, 'abstention is not low confidence');
    const inboxD = listInboxItems(h.db.sqlite, { subjectId: D.revisionId });
    assert.equal(inboxD.length, 1);
    assert.equal(inboxD[0].abstained, 1);

    // The .md projections never re-enter the pipeline as audio.
    assert.equal(countRecordings(h.db.sqlite), 4, 'one recording per seeded/uploaded input');
  } finally {
    await h.cleanup();
  }
});
