import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EVENT_TYPES,
  type ExecutorProvider,
  type ProviderRegistry,
} from '@idearelay/contracts';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { SqliteDb } from '../db/types.js';
import type { JobQueue } from '../queue/job-queue.js';
import { appendEvent } from '../db/repositories/events.js';
import {
  findRunBySubject,
  getWorkflowRun,
  insertRunStages,
  insertWorkflowRun,
  listRequirementsEligibleForRun,
  listRunningRuns,
  listRunStages,
  parseStageDetail,
  updateRunStage,
  updateRunStatus,
  type WorkflowRunRow,
} from '../db/repositories/workflows.js';
import { getRequirement, updateRequirementStatus } from '../db/repositories/requirements.js';
import {
  createDryRunStreamFn,
  runAgentStage,
} from './pi-driver.js';
import { createStageTools, renderDeliverable, type StageTool } from './stage-tools.js';
import { toAgentTools } from './to-agent-tools.js';
import {
  getWorkflowSpec,
  REQUIREMENT_RESEARCH_SPEC_ID,
} from './seed.js';
import type {
  AgentStageDef,
  RunGrant,
  StageContext,
  StageDef,
  StageDetail,
  ToolStageDef,
  WorkflowDefinition,
} from './types.js';

export interface RunnerDeps {
  sqlite: SqliteDb;
  dataDir: string;
  registry: ProviderRegistry;
  executor: ExecutorProvider;
  /**
   * StreamFn factory per agent stage. Defaults to the offline dry-run script
   * (`createDryRunStreamFn`); production wires `modelProviderStreamFn`.
   */
  streamFnFor?: (stage: AgentStageDef, definition: WorkflowDefinition) => StreamFn;
  /** Test seam: replace/extend stage tools (e.g. a throwing tool). */
  toolOverrides?: Record<string, StageTool>;
  /** Registered RagProvider instance (M6 wires the real one; null today). */
  ragProvider?: StageToolDepsRag | null;
  /** When present, the gate scan enqueues idempotent `workflow-run` jobs. */
  queue?: JobQueue;
  heartbeatMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** Structural subset of the RagProvider contract used by stage tools. */
export interface StageToolDepsRag {
  retrieve(query: string, opts: { topK?: number }): Promise<Array<{ docId: string; path: string; score: number; snippet: string }>>;
}

export interface StartRunResult {
  runId: string;
  /** false when a run already existed for this subject (idempotent). */
  started: boolean;
}

export interface RunOutcome {
  runId: string;
  status: WorkflowRunRow['status'];
  stageStatuses: Record<string, string>;
  deliverablePath?: string;
  error?: string;
}

export interface RunnerOptions {
  /** Boot-time + periodic recovery threshold (§6/§11: default 120s). */
  staleRunMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 5_000;

/** Stable key: at most one run job per requirement (idempotent per subject). */
export function workflowRunIdempotencyKey(requirementId: string): string {
  return `workflow-run:${requirementId}`;
}

/**
 * The WorkflowRun engine (spec §8 / §11): seeds the §8.1 spec, starts runs
 * idempotently per subject, executes the stage machine through the **real Pi
 * `Agent`**, and recovers crashed runs from the last successful stage.
 *
 * Checkpoint = `run_stages` rows (rows are truth, ADR-0002) — the stage
 * machine equivalent of an AgentHarness JSONL session: each stage's output is
 * persisted in `detail_json` before the next stage starts, so recovery
 * resumes from the last succeeded stage instead of from scratch.
 */
export class WorkflowRunner {
  private readonly stageTools: Map<string, StageTool>;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly options: RunnerOptions = {},
  ) {
    this.stageTools = createStageTools({
      registry: deps.registry,
      executor: deps.executor,
      sqlite: deps.sqlite,
      renderDeliverable,
      ragProvider: deps.ragProvider ?? null,
      now: deps.now,
      log: deps.log,
    });
    for (const [name, tool] of Object.entries(deps.toolOverrides ?? {})) {
      this.stageTools.set(name, tool);
    }
  }

  // ---------------------------------------------------------------
  // Run start (idempotent per subject, §8.1 gate + ADR-0006 grant)
  // ---------------------------------------------------------------

