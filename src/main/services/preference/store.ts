import { randomUUID } from 'node:crypto';
import type { SqliteDatabase as Database } from '../../sqliteTypes';
import { PREFERENCE_SEGMENTS, type PreferenceSegment } from './constants';
import type { Ballot, PreferenceChainEvent } from './types';

interface Row {
  [column: string]: unknown;
}

export type PreferenceBallotStatus =
  | 'committing'
  | 'committed'
  | 'commit_failed'
  | 'superseded'
  | 'revealed'
  | 'reveal_failed'
  | 'expired';

export const MAX_REVEAL_ATTEMPTS = 5;

export interface PreferenceBallotRow {
  id: string;
  roundPinId: string;
  signerType: 'user' | 'metabot';
  metabotId: number | null;
  judgeGlobalMetaId: string;
  ballot: Ballot;
  salt: string;
  commitHash: string;
  commitPinId: string | null;
  revealPinId: string | null;
  status: PreferenceBallotStatus;
  lastError: string | null;
  revealAttempts: number;
  commitCloseAt: number;
  revealCloseAt: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type PreferenceBallotView = Omit<PreferenceBallotRow, 'salt'>;

export interface NewBallotInput {
  roundPinId: string;
  signerType: 'user' | 'metabot';
  metabotId: number | null;
  judgeGlobalMetaId: string;
  ballot: Ballot;
  salt: string;
  commitHash: string;
  commitCloseAt: number;
  revealCloseAt: number;
  nowMs: number;
}

export const toBallotView = (row: PreferenceBallotRow): PreferenceBallotView => ({
  id: row.id,
  roundPinId: row.roundPinId,
  signerType: row.signerType,
  metabotId: row.metabotId,
  judgeGlobalMetaId: row.judgeGlobalMetaId,
  ballot: row.ballot,
  commitHash: row.commitHash,
  commitPinId: row.commitPinId,
  revealPinId: row.revealPinId,
  status: row.status,
  lastError: row.lastError,
  revealAttempts: row.revealAttempts,
  commitCloseAt: row.commitCloseAt,
  revealCloseAt: row.revealCloseAt,
  createdAtMs: row.createdAtMs,
  updatedAtMs: row.updatedAtMs,
});

const parseObject = (raw: unknown): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const nullableString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const BALLOT_COLUMNS = `id, round_pin_id, signer_type, metabot_id, judge_global_metaid, ballot_json, salt, commit_hash,
  commit_pin_id, reveal_pin_id, status, last_error, reveal_attempts, commit_close_at, reveal_close_at, created_at, updated_at`;

const toBallotRow = (row: Row): PreferenceBallotRow => ({
  id: String(row.id),
  roundPinId: String(row.round_pin_id),
  signerType: row.signer_type === 'metabot' ? 'metabot' : 'user',
  metabotId: row.metabot_id === null || row.metabot_id === undefined ? null : Number(row.metabot_id),
  judgeGlobalMetaId: String(row.judge_global_metaid),
  ballot: parseObject(row.ballot_json) as unknown as Ballot,
  salt: String(row.salt),
  commitHash: String(row.commit_hash),
  commitPinId: nullableString(row.commit_pin_id),
  revealPinId: nullableString(row.reveal_pin_id),
  status: String(row.status) as PreferenceBallotStatus,
  lastError: nullableString(row.last_error),
  revealAttempts: Number(row.reveal_attempts),
  commitCloseAt: Number(row.commit_close_at),
  revealCloseAt: Number(row.reveal_close_at),
  createdAtMs: Number(row.created_at),
  updatedAtMs: Number(row.updated_at),
});

export class PreferenceStore {
  private readonly db: Database;
  private readonly saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preference_events (
        pin_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        author TEXT NOT NULL,
        height INTEGER NOT NULL,
        tx_index INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_preference_events_path ON preference_events(path);');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preference_ballots (
        id TEXT PRIMARY KEY,
        round_pin_id TEXT NOT NULL,
        signer_type TEXT NOT NULL,
        metabot_id INTEGER,
        judge_global_metaid TEXT NOT NULL,
        ballot_json TEXT NOT NULL,
        salt TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        commit_pin_id TEXT,
        reveal_pin_id TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        reveal_attempts INTEGER NOT NULL DEFAULT 0,
        commit_close_at INTEGER NOT NULL,
        reveal_close_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_preference_ballots_round ON preference_ballots(round_pin_id, judge_global_metaid);');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_preference_ballots_status ON preference_ballots(status);');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preference_compare_telemetry (
        round_pin_id TEXT NOT NULL,
        pair_key TEXT NOT NULL,
        seconds INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (round_pin_id, pair_key)
      );
    `);
  }

  private all(sql: string, params: unknown[] = []): Row[] {
    const [first] = this.db.exec(sql, params);
    if (!first) return [];
    return first.values.map((values) => {
      const row: Row = {};
      first.columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return row;
    });
  }

  private write(sql: string, params: unknown[]): void {
    this.db.run(sql, params);
    this.saveDb();
  }

  upsertEvents(events: readonly PreferenceChainEvent[], nowMs: number): void {
    if (events.length === 0) return;
    this.db.run('BEGIN TRANSACTION;');
    try {
      for (const event of events) {
        this.db.run(
          `INSERT INTO preference_events (pin_id, path, author, height, tx_index, timestamp_ms, body_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pin_id) DO UPDATE SET
             path = excluded.path,
             author = excluded.author,
             height = excluded.height,
             tx_index = excluded.tx_index,
             timestamp_ms = excluded.timestamp_ms,
             body_json = CASE WHEN excluded.body_json = '{}' THEN preference_events.body_json ELSE excluded.body_json END,
             updated_at = excluded.updated_at;`,
          [event.pinId, event.path, event.author, event.height, event.txIndex, event.timestampMs, JSON.stringify(event.body), nowMs],
        );
      }
      this.db.run('COMMIT;');
    } catch (error) {
      try {
        this.db.run('ROLLBACK;');
      } catch {
        // keep the original failure
      }
      throw error;
    }
    this.saveDb();
  }

  loadEvents(): PreferenceChainEvent[] {
    const segments: readonly string[] = PREFERENCE_SEGMENTS;
    return this.all('SELECT pin_id, path, author, height, tx_index, timestamp_ms, body_json FROM preference_events;').flatMap(
      (row) => {
        const path = String(row.path);
        if (!segments.includes(path)) return [];
        return [{
          pinId: String(row.pin_id),
          path: path as PreferenceSegment,
          author: String(row.author),
          height: Number(row.height),
          txIndex: Number(row.tx_index),
          timestampMs: Number(row.timestamp_ms),
          body: parseObject(row.body_json),
        }];
      },
    );
  }

  insertBallot(input: NewBallotInput): PreferenceBallotRow {
    const id = randomUUID();
    this.write(
      `INSERT INTO preference_ballots (id, round_pin_id, signer_type, metabot_id, judge_global_metaid, ballot_json, salt,
         commit_hash, status, reveal_attempts, commit_close_at, reveal_close_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committing', 0, ?, ?, ?, ?);`,
      [
        id,
        input.roundPinId,
        input.signerType,
        input.metabotId,
        input.judgeGlobalMetaId,
        JSON.stringify(input.ballot),
        input.salt,
        input.commitHash,
        input.commitCloseAt,
        input.revealCloseAt,
        input.nowMs,
        input.nowMs,
      ],
    );
    const row = this.getBallot(id);
    if (!row) throw new Error('preference ballot insert failed');
    return row;
  }

