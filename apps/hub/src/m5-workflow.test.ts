import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createProviderRegistry,
  EVENT_TYPES,
} from '@idearelay/contracts';
import { openDatabase, type Db } from './db/index.js';
import { appendEvent, listEvents } from './db/repositories/events.js';
import { getRequirement, insertRequirement } from './db/repositories/requirements.js';
import {
  getWorkflowRun,
  listArtifacts,
  listRunStages,
  listWorkflowRuns,
  parseStageDetail,
  updateRunStage,
} from './db/repositories/workflows.js';
import { startHttp } from './http/server.js';
import { createScriptedStreamFn } from './workflows/pi-driver.js';
import { WorkflowRunner } from './workflows/runner.js';
import { seedWorkflowSpecs } from './workflows/seed.js';
import { DryRunExecutorProvider } from './workflows/executor-dry-run.js';
import { JobQueue } from './queue/job-queue.js';
import { registerWorkflowRunHandler } from './worker/handlers/workflow-run.js';
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
  runner: WorkflowRunner;
  executor: DryRunExecutorProvider;
  cleanup(): Promise<void>;
}

function harness(workerId: string): Harness {
  const root = mkdtempSync(join(tmpdir(), 'idearelay-m5-'));
  const dataDir = join(root, 'data');
  const db = openDatabase(join(dataDir, 'idea-relay.db'));
  seedWorkflowSpecs(db.sqlite);
  const queue = new JobQueue(db.sqlite, 5);
  const worker = new Worker(queue, {
    workerId,
    pollIntervalMs: 20,
    stallTimeoutMs: 30_000,
  });
  const executor = new DryRunExecutorProvider({ sqlite: db.sqlite });
  const runner = new WorkflowRunner(
    {
      sqlite: db.sqlite,
      dataDir,
      registry: createProviderRegistry(),
      executor,
      queue,
      heartbeatMs: 5_000,
    },
    { staleRunMs: 120_000 },
  );
  registerWorkflowRunHandler(worker, runner);
  return {
    root,
    dataDir,
    db,
    queue,
    worker,
    runner,
    executor,
    async cleanup(): Promise<void> {
      await worker.stop();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a Requirement that the M2 gate auto-advanced (the M5 run trigger):
 * requirement row + source ref + `requirement.created` +
 * `item.auto_accepted (kind=requirement)` on the source revision.
 */
function seedAutoAdvancedRequirement(
  h: Harness,
  title: string,
  body: string,
): string {
  const requirementId = randomUUID();
  const revisionId = randomUUID();
  const recordingId = randomUUID();
  const now = Date.now();
  h.db.sqlite
    .prepare(
      `INSERT INTO recordings
         (id, created_at, source_device, duration_ms, sample_rate, channels,
          audio_path, audio_checksum, status)
       VALUES (?, ?, NULL, 60000, 16000, 1, NULL, NULL, 'ready')`,
    )
    .run(recordingId, now);
  insertRequirement(h.db.sqlite, {
    id: requirementId,
    title,
    bodyPath: `requirements/${requirementId}-test.md`,
    status: 'draft',
    createdAt: now,
    sourceRevisionId: revisionId,
  });
  h.db.sqlite
    .prepare(
      `INSERT INTO requirement_source_refs
         (requirement_id, recording_id, start_ms, end_ms, char_start, char_end,
          asr_revision_id, quote_snippet)
       VALUES (?, ?, 0, 5000, 0, 10, ?, ?)`,
    )
    .run(requirementId, recordingId, revisionId, body.slice(0, 10));
  appendEvent(h.db.sqlite, {
    aggregateType: 'requirement',
    aggregateId: requirementId,
    type: EVENT_TYPES.RequirementCreated,
    payload: { recordingId, revisionId, title, body },
    createdAt: now,
  });
  appendEvent(h.db.sqlite, {
    aggregateType: 'transcript_revision',
    aggregateId: revisionId,
    type: EVENT_TYPES.ItemAutoAccepted,
    payload: { recordingId, kind: 'requirement', confidence: 0.95, tags: ['product'] },
    createdAt: now,
  });
  return requirementId;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('waitFor: predicate not satisfied before timeout');
}

function stageStartedCounts(h: Harness, runId: string): Record<string, number> {
  const stages = listRunStages(h.db.sqlite, runId);
  const counts: Record<string, number> = {};
  for (const stage of stages) {
    counts[stage.name] = listEvents(h.db.sqlite, {
      aggregateType: 'run_stage',
      aggregateId: stage.id,
      type: EVENT_TYPES.StageStarted,
    }).length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// (a) gate-eligible requirement → run → 4 stages → Deliverable + artifacts
// ---------------------------------------------------------------------------

test('M5 e2e: requirement run executes 4 stages, writes Deliverable + artifact, idempotent', async () => {
  const h = harness('m5-e2e');
  try {
    const requirementId = seedAutoAdvancedRequirement(
      h,
      '后台录音技术方案',
      '支持锁屏后台持续录音，上传可断点续传。',
    );

    // Gate scan (production path): enqueues an idempotent workflow-run job.
    const triggered = h.runner.startPendingRequirementRuns();
    assert.equal(triggered.length, 1);
    h.worker.start();

    let runId = '';
    await waitFor(() => {
      const runs = listWorkflowRuns(h.db.sqlite);
      if (runs.length === 0) return false;
      runId = runs[0].id;
      return getWorkflowRun(h.db.sqlite, runId)?.status === 'succeeded';
    });

    // One run for the subject; the requirement advanced draft → running → done.
    assert.equal(listWorkflowRuns(h.db.sqlite).length, 1);
    assert.equal(getRequirement(h.db.sqlite, requirementId)?.status, 'done');

    // All 4 spec stages recorded, in order, succeeded.
    const stages = listRunStages(h.db.sqlite, runId);
    assert.deepEqual(
      stages.map((s) => s.name),
      ['rag-context', 'scan-oss', 'enrich', 'write'],
    );
    for (const stage of stages) {
      assert.equal(stage.status, 'succeeded');
      assert.ok(stage.started_at !== null && stage.ended_at !== null);
    }

    // The scan-oss agent stage went through the REAL Pi pipeline: the scripted
    // model called github.search and the loop executed it without error.
    const scan = parseStageDetail(stages[1]);
    assert.ok(scan !== null);
    assert.equal(scan.toolCalls.length, 1);
    assert.equal(scan.toolCalls[0].tool, 'github.search');
    assert.equal(scan.toolCalls[0].isError, false);
    assert.match(scan.toolCalls[0].resultText ?? '', /TUSKit/);
    assert.match(
      scan.output ? JSON.stringify(scan.output) : '',
      /dry-run：已通过 github\.search/,
    );

    // Deliverable file + artifacts row + projection.written event.
    const run = getWorkflowRun(h.db.sqlite, runId);
    assert.ok(run?.workspace_path);
    const deliverablePath = join(run!.workspace_path!, 'deliverable.md');
    assert.ok(existsSync(deliverablePath), 'deliverable written into run workspace');
    const md = readFileSync(deliverablePath, 'utf8');
    assert.ok(md.includes('后台录音技术方案'), 'requirement title present');
    assert.ok(md.includes('支持锁屏后台持续录音'), 'requirement body present');
    assert.ok(md.includes('dry-run：已通过 github.search'), 'scan-oss conclusion present');
    assert.ok(md.includes('PRD 草稿'), 'enrich output present');

    const artifacts = listArtifacts(h.db.sqlite, runId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, 'deliverable');
    assert.equal(artifacts[0].path, deliverablePath);
    const projEvents = listEvents(h.db.sqlite, {
      aggregateType: 'workflow_run',
      aggregateId: runId,
      type: EVENT_TYPES.ProjectionWritten,
    });
    assert.equal(projEvents.length, 1);

    // Events: run.started / stage.started×4 / stage.finished×4 / run.finished,
    // with per-aggregate seq 1..n on the run aggregate.
    const runEvents = listEvents(h.db.sqlite, {
      aggregateType: 'workflow_run',
      aggregateId: runId,
    });
    assert.deepEqual(
      runEvents.map((e) => e.type),
      [EVENT_TYPES.RunStarted, EVENT_TYPES.ProjectionWritten, EVENT_TYPES.RunFinished],
    );
    assert.deepEqual(
      runEvents.map((e) => e.seq),
      [1, 2, 3],
    );
    const stageFinished = listEvents(h.db.sqlite, { type: EVENT_TYPES.StageFinished });
    assert.equal(stageFinished.length, 4);

    // ExecutorJob file handoff (§7.7 pull model): written into the workspace.
    const jobFile = join(run!.workspace_path!, 'executor', 'job.json');
    assert.ok(existsSync(jobFile), 'ExecutorJob file exists');
    const job = JSON.parse(readFileSync(jobFile, 'utf8')) as {
      toolWhitelist: string[];
      readAllow: string[];
      deliverablePath: string;
    };
    assert.ok(job.toolWhitelist.includes('github.search'));
    assert.ok(job.readAllow.some((p) => p.includes(requirementId)));

    // Idempotent per subject: gate re-scan enqueues nothing new.
    assert.equal(h.runner.startPendingRequirementRuns().length, 0);
    assert.equal(h.runner.startRunForRequirement(requirementId)?.started, false);
    assert.equal(listWorkflowRuns(h.db.sqlite).length, 1);

    // Executor dry-run rollback (unit): drops the workspace + audit event.
    const rbDir = join(h.root, 'rb-ws');
    mkdirSync(rbDir, { recursive: true });
    writeFileSync(join(rbDir, 'x.txt'), 'x');
    const handle = await h.executor.submit({
      id: 'rb-1',
      requirementId,
      workspacePath: rbDir,
      toolWhitelist: [],
      readAllow: [],
      prompt: 'p',
      deliverablePath: join(rbDir, 'd.md'),
    });
    const status = await h.executor.status(handle);
    assert.equal(status.stage, 'delivered');
    await h.executor.rollback(handle);
    assert.equal(existsSync(rbDir), false, 'workspace dropped');
    assert.ok(
      listEvents(h.db.sqlite, { type: EVENT_TYPES.RunRolledBack }).length >= 1,
      'rollback audited',
    );
    assert.deepEqual(h.executor.capabilities, {
      sandboxed: false,
      toolWhitelist: true,
      rollback: true,
    });
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) failing agent stage (isError) → stage failed → run failed
// ---------------------------------------------------------------------------

test('M5 failure: isError on tool end fails the stage and the run', async () => {
  const h = harness('m5-fail');
  try {
    const requirementId = seedAutoAdvancedRequirement(h, '会失败的需求', '这个 run 会在 scan-oss 失败。');
    const started = h.runner.startRunForRequirement(requirementId);
    assert.ok(started?.started);

    const failing = new WorkflowRunner(
      {
        sqlite: h.db.sqlite,
        dataDir: h.dataDir,
        registry: createProviderRegistry(),
        executor: h.executor,
        toolOverrides: {
          'github.search': {
            name: 'github.search',
            description: 'always fails',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
            async execute() {
              throw new Error('boom: search unavailable');
            },
          },
        },
        streamFnFor: (stage) =>
          createScriptedStreamFn([
            { toolCalls: [{ name: stage.tools[0], args: { query: 'x' } }] },
            // Terminal turn: the agent stops instead of retrying the failing
            // tool forever (a real model is bounded by the heartbeat watchdog).
            { text: '调研失败，无法完成。' },
          ]),
      },
      { staleRunMs: 120_000 },
    );
    registerWorkflowRunHandler(h.worker, failing);

    const outcome = await failing.executeRun(started.runId);
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /boom: search unavailable/);

    const stages = listRunStages(h.db.sqlite, started.runId);
    const byName = new Map(stages.map((s) => [s.name, s]));
    assert.equal(byName.get('rag-context')?.status, 'succeeded');
    assert.equal(byName.get('scan-oss')?.status, 'failed');
    assert.equal(byName.get('enrich')?.status, 'pending');
    assert.equal(byName.get('write')?.status, 'pending');

    const scan = parseStageDetail(byName.get('scan-oss')!);
    assert.ok(scan !== null);
    assert.equal(scan.toolCalls[0].isError, true);
    assert.match(scan.error ?? '', /boom/);

    // run.failed event; requirement back to open; no deliverable.
    const failedEvents = listEvents(h.db.sqlite, {
      aggregateType: 'workflow_run',
      aggregateId: started.runId,
      type: EVENT_TYPES.RunFailed,
    });
    assert.equal(failedEvents.length, 1);
    assert.equal(getRequirement(h.db.sqlite, requirementId)?.status, 'open');
    assert.equal(listArtifacts(h.db.sqlite, started.runId).length, 0);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) stale heartbeat → recovery resumes from last succeeded stage
// ---------------------------------------------------------------------------

test('M5 recovery: stale heartbeat resumes from last successful stage, not from scratch', async () => {
  const h = harness('m5-recover');
  try {
    const requirementId = seedAutoAdvancedRequirement(h, '断点恢复需求', '崩溃后从最后一个成功 stage 续跑。');
    const started = h.runner.startRunForRequirement(requirementId);
    assert.ok(started?.started);

    // "Crash" right after the first stage.
    const partial = await h.runner.executeRun(started.runId, { stopAfterStage: 'rag-context' });
    assert.equal(partial.status, 'running');

    let stages = listRunStages(h.db.sqlite, started.runId);
    assert.equal(stages[0].status, 'succeeded');
    assert.equal(stages[1].status, 'pending');
    const ragStartedAt = stages[0].started_at;

    // Fresh heartbeat → NOT considered stale.
    assert.deepEqual(await h.runner.recoverStaleRuns(600_000), []);

    // Age the heartbeat past the §6 threshold (120s).
    const detail = parseStageDetail(stages[0]);
    assert.ok(detail !== null);
    updateRunStage(h.db.sqlite, stages[0].id, {
      detail: { ...detail, heartbeatAt: Date.now() - 200_000 },
    });

    const resumed = await h.runner.recoverStaleRuns(120_000);
    assert.deepEqual(resumed, [started.runId]);

    const run = getWorkflowRun(h.db.sqlite, started.runId);
    assert.equal(run?.status, 'succeeded');
    stages = listRunStages(h.db.sqlite, started.runId);
    for (const stage of stages) assert.equal(stage.status, 'succeeded');

    // Resume evidence: rag-context started exactly ONCE (same started_at), the
    // remaining three stages ran only during recovery.
    const counts = stageStartedCounts(h, started.runId);
    assert.equal(counts['rag-context'], 1, 'succeeded stage never re-executed');
    assert.equal(listRunStages(h.db.sqlite, started.runId)[0].started_at, ragStartedAt);
    for (const name of ['scan-oss', 'enrich', 'write']) {
      assert.equal(counts[name], 1);
    }

    const md = readFileSync(join(run!.workspace_path!, 'deliverable.md'), 'utf8');
    assert.ok(md.includes('断点恢复需求'));
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) HTTP: GET /runs and GET /runs/:id/stages (the phone's view, §11)
// ---------------------------------------------------------------------------

test('M5 HTTP: /runs and /runs/:id/stages expose the observable stage list', async () => {
  const h = harness('m5-http');
  try {
    const requirementId = seedAutoAdvancedRequirement(h, 'HTTP 可观测需求', '手机能看到跑到哪个 stage。');
    const started = h.runner.startRunForRequirement(requirementId);
    assert.ok(started?.started);
    await h.runner.executeRun(started.runId);

    const http = await startHttp({ host: '127.0.0.1', port: 0, db: h.db.sqlite });
    try {
      const listRes = await fetch(`http://127.0.0.1:${http.port}/runs`);
      assert.equal(listRes.status, 200);
      const listJson = (await listRes.json()) as { runs: Array<{ id: string; status: string; subject_id: string }> };
      assert.equal(listJson.runs.length, 1);
      assert.equal(listJson.runs[0].id, started.runId);
      assert.equal(listJson.runs[0].status, 'succeeded');
      assert.equal(listJson.runs[0].subject_id, requirementId);

      const stagesRes = await fetch(`http://127.0.0.1:${http.port}/runs/${started.runId}/stages`);
      assert.equal(stagesRes.status, 200);
      const stagesJson = (await stagesRes.json()) as {
        runId: string;
        status: string;
        stages: Array<{ name: string; status: string; started_at: number | null; ended_at: number | null }>;
      };
      assert.equal(stagesJson.runId, started.runId);
      assert.equal(stagesJson.status, 'succeeded');
      assert.deepEqual(
        stagesJson.stages.map((s) => s.name),
        ['rag-context', 'scan-oss', 'enrich', 'write'],
      );
      for (const stage of stagesJson.stages) {
        assert.equal(stage.status, 'succeeded');
        assert.ok(stage.started_at !== null && stage.ended_at !== null);
      }

      const missing = await fetch(`http://127.0.0.1:${http.port}/runs/${randomUUID()}/stages`);
      assert.equal(missing.status, 404);
    } finally {
      await http.close();
    }
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) offline dry-run script sanity: scripted streamFn emits the Pi protocol
// ---------------------------------------------------------------------------

test('M5 dry-run streamFn emits a well-formed Pi event protocol', async () => {
  const h = harness('m5-protocol');
  try {
    const streamFn = createScriptedStreamFn([
      { toolCalls: [{ name: 'github.search', args: { query: 'q' } }] },
      { text: 'done' },
    ]);
    const response = (await streamFn(
      { id: 'm' } as never,
      { systemPrompt: 's', messages: [], tools: [] },
    )) as { result(): Promise<{ stopReason: string }> };
    const final = await response.result();
    assert.equal(final.stopReason, 'toolUse');
  } finally {
    await h.cleanup();
  }
});
