import { resolve } from 'node:path';
import {
  DEFAULT_DECISION_THRESHOLDS,
  type DecisionThresholds,
  type ProviderRegistration,
} from '@idearelay/contracts';

export type AsrProviderName = 'mock' | 'funasr';
export type ModelProviderName = 'mock' | 'openai';
export type DecisionProviderName = 'mock' | 'jev';

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

/** Model selection for summarization (spec §7.2, ADR-0009). */
export interface ModelConfig {
  provider: ModelProviderName;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  timeoutMs: number | null;
}

/** Decision selection for classification/tagging (spec §7.3, ADR-0005). */
export interface DecisionConfig {
  provider: DecisionProviderName;
  endpoint: string | null;
  /** Pinned model name (jev) — never the moving `jev-latest` alias. */
  model: string | null;
  apiKey: string | null;
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
  /**
   * tus data-store directory (spec §11 `POST /upload`). Lives under the data
   * dir but NEVER inside the consume folder — partial uploads must not be
   * seen by the watcher.
   */
  tusDir: string;
  http: { host: string; port: number };
  worker: {
    workerId: string;
    pollIntervalMs: number;
    stallTimeoutMs: number;
    maxAttempts: number;
  };
  asr: AsrConfig;
  model: ModelConfig;
  decision: DecisionConfig;
  /** Gate thresholds (§9) — per-call overrides still win at the call site. */
  gate: DecisionThresholds;
  /** WorkflowRun engine settings (§6 / §8 / §11, M5). */
  workflow: {
    /** Interval for the gate-eligibility scan that enqueues run jobs. */
    triggerIntervalMs: number;
    /** Stage heartbeat cadence (written into run_stages.detail_json). */
    heartbeatMs: number;
    /** §6: a `running` run with no heartbeat for this long is considered dead. */
    staleRunMs: number;
  };
  providers: ProviderRegistration[];
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseFloat(value);
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

function modelProviderFromEnv(value: string | undefined): ModelProviderName {
  const normalized = (value ?? 'mock').trim().toLowerCase();
  if (normalized === 'mock' || normalized === 'openai') return normalized;
  throw new Error(
    `unknown IDEA_RELAY_MODEL_PROVIDER: ${value} (expected 'mock' or 'openai')`,
  );
}

function decisionProviderFromEnv(value: string | undefined): DecisionProviderName {
  const normalized = (value ?? 'mock').trim().toLowerCase();
  if (normalized === 'mock' || normalized === 'jev') return normalized;
  throw new Error(
    `unknown IDEA_RELAY_DECISION_PROVIDER: ${value} (expected 'mock' or 'jev')`,
  );
}

function noulBandFromEnv(value: string | undefined): [number, number] {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_DECISION_THRESHOLDS.noulBand;
  }
  const parts = csvFromEnv(value).map((p) => Number.parseFloat(p));
  if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n))) {
    throw new Error(
      `invalid IDEA_RELAY_NOUL_BAND: ${value} (expected 'low,high', e.g. '0.35,0.65')`,
    );
  }
  return [parts[0], parts[1]];
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
  const tusDir = resolve(env.IDEA_RELAY_TUS_DIR ?? resolve(dataDir, 'tus-uploads'));

  return {
    dataDir,
    dbPath,
    inboxDir,
    tusDir,
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
    model: {
      // Defaults to the offline mock summarizer; 'openai' targets any
      // OpenAI-compatible endpoint (remote self-hosted included).
      provider: modelProviderFromEnv(env.IDEA_RELAY_MODEL_PROVIDER),
      baseUrl: nullable(env.IDEA_RELAY_MODEL_BASE_URL),
      model: nullable(env.IDEA_RELAY_MODEL_NAME),
      apiKey: nullable(env.IDEA_RELAY_MODEL_API_KEY),
      timeoutMs: env.IDEA_RELAY_MODEL_TIMEOUT_MS
        ? intFromEnv(env.IDEA_RELAY_MODEL_TIMEOUT_MS, 60_000)
        : null,
    },
    decision: {
      // Defaults to the deterministic mock so tests run offline; 'jev' is the
      // first real DecisionProvider (ADR-0005).
      provider: decisionProviderFromEnv(env.IDEA_RELAY_DECISION_PROVIDER),
      endpoint: nullable(env.IDEA_RELAY_TYPESAFE_ENDPOINT),
      model: nullable(env.IDEA_RELAY_TYPESAFE_MODEL),
      apiKey: nullable(env.TYPESAFE_API_KEY),
      timeoutMs: env.IDEA_RELAY_TYPESAFE_TIMEOUT_MS
        ? intFromEnv(env.IDEA_RELAY_TYPESAFE_TIMEOUT_MS, 30_000)
        : null,
    },
    gate: {
      high: floatFromEnv(env.IDEA_RELAY_GATE_HIGH, DEFAULT_DECISION_THRESHOLDS.high),
      low: floatFromEnv(env.IDEA_RELAY_GATE_LOW, DEFAULT_DECISION_THRESHOLDS.low),
      noulBand: noulBandFromEnv(env.IDEA_RELAY_NOUL_BAND),
    },
    workflow: {
      triggerIntervalMs: intFromEnv(env.IDEA_RELAY_RUN_TRIGGER_INTERVAL_MS, 2_000),
      heartbeatMs: intFromEnv(env.IDEA_RELAY_RUN_HEARTBEAT_MS, 5_000),
      staleRunMs: intFromEnv(env.IDEA_RELAY_RUN_STALE_MS, 120_000),
    },
    providers: [],
  };
}
