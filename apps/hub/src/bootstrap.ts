import type {
  CredentialSource,
  ProviderRegistration,
  ProviderRegistry,
} from '@idearelay/contracts';
import { loadConfig, type HubConfig } from './config/config.js';
import { registerProviders } from './config/registry.js';
import { listTables, openDatabase, type Db } from './db/index.js';
import { upsertProviders } from './db/repositories/providers.js';
import { startHttp, type HttpHandle } from './http/server.js';
import { asrRegistration, createAsrProvider } from './providers/asr/index.js';
import { createDecisionProvider, decisionRegistration } from './providers/decision/index.js';
import { createModelProvider, modelRegistration, MOCK_MODEL_ID } from './providers/model/index.js';
import { JobQueue } from './queue/job-queue.js';
import { createIntake } from './watcher/intake.js';
import { startWatcher, type WatcherHandle } from './watcher/watcher.js';
import { registerEchoHandler } from './worker/handlers/echo.js';
import { registerEnrichHandler } from './worker/handlers/enrich.js';
import { registerRealignHandler } from './worker/handlers/realign.js';
import { registerSplitHandler } from './worker/handlers/split.js';
import { registerTranscribeHandler } from './worker/handlers/transcribe.js';
import { Worker } from './worker/worker.js';

export interface Hub {
  config: HubConfig;
  registry: ProviderRegistry;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  watcher: WatcherHandle;
  http: HttpHandle;
  stop(): Promise<void>;
}

export interface BootstrapOptions {
  log?: (message: string) => void;
}

const defaultLog = (message: string): void => console.log(`[hub] ${message}`);

/**
 * Bring the Hub up in the order fixed by spec §11:
 * load config → register providers → open db + migrate → start worker loop →
 * start watcher → start HTTP.
 */
export async function bootstrap(
  config: HubConfig = loadConfig(),
  opts: BootstrapOptions = {},
): Promise<Hub> {
  const log = opts.log ?? defaultLog;

  log(
    `config: dataDir=${config.dataDir} dbPath=${config.dbPath} http=${config.http.host}:${config.http.port}`,
  );

  // 1. Providers (ADR-0009): build the selected implementations behind their
  //    interfaces, then persist/register only their metadata.
  const asr = createAsrProvider({
    provider: config.asr.provider,
    baseUrl: config.asr.baseUrl,
    model: config.asr.model,
    apiKey: config.asr.apiKey,
    timeoutMs: config.asr.timeoutMs ?? undefined,
  });
  const model = createModelProvider({
    provider: config.model.provider,
    baseUrl: config.model.baseUrl,
    model: config.model.model,
    apiKey: config.model.apiKey,
    timeoutMs: config.model.timeoutMs ?? undefined,
  });
  const decision = createDecisionProvider({
    provider: config.decision.provider,
    endpoint: config.decision.endpoint,
    model: config.decision.model,
    apiKey: config.decision.apiKey,
    timeoutMs: config.decision.timeoutMs ?? undefined,
    thresholds: config.gate,
  });

  const asrCredential: CredentialSource =
    config.asr.provider === 'funasr'
      ? { kind: 'env', name: 'IDEA_RELAY_FUNASR_API_KEY' }
      : { kind: 'none' };
  const modelCredential: CredentialSource =
    config.model.provider === 'openai'
      ? { kind: 'env', name: 'IDEA_RELAY_MODEL_API_KEY' }
      : { kind: 'none' };
  const decisionCredential: CredentialSource =
    config.decision.provider === 'jev'
      ? { kind: 'env', name: 'TYPESAFE_API_KEY' }
      : { kind: 'none' };

  const registrations: ProviderRegistration[] = [
    asrRegistration(asr, asrCredential),
    modelRegistration(model, modelCredential),
    decisionRegistration(decision, decisionCredential),
    ...config.providers,
  ];
  const registry = registerProviders(registrations);
  log(
    `providers: registered ${registry.list().length} (asr=${asr.id} model=${model.id} decision=${decision.id})`,
  );

  // 2. Database.
  const db = openDatabase(config.dbPath);
  log(`db: migrated ${config.dbPath} (${listTables(db.sqlite).length} tables)`);

  const seeded = upsertProviders(db.sqlite, registrations);
  if (seeded > 0) log(`providers: persisted ${seeded} rows`);

  // 3. Worker loop with the transcribe → enrich handlers.
  const queue = new JobQueue(db.sqlite, config.worker.maxAttempts);
  const worker = new Worker(queue, {
    workerId: config.worker.workerId,
    pollIntervalMs: config.worker.pollIntervalMs,
    stallTimeoutMs: config.worker.stallTimeoutMs,
  });
  registerEchoHandler(worker);
  registerTranscribeHandler(worker, {
    sqlite: db.sqlite,
    dataDir: config.dataDir,
    asr,
    transcribeOpts: {
      languageHints: config.asr.languageHints,
      hotwords: config.asr.hotwords,
    },
    queue,
    log,
  });
  registerEnrichHandler(worker, {
    sqlite: db.sqlite,
    dataDir: config.dataDir,
    model,
    decision,
    modelName: config.model.model ?? MOCK_MODEL_ID,
    thresholds: config.gate,
    queue,
    log,
  });
  registerSplitHandler(worker, {
    sqlite: db.sqlite,
    dataDir: config.dataDir,
    model,
    modelName: config.model.model ?? MOCK_MODEL_ID,
    log,
  });
  registerRealignHandler(worker, {
    sqlite: db.sqlite,
    dataDir: config.dataDir,
    log,
  });
  worker.start();
  log('worker: loop started (handlers: echo, transcribe, enrich, split, realign)');

  // 4. Consume-folder watcher → intake.
  const intake = createIntake({
    sqlite: db.sqlite,
    queue,
    dataDir: config.dataDir,
    log,
  });
  const watcher = await startWatcher({
    inboxDir: config.inboxDir,
    onFile: async (filePath) => {
      await intake.handleFile(filePath);
    },
    log,
  });

  // 5. HTTP, including the mobile-facing tus upload endpoint (spec §11).
  const http = await startHttp({
    ...config.http,
    tus: {
      tusDir: config.tusDir,
      inboxDir: config.inboxDir,
    },
    log,
  });

  log('ready');

  return {
    config,
    registry,
    db,
    queue,
    worker,
    watcher,
    http,
    async stop(): Promise<void> {
      await worker.stop();
      await watcher.stop();
      await http.close();
      db.sqlite.close();
    },
  };
}
