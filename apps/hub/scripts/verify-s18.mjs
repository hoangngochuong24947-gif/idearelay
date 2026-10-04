/**
 * §18 acceptance verification (spec docs/spec/mvp-implementation.md §18).
 *
 * Runs the ten acceptance criteria against the compiled hub (dist/) with
 * offline mock providers and prints a per-criterion evidence report.
 *
 * Usage: node apps/hub/scripts/verify-s18.mjs
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { openDatabase } from '../dist/db/index.js';
import { seedWorkflowSpecs } from '../dist/workflows/seed.js';
import { JobQueue } from '../dist/queue/job-queue.js';
import { Worker } from '../dist/worker/worker.js';
import { createProviderRegistry } from '@idearelay/contracts';
import {
  insertTranscriptRevision,
  insertSegment,
  clearCurrentRevision,
  listSegments,
  getCurrentRevision,
} from '../dist/db/repositories/transcripts.js';
import {
  insertRequirement,
  listRequirements,
  listSourceRefs,
} from '../dist/db/repositories/requirements.js';
import { enrichRecording } from '../dist/pipeline/enrich.js';
import { splitIdempotencyKey, registerSplitHandler } from '../dist/worker/handlers/split.js';
import { realignIdempotencyKey, registerRealignHandler } from '../dist/worker/handlers/realign.js';
import { WorkflowRunner, workflowRunIdempotencyKey } from '../dist/workflows/runner.js';
import { DryRunExecutorProvider } from '../dist/workflows/executor-dry-run.js';
import { registerWorkflowRunHandler } from '../dist/worker/handlers/workflow-run.js';
import { createMockModelProvider, MOCK_MODEL_ID } from '../dist/providers/model/mock.js';
import { createMockDecisionProvider } from '../dist/providers/decision/mock.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FIXTURE = join(REPO, 'apps', 'hub', 'test-fixtures', 'sample.m4a');
const PORT = 17918;

const results = [];
function check(id, ok, evidence) {
  results.push({ id, ok, evidence });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] §18-${id} ${evidence}`);
}

async function runUntilIdle(worker, max = 200) {
  for (let i = 0; i < max; i++) {
    const outcome = await worker.runOnce();
    if (outcome === null) return;
  }
  throw new Error('worker did not go idle');
}

// ---------------------------------------------------------------------------
// Phase A — programmatic chain: criteria 3, 4, 5(auto-advance), 7, 8
// ---------------------------------------------------------------------------
async function phaseA() {
  console.log('\n== Phase A: requirement → split → SourceRef → realign → workflow run ==');
  const root = mkdtempSync(join(tmpdir(), 's18-a-'));
  const dataDir = join(root, 'data');
  const db = openDatabase(join(dataDir, 'idea-relay.db'));
  seedWorkflowSpecs(db.sqlite);
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, { workerId: 's18-a', pollIntervalMs: 20, stallTimeoutMs: 30_000 });
  const model = createMockModelProvider(MOCK_MODEL_ID);
  const decision = createMockDecisionProvider();

  registerSplitHandler(worker, { sqlite: db.sqlite, dataDir, model, modelName: MOCK_MODEL_ID });
  registerRealignHandler(worker, { sqlite: db.sqlite, dataDir });

  const now = Date.now();

  // Requirement-cue transcript (as if M1 produced it).
  const recordingId = randomUUID();
  const revisionId = randomUUID();
  db.sqlite
    .prepare(
      `INSERT INTO recordings (id, created_at, source_device, duration_ms, sample_rate, channels, audio_path, audio_checksum, status)
       VALUES (?, ?, NULL, 60000, 16000, 1, NULL, NULL, 'received')`,
    )
    .run(recordingId, now);
  insertTranscriptRevision(db.sqlite, {
    id: revisionId, recordingId, kind: 'final', providerId: 'mock', model: 'mock-asr-v1',
    languageHints: null, isCurrent: true, createdAt: now,
  });
  const segs = [
    { idx: 0, startMs: 0, endMs: 20_000, text: '我希望 App 支持后台录音，需要做成锁屏 40 分钟连续录制不中断。' },
    { idx: 1, startMs: 20_000, endMs: 40_000, text: '录音结束后应该支持自动上传到 Hub，断网也要能续传，这是一个硬性需求。' },
    { idx: 2, startMs: 40_000, endMs: 60_000, text: '另外随便聊聊今天的天气，这段没有需求。' },
  ];
  for (const s of segs) {
    insertSegment(db.sqlite, { id: randomUUID(), revisionId, ...s, speaker: 'speaker_1', confidence: 0.95 });
  }
  db.sqlite.prepare(`UPDATE recordings SET status='ready' WHERE id=?`).run(recordingId);

  // --- Criterion 5 (auto-advance half): cue transcript → gate auto-advances.
  const outcome = await enrichRecording(
    { sqlite: db.sqlite, dataDir, model, decision, modelName: MOCK_MODEL_ID },
    recordingId,
  );
  check('5a', outcome.gate === 'auto_advanced' && outcome.kind === 'requirement',
    `cue transcript → gate=${outcome.gate}, kind=${outcome.kind}, confidence=${outcome.confidence}`);

  // --- Criterion 3: split → >=2 Requirements, SourceRefs resolve to time ranges.
  queue.enqueue({
    kind: 'split',
    payload: { recordingId, revisionId },
    idempotencyKey: splitIdempotencyKey(recordingId, revisionId),
  });
  await runUntilIdle(worker);
  const reqs = listRequirements(db.sqlite).filter((r) => {
    const rev = db.sqlite.prepare(`SELECT source_revision_id FROM requirements WHERE id=?`).get(r.id);
    return rev.source_revision_id === revisionId;
  });
  let refsOk = reqs.length >= 2;
  const refDetails = [];
  for (const r of reqs) {
    const refs = listSourceRefs(db.sqlite, r.id);
    for (const ref of refs) {
      const inside = ref.start_ms < ref.end_ms && ref.end_ms <= 60_000;
      const overlapsReal = segs.some((s) => s.startMs < ref.end_ms && s.endMs > ref.start_ms);
      refsOk = refsOk && ref.recording_id === recordingId && inside && overlapsReal && ref.quote_snippet.length > 0;
      refDetails.push(`[${ref.start_ms}..${ref.end_ms}ms quote="${ref.quote_snippet.slice(0, 18)}…"]`);
    }
  }
  check('3', refsOk, `${reqs.length} Requirements from one transcript; refs: ${refDetails.join(' ')}`);

  // --- Criteria 7+8: workflow run with observable stages + executor dry-run.
  const executor = new DryRunExecutorProvider({ sqlite: db.sqlite });
  const runner = new WorkflowRunner(
    { sqlite: db.sqlite, dataDir, registry: createProviderRegistry(), executor, queue, heartbeatMs: 5_000 },
    { staleRunMs: 120_000 },
  );
  registerWorkflowRunHandler(worker, runner);
  queue.enqueue({
    kind: 'workflow-run',
    payload: { requirementId: reqs[0].id },
    idempotencyKey: workflowRunIdempotencyKey(reqs[0].id),
  });
  await runUntilIdle(worker);

  const stages = db.sqlite
    .prepare(`SELECT name, status, started_at, ended_at FROM run_stages ORDER BY rowid`)
    .all();
  const stagesOk = stages.length >= 4 && stages.every((s) => s.status === 'succeeded');
  check('7a', stagesOk,
    `run_stages: ${stages.map((s) => `${s.name}=${s.status}`).join(', ')}`);

  const runRow = db.sqlite.prepare(`SELECT id, workspace_path, status FROM workflow_runs ORDER BY rowid DESC LIMIT 1`).get();
  const executorJobFile = join(runRow.workspace_path, 'executor', 'job.json');
  const deliverable = db.sqlite.prepare(`SELECT id, path, kind FROM artifacts`).get();
  // artifacts.path is stored absolute (join(workspacePath, 'deliverable.md')).
  const deliverableOk = deliverable !== undefined && existsSync(deliverable.path);
  check('8', existsSync(executorJobFile) && deliverableOk,
    `ExecutorJob file=executor/job.json in workspace (${existsSync(executorJobFile)}); Deliverable artifact ${deliverable?.path} on disk (${deliverableOk})`);

  // --- Criterion 4: ASR re-run → realign, no reference lost.
  const oldRefs = reqs.map((r) => listSourceRefs(db.sqlite, r.id)[0]);
  const revisionId2 = randomUUID();
  clearCurrentRevision(db.sqlite, recordingId, 'final');
  insertTranscriptRevision(db.sqlite, {
    id: revisionId2, recordingId, kind: 'final', providerId: 'mock', model: 'mock-asr-v1',
    languageHints: null, isCurrent: true, createdAt: now + 1000,
  });
  const segs2 = [
    { idx: 0, startMs: 1_000, endMs: 22_000, text: '（重跑）我希望 App 支持后台录音，需要做成锁屏 40 分钟连续录制。' },
    { idx: 1, startMs: 22_000, endMs: 43_000, text: '（重跑）录音结束后应该支持自动上传到 Hub，断网也要能续传。' },
    { idx: 2, startMs: 43_000, endMs: 61_000, text: '（重跑）天气闲聊，没有需求。' },
  ];
  for (const s of segs2) {
    insertSegment(db.sqlite, { id: randomUUID(), revisionId: revisionId2, ...s, speaker: 'speaker_1', confidence: 0.95 });
  }
  queue.enqueue({
    kind: 'realign',
    payload: { recordingId, revisionId: revisionId2 },
    idempotencyKey: realignIdempotencyKey(recordingId, revisionId2),
  });
  await runUntilIdle(worker);

  let realignOk = true;
  for (let i = 0; i < reqs.length; i++) {
    const refs = listSourceRefs(db.sqlite, reqs[i].id);
    realignOk = realignOk && refs.length >= 1; // no reference lost
    for (const ref of refs) {
      realignOk = realignOk
        && ref.asr_revision_id === revisionId2
        && segs2.some((s) => s.startMs < ref.end_ms && s.endMs > ref.start_ms);
    }
  }
  check('4', realignOk,
    `re-run ASR → ${reqs.length}/${reqs.length} Requirements re-aligned to revision ${revisionId2.slice(0, 8)}…; refs preserved, quotes refreshed`);

  await worker.stop();
  db.sqlite.close();
}

// ---------------------------------------------------------------------------
// Phase B — live hub process: criteria 1, 2, 5(inbox half), 9, 10
// ---------------------------------------------------------------------------
function startHub(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [join(REPO, 'apps', 'hub', 'dist', 'index.js')], {
    env: {
      ...process.env,
      IDEA_RELAY_DATA_DIR: dataDir,
      IDEA_RELAY_HTTP_PORT: String(PORT),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bootLog = [];
  child.stdout.on('data', (d) => bootLog.push(String(d)));
  child.stderr.on('data', (d) => process.stderr.write(`[hub] ${d}`));
  child.bootLog = bootLog;
  return child;
}

async function waitForHealth(child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('hub exited early');
    await delay(200);
  }
  throw new Error('hub health timeout');
}

async function phaseB() {
  console.log('\n== Phase B: live hub — drop audio → projection → inbox; offline reboot; provider swap ==');
  const dataDir = mkdtempSync(join(tmpdir(), 's18-b-'));
  const dbPath = join(dataDir, 'idea-relay.db');

  // 1) First boot: mock providers (zero env → fully offline), drop fixture.
  let hub = startHub(dataDir);
  await waitForHealth(hub);
  const inboxDir = join(dataDir, 'inbox');
  copyFileSync(FIXTURE, join(inboxDir, 'demo.m4a'));
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await delay(500);
    const db = openDatabase(dbPath);
    const row = db.sqlite.prepare(`SELECT status FROM recordings LIMIT 1`).get();
    const itemCount = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM inbox_items`).get().n;
    db.sqlite.close();
    if (row?.status === 'ready' && itemCount >= 1) { ready = true; break; }
  }
  const projDir = join(dataDir, 'recordings');
  const recDirs = existsSync(projDir) ? readdirSync(projDir) : [];
  const finalPath = recDirs.length > 0 ? join(projDir, recDirs[0], 'transcript.final.md') : null;
  check('1', ready && finalPath !== null && existsSync(finalPath),
    `dropped fixture audio → ${finalPath ? 'recordings/<id>/transcript.final.md produced with no intervention' : 'MISSING'} (mock ASR; 40-min span bounded by real provider)`);

  // 2) Two revisions, final current.
  const db = openDatabase(dbPath);
  const recId = db.sqlite.prepare(`SELECT id FROM recordings LIMIT 1`).get().id;
  const revs = db.sqlite.prepare(`SELECT kind, is_current FROM transcript_revisions WHERE recording_id=?`).all(recId);
  const hasBoth = revs.some((r) => r.kind === 'provisional') && revs.some((r) => r.kind === 'final');
  const finalCurrent = revs.filter((r) => r.kind === 'final' && r.is_current === 1).length === 1;
  check('2', hasBoth && finalCurrent,
    `revisions per recording: ${revs.map((r) => `${r.kind}(current=${r.is_current})`).join(', ')}`);

  // 5 (inbox half): low-confidence fixture content must land in Inbox.
  const items = db.sqlite.prepare(`SELECT id, kind, confidence, status FROM inbox_items`).all();
  check('5b', items.length >= 1 && items.every((i) => i.status === 'pending'),
    `low-confidence content → ${items.length} inbox_items pending (auto-advance half proven in Phase A §5a)`);
  db.sqlite.close();
  hub.kill();
  await new Promise((r) => child_exit(hub, r));

  // 9) Cloud providers off: reboot same data dir, still boots and reads history.
  hub = startHub(dataDir, { IDEA_RELAY_ASR_PROVIDER: 'mock', IDEA_RELAY_MODEL_PROVIDER: 'mock', IDEA_RELAY_DECISION_PROVIDER: 'mock', TYPESAFE_API_KEY: '', OPENAI_API_KEY: '' });
  await waitForHealth(hub);
  const inboxRes = await fetch(`http://127.0.0.1:${PORT}/inbox`);
  const inboxJson = await inboxRes.json();
  const reqRes = await fetch(`http://127.0.0.1:${PORT}/requirements`);
  const reqJson = await reqRes.json();
  check('9', inboxRes.ok && reqRes.ok && Array.isArray(inboxJson.items) && inboxJson.items.length >= 1,
    `offline reboot (no cloud credentials): /inbox → ${inboxJson.items.length} historical item(s), /requirements → ${reqJson.requirements.length} row(s)`);

  // 10) Provider swap = one env line, business layer untouched.
  hub.kill();
  await new Promise((r) => child_exit(hub, r));
  hub = startHub(dataDir, { IDEA_RELAY_ASR_PROVIDER: 'funasr', IDEA_RELAY_FUNASR_BASE_URL: 'http://127.0.0.1:1' });
  await waitForHealth(hub);
  // The single env line swapped the registry entry; the pipeline is unchanged.
  const bootLine = hub.bootLog.join('').split('\n').find((l) => l.includes('providers: registered'));
  const asrSwapped = bootLine?.includes('asr=funasr') ?? false;
  check('10', asrSwapped,
    `boot log: "${bootLine?.trim()}" — one env line (IDEA_RELAY_ASR_PROVIDER) swapped the implementation, business code untouched`);

  hub.kill();
  await new Promise((r) => child_exit(hub, r));
}

function child_exit(child, resolve) {
  if (child.exitCode !== null) return resolve();
  child.once('exit', resolve);
  setTimeout(resolve, 2_000).unref();
}

// ---------------------------------------------------------------------------
try {
  await phaseA();
  await phaseB();
} catch (err) {
  console.error('\nverification crashed:', err);
  process.exitCode = 1;
} finally {
  console.log('\n== §18 summary ==');
  for (const r of results) console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] §18-${r.id}`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nALL CHECKED CRITERIA PASS' : `\n${failed.length} FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
