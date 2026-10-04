import type { ProviderRegistration, SyncProvider } from '@idearelay/contracts';

/** Registry metadata for a SyncProvider (§7 preamble, ADR-0009). */
export function syncProviderRegistration(
  provider: SyncProvider,
  enabled = true,
): ProviderRegistration {
  return {
    id: provider.id,
    kind: 'sync',
    name: `${provider.id} one-way mirror (push)`,
    credentialSource: { kind: 'none' },
    capabilities: provider.capabilities,
    enabled,
  };
}

export { LocalDirSyncProvider } from './local-dir.js';
