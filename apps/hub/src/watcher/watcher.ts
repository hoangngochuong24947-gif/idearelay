import { mkdirSync } from 'node:fs';

export interface WatcherOptions {
  inboxDir: string;
  log?: (message: string) => void;
}

export interface WatcherHandle {
  stop(): Promise<void>;
}

/**
 * M0 stub: ensures the consume folder exists. Real chokidar watching
 * (`awaitWriteFinish` + atomic `.part` → `mv` dedupe) lands in M1.
 */
export async function startWatcher(opts: WatcherOptions): Promise<WatcherHandle> {
  mkdirSync(opts.inboxDir, { recursive: true });
  opts.log?.(
    `watcher: consume folder ready at ${opts.inboxDir} (M0 stub — not watching yet)`,
  );
  return {
    async stop(): Promise<void> {
      // no resources held in M0
    },
  };
}
