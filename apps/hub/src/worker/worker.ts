import type { JobQueue, JobRow } from '../queue/job-queue.js';

export type JobHandler = (job: JobRow) => Promise<unknown>;

export interface WorkerOptions {
  workerId: string;
  pollIntervalMs: number;
  stallTimeoutMs: number;
}

export interface JobRunOutcome {
  job: JobRow;
  result: unknown;
}

/**
 * Worker loop: reclaim stalled leases, atomically claim one job, dispatch by
 * `kind`, keep the heartbeat alive while working, then mark succeeded/failed/dead
 * (spec §11). Handler failures never crash the loop.
 */
export class Worker {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly opts: WorkerOptions,
  ) {}

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Claim and run at most one job. Returns null when the queue is empty. */
  async runOnce(): Promise<JobRunOutcome | null> {
    this.queue.reclaimStalled(this.opts.stallTimeoutMs);
    const job = this.queue.claim(this.opts.workerId);
    if (job === null) return null;

    const heartbeat = setInterval(() => {
      try {
        this.queue.heartbeat(job.id);
      } catch {
        // Heartbeat is best-effort; a lost lease is handled by reclaim.
      }
    }, Math.max(250, Math.floor(this.opts.stallTimeoutMs / 3)));
    heartbeat.unref();

    let result: unknown;
    try {
      const handler = this.handlers.get(job.kind);
      if (handler === undefined) {
        throw new Error(`no handler registered for kind: ${job.kind}`);
      }
      result = await handler(job);
      this.queue.complete(job.id);
    } catch (error) {
      this.queue.fail(job.id, error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(heartbeat);
    }
    const updated = this.queue.get(job.id);
    return updated === null ? null : { job: updated, result };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (error) {
        console.error('[hub] worker tick failed:', error);
      }
      if (this.running) {
        this.timer = setTimeout(() => void loop(), this.opts.pollIntervalMs);
      }
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
