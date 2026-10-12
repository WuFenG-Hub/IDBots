/**
 * Chain-backup data layer: whitelist extraction from the local DB and
 * idempotent import back into it. Pure db-level module (no Electron, no
 * chain imports) so unit tests can run it against an in-memory SqliteStore.
 *
 * Whitelist (MVP = L0 + L3): user_memories (+sources), metabot_daily_summaries,
 * metabot_weekly_summaries, metaid_knowledge_entries (+revisions),
 * metaid_knowledge_procedures, and the Bot's wallet mnemonic (key envelope).
 * NEVER add user_identity, kv, im_config or raw metabot_wallets rows here.
 */

import { objectId } from './chainBackupCrypto';
import type { SqliteDatabase } from '../sqliteTypes';

export type ChainBackupObjectKind =
  | 'memory'
  | 'dream_daily'
  | 'dream_weekly'
  | 'knowledge'
  | 'knowledge_revision'
  | 'knowledge_procedure'
  | 'key_envelope';

export interface ChainBackupObject {
  id: string;
  kind: ChainBackupObjectKind;
  data: Record<string, unknown>;
}

export function queryRows(db: SqliteDatabase, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const out: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      out[col] = row[i];
    });
    return out;
  });
}

function makeObject(kind: ChainBackupObjectKind, data: Record<string, unknown>): ChainBackupObject {
  return { id: objectId({ kind, data }), kind, data };
}

/**
 * Extract the whitelist for one Bot. Raw SELECT * snapshots: the row
 * (including derived columns like fingerprint/importance) is preserved
 * verbatim so restore never needs to recompute store-layer invariants.
 */
export function extractBackupObjects(
  db: SqliteDatabase,
  metabotId: number,
  wallet: { mnemonic: string; path: string } | null,
): ChainBackupObject[] {
  const objects: ChainBackupObject[] = [];

  const memories = queryRows(
    db,
    `SELECT * FROM user_memories WHERE metabot_id = ? AND status != 'deleted'`,
    [metabotId],
  );
  for (const memory of memories) {
    const sources = queryRows(
      db,
      `SELECT * FROM user_memory_sources WHERE memory_id = ?`,
      [memory.id],
    );
    objects.push(makeObject('memory', { ...memory, sources }));
  }

  for (const row of queryRows(db, `SELECT * FROM metabot_daily_summaries WHERE metabot_id = ?`, [metabotId])) {
    objects.push(makeObject('dream_daily', row));
  }
  for (const row of queryRows(db, `SELECT * FROM metabot_weekly_summaries WHERE metabot_id = ?`, [metabotId])) {
    objects.push(makeObject('dream_weekly', row));
  }

  const knowledge = queryRows(db, `SELECT * FROM metaid_knowledge_entries WHERE metabot_id = ?`, [metabotId]);
  for (const entry of knowledge) {
    const revisions = queryRows(
      db,
      `SELECT * FROM metaid_knowledge_revisions WHERE knowledge_id = ?`,
      [entry.id],
    );
    objects.push(makeObject('knowledge', { ...entry, revisions }));
  }
  for (const row of queryRows(db, `SELECT * FROM metaid_knowledge_procedures WHERE metabot_id = ?`, [metabotId])) {
    objects.push(makeObject('knowledge_procedure', row));
  }

  if (wallet?.mnemonic?.trim()) {
    objects.push(makeObject('key_envelope', { mnemonic: wallet.mnemonic.trim(), path: wallet.path }));
  }

  return objects;
}

// ---------------------------------------------------------------------------
// local backup journal (chain_backup_state)
// ---------------------------------------------------------------------------

export interface ChainBackupSegmentRef {
  pinId: string;
  segment: string;
  bytes: number;
  kinds: string[];
  objectIds: string[];
}

export interface ChainBackupStateRow {
  bot_globalmetaid: string;
  manifest_pinid: string | null;
  segments_json: string;
  uploaded_object_ids_json: string;
  last_backup_at: number | null;
  updated_at: number;
}

export function readChainBackupState(db: SqliteDatabase, botGlobalMetaId: string): ChainBackupStateRow | null {
  const rows = queryRows(db, `SELECT * FROM chain_backup_state WHERE bot_globalmetaid = ?`, [botGlobalMetaId]);
  return (rows[0] as unknown as ChainBackupStateRow) ?? null;
}

export function writeChainBackupState(
  db: SqliteDatabase,
  input: {
    botGlobalMetaId: string;
    manifestPinId: string | null;
    segments: ChainBackupSegmentRef[];
    uploadedObjectIds: string[];
    lastBackupAt: number;
  },
): void {
  db.run(
    `INSERT INTO chain_backup_state
       (bot_globalmetaid, manifest_pinid, segments_json, uploaded_object_ids_json, last_backup_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bot_globalmetaid) DO UPDATE SET
       manifest_pinid = excluded.manifest_pinid,
       segments_json = excluded.segments_json,
       uploaded_object_ids_json = excluded.uploaded_object_ids_json,
       last_backup_at = excluded.last_backup_at,
       updated_at = excluded.updated_at`,
    [
      input.botGlobalMetaId,
      input.manifestPinId,
      JSON.stringify(input.segments),
      JSON.stringify(input.uploadedObjectIds),
      input.lastBackupAt,
      Date.now(),
    ],
  );
}

/** Per-Bot last-backup summary for the settings UI. */
export function listChainBackupStates(db: SqliteDatabase): ChainBackupStateRow[] {
  return queryRows(db, `SELECT * FROM chain_backup_state ORDER BY updated_at DESC`) as unknown as ChainBackupStateRow[];
}

/**
 * Rebuild the local journal from an on-chain manifest after a restore, so the
 * next backup on this device diffs against what is already on-chain instead
 * of re-uploading everything. `manifestUpdatedAt` is unix seconds.
 */
