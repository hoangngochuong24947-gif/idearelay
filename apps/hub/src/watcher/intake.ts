import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { EVENT_TYPES } from '@idearelay/contracts';
import type { SqliteDb } from '../db/types.js';
import { appendEvent } from '../db/repositories/events.js';
import * as recordings from '../db/repositories/recordings.js';
import type { JobQueue } from '../queue/job-queue.js';
import { isFinalizedAudioFile, mimeForPath } from '../util/media.js';

export interface IntakeDeps {
  sqlite: SqliteDb;
  queue: JobQueue;
  dataDir: string;
  now?: () => number;
  log?: (message: string) => void;
}

export interface IntakeResult {
  handled: boolean;
  reason?: string;
  recordingId?: string;
  /** True when an identical file had already been received. */
  deduped?: boolean;
}

export interface Intake {
  /** Called by the watcher for every finalized file that appears in `inbox/`. */
  handleFile(filePath: string): Promise<IntakeResult>;
}

/** Stable idempotency key so re-dropping the same file never double-enqueues. */
export function transcribeIdempotencyKey(
  recordingId: string,
  checksum: string,
): string {
  return `transcribe:${recordingId}:${checksum}`;
}

/**
 * The consume-folder intake (spec §11, §13 step 3). Computes the checksum,
 * archives the audio under `data/recordings/<id>/`, upserts the `recordings` row
 * (status `received`), records `recording.received`, and idempotently enqueues a
 * `transcribe` job — all in one transaction.
 */
export function createIntake(deps: IntakeDeps): Intake {
  const { sqlite, queue, dataDir } = deps;
  const now = deps.now ?? ((): number => Date.now());

  return {
    async handleFile(filePath: string): Promise<IntakeResult> {
      if (!isFinalizedAudioFile(filePath)) {
        return { handled: false, reason: 'not-finalized-audio' };
      }
      if (!existsSync(filePath)) {
        return { handled: false, reason: 'missing' };
      }

      const checksum = await sha256File(filePath);
      const existing = recordings.findRecordingByChecksum(sqlite, checksum);

      if (existing !== null) {
        // Identical content already received: re-assert the (idempotent) job and
        // drop the duplicate inbox file. Never creates a second recording.
        queue.enqueue({
          kind: 'transcribe',
          payload: { recordingId: existing.id },
          idempotencyKey: transcribeIdempotencyKey(existing.id, checksum),
        });
        safeRemove(filePath);
        deps.log?.(
          `intake: duplicate ignored (checksum=${checksum.slice(0, 12)}…) recording=${existing.id}`,
        );
        return { handled: true, recordingId: existing.id, deduped: true };
      }

      const id = randomUUID();
      const ext = extname(filePath).toLowerCase();
      const dest = join(dataDir, 'recordings', id, `audio${ext}`);
      mkdirSync(dirname(dest), { recursive: true });
      moveFile(filePath, dest);

      const at = now();
      const writeOnce = sqlite.transaction(() => {
        recordings.insertRecording(sqlite, {
          id,
          createdAt: at,
          audioPath: dest,
          audioChecksum: checksum,
          status: 'received',
        });
        appendEvent(sqlite, {
          aggregateType: 'recording',
          aggregateId: id,
          type: EVENT_TYPES.RecordingReceived,
          payload: { audioPath: dest, checksum, mime: mimeForPath(dest) },
          createdAt: at,
        });
        queue.enqueue({
          kind: 'transcribe',
          payload: { recordingId: id },
          idempotencyKey: transcribeIdempotencyKey(id, checksum),
        });
      });
      writeOnce();

      deps.log?.(`intake: received recording=${id} checksum=${checksum.slice(0, 12)}…`);
      return { handled: true, recordingId: id, deduped: false };
    },
  };
}

function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch {
    // Cross-device fallback: copy then remove.
    copyFileSync(src, dest);
    safeRemove(src);
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort — a leftover duplicate is harmless.
  }
}
