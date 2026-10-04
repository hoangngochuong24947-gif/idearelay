import type Database from 'better-sqlite3';

/** The better-sqlite3 connection type. */
export type SqliteDb = InstanceType<typeof Database>;
