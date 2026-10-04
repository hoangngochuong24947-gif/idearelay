import type { Worker } from '../worker.js';
import {
  transcribeRecording,
  type TranscribeDeps,
} from '../../pipeline/transcribe.js';

/** Payload of a `transcribe` job enqueued by the consume-folder intake. */
export interface TranscribeJobPayload {
  recordingId: string;
}

/**
 * Register the `transcribe` worker handler. It runs the M1 pipeline purely
 * against the injected `AsrProvider` interface.
 */
export function registerTranscribeHandler(
  worker: Worker,
  deps: TranscribeDeps,
): void {
  worker.register('transcribe', async (job) => {
    const payload = JSON.parse(job.payload_json) as TranscribeJobPayload;
    if (typeof payload.recordingId !== 'string' || payload.recordingId === '') {
      throw new Error('transcribe job payload missing recordingId');
    }
    return transcribeRecording(deps, payload.recordingId);
  });
}
