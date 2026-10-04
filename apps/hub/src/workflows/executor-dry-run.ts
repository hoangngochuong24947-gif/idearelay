import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_TYPES,
  type ExecutorHandle,
  type ExecutorJob,
  type ExecutorProvider,
  type ExecutorStatus,
} from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { appendEvent } from '../db/repositories/events.js';

export interface DryRunExecutorOptions {
  sqlite?: SqliteDb;
  /** Audit sink for rollback (ADR-0006: external side effects must be auditable). */
  now?: () => number;
  /**
   * Dry-run "completion": given the job, return the Deliverable content the
   * simulated executor drops at `job.deliverablePath`. Returning null leaves
   * the job file only (never executed).
   */
  complete?: (job: ExecutorJob) => string | null;
  log?: (message: string) => void;
}

const JOB_FILE = 'executor/job.json';
const STATUS_FILE = 'executor/status.json';

/** Default dry-run "completion": the prompt becomes the stub Deliverable. */
function defaultDryRunCompletion(job: ExecutorJob): string {
  return [
    `# Deliverable (dry-run)`,
    '',
    `- executor job: ${job.id}`,
    `- requirement: ${job.requirementId}`,
    `- tool whitelist: ${job.toolWhitelist.join(', ')}`,
    '',
    '## 交付正文（由 prompt 合成，未执行任何代码）',
    '',
    job.prompt,
    '',
  ].join('\n');
}

/**
 * The MVP **dry-run** ExecutorProvider (§7.7, ADR-0006).
 *
 * - Pull model: `submit` writes the `ExecutorJob` **as a file** into the run
 *   workspace (`<ws>/executor/job.json`) — the executor's handoff artifact.
 * - No arbitrary code execution, ever: the "completion" is a caller-supplied
 *   pure function writing a stub Deliverable.
 * - `status()` reads the workspace state; `rollback()` deletes the workspace
 *   and appends an audit event.
 */
export class DryRunExecutorProvider implements ExecutorProvider {
  readonly id = 'dry-run';
  readonly capabilities = { sandboxed: false, toolWhitelist: true, rollback: true };

  constructor(private readonly opts: DryRunExecutorOptions = {}) {}

  async submit(job: ExecutorJob): Promise<ExecutorHandle> {
    const jobPath = join(job.workspacePath, JOB_FILE);
    mkdirSync(join(job.workspacePath, 'executor'), { recursive: true });
    writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8');

    const completion = this.opts.complete !== undefined
      ? this.opts.complete(job)
      : defaultDryRunCompletion(job);
    if (completion !== null) {
      mkdirSync(job.workspacePath, { recursive: true });
      writeFileSync(job.deliverablePath, completion, 'utf8');
    }
    const status: ExecutorStatus = {
      stage: completion !== null ? 'delivered' : 'submitted',
      running: completion === null,
      done: false,
      failed: false,
      detail: completion !== null ? 'dry-run completion written' : 'job file written, not executed',
    };
    writeFileSync(join(job.workspacePath, STATUS_FILE), JSON.stringify(status, null, 2), 'utf8');
    this.opts.log?.(`executor(dry-run): job ${job.id} submitted → ${status.stage}`);
    return { id: job.id, providerId: this.id, workspacePath: job.workspacePath };
  }

  async status(h: ExecutorHandle): Promise<ExecutorStatus> {
    const statusPath = join(h.workspacePath, STATUS_FILE);
    if (existsSync(statusPath)) {
      try {
        return JSON.parse(readFileSync(statusPath, 'utf8')) as ExecutorStatus;
      } catch {
        // fall through to file heuristics
      }
    }
    const jobPath = join(h.workspacePath, JOB_FILE);
    return {
      stage: existsSync(jobPath) ? 'submitted' : 'missing',
      running: false,
      done: existsSync(jobPath),
      failed: false,
      detail: null,
    };
  }

  async rollback(h: ExecutorHandle): Promise<void> {
    // ADR-0006: the run workspace can be dropped wholesale; the audit event
    // records the (dry-run: empty) set of external side effects.
    rmSync(h.workspacePath, { recursive: true, force: true });
    if (this.opts.sqlite !== undefined) {
      appendEvent(this.opts.sqlite, {
        aggregateType: 'workflow_run',
        aggregateId: h.id.startsWith('exec-') ? h.id.slice('exec-'.length) : h.id,
        type: EVENT_TYPES.RunRolledBack,
        payload: { executor: this.id, workspacePath: h.workspacePath, externalSideEffects: [] },
        createdAt: this.opts.now?.() ?? Date.now(),
      });
    }
    this.opts.log?.(`executor(dry-run): rolled back workspace ${h.workspacePath}`);
  }
}
