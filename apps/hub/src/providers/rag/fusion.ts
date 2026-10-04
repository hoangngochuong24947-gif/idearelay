/**
 * Reciprocal Rank Fusion (RRF) for hybrid retrieval (spec §7.6).
 *
 * Chosen over weighted score normalization because BM25 and cosine-distance
 * live on incompatible scales; RRF only consumes *ranks*, so no calibration is
 * needed. It is the standard hybrid-search baseline (Cormack et al. 2009) and
 * the default in production retrieval stacks. With a single list available
 * (e.g. model failed to load → BM25-only) RRF is monotonic in rank, i.e. the
 * fused order degenerates gracefully to that list's order.
 */

/** RRF damping constant; 60 is the literature default. */
export const RRF_K = 60;

/** A ranked list of document ids, best first. Duplicates are ignored. */
export interface RankedList {
  /** Descriptive name, e.g. `bm25` or `knn`. */
  name: string;
  /** Document ids ordered best-first. */
  ranked: readonly string[];
}

/** A fused document id and its RRF score (higher = better). */
export interface FusedHit {
  docId: string;
  score: number;
}

/**
 * Fuse the given ranked lists with RRF:
 *   score(d) = Σ_lists 1 / (RRF_K + rank_of_d_in_list)   (rank is 1-based)
 * Documents absent from a list contribute nothing for that list.
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  topK: number,
): FusedHit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (let i = 0; i < list.ranked.length; i++) {
      const docId = list.ranked[i];
      if (seen.has(docId)) continue;
      seen.add(docId);
      scores.set(docId, (scores.get(docId) ?? 0) + 1 / (RRF_K + i + 1));
    }
  }
  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK, 0));
}
