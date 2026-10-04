import type { Worker } from '../worker.js';
import type { JobRow } from '../../queue/job-queue.js';
import { workflowRunIdempotencyKey, type WorkflowRunner } from '../../workflows/runner.js';

export { workflowRunIdempotencyKey };

/** Payload of a `workflow-run` job (enqueued by the runner's gate scan). */
export interface WorkflowRunJobPayload {
  requirementId: string;
}

/**
 * Register the `workflow-run` worker handler (spec §8, M5). Starts the run
 * (idempotent) and drives its stage machine through the Pi driver; the worker
 * loop keeps the job heartbeat alive while the run executes (§11).
 */
export function registerWorkflowRunHandler(worker: Worker, runner: WorkflowRunner): void {
  worker.register('workflow-run', async (job: JobRow) => {
    const payload = JSON.parse(job.payload_json) as WorkflowRunJobPayload;
    if (typeof payload.requirementId !== 'string' || payload.requirementId === '') {
      throw new Error('workflow-run job payload missing requirementId');
    }
    const started = runner.startRunForRequirement(payload.requirementId);
    if (started === null) {
      throw new Error(`requirement not found: ${payload.requirementId}`);
    }
    return runner.executeRun(started.runId);
  });
}
