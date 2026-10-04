import type { Worker } from '../worker.js';

/**
 * The M0 smoke handler: it returns its own payload so the round-trip can be
 * verified without any external service.
 */
export function registerEchoHandler(worker: Worker): void {
  worker.register('echo', async (job) => JSON.parse(job.payload_json) as unknown);
}