export function rebuildChainBackupStateFromManifest(
  db: SqliteDatabase,
  input: {
    botGlobalMetaId: string;
    manifestPinId: string;
    segments: ChainBackupSegmentRef[];
    manifestUpdatedAt: number;
  },
): void {
  writeChainBackupState(db, {
    botGlobalMetaId: input.botGlobalMetaId,
    manifestPinId: input.manifestPinId,
    segments: input.segments,
    uploadedObjectIds: input.segments.flatMap((s) => s.objectIds),
    lastBackupAt: input.manifestUpdatedAt * 1000,
  });
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

const tableColumnsCache = new WeakMap<SqliteDatabase, Map<string, string[]>>();
function tableColumns(db: SqliteDatabase, table: string): string[] {
  let perDb = tableColumnsCache.get(db);
  if (!perDb) {
    perDb = new Map();
    tableColumnsCache.set(db, perDb);
  }
  let cols = perDb.get(table);
  if (!cols) {
    cols = queryRows(db, `PRAGMA table_info(${table})`).map((row) => String(row.name));
    perDb.set(table, cols);
  }
  return cols;
}

/** INSERT OR IGNORE with the row's keys intersected against the live schema. */
function insertRowIgnore(db: SqliteDatabase, table: string, row: Record<string, unknown>): boolean {
  const cols = tableColumns(db, table);
  const keys = Object.keys(row).filter((key) => cols.includes(key));
  if (!keys.length) return false;
  const placeholders = keys.map(() => '?').join(', ');
  db.run(
    `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
    keys.map((key) => row[key]),
  );
  const modified = typeof db.getRowsModified === 'function' ? db.getRowsModified() : 1;
  return modified > 0;
}

function rowExists(db: SqliteDatabase, table: string, where: Record<string, unknown>): boolean {
  const clauses = Object.keys(where).map((key) => `${key} IS ?`);
  const rows = queryRows(db, `SELECT 1 AS one FROM ${table} WHERE ${clauses.join(' AND ')} LIMIT 1`, Object.values(where));
  return rows.length > 0;
}

/**
 * Import one Bot's decrypted backup objects. Only `metabot_id` is remapped;
 * every other column (including TEXT ids, fingerprints, timestamps) is copied
 * verbatim. Idempotent: unique-constrained tables use INSERT OR IGNORE; tables
 * without one (user_memories, user_memory_sources, knowledge revisions) get a
 * natural-key pre-check.
 */
export function importBackupObjects(
  db: SqliteDatabase,
  newMetabotId: number,
  objects: ChainBackupObject[],
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;

  for (const obj of objects) {
    const data = obj.data;
    try {
      switch (obj.kind) {
        case 'memory': {
          const { sources, ...row } = data as { sources?: unknown[] } & Record<string, unknown>;
          row.metabot_id = newMetabotId;
          const dup = rowExists(db, 'user_memories', {
            metabot_id: newMetabotId,
            scope_kind: row.scope_kind ?? null,
            scope_key: row.scope_key ?? null,
            fingerprint: row.fingerprint ?? null,
          });
          if (!dup && insertRowIgnore(db, 'user_memories', row)) {
            imported += 1;
          } else {
            skipped += 1;
          }
          for (const rawSource of Array.isArray(sources) ? sources : []) {
            const source = { ...(rawSource as Record<string, unknown>) };
            source.metabot_id = newMetabotId;
            const sourceDup = rowExists(db, 'user_memory_sources', {
              memory_id: source.memory_id ?? null,
              source_type: source.source_type ?? null,
              dream_date: source.dream_date ?? null,
              source_id: source.source_id ?? null,
            });
            if (!sourceDup && insertRowIgnore(db, 'user_memory_sources', source)) {
              imported += 1;
            } else {
              skipped += 1;
            }
          }
          break;
        }
        case 'dream_daily': {
          const row = { ...data, metabot_id: newMetabotId };
          if (insertRowIgnore(db, 'metabot_daily_summaries', row)) imported += 1; else skipped += 1;
          break;
        }
        case 'dream_weekly': {
          const row = { ...data, metabot_id: newMetabotId };
          if (insertRowIgnore(db, 'metabot_weekly_summaries', row)) imported += 1; else skipped += 1;
          break;
        }
        case 'knowledge': {
          const { revisions, ...row } = data as { revisions?: unknown[] } & Record<string, unknown>;
          row.metabot_id = newMetabotId;
          if (insertRowIgnore(db, 'metaid_knowledge_entries', row)) imported += 1; else skipped += 1;
          for (const rawRevision of Array.isArray(revisions) ? revisions : []) {
            const revision = { ...(rawRevision as Record<string, unknown>) };
            const revisionDup = rowExists(db, 'metaid_knowledge_revisions', {
              knowledge_id: revision.knowledge_id ?? null,
              version: revision.version ?? null,
              created_at: revision.created_at ?? null,
            });
            if (!revisionDup && insertRowIgnore(db, 'metaid_knowledge_revisions', revision)) {
              imported += 1;
            } else {
              skipped += 1;
            }
          }
          break;
        }
        case 'knowledge_procedure': {
          const row = { ...data, metabot_id: newMetabotId };
          if (insertRowIgnore(db, 'metaid_knowledge_procedures', row)) imported += 1; else skipped += 1;
          break;
        }
        case 'key_envelope':
          // handled by the skeleton-restore step, never inserted into a table
          skipped += 1;
          break;
        default:
          skipped += 1;
      }
    } catch (error) {
      console.warn('[ChainBackup] import object failed', obj.kind, obj.id, error instanceof Error ? error.message : String(error));
      skipped += 1;
    }
  }

  return { imported, skipped };
}
