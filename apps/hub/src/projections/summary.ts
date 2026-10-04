import { join } from 'node:path';
import type { InboxKind } from '@idearelay/contracts';
import { writeProjectionFile, type ProjectionWriteResult } from './io.js';

export interface SummaryProjectionInput {
  dataDir: string;
  recordingId: string;
  revisionId: string;
  kind: InboxKind;
  confidence: number;
  abstained: boolean;
  tags: readonly string[];
  summary: string;
  model: string | null;
  createdAt: number;
}

/**
 * Write `data/recordings/<recording_id>/summary.md` + `.sha256` (spec §5.8).
 * Layout is deterministic: same rows always render byte-identical markdown.
 */
export function writeSummaryProjection(
  input: SummaryProjectionInput,
): ProjectionWriteResult {
  const path = join(input.dataDir, 'recordings', input.recordingId, 'summary.md');
  return writeProjectionFile(path, renderSummaryMarkdown(input));
}

export function renderSummaryMarkdown(input: SummaryProjectionInput): string {
  const lines: string[] = [];
  lines.push('# Summary');
  lines.push('');
  lines.push(`- recording: \`${input.recordingId}\``);
  lines.push(`- revision: \`${input.revisionId}\``);
  lines.push(`- kind: \`${input.kind}\``);
  lines.push(`- confidence: ${formatConfidence(input.confidence)}`);
  lines.push(`- abstained: ${input.abstained ? 'true' : 'false'}`);
  lines.push(`- tags: ${input.tags.length > 0 ? input.tags.join(', ') : '-'}`);
  lines.push(`- model: \`${input.model ?? '-'}\``);
  lines.push(`- created_at: \`${new Date(input.createdAt).toISOString()}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(input.summary.trim());
  lines.push('');
  return lines.join('\n');
}

/** Stable 4-decimal confidence formatting (diff-friendly). */
export function formatConfidence(value: number): string {
  return value.toFixed(4);
}
