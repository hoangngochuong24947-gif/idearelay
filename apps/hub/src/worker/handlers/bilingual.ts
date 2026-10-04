import type { Worker } from '../worker.js';
import { writeBilingualTranscript, type BilingualDeps } from '../../pipeline/bilingual.js';

/** Payload of a `bilingual` job (enqueued by enrich, or on demand). */
export interface BilingualJobPayload {
  recordingId: string;
  revisionId?: string;
}

/**
 * Register the `bilingual` worker handler (spec §15, M7): one batched translate
 * call over the Final segments → `transcript.bilingual.md` projection.
 */
export function registerBilingualHandler(worker: Worker, deps: BilingualDeps): void {
  worker.register('bilingual', async (job) => {
    const payload = JSON.parse(job.payload_json) as BilingualJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('bilingual job payload missing recordingId');
    }
    return writeBilingualTranscript(
      deps,
      payload.recordingId,
      typeof payload.revisionId === 'string' ? payload.revisionId : undefined,
    );
  });
}
