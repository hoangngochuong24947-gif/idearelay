import { resolve } from 'node:path';
import type { ProviderRegistration } from '@idearelay/contracts';

/**
 * Hub runtime configuration (spec §11). Credentials never appear here — only the
 * *source descriptor* does (an env var name), see ADR-0009.
 */
export interface HubConfig {
  dataDir: string;
  dbPath: string;
  inboxDir: string;
  http: { host: string; port: number };
  worker: {
    workerId: string;
    pollIntervalMs: number;
    stallTimeoutMs: number;
    maxAttempts: number;
  };
  providers: ProviderRegistration[];
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const dataDir = resolve(env.IDEA_RELAY_DATA_DIR ?? 'data');
  const dbPath = resolve(
    env.IDEA_RELAY_DB_PATH ?? resolve(dataDir, 'idea-relay.db'),
  );
  const inboxDir = resolve(env.IDEA_RELAY_INBOX_DIR ?? resolve(dataDir, 'inbox'));

  return {
    dataDir,
    dbPath,
    inboxDir,
    http: {
      host: env.IDEA_RELAY_HTTP_HOST ?? '127.0.0.1',
      port: intFromEnv(env.IDEA_RELAY_HTTP_PORT, 8787),
    },
    worker: {
      workerId: env.IDEA_RELAY_WORKER_ID ?? `hub-${process.pid}`,
      pollIntervalMs: intFromEnv(env.IDEA_RELAY_POLL_INTERVAL_MS, 500),
      stallTimeoutMs: intFromEnv(env.IDEA_RELAY_STALL_TIMEOUT_MS, 30_000),
      maxAttempts: intFromEnv(env.IDEA_RELAY_MAX_ATTEMPTS, 5),
    },
    providers: [],
  };
}