  /**
   * Start a WorkflowRun for a Requirement. Idempotent: an existing run for the
   * subject short-circuits. Creates the run row, the grant, the workspace and
   * one `run_stages` row per spec stage.
   */
  startRunForRequirement(requirementId: string): StartRunResult | null {
    const requirement = getRequirement(this.deps.sqlite, requirementId);
    if (requirement === null) return null;

    const existing = findRunBySubject(this.deps.sqlite, 'requirement', requirementId);
    if (existing !== null) {
      return { runId: existing.id, started: false };
    }

    const spec = getWorkflowSpec(this.deps.sqlite, REQUIREMENT_RESEARCH_SPEC_ID);
    if (spec === null) throw new Error(`workflow spec missing: ${REQUIREMENT_RESEARCH_SPEC_ID}`);
    const definition = JSON.parse(spec.definition_json) as WorkflowDefinition;

    const runId = randomUUID();
    const now = this.deps.now?.() ?? Date.now();
    const workspacePath = join(this.deps.dataDir, 'workspaces', runId);
    const grant: RunGrant = {
      toolWhitelist: [
        ...new Set(definition.stages.flatMap((s) => (s.kind === 'agent' ? s.tools : [s.tool]))),
      ],
      // Read-allow: only the run's own requirement projection (ADR-0006).
      readAllow: requirement.body_path ? [requirement.body_path] : [],
      credentials: 'none',
      executor: 'dry-run',
    };

    const stageIds = definition.stages.map(() => randomUUID());
    const writeOnce = this.deps.sqlite.transaction(() => {
      insertWorkflowRun(this.deps.sqlite, {
        id: runId,
        specId: spec.id,
        subjectType: 'requirement',
        subjectId: requirementId,
        status: 'pending',
        grantJson: JSON.stringify(grant),
        workspacePath,
        createdAt: now,
      });
      insertRunStages(
        this.deps.sqlite,
        definition.stages.map((stage, i) => ({ id: stageIds[i], runId, name: stage.name })),
      );
      appendEvent(this.deps.sqlite, {
        aggregateType: 'workflow_run',
        aggregateId: runId,
        type: EVENT_TYPES.RunStarted,
        payload: {
          specId: spec.id,
          subjectType: 'requirement',
          subjectId: requirementId,
          workspacePath,
          grant,
        },
        createdAt: now,
      });
    });
    writeOnce();
    mkdirSync(workspacePath, { recursive: true });
    updateRequirementStatus(this.deps.sqlite, requirementId, 'running');
    this.deps.log?.(`run ${runId}: started for requirement ${requirementId} (${definition.stages.length} stages)`);
    return { runId, started: true };
  }

  /**
   * Scan for gate-eligible requirements (§8.1 gate) and enqueue an idempotent
   * `workflow-run` job per subject. Without a queue, starts runs directly.
   */
  startPendingRequirementRuns(): string[] {
    const eligible = listRequirementsEligibleForRun(this.deps.sqlite);
    const started: string[] = [];
    for (const requirementId of eligible) {
      if (this.deps.queue !== undefined) {
        const result = this.deps.queue.enqueue({
          kind: 'workflow-run',
          payload: { requirementId },
          idempotencyKey: workflowRunIdempotencyKey(requirementId),
        });
        if (result.inserted) started.push(requirementId);
        continue;
      }
      const result = this.startRunForRequirement(requirementId);
      if (result !== null && result.started) started.push(result.runId);
    }
    return started;
  }

  // ---------------------------------------------------------------
  // Stage machine execution (resumable; heartbeat via detail_json)
  // ---------------------------------------------------------------

  /**
   * Execute (or resume) a run: skips succeeded stages, re-runs everything
   * else in spec order. A stage failure fails the run (Pi's `isError` rule).
   */
  async executeRun(runId: string, opts: { stopAfterStage?: string } = {}): Promise<RunOutcome> {
    const run = getWorkflowRun(this.deps.sqlite, runId);
    if (run === null) throw new Error(`workflow run not found: ${runId}`);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'rolled_back') {
      return this.outcomeFor(run, undefined);
    }

