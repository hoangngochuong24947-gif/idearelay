import type { Worker } from '../worker.js';
import { enrichRecording, type EnrichDeps } from '../../pipeline/enrich.js';

/** Payload of an `enrich` job enqueued at the end of the transcribe handler. */
export interface EnrichJobPayload {
  recordingId: string;
  revisionId?: string;
}

/** Stable key so the same final revision is never enriched twice (§5.5). */
export function enrichIdempotencyKey(recordingId: string, revisionId: string): string {
  return `enrich:${recordingId}:${revisionId}`;
}

/**
 * Register the `enrich` worker handler (spec §13 step 6). Runs the M2 pipeline
 * purely against the injected `ModelProvider` / `DecisionProvider` interfaces.
 */
export function registerEnrichHandler(worker: Worker, deps: EnrichDeps): void {
  worker.register('enrich', async (job) => {
    const payload = JSON.parse(job.payload_json) as EnrichJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('enrich job payload missing recordingId');
    }
    return enrichRecording(
      deps,
      payload.recordingId,
      typeof payload.revisionId === 'string' ? payload.revisionId : undefined,
    );
  });
}
