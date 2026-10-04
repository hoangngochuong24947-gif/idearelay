import { mkdirSync } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import { isFinalizedAudioFile } from '../util/media.js';

export interface AwaitWriteFinishOptions {
  stabilityThreshold: number;
  pollInterval: number;
}

export interface WatcherOptions {
  /** The consume folder, e.g. `data/inbox`. */
  inboxDir: string;
  /** Invoked once per finalized file. Errors are caught and logged. */
  onFile: (filePath: string) => Promise<void> | void;
  log?: (message: string) => void;
  /** chokidar `awaitWriteFinish`; defaults to 200ms / 50ms. */
  awaitWriteFinish?: AwaitWriteFinishOptions;
}

export interface WatcherHandle {
  /** The underlying chokidar watcher (exposed for tests). */
  watcher: FSWatcher;
  stop(): Promise<void>;
}

const DEFAULT_AWF: AwaitWriteFinishOptions = {
  stabilityThreshold: 200,
  pollInterval: 50,
};

/**
 * Real consume-folder watcher (spec §11, §13 step 3; stack-survey §二). Mobile
 * uploads land as `.part` and are atomically `mv`'d; `awaitWriteFinish` plus the
 * finalized-file filter guarantee only completed audio triggers intake. Files
 * already present on startup are processed too (`ignoreInitial: false`), which is
 * the crash-recovery path. Handling is serialized so rapid adds cannot race on a
 * single recording row.
 */
export async function startWatcher(opts: WatcherOptions): Promise<WatcherHandle> {
  mkdirSync(opts.inboxDir, { recursive: true });

  const watcher = watch(opts.inboxDir, {
    ignoreInitial: false,
    depth: 0, // the consume folder is flat
    persistent: true,
    awaitWriteFinish: opts.awaitWriteFinish ?? DEFAULT_AWF,
  });

  let chain: Promise<void> = Promise.resolve();
  const handle = (filePath: string): void => {
    chain = chain.then(async () => {
      if (!isFinalizedAudioFile(filePath)) return;
      try {
        await opts.onFile(filePath);
      } catch (error) {
        opts.log?.(
          `watcher: failed to handle ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

  watcher.on('add', handle);
  watcher.on('error', (error) => {
    opts.log?.(
      `watcher: error ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  opts.log?.(`watcher: watching ${opts.inboxDir}`);

  return {
    watcher,
    async stop(): Promise<void> {
      await chain.catch(() => undefined);
      await watcher.close();
    },
  };
}
