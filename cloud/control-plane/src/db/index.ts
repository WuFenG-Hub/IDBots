import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

/**
 * SQLite access. WAL mode, versioned idempotent migrations at startup, and
 * the runtime seed for the single v1 hosts row (from config — migrations
 * themselves never seed deployment-specific rows).
 */

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version INTEGER PRIMARY KEY, ' +
      'applied_at INTEGER NOT NULL' +
      ')',
  );
  runMigrations(db);
  return db;
}

export function runMigrations(db: Database.Database, now: number = Date.now()): void {
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        now,
      );
    })();
  }
}

export interface HostSeed {
  id: string;
  dockerUrl: string;
  capacity: number;
  status: string;
}

/** Insert the configured host row once; never overwrite an existing one. */
export function ensureHostRow(db: Database.Database, seed: HostSeed): void {
  db.prepare(
    `INSERT INTO hosts (id, docker_url, capacity, status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(seed.id, seed.dockerUrl, seed.capacity, seed.status);
}
