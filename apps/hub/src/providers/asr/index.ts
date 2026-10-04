import type {
  AsrProvider,
  CredentialSource,
  JsonObject,
  ProviderRegistration,
} from '@idearelay/contracts';
import { createFunasrAsrProvider } from './funasr.js';
import { createMockAsrProvider } from './mock.js';

export type AsrProviderName = 'mock' | 'funasr';

/** Config-driven selection of the ASR implementation (spec §7.1, ADR-0009). */
export interface AsrProviderConfig {
  provider: AsrProviderName;
  baseUrl: string | null;
  model: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
}

/**
 * Build the selected `AsrProvider` instance. Only the bootstrap/config layer
 * imports the concrete classes; pipeline code depends on the interface alone.
 */
export function createAsrProvider(cfg: AsrProviderConfig): AsrProvider {
  switch (cfg.provider) {
    case 'mock':
      return createMockAsrProvider();
    case 'funasr': {
      if (cfg.baseUrl === null || cfg.baseUrl.trim() === '') {
        throw new Error(
          'funasr ASR provider requires IDEA_RELAY_FUNASR_BASE_URL to be set',
        );
      }
      return createFunasrAsrProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model ?? 'paraformer-zh',
        apiKey: cfg.apiKey ?? null,
        timeoutMs: cfg.timeoutMs,
      });
    }
  }
}

/** Registration metadata for the seven-Provider registry (§7 preamble). */
export function asrRegistration(
  provider: AsrProvider,
  credentialSource: CredentialSource = { kind: 'none' },
): ProviderRegistration {
  return {
    id: `asr:${provider.id}`,
    kind: 'asr',
    name: provider.id,
    credentialSource,
    capabilities: provider.capabilities as unknown as JsonObject,
    enabled: true,
  };
}

export { createMockAsrProvider, MOCK_ASR_ID, MOCK_ASR_MODEL } from './mock.js';
export { createFunasrAsrProvider, FUNASR_ASR_ID } from './funasr.js';
