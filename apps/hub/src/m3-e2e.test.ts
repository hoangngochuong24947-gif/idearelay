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
  getRequirement,
  listRequirements,
  listRequirementsBySourceRevision,
  listSourceRefs,
} from './db/repositories/requirements.js';
import {
  clearCurrentRevision,
  insertSegment,
  insertTranscriptRevision,
  listSegments,
} from './db/repositories/transcripts.js';
import { realignRequirements } from './pipeline/realign.js';
import {
  buildSplitPrompt,
  parseSplitCompletion,
  splitRequirements,
  type SplitDeps,
} from './pipeline/split.js';
import { createMockDecisionProvider } from './providers/decision/mock.js';
import {
  createMockModelProvider,
  MOCK_MODEL_ID,
  type MockSplitFixtureEntry,
} from './providers/model/mock.js';
import { JobQueue } from './queue/job-queue.js';
import { requirementBodyPath, requirementSlug } from './projections/requirement.js';
import { enrichIdempotencyKey } from './worker/handlers/enrich.js';
import {
  realignIdempotencyKey,
  registerRealignHandler,
} from './worker/handlers/realign.js';
import { registerEnrichHandler } from './worker/handlers/enrich.js';
import { registerSplitHandler } from './worker/handlers/split.js';
import { Worker } from './worker/worker.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  root: string;
  dataDir: string;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  cleanup(): Promise<void>;
}

