import type {
  CredentialSource,
  JsonObject,
  ModelProvider,
  ProviderRegistration,
} from '@idearelay/contracts';
import { createMockModelProvider } from './mock.js';
import { createOpenAiModelProvider } from './openai.js';

export type ModelProviderName = 'mock' | 'openai';

/** Config-driven selection of the ModelProvider implementation (§7.2, ADR-0009). */
export interface ModelProviderConfig {
  provider: ModelProviderName;
  baseUrl: string | null;
  model: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
}

/**
 * Build the selected `ModelProvider`. Only the bootstrap/config layer imports
 * concrete classes; the enrich pipeline depends on the interface alone.
 */
export function createModelProvider(cfg: ModelProviderConfig): ModelProvider {
  switch (cfg.provider) {
    case 'mock':
      return createMockModelProvider(cfg.model ?? undefined);
    case 'openai': {
      if (cfg.baseUrl === null || cfg.baseUrl.trim() === '') {
        throw new Error(
          'openai model provider requires IDEA_RELAY_MODEL_BASE_URL to be set',
        );
      }
      if (cfg.model === null || cfg.model.trim() === '') {
        throw new Error(
          'openai model provider requires IDEA_RELAY_MODEL_NAME to be set',
        );
      }
      return createOpenAiModelProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey ?? null,
        timeoutMs: cfg.timeoutMs,
      });
    }
  }
}

/** Registration metadata for the seven-Provider registry (§7 preamble). */
export function modelRegistration(
  provider: ModelProvider,
  credentialSource: CredentialSource = { kind: 'none' },
): ProviderRegistration {
  return {
    id: `model:${provider.id}`,
    kind: 'model',
    name: provider.id,
    credentialSource,
    capabilities: {
      models: provider.models().map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        structuredOutput: m.structuredOutput,
      })),
    } as unknown as JsonObject,
    enabled: true,
  };
}

export { createMockModelProvider, MOCK_MODEL_ID, renderMockSummary } from './mock.js';
export { createOpenAiModelProvider, OPENAI_MODEL_ID } from './openai.js';
