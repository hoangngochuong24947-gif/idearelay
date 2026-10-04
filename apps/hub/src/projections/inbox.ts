import { join } from 'node:path';
import type { InboxKind, InboxStatus } from '@idearelay/contracts';
import { writeProjectionFile, type ProjectionWriteResult } from './io.js';
import { formatConfidence } from './summary.js';

export interface InboxItemProjectionInput {
  dataDir: string;
  itemId: string;
  kind: InboxKind;
  status: InboxStatus;
  recordingId: string;
  revisionId: string;
  summary: string;
  tags: readonly string[];
  confidence: number;
  abstained: boolean;
  /** Human-readable reason this item landed in the Inbox (the gate outcome). */
  reason: string;
  createdAt: number;
}

/**
 * Write a per-InboxItem projection + `.sha256` under `data/inbox-items/` (spec §5.8).
 * It must NOT live in `data/inbox/`, which §4 reserves as the phone-upload consume
 * folder; keeping the two separate avoids projecting files into the watch target.
 */
export function writeInboxItemProjection(
  input: InboxItemProjectionInput,
): ProjectionWriteResult {
  const path = join(input.dataDir, 'inbox-items', `${input.itemId}.md`);
  return writeProjectionFile(path, renderInboxItemMarkdown(input));
}

export function renderInboxItemMarkdown(input: InboxItemProjectionInput): string {
  const lines: string[] = [];
  lines.push('# InboxItem');
  lines.push('');
  lines.push(`- id: \`${input.itemId}\``);
  lines.push(`- kind: \`${input.kind}\``);
  lines.push(`- status: \`${input.status}\``);
  lines.push(`- recording: \`${input.recordingId}\``);
  lines.push(`- revision: \`${input.revisionId}\``);
  lines.push(`- confidence: ${formatConfidence(input.confidence)}`);
  lines.push(`- abstained: ${input.abstained ? 'true' : 'false'}`);
  lines.push(`- tags: ${input.tags.length > 0 ? input.tags.join(', ') : '-'}`);
  lines.push(`- reason: ${input.reason}`);
  lines.push(`- created_at: \`${new Date(input.createdAt).toISOString()}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(input.summary.trim());
  lines.push('');
  return lines.join('\n');
}
