import type { ProviderRegistry } from '@idearelay/contracts';
import { loadConfig, type HubConfig } from './config/config.js';
import { registerProviders } from './config/registry.js';
import { listTables, openDatabase, type Db } from './db/index.js';
import { upsertProviders } from './db/repositories/providers.js';
import { startHttp, type HttpHandle } from './http/server.js';
import { JobQueue } from './queue/job-queue.js';
import { startWatcher, type WatcherHandle } from './watcher/watcher.js';
import { registerEchoHandler } from './worker/handlers/echo.js';
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

  const registry = registerProviders(config.providers);
  log(`providers: registered ${registry.list().length}`);

  const db = openDatabase(config.dbPath);
  log(`db: migrated ${config.dbPath} (${listTables(db.sqlite).length} tables)`);

  const seeded = upsertProviders(db.sqlite, config.providers);
  if (seeded > 0) log(`providers: persisted ${seeded} rows`);

  const queue = new JobQueue(db.sqlite, config.worker.maxAttempts);
  const worker = new Worker(queue, {
    workerId: config.worker.workerId,
    pollIntervalMs: config.worker.pollIntervalMs,
    stallTimeoutMs: config.worker.stallTimeoutMs,
  });
  registerEchoHandler(worker);
  worker.start();
  log('worker: loop started (handler: echo)');

  const watcher = await startWatcher({ inboxDir: config.inboxDir, log });

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
