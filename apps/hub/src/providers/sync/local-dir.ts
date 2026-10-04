import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import type {
  ProjectedFile,
  SyncProvider,
  SyncResult,
  SyncTarget,
} from '@idearelay/contracts';

/**
 * First real `SyncProvider` (spec §7.5, ADR-0002): a strict **one-way mirror**
 * into a target local directory. `ProjectedFile.path` is relative to the Hub's
 * data dir; the same relative tree is reproduced under the target. Files whose
 * checksum already matches the target are skipped, so the `sync` job is
 * idempotent and cheap to re-run.
 *
 * The target is **never read back into business logic** — it is a mirror, not
 * a source (rows are truth), and no conflict resolution exists by design.
 */
export class LocalDirSyncProvider implements SyncProvider {
  readonly id = 'local-dir';
  readonly capabilities = { direction: 'push' as const, ttlDays: null };

  constructor(
    private readonly opts: {
      /** Absolute path of the Hub data dir (the projection root). */
      dataDir: string;
      log?: (message: string) => void;
    },
  ) {}

  async push(target: SyncTarget, files: ProjectedFile[]): Promise<SyncResult> {
    const dir = target.config['dir'];
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('LocalDirSyncProvider requires target.config.dir (absolute path)');
    }

    let pushed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const file of files) {
      const relative = normalize(file.path).split(sep).join('/');
      if (relative.startsWith('../') || relative === '..' || relative.startsWith('/')) {
        errors.push(`${file.path}: path escapes the data dir; refusing`);
        continue;
      }
      const sourcePath = join(this.opts.dataDir, relative);
      const targetPath = join(dir, relative);
      try {
        const content = readFileSync(sourcePath);
        const checksum = createHash('sha256').update(content).digest('hex');
        try {
          const targetChecksum = createHash('sha256')
            .update(readFileSync(targetPath))
            .digest('hex');
          if (targetChecksum === checksum) {
            skipped += 1;
            continue;
          }
        } catch {
          // Target missing → push below.
        }
        mkdirSync(dirname(targetPath), { recursive: true });
        // Atomic-ish replace so a concurrent mirror reader never sees a half file.
        const tmpPath = `${targetPath}.tmp`;
        writeFileSync(tmpPath, content);
        renameSync(tmpPath, targetPath);
        pushed += 1;
      } catch (error) {
        errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.opts.log?.(
      `sync: pushed=${pushed} skipped=${skipped} errors=${errors.length} → ${dir}`,
    );
    return { pushed, skipped, errors };
  }
}
