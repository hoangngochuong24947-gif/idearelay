import type { Worker } from '../worker.js';
import { bilingualIdempotencyKey } from '../../pipeline/bilingual.js';
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
 * When a queue is present, a completed enrich also enqueues the idempotent
 * `bilingual` job (spec §15: 转写层直接出双语 — the projection is written after
 * the Final transcript and its enrichment).
 */
export function registerEnrichHandler(worker: Worker, deps: EnrichDeps): void {
  worker.register('enrich', async (job) => {
    const payload = JSON.parse(job.payload_json) as EnrichJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('enrich job payload missing recordingId');
    }
    const outcome = await enrichRecording(
      deps,
      payload.recordingId,
      typeof payload.revisionId === 'string' ? payload.revisionId : undefined,
    );
    if (deps.queue !== undefined) {
      deps.queue.enqueue({
        kind: 'bilingual',
        payload: { recordingId: outcome.recordingId, revisionId: outcome.revisionId },
        idempotencyKey: bilingualIdempotencyKey(outcome.recordingId, outcome.revisionId),
      });
    }
    return outcome;
  });
}
