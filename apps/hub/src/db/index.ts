import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from './migrate.js';
import * as schema from './schema.js';
import type { SqliteDb } from './types.js';

export interface Db {
  sqlite: SqliteDb;
  orm: BetterSQLite3Database<typeof schema>;
}

/**
 * Open (creating if needed) the authoritative SQLite database, run migrations,
 * and return both the raw connection and the Drizzle handle. Rows are truth
 * (ADR-0002) — nothing here reads projection files back.
 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);
  const orm = drizzle(sqlite, { schema });
  return { sqlite, orm };
}

/** Table names present in the database, excluding SQLite internals. */
export function listTables(sqlite: SqliteDb): string[] {
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export { schema };
export type { SqliteDb };
