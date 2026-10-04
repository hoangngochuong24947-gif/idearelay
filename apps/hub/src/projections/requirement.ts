import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeProjectionFile, type ProjectionWriteResult } from './io.js';
import { formatDurationMs } from './transcript.js';

/**
 * Deterministic requirement projection (spec §5.8, ADR-0002).
 * Layout: `data/requirements/<id>-<slug>.md`.
 */

export interface RequirementProjectionRef {
  recordingId: string;
  startMs: number;
  endMs: number;
  charStart: number | null;
  charEnd: number | null;
  asrRevisionId: string | null;
  quoteSnippet: string;
}

export interface RequirementProjectionInput {
  dataDir: string;
  requirement: {
    id: string;
    title: string;
    status: string;
    createdAt: number;
    sourceRevisionId: string | null;
  };
  /** Requirement body text (stored in the `requirement.created` event payload). */
  body: string;
  refs: readonly RequirementProjectionRef[];
}

const SLUG_MAX_CHARS = 40;

/**
 * Slug rule: ASCII-safe slugification of the title (`[^a-z0-9]+ → '-'`,
 * trimmed, capped at 40 chars). A title with no ASCII-alphanumeric content
 * (e.g. pure Chinese) falls back to the first 8 hex chars of
 * `sha256(title)` — stable for the same bytes, independent of wall-clock or
 * ids, so a rebuild produces byte-identical filenames (no diff noise).
 */
export function requirementSlug(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, '');
  if (ascii.length > 0) return ascii;
  return createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 8);
}

/** `requirements/<id>-<slug>.md` — the `body_path` stored on the row (§5.2). */
export function requirementBodyPath(id: string, title: string): string {
  return `requirements/${id}-${requirementSlug(title)}.md`;
}

export function renderRequirementMarkdown(input: RequirementProjectionInput): string {
  const { requirement, refs } = input;
  const lines: string[] = [];
  lines.push(`# Requirement: ${requirement.title}`);
  lines.push('');
  lines.push(`- id: \`${requirement.id}\``);
  lines.push(`- status: \`${requirement.status}\``);
  lines.push(`- created_at: \`${new Date(requirement.createdAt).toISOString()}\``);
  lines.push(`- source_revision: \`${requirement.sourceRevisionId ?? '-'}\``);
  lines.push('');
  lines.push('## Body');
  lines.push('');
  lines.push(input.body.trim());
  lines.push('');
  lines.push('## Source anchors');
  lines.push('');
  for (const ref of refs) {
    const chars =
      ref.charStart !== null && ref.charEnd !== null
        ? ` · chars ${ref.charStart}–${ref.charEnd}`
        : '';
    lines.push(
      `- recording \`${ref.recordingId}\` · [${formatDurationMs(ref.startMs)} → ${formatDurationMs(ref.endMs)}]${chars} · revision \`${ref.asrRevisionId ?? '-'}\``,
    );
    lines.push('');
    lines.push(`  > ${ref.quoteSnippet}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeRequirementProjection(
  input: RequirementProjectionInput,
): ProjectionWriteResult {
  const path = join(
    input.dataDir,
    requirementBodyPath(input.requirement.id, input.requirement.title),
  );
  return writeProjectionFile(path, renderRequirementMarkdown(input));
}
