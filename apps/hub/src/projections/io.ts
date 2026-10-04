import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface ProjectionWriteResult {
  /** Absolute path of the written projection file. */
  path: string;
  /** Hex SHA-256 of the file bytes. */
  sha256: string;
}

/**
 * Deterministically write a projection file with its `.sha256` sidecar and an
 * atomic `.tmp → rename` (spec §5.8, ADR-0002). Projections are write-only:
 * the Hub never reads them back for business logic.
 */
export function writeProjectionFile(
  path: string,
  content: string | Buffer,
): ProjectionWriteResult {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, path);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, 'utf8');

  return { path, sha256 };
}
