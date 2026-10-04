import {
  createProviderRegistry,
  type ProviderRegistration,
  type ProviderRegistry,
} from '@idearelay/contracts';

/** Build a registry from configuration (§7 preamble). */
export function registerProviders(
  registrations: readonly ProviderRegistration[],
): ProviderRegistry {
  const registry = createProviderRegistry();
  for (const registration of registrations) {
    registry.register(registration);
  }
  return registry;
}
