import type { Worker } from '../worker.js';
import { realignRequirements, type RealignDeps } from '../../pipeline/realign.js';

/** Payload of a `realign` job (enqueued whenever a new Final revision lands). */
export interface RealignJobPayload {
  recordingId: string;
  revisionId?: string;
}

/** Stable key so the same target revision never realigns twice (§5.5). */
export function realignIdempotencyKey(recordingId: string, revisionId: string): string {
  return `realign:${recordingId}:${revisionId}`;
}

/**
 * Register the `realign` worker handler (spec §10 / §18). Runs whenever a
 * newer Final revision supersedes an old one: existing Requirements re-align
 * to the new segments by time overlap without losing any reference.
 */
export function registerRealignHandler(worker: Worker, deps: RealignDeps): void {
  worker.register('realign', async (job) => {
    const payload = JSON.parse(job.payload_json) as RealignJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('realign job payload missing recordingId');
    }
    return realignRequirements(
      deps,
      payload.recordingId,
      typeof payload.revisionId === 'string' ? payload.revisionId : undefined,
    );
  });
}
