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
import { JobQueue } from './queue/job-queue.js';
import { createIntake } from './watcher/intake.js';
import { startWatcher, type WatcherHandle } from './watcher/watcher.js';
import { registerEchoHandler } from './worker/handlers/echo.js';
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

  // 1. Providers (ADR-0009): build the selected ASR implementation behind the
  //    interface, then persist/register only its metadata.
  const asr = createAsrProvider({
    provider: config.asr.provider,
    baseUrl: config.asr.baseUrl,
    model: config.asr.model,
    apiKey: config.asr.apiKey,
    timeoutMs: config.asr.timeoutMs ?? undefined,
  });
  const credentialSource: CredentialSource =
    config.asr.provider === 'funasr'
      ? { kind: 'env', name: 'IDEA_RELAY_FUNASR_API_KEY' }
      : { kind: 'none' };
  const registrations: ProviderRegistration[] = [
    asrRegistration(asr, credentialSource),
    ...config.providers,
  ];
  const registry = registerProviders(registrations);
  log(`providers: registered ${registry.list().length} (asr=${asr.id})`);

  // 2. Database.
  const db = openDatabase(config.dbPath);
  log(`db: migrated ${config.dbPath} (${listTables(db.sqlite).length} tables)`);

  const seeded = upsertProviders(db.sqlite, registrations);
  if (seeded > 0) log(`providers: persisted ${seeded} rows`);

  // 3. Worker loop with the transcribe handler.
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
    log,
  });
  worker.start();
  log('worker: loop started (handlers: echo, transcribe)');

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

  // 5. HTTP.
  const http = await startHttp({ ...config.http, log });

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
