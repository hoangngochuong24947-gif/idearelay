/**
 * RagProvider implementations (spec §7.6). ADR-0009: providers are in-process
 * TS modules registered by name/kind/credential-source/capability.
 */

import type { ProviderRegistration } from '@idearelay/contracts';
import { DEFAULT_EMBEDDING_MODEL, SQLITE_HYBRID_RAG_ID } from './hybrid.js';

export { createRagProvider, ftsMatchQuery, DEFAULT_EMBEDDING_MODEL, SQLITE_HYBRID_RAG_ID } from './hybrid.js';
export type { CreateRagProviderOptions } from './hybrid.js';
export { reciprocalRankFusion, RRF_K } from './fusion.js';
export type { RankedList, FusedHit } from './fusion.js';

/**
 * Registration metadata for the hybrid provider (ADR-0009). The capabilities
 * are only fully known at runtime (they depend on whether the `.gguf` model
 * loaded), so the record is derived from a constructed provider instance —
 * the bootstrap wiring does:
 *
 *   const rag = createRagProvider({ dbPath: config.dbPath });
 *   registry.register(ragProviderRegistration(rag));
 */
export function ragProviderRegistration(provider: {
  readonly id: string;
  readonly capabilities: { hybrid: boolean; embeddingModel: string | null };
}): ProviderRegistration {
  return {
    id: SQLITE_HYBRID_RAG_ID,
    kind: 'rag',
    name: 'sqlite-vec + FTS5 + sqlite-lembed (hybrid, local .gguf)',
    credentialSource: { kind: 'none' },
    capabilities: {
      hybrid: provider.capabilities.hybrid,
      embeddingModel: provider.capabilities.embeddingModel,
      fusion: 'reciprocal-rank-fusion',
      defaultModel: DEFAULT_EMBEDDING_MODEL.file,
    },
    enabled: true,
  };
}