    const spec = getWorkflowSpec(this.deps.sqlite, run.spec_id);
    if (spec === null) throw new Error(`workflow spec missing: ${run.spec_id}`);
    const definition = JSON.parse(spec.definition_json) as WorkflowDefinition;
    const grant = JSON.parse(run.grant_json ?? '{}') as RunGrant;
    const requirement = getRequirement(this.deps.sqlite, run.subject_id);
    if (requirement === null) throw new Error(`requirement missing: ${run.subject_id}`);

    if (run.status === 'pending') {
      updateRunStatus(this.deps.sqlite, runId, 'running');
    }
    mkdirSync(run.workspace_path ?? '', { recursive: true });

    const ctx: StageContext = {
      runId,
      workspacePath: run.workspace_path ?? '',
      requirement: {
        id: requirement.id,
        title: requirement.title,
        body: requirementBody(this.deps.sqlite, requirement.id, requirement.body_path),
        bodyPath: requirement.body_path,
      },
      grant,
      ragHits: [],
    };

    let failedStage: string | undefined;
    let failure: string | undefined;

    for (let i = 0; i < definition.stages.length; i += 1) {
      const stageDef = definition.stages[i];
      const stages = listRunStages(this.deps.sqlite, runId);
      const stageRow = stages[i];

      if (stageRow.status === 'succeeded') {
        this.hydrateContext(ctx, parseStageDetail(stageRow)?.output);
        continue;
      }
      if (stageRow.status === 'running') {
        // Crashed mid-stage: reset and re-run this stage.
        updateRunStage(this.deps.sqlite, stageRow.id, { status: 'pending' });
      }

      const detail: StageDetail = { heartbeatAt: this.deps.now?.() ?? Date.now(), toolCalls: [] };
      updateRunStage(this.deps.sqlite, stageRow.id, {
        status: 'running',
        startedAt: this.deps.now?.() ?? Date.now(),
        detail,
      });
      appendEvent(this.deps.sqlite, {
        aggregateType: 'run_stage',
        aggregateId: stageRow.id,
        type: EVENT_TYPES.StageStarted,
        payload: { runId, name: stageDef.name },
        createdAt: this.deps.now?.() ?? Date.now(),
      });

      // Heartbeat (§6/§11): keep the stage detail fresh while the stage runs.
      const heartbeat = setInterval(() => {
        try {
          updateRunStage(this.deps.sqlite, stageRow.id, {
            detail: { ...detail, heartbeatAt: this.deps.now?.() ?? Date.now() },
          });
        } catch {
          // best-effort; recovery handles a lost heartbeat
        }
      }, this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
      heartbeat.unref();

      try {
        const output = await this.executeStage(stageDef, ctx);
        if (stageDef.kind === 'agent') {
          const agentOut = output as { toolCalls?: StageDetail['toolCalls']; failure?: string };
          if (agentOut.toolCalls !== undefined) detail.toolCalls = agentOut.toolCalls;
          if (agentOut.failure !== undefined) {
            throw new Error(agentOut.failure);
          }
        }
        detail.output = output;
        if (stageDef.name === 'rag-context') {
          const ragOut = output as { hits?: StageContext['ragHits'] } | undefined;
          ctx.ragHits = ragOut?.hits ?? [];
        }
        if (stageDef.name === 'scan-oss') {
          ctx.scanOssText = (output as { finalText?: string })?.finalText;
        }
        if (stageDef.name === 'enrich') {
          ctx.enrichText = (output as { finalText?: string })?.finalText;
        }
        updateRunStage(this.deps.sqlite, stageRow.id, {
          status: 'succeeded',
          endedAt: this.deps.now?.() ?? Date.now(),
          detail,
        });
        appendEvent(this.deps.sqlite, {
          aggregateType: 'run_stage',
          aggregateId: stageRow.id,
          type: EVENT_TYPES.StageFinished,
          payload: { runId, name: stageDef.name, status: 'succeeded' },
          createdAt: this.deps.now?.() ?? Date.now(),
        });
        if (opts.stopAfterStage === stageDef.name) {
          clearInterval(heartbeat);
          // Simulated crash: run stays `running` with fresh heartbeats.
          return {
            runId,
            status: 'running',
            stageStatuses: this.stageStatuses(runId),
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        detail.error = message;
        updateRunStage(this.deps.sqlite, stageRow.id, {
          status: 'failed',
          endedAt: this.deps.now?.() ?? Date.now(),
          detail,
        });
        appendEvent(this.deps.sqlite, {
          aggregateType: 'run_stage',
          aggregateId: stageRow.id,
          type: EVENT_TYPES.StageFinished,
          payload: { runId, name: stageDef.name, status: 'failed', error: message },
          createdAt: this.deps.now?.() ?? Date.now(),
        });
        failedStage = stageDef.name;
        failure = message;
      } finally {
        clearInterval(heartbeat);
      }
      if (failure !== undefined) break;
    }

    if (failure !== undefined) {
      updateRunStatus(this.deps.sqlite, runId, 'failed', this.deps.now?.() ?? Date.now());
      appendEvent(this.deps.sqlite, {
        aggregateType: 'workflow_run',
        aggregateId: runId,
        type: EVENT_TYPES.RunFailed,
        payload: {
          specId: run.spec_id,
          subjectType: run.subject_type,
          subjectId: run.subject_id,
          failedStage,
          error: failure,
        },
        createdAt: this.deps.now?.() ?? Date.now(),
      });
      updateRequirementStatus(this.deps.sqlite, run.subject_id, 'open');
      this.deps.log?.(`run ${runId}: failed at stage ${failedStage}: ${failure}`);
      return {
        runId,
        status: 'failed',
        stageStatuses: this.stageStatuses(runId),
        error: failure,
      };
    }

    updateRunStatus(this.deps.sqlite, runId, 'succeeded', this.deps.now?.() ?? Date.now());
    appendEvent(this.deps.sqlite, {
      aggregateType: 'workflow_run',
      aggregateId: runId,
      type: EVENT_TYPES.RunFinished,
      payload: {
        specId: run.spec_id,
        subjectType: run.subject_type,
        subjectId: run.subject_id,
        deliverablePath: ctx.deliverablePath ?? null,
      },
      createdAt: this.deps.now?.() ?? Date.now(),
    });
    updateRequirementStatus(this.deps.sqlite, run.subject_id, 'done');
    this.deps.log?.(`run ${runId}: succeeded`);
    return {
      runId,
      status: 'succeeded',
      stageStatuses: this.stageStatuses(runId),
      deliverablePath: ctx.deliverablePath,
    };
  }

  private async executeStage(stageDef: StageDef, ctx: StageContext): Promise<unknown> {
    if (stageDef.kind === 'tool') {
      const tool = this.stageTools.get((stageDef as ToolStageDef).tool);
      if (tool === undefined) throw new Error(`unknown stage tool: ${(stageDef as ToolStageDef).tool}`);
      const result = await tool.execute({}, ctx);
      return result.output ?? { text: result.text };
    }

    // Agent stage — the real Pi Agent pipeline (§8.2).
    const agentDef = stageDef as AgentStageDef;
    const template = this.currentTemplate(agentDef.promptTemplate);
    const tools = agentDef.tools.map((name) => {
      const tool = this.stageTools.get(name);
      if (tool === undefined) throw new Error(`unknown stage tool: ${name}`);
      return tool;
    });
    const agentTools = toAgentTools(tools, ctx);
    const streamFn =
      this.deps.streamFnFor?.(agentDef, this.currentDefinition()) ??
      createDryRunStreamFn(agentDef.tools[0]);

    const prompt = template.userTemplate
      .replace('{{requirement}}', ctx.requirement.body)
      .replace('{{rag}}', ctx.ragHits.length > 0 ? JSON.stringify(ctx.ragHits) : '（无）')
      .replace('{{scan}}', ctx.scanOssText ?? '（无）');

    const result = await runAgentStage({
      systemPrompt: template.system,
      prompt,
      tools: agentTools,
      streamFn,
      sessionId: ctx.runId,
    });

    for (const call of result.toolCalls) {
      if (call.isError) {
        const failed = result.toolCalls.find((c) => c.isError);
        return {
          finalText: result.finalText,
          toolCalls: result.toolCalls,
          failure: `agent stage tool failed: ${failed?.tool}${failed?.resultText ? `: ${failed.resultText}` : ''}`,
        };
      }
    }
    if (result.errorMessage !== undefined && result.errorMessage !== '') {
      return {
        finalText: result.finalText,
        toolCalls: result.toolCalls,
        failure: `agent stage failed: ${result.errorMessage}`,
      };
    }
    return { finalText: result.finalText, toolCalls: result.toolCalls };
  }

  // ---------------------------------------------------------------
  // Heartbeat staleness + crash recovery (§6 / §11)
  // ---------------------------------------------------------------

  /**
   * Scan `running` runs whose newest stage heartbeat is older than
   * `staleRunMs` (default 120s, §6) and resume them from the last succeeded
   * stage. Returns the resumed run ids.
   */
  async recoverStaleRuns(staleRunMs?: number): Promise<string[]> {
    const threshold = staleRunMs ?? this.options.staleRunMs ?? 120_000;
    const now = this.deps.now?.() ?? Date.now();
    const resumed: string[] = [];
    for (const run of listRunningRuns(this.deps.sqlite)) {
      const stages = listRunStages(this.deps.sqlite, run.id);
      const heartbeats = stages
        .map((s) => parseStageDetail(s)?.heartbeatAt ?? 0)
        .filter((h) => h > 0);
      const latest = heartbeats.length > 0 ? Math.max(...heartbeats) : 0;
      if (now - latest < threshold) continue;
      this.deps.log?.(`run ${run.id}: stale heartbeat (${now - latest}ms) → resuming`);
      await this.executeRun(run.id);
      resumed.push(run.id);
    }
    return resumed;
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  private cachedDefinition: WorkflowDefinition | null = null;
  private currentDefinition(): WorkflowDefinition {
    if (this.cachedDefinition !== null) return this.cachedDefinition;
    const spec = getWorkflowSpec(this.deps.sqlite, REQUIREMENT_RESEARCH_SPEC_ID);
    this.cachedDefinition = JSON.parse(spec?.definition_json ?? '{}') as WorkflowDefinition;
    return this.cachedDefinition;
  }

  private currentTemplate(name: string): { system: string; userTemplate: string } {
    const definition = this.currentDefinition();
    const template = definition.promptTemplates?.[name];
    if (template === undefined) {
      throw new Error(`prompt template missing: ${name}`);
    }
    return template;
  }

  private hydrateContext(ctx: StageContext, output: unknown): void {
    if (output === undefined || output === null) return;
    // Rebuild cross-stage context from persisted stage outputs (resume path).
    if (typeof output === 'object' && 'hits' in output) {
      ctx.ragHits = (output as { hits: StageContext['ragHits'] }).hits ?? [];
    }
    if (typeof output === 'object' && 'finalText' in output) {
      const text = (output as { finalText: string }).finalText;
      // The first agent stage after rag-context is scan-oss; the second is enrich.
      if (ctx.scanOssText === undefined) ctx.scanOssText = text;
      else ctx.enrichText = text;
    }
    if (typeof output === 'object' && 'deliverablePath' in output) {
      ctx.deliverablePath = (output as { deliverablePath: string }).deliverablePath;
    }
  }

  private stageStatuses(runId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const stage of listRunStages(this.deps.sqlite, runId)) {
      out[stage.name] = stage.status;
    }
    return out;
  }

  private outcomeFor(run: WorkflowRunRow, error: string | undefined): RunOutcome {
    return {
      runId: run.id,
      status: run.status,
      stageStatuses: this.stageStatuses(run.id),
      error,
    };
  }
}

/** Requirement body from rows: the `requirement.created` event payload (§6). */
function requirementBody(sqlite: SqliteDb, requirementId: string, bodyPath: string | null): string {
  const events = listRequirementEvents(sqlite, requirementId);
  for (const event of events) {
    try {
      const payload = JSON.parse(event.payloadJson) as { body?: unknown };
      if (typeof payload.body === 'string') return payload.body;
    } catch {
      // malformed payload → keep scanning
    }
  }
  // Fall back to the projection file name (path only; projections are write-only
  // for business logic, but the body here is display context for prompts).
  void bodyPath;
  return requirementId;
}

function listRequirementEvents(sqlite: SqliteDb, requirementId: string) {
  return sqlite
    .prepare(
      `SELECT payload_json AS payloadJson FROM events
        WHERE aggregate_type = 'requirement' AND aggregate_id = ?
        ORDER BY id ASC`,
    )
    .all(requirementId) as Array<{ payloadJson: string }>;
}
