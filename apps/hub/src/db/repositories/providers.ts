import type { ProviderRegistration } from '@idearelay/contracts';
import type { SqliteDb } from '../types.js';

/**
 * Persist provider registration records (§5.7). Credentials are **never**
 * written: only the credential *source descriptor* is stored (ADR-0009).
 */
export function upsertProviders(
  sqlite: SqliteDb,
  registrations: readonly ProviderRegistration[],
): number {
  const stmt = sqlite.prepare(
    `INSERT INTO providers (id, kind, name, config_json, capabilities_json, enabled)
     VALUES (@id, @kind, @name, @config_json, @capabilities_json, @enabled)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       name = excluded.name,
       config_json = excluded.config_json,
       capabilities_json = excluded.capabilities_json,
       enabled = excluded.enabled`,
  );
  let written = 0;
  for (const reg of registrations) {
    stmt.run({
      id: reg.id,
      kind: reg.kind,
      name: reg.name,
      config_json: JSON.stringify({ credentialSource: reg.credentialSource }),
      capabilities_json: JSON.stringify(reg.capabilities),
      enabled: reg.enabled ? 1 : 0,
    });
    written += 1;
  }
  return written;
}