  getBallot(id: string): PreferenceBallotRow | null {
    const [row] = this.all(`SELECT ${BALLOT_COLUMNS} FROM preference_ballots WHERE id = ?;`, [id]);
    return row ? toBallotRow(row) : null;
  }

  listBallots(filter: { roundPinId?: string; statuses?: PreferenceBallotStatus[] } = {}): PreferenceBallotRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.roundPinId) {
      clauses.push('round_pin_id = ?');
      params.push(filter.roundPinId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.all(`SELECT ${BALLOT_COLUMNS} FROM preference_ballots ${where} ORDER BY created_at ASC, rowid ASC;`, params).map(toBallotRow);
  }

  markCommitted(id: string, commitPinId: string, nowMs: number): void {
    const row = this.getBallot(id);
    if (!row) return;
    this.db.run(
      `UPDATE preference_ballots SET status = 'superseded', updated_at = ?
       WHERE round_pin_id = ? AND judge_global_metaid = ? AND id <> ? AND status IN ('committing', 'committed');`,
      [nowMs, row.roundPinId, row.judgeGlobalMetaId, id],
    );
    this.write(
      `UPDATE preference_ballots SET status = 'committed', commit_pin_id = ?, last_error = NULL, updated_at = ? WHERE id = ?;`,
      [commitPinId, nowMs, id],
    );
  }

  markCommitFailed(id: string, error: string, nowMs: number): void {
    this.write(`UPDATE preference_ballots SET status = 'commit_failed', last_error = ?, updated_at = ? WHERE id = ?;`, [error, nowMs, id]);
  }

  markRevealed(id: string, revealPinId: string, nowMs: number): void {
    this.write(
      `UPDATE preference_ballots SET status = 'revealed', reveal_pin_id = ?, last_error = NULL, updated_at = ? WHERE id = ?;`,
      [revealPinId, nowMs, id],
    );
  }

  markRevealRetry(id: string, nowMs: number): void {
    this.write(`UPDATE preference_ballots SET status = 'committed', reveal_pin_id = NULL, updated_at = ? WHERE id = ?;`, [nowMs, id]);
  }

  markRevealFailed(id: string, error: string, nowMs: number): PreferenceBallotStatus {
    const row = this.getBallot(id);
    if (!row) return 'reveal_failed';
    const attempts = row.revealAttempts + 1;
    const status: PreferenceBallotStatus = attempts >= MAX_REVEAL_ATTEMPTS ? 'reveal_failed' : 'committed';
    this.write(
      `UPDATE preference_ballots SET status = ?, reveal_attempts = ?, last_error = ?, updated_at = ? WHERE id = ?;`,
      [status, attempts, error, nowMs, id],
    );
    return status;
  }

  expireStale(nowSec: number, nowMs: number): number {
    const stale = this.all(
      `SELECT id FROM preference_ballots WHERE status IN ('committing', 'committed') AND reveal_close_at < ?;`,
      [nowSec],
    );
    if (stale.length === 0) return 0;
    this.write(
      `UPDATE preference_ballots SET status = 'expired', updated_at = ? WHERE status IN ('committing', 'committed') AND reveal_close_at < ?;`,
      [nowMs, nowSec],
    );
    return stale.length;
  }

  countActive(nowSec: number): number {
    const [row] = this.all(
      `SELECT COUNT(*) AS n FROM preference_ballots WHERE status IN ('committing', 'committed', 'revealed') AND reveal_close_at >= ?;`,
      [nowSec],
    );
    return row ? Number(row.n) : 0;
  }

  recordTelemetry(roundPinId: string, pairKey: string, seconds: number, nowMs: number): void {
    this.write(
      `INSERT INTO preference_compare_telemetry (round_pin_id, pair_key, seconds, recorded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(round_pin_id, pair_key) DO UPDATE SET seconds = preference_compare_telemetry.seconds + excluded.seconds,
         recorded_at = excluded.recorded_at;`,
      [roundPinId, pairKey, seconds, nowMs],
    );
  }

  telemetryForRound(roundPinId: string): { pairKey: string; seconds: number }[] {
    return this.all(
      'SELECT pair_key, seconds FROM preference_compare_telemetry WHERE round_pin_id = ? ORDER BY pair_key ASC;',
      [roundPinId],
    ).map((row) => ({ pairKey: String(row.pair_key), seconds: Number(row.seconds) }));
  }
}
