import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.js';

/** Fresh migrated SQLite database in a unique temp directory. */
export function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-test-'));
  return openDb(path.join(dir, 'test.sqlite'));
}

export const MASTER_KEY = Buffer.alloc(32, 7);

export const TENANT_DEFAULTS = {
  hostId: 'h_testhost',
  tenantImage: 'registry.example.com/idbots/tenant:0.1.0-test',
};

export interface SmsSeed {
  phone: string;
  ip: string;
  now: number;
  purpose?: 'login' | 'reverify';
  attempts?: number;
  consumedAt?: number | null;
}

let smsCounter = 0;

export function insertSmsSend(db: Database.Database, seed: SmsSeed): number {
  smsCounter += 1;
  const info = db
    .prepare(
      `INSERT INTO sms_codes (phone_e164, purpose, code_hash, attempts, expires_at, consumed_at, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.phone,
      seed.purpose ?? 'login',
      `hash-${seed.phone}-${seed.now}-${smsCounter}`,
      seed.attempts ?? 0,
      seed.now + 300_000,
      seed.consumedAt === undefined ? null : seed.consumedAt,
      seed.ip,
      seed.now,
    );
  return Number(info.lastInsertRowid);
}

export function insertInvite(
  db: Database.Database,
  seed: {
    code: string;
    maxUses?: number;
    usedCount?: number;
    withRedeem?: number;
    disabled?: number;
    expiresAt?: number | null;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO invites (code, max_uses, used_count, with_redeem, note, expires_at, disabled, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    seed.code,
    seed.maxUses ?? 1,
    seed.usedCount ?? 0,
    seed.withRedeem ?? 0,
    seed.expiresAt === undefined ? null : seed.expiresAt,
    seed.disabled ?? 0,
    seed.now,
  );
}

export function insertRedeemCode(
  db: Database.Database,
  seed: { codeHash: string; importedAt: number },
): void {
  db.prepare(
    `INSERT INTO redeem_codes (code_enc, code_hash, batch_note, imported_at)
     VALUES (?, ?, 'test-batch', ?)`,
  ).run(`enc-${seed.codeHash}`, seed.codeHash, seed.importedAt);
}
