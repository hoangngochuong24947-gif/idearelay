import type { SegmentRow } from '../db/repositories/transcripts.js';

/**
 * Time → anchor resolution for the hybrid SourceRef (ADR-0004, spec §10).
 *
 * The model only proposes `[startMs, endMs]`. Everything else — the secondary
 * char offsets and the human `quote_snippet` — is **derived here** from the
 * revision's real segments, so every ref provably resolves back to a concrete
 * interval of the transcript. The same function drives the initial split and
 * the post-ASR-re-run realignment, which is what makes realignment lossless:
 * the primary time anchor never moves, only its resolution is recomputed.
 */

export interface CharMap {
  /** Start offset of each segment inside the canonical joined transcript text. */
  offsets: number[];
  /** End offset (exclusive) of each segment. */
  ends: number[];
  /** Canonical joined text: segment texts joined by `\n`. */
  joined: string;
}

/**
 * Canonical transcript text = segment texts joined by a single `\n` (the same
 * rule enrich uses). Deterministic, so char offsets are stable across rebuilds.
 */
export function buildCharMap(texts: readonly string[]): CharMap {
  const offsets: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (let i = 0; i < texts.length; i += 1) {
    offsets.push(pos);
    pos += texts[i].length;
    ends.push(pos);
    if (i < texts.length - 1) pos += 1; // the '\n' separator
  }
  const parts: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    parts.push(texts[i]);
    if (i < texts.length - 1) parts.push('\n');
  }
  return { offsets, ends, joined: parts.join('') };
}

export const QUOTE_MAX_CHARS = 200;

export interface AnchorResult {
  /** Clamped primary anchor — what gets stored in `start_ms`/`end_ms`. */
  startMs: number;
  endMs: number;
  /** Half-open overlap into `segments`; equal when a nearest-segment fallback fired. */
  firstIdx: number;
  lastIdx: number;
  /** Secondary anchor: char offsets into the canonical joined text. */
  charStart: number;
  charEnd: number;
  /** Self-explaining snapshot for humans. */
  quote: string;
}

/**
 * Resolve a proposed `[startMs, endMs]` against concrete segments. Intervals
 * are clamped into the transcript span; if nothing overlaps (ASR re-runs can
 * shift everything), the nearest segment by midpoint distance keeps the ref
 * resolvable — a reference is never dropped.
 */
export function anchorToSegments(
  segments: readonly SegmentRow[],
  charMap: CharMap,
  proposedStartMs: number,
  proposedEndMs: number,
): AnchorResult {
  if (segments.length === 0) {
    throw new Error('anchorToSegments: revision has no segments');
  }
  let start = Math.round(proposedStartMs);
  let end = Math.round(proposedEndMs);
  if (start > end) [start, end] = [end, start];

  const spanStart = segments[0].start_ms;
  const spanEnd = segments[segments.length - 1].end_ms;
  start = Math.min(Math.max(start, spanStart), spanEnd);
  end = Math.min(Math.max(end, start), spanEnd);

  const overlapping: number[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.start_ms < end && seg.end_ms > start) overlapping.push(i);
  }

  let firstIdx: number;
  let lastIdx: number;
  if (overlapping.length > 0) {
    firstIdx = overlapping[0];
    lastIdx = overlapping[overlapping.length - 1];
  } else {
    // No literal overlap → nearest segment by midpoint distance (ties → lower idx).
    const mid = (start + end) / 2;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < segments.length; i += 1) {
      const segMid = (segments[i].start_ms + segments[i].end_ms) / 2;
      const dist = Math.abs(segMid - mid);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    firstIdx = best;
    lastIdx = best;
    start = segments[best].start_ms;
    end = segments[best].end_ms;
  }

  const quoteTexts = segments
    .slice(firstIdx, lastIdx + 1)
    .map((s) => s.text);
  let quote = quoteTexts.join(' ');
  if (quote.length > QUOTE_MAX_CHARS) quote = `${quote.slice(0, QUOTE_MAX_CHARS)}…`;

  return {
    startMs: start,
    endMs: end,
    firstIdx,
    lastIdx,
    charStart: charMap.offsets[firstIdx],
    charEnd: charMap.ends[lastIdx],
    quote,
  };
}
