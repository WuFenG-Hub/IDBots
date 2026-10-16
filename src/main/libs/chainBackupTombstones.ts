/**
 * Chain-backup deletion ledger. Rows that leave their live tables through a
 * HARD delete (memory-tombstone purge, knowledge delete) are invisible to the
 * backup extraction scan, so without a ledger their last backed-up snapshot
 * would silently come back on the next restore. The ledger records just the
 * row reference; extraction turns each entry into a minimal tombstone object
 * and restore applies the newest version of every row (tombstones included).
 *
 * Soft-deleted memories (status='deleted', still in user_memories) do NOT go
 * through here — extraction reads them straight from the table, which also
 * keeps the deleted→restored rollback transition correct for free.
 */

import type { SqliteDatabase } from '../sqliteTypes';

export type ChainBackupTombstoneKind = 'memory' | 'knowledge';

export interface ChainBackupTombstoneRow {
  kind: ChainBackupTombstoneKind;
  ref: string;
  metabot_id: number | null;
  deleted_at: number;
}

export function ensureChainBackupTombstoneSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chain_backup_tombstones (
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      metabot_id INTEGER,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (kind, ref)
    )
  `);
}

export function recordChainBackupTombstones(
  db: SqliteDatabase,
  entries: Array<{
    kind: ChainBackupTombstoneKind;
    ref: string;
    metabotId?: number | null;
    deletedAt?: number;
  }>,
): void {
  if (!entries.length) return;
  ensureChainBackupTombstoneSchema(db);
  const now = Date.now();
  for (const entry of entries) {
    const ref = String(entry.ref ?? '').trim();
    if (!ref) continue;
    db.run(
      `INSERT OR IGNORE INTO chain_backup_tombstones (kind, ref, metabot_id, deleted_at) VALUES (?, ?, ?, ?)`,
      [
        entry.kind,
        ref,
        Number.isInteger(entry.metabotId) ? (entry.metabotId as number) : null,
        Number.isInteger(entry.deletedAt) ? (entry.deletedAt as number) : now,
      ],
    );
  }
}

export function listChainBackupTombstones(db: SqliteDatabase, metabotId: number): ChainBackupTombstoneRow[] {
  ensureChainBackupTombstoneSchema(db);
  const result = db.exec(
    `SELECT kind, ref, metabot_id, deleted_at FROM chain_backup_tombstones WHERE metabot_id = ? OR metabot_id IS NULL`,
    [metabotId],
  );
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const record = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
    const row_: ChainBackupTombstoneRow = {
      kind: record.kind === 'knowledge' ? 'knowledge' : 'memory',
      ref: String(record.ref ?? ''),
      metabot_id: typeof record.metabot_id === 'number' ? record.metabot_id : null,
      deleted_at: typeof record.deleted_at === 'number' ? record.deleted_at : 0,
    };
    return row_;
  }).filter((row) => row.ref);
}
