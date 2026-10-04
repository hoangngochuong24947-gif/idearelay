import { join } from 'node:path';
import { writeProjectionFile, type ProjectionWriteResult } from './io.js';
import { formatDurationMs } from './transcript.js';

export interface BilingualRow {
  idx: number;
  startMs: number;
  endMs: number;
  /** The original segment text — the truth this projection is derived from. */
  text: string;
  /** The English rendering produced by the ModelProvider (§15). */
  english: string;
}

export interface BilingualProjectionInput {
  dataDir: string;
  recordingId: string;
  revision: {
    id: string;
    providerId: string | null;
    model: string | null;
    createdAt: number;
  };
  rows: readonly BilingualRow[];
}

/**
 * Write the 中英对照 (bilingual) transcript projection + `.sha256` under
 * `data/recordings/<recording_id>/transcript.bilingual.md` (spec §15: 转写层
 * 直接出双语). This is a **derived** projection: the `segments` rows remain
 * truth, and re-running replaces the file wholesale (never merges).
 */
export function writeBilingualProjection(
  input: BilingualProjectionInput,
): ProjectionWriteResult {
  const path = join(
    input.dataDir,
    'recordings',
    input.recordingId,
    'transcript.bilingual.md',
  );
  return writeProjectionFile(path, renderBilingualMarkdown(input));
}

export function renderBilingualMarkdown(input: BilingualProjectionInput): string {
  const { revision, rows, recordingId } = input;
  const lines: string[] = [];
  lines.push('# Bilingual Transcript (中英对照)');
  lines.push('');
  lines.push(
    '> Derived projection (spec §15: 转写层直接出双语). The transcript rows',
  );
  lines.push('> remain truth; this file is regenerated from them and a re-run');
  lines.push('> replaces it wholesale — manual edits here are never merged back.');
  lines.push('');
  lines.push(`- recording: \`${recordingId}\``);
  lines.push(`- revision: \`${revision.id}\``);
  lines.push(`- provider: \`${revision.providerId ?? '-'}\``);
  lines.push(`- model: \`${revision.model ?? '-'}\``);
  lines.push(`- created_at: \`${new Date(revision.createdAt).toISOString()}\``);
  lines.push(`- segments: ${rows.length}`);
  lines.push('');
  lines.push('## Segments');
  lines.push('');
  for (const row of rows) {
    lines.push(
      `[${formatDurationMs(row.startMs)} → ${formatDurationMs(row.endMs)}] ${row.text}`,
    );
    lines.push(`  EN: ${row.english}`);
  }
  lines.push('');
  return lines.join('\n');
}
