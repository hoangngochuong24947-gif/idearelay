import type { Worker } from '../worker.js';
import { splitRequirements, type SplitDeps } from '../../pipeline/split.js';

/** Payload of a `split` job (enqueued by enrich, or on demand). */
export interface SplitJobPayload {
  recordingId: string;
  revisionId?: string;
}

/** Stable key so the same final revision is never split twice (§5.5). */
export function splitIdempotencyKey(recordingId: string, revisionId: string): string {
  return `split:${recordingId}:${revisionId}`;
}

/**
 * Register the `split` worker handler (spec §13 step 6, §10). Runs the M3
 * requirement-splitting pipeline purely against the injected `ModelProvider`
 * interface.
 */
export function registerSplitHandler(worker: Worker, deps: SplitDeps): void {
  worker.register('split', async (job) => {
    const payload = JSON.parse(job.payload_json) as SplitJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('split job payload missing recordingId');
    }
    return splitRequirements(
      deps,
      payload.recordingId,
      typeof payload.revisionId === 'string' ? payload.revisionId : undefined,
    );
  });
}
