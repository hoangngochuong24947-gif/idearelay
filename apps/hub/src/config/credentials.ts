import type { CredentialSource } from '@idearelay/contracts';

export { envCredential } from '@idearelay/contracts';

/**
 * Resolve a credential from its declared source at call time. Secrets are read
 * from the environment and never persisted (ADR-0009).
 */
export function resolveCredential(
  source: CredentialSource,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (source.kind === 'none') return null;
  const value = env[source.name];
  return value !== undefined && value.length > 0 ? value : null;
}
