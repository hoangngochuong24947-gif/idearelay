import type {
  CredentialSource,
  ProviderRegistration,
  ProviderRegistry,
} from '@idearelay/contracts';
import { loadConfig, type HubConfig } from './config/config.js';
import { registerProviders } from './config/registry.js';
import { listTables, openDatabase, type Db } from './db/index.js';
import { upsertProviders } from './db/repositories/providers.js';
import { DryRunExecutorProvider } from './workflows/executor-dry-run.js';
import { seedWorkflowSpecs } from './workflows/seed.js';
import { WorkflowRunner } from './workflows/runner.js';
import { startHttp, type HttpHandle } from './http/server.js';
import { asrRegistration, createAsrProvider } from './providers/asr/index.js';
import { createDecisionProvider, decisionRegistration } from './providers/decision/index.js';
import { createModelProvider, modelRegistration, MOCK_MODEL_ID } from './providers/model/index.js';
import { createRagProvider, ragProviderRegistration } from './providers/rag/index.js';
import { LocalDirSyncProvider, syncProviderRegistration } from './providers/sync/index.js';
import { JobQueue } from './queue/job-queue.js';
import { createIntake } from './watcher/intake.js';
import { startWatcher, type WatcherHandle } from './watcher/watcher.js';
import { registerBilingualHandler } from './worker/handlers/bilingual.js';
import { registerEchoHandler } from './worker/handlers/echo.js';
import { registerEnrichHandler } from './worker/handlers/enrich.js';
import { registerRealignHandler } from './worker/handlers/realign.js';
import { registerSplitHandler } from './worker/handlers/split.js';
import { registerSyncHandler } from './worker/handlers/sync.js';
import { registerTranscribeHandler } from './worker/handlers/transcribe.js';
import { registerWorkflowRunHandler } from './worker/handlers/workflow-run.js';
import { Worker } from './worker/worker.js';

export interface Hub {
  config: HubConfig;
  registry: ProviderRegistry;
  db: Db;
  queue: JobQueue;
  worker: Worker;
  watcher: WatcherHandle;
  http: HttpHandle;
  /** The M5 WorkflowRun engine (spec §8). */
  runner: WorkflowRunner;
  stop(): Promise<void>;
}

export interface BootstrapOptions {
  log?: (message: string) => void;
}

const defaultLog = (message: string): void => console.log(`[hub] ${message}`);

/** How often the one-way mirror re-pushes projections (§7.5). */
const SYNC_ENQUEUE_INTERVAL_MS = 60_000;

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

  // Executor (§7.7 / ADR-0006): MVP ships only the dry-run implementation.
  const executor = new DryRunExecutorProvider({ log });
  const executorRegistration: ProviderRegistration = {
    id: executor.id,
    kind: 'executor',
    name: 'Dry-run executor (file handoff, no code execution)',
    credentialSource: { kind: 'none' },
    capabilities: executor.capabilities,
    enabled: true,
  };

  // SyncProvider (§7.5, M7): one-way local-dir mirror, disabled when the target
  // env is unset. The target is a mirror only, never a source (ADR-0002).
  const syncProvider = new LocalDirSyncProvider({ dataDir: config.dataDir, log });
  const syncRegistration = syncProviderRegistration(
    syncProvider,
    config.sync.targetDir !== null,
  );

  const registrations: ProviderRegistration[] = [
    asrRegistration(asr, asrCredential),
    modelRegistration(model, modelCredential),
    decisionRegistration(decision, decisionCredential),
    executorRegistration,
    syncRegistration,
    ...config.providers,
  ];
  const registry = registerProviders(registrations);
  log(
    `providers: registered ${registry.list().length} (asr=${asr.id} model=${model.id} decision=${decision.id})`,
  );

  // 2. Database.
  const db = openDatabase(config.dbPath);
  log(`db: migrated ${config.dbPath} (${listTables(db.sqlite).length} tables)`);

  // RagProvider (§7.6): sqlite-vec + FTS5 + sqlite-lembed, created after the db
  // file exists (it opens its own dedicated connection). Degrades to BM25-only
  // when the local .gguf model is missing/unloadable.
  const rag = createRagProvider({ dbPath: config.dbPath });
  const ragRegistration = ragProviderRegistration(rag);
  registrations.push(ragRegistration);
  registry.register(ragRegistration);
  log(
    `rag: ${rag.id} hybrid=${rag.capabilities.hybrid} embedding=${rag.capabilities.embeddingModel ?? 'none (BM25-only)'}`,
  );

  const seeded = upsertProviders(db.sqlite, registrations);
  if (seeded > 0) log(`providers: persisted ${seeded} rows`);

  // WorkflowSpec seed (§8.1) — idempotent.
  if (seedWorkflowSpecs(db.sqlite)) {
    log('workflows: seeded requirement-research spec');
  }

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
  registerBilingualHandler(worker, {
    sqlite: db.sqlite,
    dataDir: config.dataDir,
    model,
    modelName: config.model.model ?? MOCK_MODEL_ID,
    log,
  });
  registerSyncHandler(worker, {
    sqlite: db.sqlite,
    dataDir: config.dataDir,
    sync: syncProvider,
    targetDir: config.sync.targetDir,
    log,
  });

  // 3b. WorkflowRun engine (M5, spec §8): gate scan → run jobs → Pi stages.
  const runner = new WorkflowRunner(
    {
      sqlite: db.sqlite,
      dataDir: config.dataDir,
      registry,
      executor,
      ragProvider: rag,
      heartbeatMs: config.workflow.heartbeatMs,
      log,
    },
    { staleRunMs: config.workflow.staleRunMs },
  );
  registerWorkflowRunHandler(worker, runner);
  const recovered = await runner.recoverStaleRuns(config.workflow.staleRunMs);
  if (recovered.length > 0) log(`workflows: recovered ${recovered.length} stale run(s)`);
  const triggerTimer = setInterval(() => {
    try {
      runner.startPendingRequirementRuns();
    } catch (error) {
      log(`workflows: gate scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, config.workflow.triggerIntervalMs);
  triggerTimer.unref();
  runner.startPendingRequirementRuns();
  log(
    `workflows: run engine started (trigger=${config.workflow.triggerIntervalMs}ms heartbeat=${config.workflow.heartbeatMs}ms stale=${config.workflow.staleRunMs}ms)`,
  );

  worker.start();
  log('worker: loop started (handlers: echo, transcribe, enrich, split, realign, bilingual, sync)');

  // One-way mirror (§7.5): enqueue a `sync` job at startup and periodically;
  // each run skips unchanged files, so this is cheap and idempotent.
  queue.enqueue({ kind: 'sync' });
  const syncTimer = setInterval(() => {
    queue.enqueue({ kind: 'sync' });
  }, SYNC_ENQUEUE_INTERVAL_MS);
  syncTimer.unref();

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

  // 5. HTTP, including the mobile-facing tus upload endpoint and the M5
  //    run-observation routes (spec §11).
  const http = await startHttp({
    ...config.http,
    tus: {
      tusDir: config.tusDir,
      inboxDir: config.inboxDir,
    },
    db: db.sqlite,
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
    runner,
    async stop(): Promise<void> {
      clearInterval(triggerTimer);
      clearInterval(syncTimer);
      await worker.stop();
      await watcher.stop();
      await http.close();
      db.sqlite.close();
    },
  };
}
