/**
 * Bot Wallet Transfer Ledger (R2 audit)
 *
 * Every wallet_transfer attempt — local (channel A, auto-approved), external
 * (channel B, owner-gated), refused, or failed — lands here. Free-of-
 * confirmation does NOT mean free of bookkeeping: the audit row is the
 * owner's record of who moved what between the local bots' wallets.
 *
 * Same idempotent-ensure pattern as chainContentHistoryStore: the schema is
 * created on first run via CREATE TABLE IF NOT EXISTS (Database Upgrade
 * Safety) and the store class owns the CRUD.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';

export type BotTransferStatus = 'broadcast' | 'refused' | 'failed';

export interface BotWalletTransferRecord {
  id: number;
  metabotId: number;
  fromAddress: string;
  toAddress: string;
  toMetabotId: number | null;
  chain: string;
  amountSats: number;
  feeSats: number | null;
  txid: string | null;
  memo: string | null;
  channel: 'local' | 'external';
  status: BotTransferStatus;
  error: string | null;
  sessionId: string | null;
  origin: string | null;
  occurredAtMs: number;
  createdAt: string;
}

export interface RecordBotWalletTransferInput {
  metabotId: number;
  fromAddress: string;
  toAddress: string;
  toMetabotId?: number | null;
  chain: string;
  amountSats: number;
  feeSats?: number | null;
  txid?: string | null;
  memo?: string | null;
  channel: 'local' | 'external';
  status: BotTransferStatus;
  error?: string | null;
  sessionId?: string | null;
  origin?: string | null;
  occurredAtMs: number;
}

interface BotWalletTransferRow {
  id: number;
  metabot_id: number;
  from_address: string;
  to_address: string;
  to_metabot_id: number | null;
  chain: string;
  amount_sats: number;
  fee_sats: number | null;
  txid: string | null;
  memo: string | null;
  channel: string;
  status: string;
  error: string | null;
  session_id: string | null;
  origin: string | null;
  occurred_at_ms: number;
  created_at: string;
}

/** Create the ledger table without changing existing user data. */
export function ensureBotWalletTransferSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_wallet_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metabot_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      to_metabot_id INTEGER,
      chain TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      fee_sats INTEGER,
      txid TEXT,
      memo TEXT,
      channel TEXT NOT NULL CHECK (channel IN ('local', 'external')),
      status TEXT NOT NULL CHECK (status IN ('broadcast', 'refused', 'failed')),
      error TEXT,
      session_id TEXT,
      origin TEXT,
      occurred_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_bot_wallet_transfers_metabot_time
      ON bot_wallet_transfers(metabot_id, occurred_at_ms);
  `);
}

const rowToRecord = (row: BotWalletTransferRow): BotWalletTransferRecord => ({
  id: row.id,
  metabotId: row.metabot_id,
  fromAddress: row.from_address,
  toAddress: row.to_address,
  toMetabotId: row.to_metabot_id ?? null,
  chain: row.chain,
  amountSats: Number(row.amount_sats) || 0,
  feeSats: row.fee_sats == null ? null : Number(row.fee_sats) || 0,
  txid: row.txid || null,
  memo: row.memo || null,
  channel: row.channel === 'external' ? 'external' : 'local',
  status: (['broadcast', 'refused', 'failed'] as string[]).includes(row.status)
    ? (row.status as BotTransferStatus)
    : 'failed',
  error: row.error || null,
  sessionId: row.session_id || null,
  origin: row.origin || null,
  occurredAtMs: Number(row.occurred_at_ms) || 0,
  createdAt: row.created_at,
});

export class BotWalletTransferStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    ensureBotWalletTransferSchema(db);
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  record(input: RecordBotWalletTransferInput): BotWalletTransferRecord {
    this.db.run(
      `INSERT INTO bot_wallet_transfers
        (metabot_id, from_address, to_address, to_metabot_id, chain, amount_sats,
         fee_sats, txid, memo, channel, status, error, session_id, origin, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.metabotId,
        input.fromAddress,
        input.toAddress,
        input.toMetabotId ?? null,
        input.chain,
        Math.max(0, Math.floor(input.amountSats)),
        input.feeSats ?? null,
        input.txid ?? null,
        input.memo ?? null,
        input.channel,
        input.status,
        input.error ?? null,
        input.sessionId ?? null,
        input.origin ?? null,
        input.occurredAtMs,
      ],
    );
    this.saveDb();
    return this.list(1)[0];
  }

  list(limit = 50, metabotId?: number): BotWalletTransferRecord[] {
    const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
    const rows = metabotId
      ? this.getAll<BotWalletTransferRow>(
          'SELECT * FROM bot_wallet_transfers WHERE metabot_id = ? ORDER BY id DESC LIMIT ?',
          [metabotId, capped],
        )
      : this.getAll<BotWalletTransferRow>(
          'SELECT * FROM bot_wallet_transfers ORDER BY id DESC LIMIT ?',
          [capped],
        );
    return rows.map(rowToRecord);
  }
}