async function harness(workerId: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m3-'));
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

interface SeedSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** Seed a Final transcript (as if M1 produced it). */
function seedFinalTranscript(
  h: Harness,
  segments: SeedSegment[],
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

/** Simulate an ASR re-run: a NEW current final revision with shifted/reworded segments. */
function rerunAsr(h: Harness, recordingId: string, segments: SeedSegment[]): string {
  const revisionId = randomUUID();
  clearCurrentRevision(h.db.sqlite, recordingId, 'final');
  insertTranscriptRevision(h.db.sqlite, {
    id: revisionId,
    recordingId,
    kind: 'final',
    providerId: 'seed',
    model: 'seed-v2',
    languageHints: JSON.stringify(['zh']),
    isCurrent: true,
    createdAt: Date.now(),
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
  return revisionId;
}

function splitDeps(h: Harness, fixture: readonly MockSplitFixtureEntry[]): SplitDeps {
  return {
    sqlite: h.db.sqlite,
    dataDir: h.dataDir,
    model: createMockModelProvider(MOCK_MODEL_ID, { splitFixture: fixture }),
    modelName: MOCK_MODEL_ID,
  };
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

function createdEventCount(sqlite: Db['sqlite'], requirementId: string): number {
  return listEvents(sqlite, {
    aggregateType: 'requirement',
    aggregateId: requirementId,
    type: EVENT_TYPES.RequirementCreated,
  }).length;
}

// ---------------------------------------------------------------------------
// R1: 40-min-style transcript, three topical segments (App / RAG / 日志闲聊).
// ---------------------------------------------------------------------------

const R1_SEGMENTS: SeedSegment[] = [
  { startMs: 0, endMs: 1_800, text: '我们需要支持后台录音，锁屏的时候也要持续录制，这是核心需求。' },
  { startMs: 1_800, endMs: 3_600, text: 'RAG 检索这块要用 sqlite-vec 加 FTS5 做混合检索。' },
  { startMs: 3_600, endMs: 5_400, text: '今天天气不错，出去走了一圈，顺便记录一下。' },
];

const SPLIT_FIXTURE: MockSplitFixtureEntry[] = [
  {
    title: 'Background recording support',
    body: '支持后台录音：锁屏时持续录制不中断。',
    startMs: 0,
    endMs: 1_800,
  },
  {
    title: '需求溯源与混合锚点',
    body: '用 sqlite-vec 加 FTS5 实现混合检索。',
    startMs: 1_800,
    endMs: 3_600,
  },
];

test('M3 e2e: split → hybrid anchors → projection → ASR re-run realignment', async () => {
  const h = await harness('m3-main');
  try {
    const { recordingId, revisionId: r1 } = seedFinalTranscript(h, R1_SEGMENTS);

    // ------------------------------------------------------------------
    // (a) one transcript → ≥2 Requirements.
    // ------------------------------------------------------------------
    const outcome = await splitRequirements(splitDeps(h, SPLIT_FIXTURE), recordingId, r1);
    assert.equal(outcome.skipped, false);
    assert.ok(outcome.requirementIds.length >= 2, 'at least 2 requirements');
    const reqRows = listRequirements(h.db.sqlite);
    assert.equal(reqRows.length, outcome.requirementIds.length);
    for (const row of reqRows) {
      assert.equal(row.status, 'draft');
      assert.equal(row.source_revision_id, r1);
      assert.equal(
        row.body_path,
        requirementBodyPath(row.id, row.title),
        'body_path follows the deterministic naming rule',
      );
    }

    // Slug rule: ASCII title → slugified; pure-Chinese title → sha256(title)[0:8].
    const asciiRow = reqRows.find((r) => r.title === 'Background recording support');
    const zhRow = reqRows.find((r) => r.title === '需求溯源与混合锚点');
    assert.ok(asciiRow !== undefined && zhRow !== undefined);
    assert.ok(asciiRow.body_path?.includes('-background-recording-support.md'));
    assert.ok(
      zhRow.body_path?.includes(`-${requirementSlug('需求溯源与混合锚点')}.md`),
      'chinese title falls back to a stable hash slug',
    );
    assert.equal(requirementSlug('需求溯源与混合锚点').length, 8);

    // ------------------------------------------------------------------
    // (b) each SourceRef resolves back to a real [start_ms, end_ms] interval.
    // ------------------------------------------------------------------
    const segments1 = listSegments(h.db.sqlite, r1);
    const texts1 = segments1.map((s) => s.text);
    // Canonical joined text: segment texts joined by '\n' — offsets are exact.
    const offsets1 = [0];
    for (let i = 0; i < texts1.length - 1; i += 1) {
      offsets1.push(offsets1[i] + texts1[i].length + 1);
    }

    const refsByReq = new Map(reqRows.map((r) => [r.id, listSourceRefs(h.db.sqlite, r.id)]));
    for (const [reqId, refs] of refsByReq) {
      assert.equal(refs.length, 1, 'one ref per requirement in this fixture');
      const ref = refs[0];
      assert.equal(ref.requirement_id, reqId);
      // The interval must sit inside the transcript span and overlap a real segment.
      assert.ok(ref.start_ms < ref.end_ms, 'non-empty interval');
      assert.ok(
        segments1.some((s) => s.start_ms < ref.end_ms && s.end_ms > ref.start_ms),
        `ref [${ref.start_ms}, ${ref.end_ms}] overlaps a real segment`,
      );
      assert.equal(ref.char_start !== null && ref.char_end !== null, true);
      assert.ok(ref.char_end! > ref.char_start!, 'non-empty char range');
      assert.ok(ref.quote_snippet.length > 0, 'quote snapshot present');
    }
    const refAscii = refsByReq.get(asciiRow.id)![0];
    const refZh = refsByReq.get(zhRow.id)![0];
    assert.deepEqual([refAscii.start_ms, refAscii.end_ms], [0, 1_800]);
    assert.deepEqual([refZh.start_ms, refZh.end_ms], [1_800, 3_600]);
    // char offsets resolve exactly into the canonical joined text.
    assert.deepEqual([refAscii.char_start, refAscii.char_end], [offsets1[0], offsets1[0] + texts1[0].length]);
    assert.deepEqual([refZh.char_start, refZh.char_end], [offsets1[1], offsets1[1] + texts1[1].length]);
    assert.equal(refAscii.asr_revision_id, r1);
    assert.equal(refAscii.quote_snippet, texts1[0], 'quote is the real transcript text');
    assert.equal(refZh.quote_snippet, texts1[1]);

    // ------------------------------------------------------------------
    // (c) shared background is not lost: same recording_id, distinct intervals.
    // ------------------------------------------------------------------
    assert.equal(refAscii.recording_id, recordingId);
    assert.equal(refZh.recording_id, recordingId);
    assert.notDeepEqual(
      [refAscii.start_ms, refAscii.end_ms],
      [refZh.start_ms, refZh.end_ms],
      'distinct time intervals per requirement',
    );

    // Events: requirement.created + projection.written per requirement.
    for (const row of reqRows) {
      assert.equal(createdEventCount(h.db.sqlite, row.id), 1);
    }
    const projEvents = listEvents(h.db.sqlite, { type: EVENT_TYPES.ProjectionWritten });
    assert.equal(
      projEvents.filter((e) => e.aggregateType === 'requirement').length,
      reqRows.length,
    );

    // ------------------------------------------------------------------
    // (d) projection md + .sha256 exist and contain body + quote.
    // ------------------------------------------------------------------
    for (const row of reqRows) {
      const path = join(h.dataDir, row.body_path ?? '');
      assertSidecar(path);
      const md = readFileSync(path, 'utf8');
      assert.ok(md.includes(`# Requirement: ${row.title}`));
      const refs = refsByReq.get(row.id)!;
      for (const ref of refs) {
        assert.ok(md.includes(ref.quote_snippet), 'md contains the quote snippet');
      }
      assert.ok(md.includes('## Source anchors'));
      assert.ok(md.includes(recordingId), 'md names the recording');
    }

    // Idempotent: splitting the same revision again is a no-op.
    const replay = await splitRequirements(splitDeps(h, SPLIT_FIXTURE), recordingId, r1);
    assert.equal(replay.skipped, true);
    assert.equal(listRequirements(h.db.sqlite).length, reqRows.length);
    for (const row of reqRows) {
      assert.equal(createdEventCount(h.db.sqlite, row.id), 1);
    }

    // ------------------------------------------------------------------
    // (e) ASR re-run → new final revision with SHIFTED + REWORDED segments;
    //     existing Requirements re-align automatically, no reference lost.
    // ------------------------------------------------------------------
    const R2_SEGMENTS: SeedSegment[] = [
      { startMs: 1_000, endMs: 2_800, text: '后台录音核心需求确认（精转修正）：锁屏持续录制不中断。' },
      { startMs: 2_800, endMs: 4_600, text: 'RAG 检索改为混合检索方案（精转修正）。' },
      { startMs: 4_600, endMs: 6_400, text: '散步日记段落（精转修正）。' },
    ];
    const r2 = rerunAsr(h, recordingId, R2_SEGMENTS);

    // Realign through the JOB QUEUE to prove the handler wiring as well.
    registerRealignHandler(h.worker, { sqlite: h.db.sqlite, dataDir: h.dataDir });
    h.worker.start();
    h.queue.enqueue({
      kind: 'realign',
      payload: { recordingId, revisionId: r2 },
      idempotencyKey: realignIdempotencyKey(recordingId, r2),
    });
    await waitFor(
      () =>
        listEvents(h.db.sqlite, { type: EVENT_TYPES.RequirementRealigned }).length ===
        reqRows.length,
    );

    const segments2 = listSegments(h.db.sqlite, r2);
    const texts2 = segments2.map((s) => s.text);
    const offsets2 = [0];
    for (let i = 0; i < texts2.length - 1; i += 1) {
      offsets2.push(offsets2[i] + texts2[i].length + 1);
    }

    // The primary anchor never moves; only secondary fields refresh.
    const refAscii2 = listSourceRefs(h.db.sqlite, asciiRow.id)[0];
    const refZh2 = listSourceRefs(h.db.sqlite, zhRow.id)[0];
    assert.deepEqual([refAscii2.start_ms, refAscii2.end_ms], [0, 1_800], 'primary anchor intact');
    assert.deepEqual([refZh2.start_ms, refZh2.end_ms], [1_800, 3_600], 'primary anchor intact');
    assert.equal(refAscii2.asr_revision_id, r2, 'asr_revision_id refreshed');
    assert.equal(refZh2.asr_revision_id, r2);
    // Still resolves into a real segment of the NEW revision (shifted times).
    for (const ref of [refAscii2, refZh2]) {
      assert.ok(
        segments2.some((s) => s.start_ms < ref.end_ms && s.end_ms > ref.start_ms),
        'realigned ref still overlaps a real segment',
      );
    }
    // char offsets + quote recomputed from the new segments by time overlap.
    assert.deepEqual(
      [refAscii2.char_start, refAscii2.char_end],
      [offsets2[0], offsets2[0] + texts2[0].length],
    );
    // refZh [1800,3600] now overlaps BOTH new segments [1000,2800] and [2800,4600].
    assert.deepEqual(
      [refZh2.char_start, refZh2.char_end],
      [offsets2[0], offsets2[1] + texts2[1].length],
    );
    assert.equal(refAscii2.quote_snippet, texts2[0]);
    assert.equal(refZh2.quote_snippet, `${texts2[0]} ${texts2[1]}`);

    // No reference lost: still exactly 2 requirements, same recording.
    assert.equal(listRequirements(h.db.sqlite).length, reqRows.length);
    assert.equal(refAscii2.recording_id, recordingId);
    assert.equal(refZh2.recording_id, recordingId);
    // source_revision_id keeps pointing at the generating revision.
    assert.equal(getRequirement(h.db.sqlite, asciiRow.id)?.source_revision_id, r1);

    // Projection re-rendered: contains the NEW quote, sidecar matches.
    const mdPath2 = join(h.dataDir, asciiRow.body_path ?? '');
    assertSidecar(mdPath2);
    const md2 = readFileSync(mdPath2, 'utf8');
    assert.ok(md2.includes(refAscii2.quote_snippet), 'md carries the realigned quote');
    assert.ok(!md2.includes(texts1[0]), 'stale quote is gone');

    // Idempotent: a second realign run against r2 changes nothing.
    const again = realignRequirements(
      { sqlite: h.db.sqlite, dataDir: h.dataDir },
      recordingId,
      r2,
    );
    assert.equal(again.realigned, 0);
    assert.equal(
      listEvents(h.db.sqlite, { type: EVENT_TYPES.RequirementRealigned }).length,
      reqRows.length,
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Wiring: enrich auto-advanced `requirement` → idempotent split job; other
// kinds never split. Split output is parsed tolerantly (fenced JSON, etc.).
// ---------------------------------------------------------------------------

test('M3 wiring: gate → split job; on-demand split; tolerant parse', async () => {
  const h = await harness('m3-wiring');
  try {
    const fixture: MockSplitFixtureEntry[] = [
      { title: 'Part one', body: '第一部分。', startMs: 0, endMs: 2_500 },
      { title: '第二部分', body: '第二部分。', startMs: 2_500, endMs: 5_000 },
    ];
    const deps = splitDeps(h, fixture);
    registerSplitHandler(h.worker, deps);
    registerEnrichHandler(h.worker, {
      sqlite: h.db.sqlite,
      dataDir: h.dataDir,
      model: createMockModelProvider(MOCK_MODEL_ID),
      decision: createMockDecisionProvider(),
      modelName: MOCK_MODEL_ID,
      queue: h.queue,
    });
    h.worker.start();

    // A requirement-cue transcript: gate auto-advances → split job runs.
    const A = seedFinalTranscript(h, [
      { startMs: 0, endMs: 5_000, text: '我们需要支持后台录音的技术方案，这是核心需求，应该优先实现。' },
    ]);
    h.queue.enqueue({
      kind: 'enrich',
      payload: { recordingId: A.recordingId, revisionId: A.revisionId },
      idempotencyKey: enrichIdempotencyKey(A.recordingId, A.revisionId),
    });
    await waitFor(
      () => listRequirementsBySourceRevision(h.db.sqlite, A.revisionId).length >= 2,
    );
    const reqsA = listRequirementsBySourceRevision(h.db.sqlite, A.revisionId);
    assert.equal(reqsA.length, 2);

    // A log-cue transcript: auto-advances as `log` → must NOT split.
    const B = seedFinalTranscript(h, [
      { startMs: 0, endMs: 5_000, text: '今天天气不错，记录一下散步。' },
    ]);
    h.queue.enqueue({
      kind: 'enrich',
      payload: { recordingId: B.recordingId, revisionId: B.revisionId },
      idempotencyKey: enrichIdempotencyKey(B.recordingId, B.revisionId),
    });
    await waitFor(
      () =>
        listEvents(h.db.sqlite, {
          aggregateType: 'transcript_revision',
          aggregateId: B.revisionId,
          type: EVENT_TYPES.EnrichCompleted,
        }).length === 1,
    );
    assert.equal(
      listRequirementsBySourceRevision(h.db.sqlite, B.revisionId).length,
      0,
      'non-requirement kinds never split',
    );
    const splitJobs = h.db.sqlite
      .prepare("SELECT payload_json FROM jobs WHERE kind = 'split'")
      .all() as Array<{ payload_json: string }>;
    assert.ok(
      splitJobs.every((j) => !(j.payload_json as string).includes(B.revisionId)),
      'no split job for the log-kind revision',
    );

    // Structured-output calls are parseable even when fenced by the model.
    const fenced = JSON.stringify({
      requirements: [{ title: 'T', body: 'B', startMs: 0, endMs: 1 }],
    });
    const parsed = parseSplitCompletion(`\`\`\`json\n${fenced}\n\`\`\``);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].endMs, 1);

    // The prompt carries timed segment JSON (what the mock/real model consumes).
    const prompt = buildSplitPrompt([
      { idx: 0, start_ms: 0, end_ms: 1_800, text: 'x' },
    ]);
    assert.ok(prompt.includes('"startMs":0'));
    assert.ok(prompt.includes('<transcript>'));
  } finally {
    await h.cleanup();
  }
});
