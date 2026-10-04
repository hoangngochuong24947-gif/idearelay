import type {
  CredentialSource,
  DecisionProvider,
  DecisionThresholds,
  JsonObject,
  ProviderRegistration,
} from '@idearelay/contracts';
import { createJevDecisionProvider, JEV_DEFAULT_ENDPOINT } from './jev.js';
import { createMockDecisionProvider } from './mock.js';

export type DecisionProviderName = 'mock' | 'jev';

/** Config-driven selection of the DecisionProvider implementation (§7.3, ADR-0005). */
export interface DecisionProviderConfig {
  provider: DecisionProviderName;
  /** SystemOne endpoint (jev only). */
  endpoint: string | null;
  /** Pinned model name (jev only, required). */
  model: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
  thresholds?: DecisionThresholds;
}

/**
 * Build the selected `DecisionProvider`. Defaults to the deterministic mock so
 * a zero-config Hub runs offline; `jev` is the first real implementation.
 */
export function createDecisionProvider(cfg: DecisionProviderConfig): DecisionProvider {
  switch (cfg.provider) {
    case 'mock':
      return createMockDecisionProvider();
    case 'jev': {
      if (cfg.apiKey == null || cfg.apiKey.trim() === '') {
        throw new Error('jev decision provider requires TYPESAFE_API_KEY to be set');
      }
      if (cfg.model === null || cfg.model.trim() === '') {
        throw new Error(
          'jev decision provider requires a pinned model (IDEA_RELAY_TYPESAFE_MODEL)',
        );
      }
      return createJevDecisionProvider({
        endpoint: cfg.endpoint ?? JEV_DEFAULT_ENDPOINT,
        model: cfg.model,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
        thresholds: cfg.thresholds,
      });
    }
  }
}

/** Registration metadata for the seven-Provider registry (§7 preamble). */
export function decisionRegistration(
  provider: DecisionProvider,
  credentialSource: CredentialSource = { kind: 'none' },
): ProviderRegistration {
  return {
    id: `decision:${provider.id}`,
    kind: 'decision',
    name: provider.id,
    credentialSource,
    capabilities: { primitives: ['choice', 'score', 'noul'] } as unknown as JsonObject,
    enabled: true,
  };
}

export { createMockDecisionProvider, MOCK_DECISION_ID, INBOX_KINDS, tagVocabulary, kindVocabulary } from './mock.js';
export type { MockDecisionConfig } from './mock.js';
export { createJevDecisionProvider, JEV_DECISION_ID, JEV_DEFAULT_ENDPOINT } from './jev.js';
