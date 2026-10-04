import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EVENT_TYPES, type ProjectedFile, type SyncProvider } from '@idearelay/contracts';
import { appendEvent } from '../../db/repositories/events.js';
import type { SqliteDb } from '../../db/types.js';
import type { Worker } from '../../worker/worker.js';

/**
 * The `sync` job kind (spec §7.5 / M7): collect every existing projection file
 * under the data dir and push them through the SyncProvider into the configured
 * target. One-way mirror only — the target is never read back into business
 * logic. Idempotent: unchanged files are skipped by checksum.
 */

/** Payload of a `sync` job (empty; the job always mirrors everything). */
export interface SyncJobPayload {}

export interface SyncJobDeps {
  sqlite: SqliteDb;
  dataDir: string;
  /** Interface only — never a concrete class (ADR-0009). */
  sync: SyncProvider;
  /**
   * Absolute target dir from `IDEA_RELAY_SYNC_TARGET_DIR`. When null the job is
   * a no-op (sync is disabled).
   */
  targetDir: string | null;
  log?: (message: string) => void;
}

/** Directories under the data dir that are NOT projections (never mirrored). */
const EXCLUDED_DIRS = new Set(['inbox', 'tus-uploads']);

/** Runtime files (DB + WAL/SHM) are truth-adjacent state, not projections. */
const EXCLUDED_FILES = new Set(['idea-relay.db', 'idea-relay.db-wal', 'idea-relay.db-shm']);

/** Walk the data dir and collect every projection file with its checksum. */
export function collectProjectedFiles(dataDir: string): ProjectedFile[] {
  const files: ProjectedFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith('.tmp')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || EXCLUDED_FILES.has(entry.name)) continue;
      const content = readFileSync(fullPath);
      files.push({
        path: relative(dataDir, fullPath),
        checksum: createHash('sha256').update(content).digest('hex'),
      });
    }
  };
  try {
    walk(dataDir);
  } catch {
    // Data dir missing → nothing to mirror.
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function registerSyncHandler(worker: Worker, deps: SyncJobDeps): void {
  worker.register('sync', async () => {
    if (deps.targetDir === null) {
      deps.log?.('sync: disabled (IDEA_RELAY_SYNC_TARGET_DIR unset)');
      return { pushed: 0, skipped: 0, errors: [], disabled: true };
    }
    const files = collectProjectedFiles(deps.dataDir);
    const result = await deps.sync.push(
      { id: 'hub-mirror', kind: 'local-dir', config: { dir: deps.targetDir } },
      files,
    );
    appendEvent(deps.sqlite, {
      aggregateType: 'provider',
      aggregateId: deps.sync.id,
      type: EVENT_TYPES.SyncCompleted,
      payload: {
        target: deps.targetDir,
        pushed: result.pushed,
        skipped: result.skipped,
        errorCount: result.errors.length,
        errors: result.errors,
      },
    });
    return result;
  });
}
