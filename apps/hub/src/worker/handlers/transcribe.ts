import type { JobQueue } from '../../queue/job-queue.js';
import type { Worker } from '../worker.js';
import {
  transcribeRecording,
  type TranscribeDeps,
} from '../../pipeline/transcribe.js';
import { enrichIdempotencyKey } from './enrich.js';

/** Payload of a `transcribe` job enqueued by the consume-folder intake. */
export interface TranscribeJobPayload {
  recordingId: string;
}

export interface TranscribeHandlerDeps extends TranscribeDeps {
  /** When present, a Final transcript enqueues an idempotent `enrich` job. */
  queue?: JobQueue;
}

/**
 * Register the `transcribe` worker handler. It runs the M1 pipeline purely
 * against the injected `AsrProvider` interface, then (M2) enqueues the `enrich`
 * stage so summarization + classification follow every Final transcript
 * (spec §13 steps 5–6).
 */
export function registerTranscribeHandler(
  worker: Worker,
  deps: TranscribeHandlerDeps,
): void {
  worker.register('transcribe', async (job) => {
    const payload = JSON.parse(job.payload_json) as TranscribeJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('transcribe job payload missing recordingId');
    }
    const outcome = await transcribeRecording(deps, payload.recordingId);

    deps.queue?.enqueue({
      kind: 'enrich',
      payload: {
        recordingId: outcome.recordingId,
        revisionId: outcome.finalRevisionId,
      },
      idempotencyKey: enrichIdempotencyKey(outcome.recordingId, outcome.finalRevisionId),
    });

    return outcome;
  });
}
