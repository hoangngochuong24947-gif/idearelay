import { resolve } from 'node:path';
import type { ProviderRegistration } from '@idearelay/contracts';

export type AsrProviderName = 'mock' | 'funasr';

/** ASR selection + Final-transcription options (spec §7.1, ADR-0007/0009). */
export interface AsrConfig {
  provider: AsrProviderName;
  baseUrl: string | null;
  model: string | null;
  /** Optional bearer token for the FunASR service (from env, never persisted). */
  apiKey: string | null;
  languageHints: string[];
  hotwords: string[];
  /** FunASR request timeout in ms, or null for the provider default. */
  timeoutMs: number | null;
}

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
  asr: AsrConfig;
  providers: ProviderRegistration[];
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function csvFromEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function asrProviderFromEnv(value: string | undefined): AsrProviderName {
  const normalized = (value ?? 'mock').trim().toLowerCase();
  if (normalized === 'mock' || normalized === 'funasr') return normalized;
  throw new Error(
    `unknown IDEA_RELAY_ASR_PROVIDER: ${value} (expected 'mock' or 'funasr')`,
  );
}

function nullable(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return value;
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
    asr: {
      // Defaults to the offline mock so a fresh Hub works with zero config; set
      // 'funasr' (+ base URL) for the real Final transcription path.
      provider: asrProviderFromEnv(env.IDEA_RELAY_ASR_PROVIDER),
      baseUrl: nullable(env.IDEA_RELAY_FUNASR_BASE_URL),
      model: nullable(env.IDEA_RELAY_ASR_MODEL),
      apiKey: nullable(env.IDEA_RELAY_FUNASR_API_KEY),
      languageHints: csvFromEnv(env.IDEA_RELAY_ASR_LANGUAGE_HINTS ?? 'zh'),
      hotwords: csvFromEnv(env.IDEA_RELAY_ASR_HOTWORDS),
      timeoutMs: env.IDEA_RELAY_ASR_TIMEOUT_MS
        ? intFromEnv(env.IDEA_RELAY_ASR_TIMEOUT_MS, 120_000)
        : null,
    },
    providers: [],
  };
}
