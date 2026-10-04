import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface ProjectionSegment {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
}

export interface TranscriptProjectionInput {
  dataDir: string;
  recordingId: string;
  revision: {
    id: string;
    providerId: string | null;
    model: string | null;
    languageHints: string | null;
    createdAt: number;
  };
  segments: readonly ProjectionSegment[];
}

export interface TranscriptProjectionResult {
  /** Absolute path of the written markdown file. */
  path: string;
  /** Hex SHA-256 of the markdown bytes. */
  sha256: string;
}

/**
 * Deterministically write the Final Transcript projection and its `.sha256`
 * sidecar (spec §5.8, ADR-0002). Projections are write-only outputs — the Hub
 * never reads them back for business logic.
 *
 * Layout: `data/recordings/<recording_id>/transcript.final.md`.
 */
export function writeTranscriptFinalProjection(
  input: TranscriptProjectionInput,
): TranscriptProjectionResult {
  const dir = join(input.dataDir, 'recordings', input.recordingId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.final.md');

  const markdown = renderTranscriptFinalMarkdown(input);
  const bytes = Buffer.from(markdown, 'utf8');

  // Write via a temp file + atomic rename so readers never see a partial file.
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, path);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, 'utf8');

  return { path, sha256 };
}

/** Deterministic markdown renderer (no wall-clock reads beyond the revision). */
export function renderTranscriptFinalMarkdown(
  input: TranscriptProjectionInput,
): string {
  const { revision, segments, recordingId } = input;
  const lines: string[] = [];
  lines.push('# Final Transcript');
  lines.push('');
  lines.push(`- recording: \`${recordingId}\``);
  lines.push(`- revision: \`${revision.id}\``);
  lines.push(`- provider: \`${revision.providerId ?? '-'}\``);
  lines.push(`- model: \`${revision.model ?? '-'}\``);
  lines.push(`- language_hints: \`${revision.languageHints ?? '-'}\``);
  lines.push(`- created_at: \`${new Date(revision.createdAt).toISOString()}\``);
  lines.push(`- segments: ${segments.length}`);
  lines.push('');
  lines.push('## Segments');
  lines.push('');
  for (const seg of segments) {
    const speaker = seg.speaker !== null ? `${seg.speaker} ` : '';
    const confidence =
      seg.confidence !== null ? `(${seg.confidence.toFixed(2)}) ` : '';
    lines.push(
      `[${formatDurationMs(seg.startMs)} → ${formatDurationMs(seg.endMs)}] ${speaker}${confidence}${seg.text}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** `HH:MM:SS.mmm` — stable and diff-friendly. */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}
