import type { RecordingStatus } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

/** Raw `recordings` row (§5.1). Rows are truth (ADR-0002). */
export interface RecordingRow {
  id: string;
  created_at: number;
  source_device: string | null;
  duration_ms: number | null;
  sample_rate: number | null;
  channels: number | null;
  audio_path: string | null;
  audio_checksum: string | null;
  status: RecordingStatus;
}

export interface NewRecording {
  id: string;
  createdAt: number;
  sourceDevice?: string | null;
  durationMs?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  audioPath?: string | null;
  audioChecksum?: string | null;
  status: RecordingStatus;
}

export function insertRecording(sqlite: SqliteDb, rec: NewRecording): void {
  sqlite
    .prepare(
      `INSERT INTO recordings
         (id, created_at, source_device, duration_ms, sample_rate, channels,
          audio_path, audio_checksum, status)
       VALUES (@id, @created_at, @source_device, @duration_ms, @sample_rate,
               @channels, @audio_path, @audio_checksum, @status)`,
    )
    .run({
      id: rec.id,
      created_at: rec.createdAt,
      source_device: rec.sourceDevice ?? null,
      duration_ms: rec.durationMs ?? null,
      sample_rate: rec.sampleRate ?? null,
      channels: rec.channels ?? null,
      audio_path: rec.audioPath ?? null,
      audio_checksum: rec.audioChecksum ?? null,
      status: rec.status,
    });
}

export function getRecording(sqlite: SqliteDb, id: string): RecordingRow | null {
  const row = sqlite
    .prepare('SELECT * FROM recordings WHERE id = ?')
    .get(id) as RecordingRow | undefined;
  return row ?? null;
}

/**
 * Find an existing recording by audio checksum. The watcher uses this to reuse
 * the same row when the identical file is dropped twice, so a re-drop never
 * creates a second recording (spec §11 consume folder).
 */
export function findRecordingByChecksum(
  sqlite: SqliteDb,
  checksum: string,
): RecordingRow | null {
  const row = sqlite
    .prepare(
      'SELECT * FROM recordings WHERE audio_checksum = ? ORDER BY created_at ASC LIMIT 1',
    )
    .get(checksum) as RecordingRow | undefined;
  return row ?? null;
}

export function setRecordingStatus(
  sqlite: SqliteDb,
  id: string,
  status: RecordingStatus,
): void {
  sqlite.prepare('UPDATE recordings SET status = ? WHERE id = ?').run(status, id);
}

export function countRecordings(sqlite: SqliteDb): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM recordings').get() as {
    n: number;
  };
  return row.n;
}
