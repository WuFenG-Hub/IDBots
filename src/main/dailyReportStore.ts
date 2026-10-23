/**
 * Daily Report (每日汇报) run ledger — one row per local day.
 *
 * Mirrors metabot_dream_runs' per-date idempotency: the service claims a day
 * with an INSERT whose UNIQUE(report_date) guards double-fire, then moves the
 * row through running → completed/skipped/failed. A failure after the claim
 * (generator/LLM error) leaves a 'failed' row that the service re-arms with
 * bounded same-day backoff (dreamRetryPolicy); a failure after delivery
 * reused the recorded session_id, so a retry never creates a second report
 * session for the same day. A crash after the claim leaves a stale 'running'
 * row that failStaleRunningRuns (service start / each tick) flips to 'failed'
 * so the day re-enters the bounded-retry path instead of blocking the
 * UNIQUE(report_date) claim forever.
 */

import type { SqliteDatabase as Database } from './sqliteTypes';

export type DailyReportRunStatus = 'running' | 'completed' | 'skipped' | 'failed';
export type DailyReportTriggerKind = 'scheduled' | 'catchup' | 'retry' | 'manual';

export interface DailyReportRun {
  id: number;
  reportDate: string;
  status: DailyReportRunStatus;
  triggerKind: DailyReportTriggerKind;
  sessionId: string | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  factsJson: string | null;
  error: string | null;
  attemptCount: number;
  createdAt: number;
  completedAt: number | null;
}

export interface DailyReportRunClaim {
  reportDate: string;
  triggerKind: DailyReportTriggerKind;
  windowStartMs: number;
  windowEndMs: number;
}

interface DailyReportRunRow {
  id: number;
  report_date: string;
  status: string;
  trigger_kind: string;
  session_id: string | null;
  window_start_ms: number | null;
  window_end_ms: number | null;
  facts_json: string | null;
  error: string | null;
  attempt_count: number;
  created_at: number;
  completed_at: number | null;
}

export class DailyReportStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureSchema();
  }

  /**
   * Idempotent first-run migration (CREATE TABLE IF NOT EXISTS — the same
   * double-entry convention as the dream tables: sqliteStore.initializeTables
   * also creates this table, so a fresh store on an old database is safe).
   */
  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS daily_report_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        session_id TEXT,
        window_start_ms INTEGER,
        window_end_ms INTEGER,
        facts_json TEXT,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  getRunForDate(reportDate: string): DailyReportRun | null {
    const row = this.getOne<DailyReportRunRow>(
      'SELECT * FROM daily_report_runs WHERE report_date = ? LIMIT 1',
      [reportDate],
    );
    return row ? this.rowToRun(row) : null;
  }

  /**
   * The window anchor for the next report: the most recent COMPLETED run's
   * window end. Skipped days carry no content, so they do not move the anchor
   * (their window is re-inspected by the next real report, which is what the
   * "since last successful report" rule means for an empty day).
   */
  getLastSuccessfulRun(): DailyReportRun | null {
    const row = this.getOne<DailyReportRunRow>(
      `SELECT * FROM daily_report_runs
       WHERE status = 'completed' AND window_end_ms IS NOT NULL
       ORDER BY window_end_ms DESC
       LIMIT 1`,
    );
    return row ? this.rowToRun(row) : null;
  }

  /**
   * Claim a day: INSERT the run row. The UNIQUE(report_date) violation means
   * another attempt (or an earlier tick) already owns the day — return null
   * and fire nothing. The claim happens BEFORE any generation work, which is
   * what makes double-fire impossible. `atMs` is injectable for tests.
   */
  claimRun(claim: DailyReportRunClaim, atMs: number = Date.now()): DailyReportRun | null {
    try {
      this.db.run(
        `INSERT INTO daily_report_runs
           (report_date, status, trigger_kind, session_id,
            window_start_ms, window_end_ms, facts_json, error,
            attempt_count, created_at, completed_at)
         VALUES (?, 'running', ?, NULL, ?, ?, NULL, NULL, 1, ?, NULL)`,
        [claim.reportDate, claim.triggerKind, claim.windowStartMs, claim.windowEndMs, atMs],
      );
    } catch {
      // sql.js raises on the UNIQUE(report_date) conflict — the day is taken.
      return null;
    }
    this.saveDb();
    return this.getRunForDate(claim.reportDate);
  }

  /**
   * Re-arm a failed day for a bounded same-day retry: flip the row back to
   * 'running', bump attempt_count and re-stamp the window. Returns null when
   * the row is not in a retryable state (already retried past the cap, or a
   * concurrent claim settled it) — the caller treats null as "do not retry".
   */
  reactivateFailedRun(claim: DailyReportRunClaim, maxAttempts: number, atMs: number = Date.now()): DailyReportRun | null {
    this.db.run(
      `UPDATE daily_report_runs
       SET status = 'running', trigger_kind = ?, error = NULL,
           window_start_ms = ?, window_end_ms = ?,
           attempt_count = attempt_count + 1,
           created_at = ?, completed_at = NULL
       WHERE report_date = ? AND status = 'failed' AND attempt_count < ?`,
      [claim.triggerKind, claim.windowStartMs, claim.windowEndMs, atMs, claim.reportDate, maxAttempts],
    );
    if ((this.db.getRowsModified?.() ?? 0) <= 0) {
      return null;
    }
    this.saveDb();
    return this.getRunForDate(claim.reportDate);
  }

  /**
   * Crash recovery for runs orphaned by a killed process: flip 'running' rows
   * created BEFORE the current service instance started to 'failed' with a
   * recovery error and completed_at = atMs. Rows created at/after
   * `startedAtMs` belong to the live instance (including one it is executing
   * right now — its claims are stamped with atMs >= its own start) and are
   * never touched. The failed rows re-enter the service's bounded retry/
   * backoff path, so a recovered day is retried instead of permanently
   * blocking the UNIQUE(report_date) claim. Returns the recovered runs.
   */
  failStaleRunningRuns(startedAtMs: number, atMs: number = Date.now()): DailyReportRun[] {
    const stale = this.getAll<DailyReportRunRow>(
      `SELECT * FROM daily_report_runs WHERE status = 'running' AND created_at < ?`,
      [startedAtMs],
    );
    if (stale.length === 0) return [];
    const error = 'run interrupted by app restart (recovered stale running row)';
    this.db.run(
      `UPDATE daily_report_runs
       SET status = 'failed', error = ?, completed_at = ?
       WHERE status = 'running' AND created_at < ?`,
      [error, atMs, startedAtMs],
    );
    this.saveDb();
    return stale.map((row) => this.rowToRun({ ...row, status: 'failed', error, completed_at: atMs }));
  }

  /**
   * Reset today's row for a fresh MANUAL attempt (owner-initiated "run now").
   * Unlike the scheduled claim, a manual run is allowed to re-open a day that
   * already has a row in any status — including a stale 'running' left by a
   * crash (in-process concurrency is guarded by the service's firing flag).
   * The previous session_id is dropped: every manual run delivers a NEW
   * report session, and attempt_count keeps climbing per the retry patterns.
   */
  resetRunForManual(claim: DailyReportRunClaim, atMs: number = Date.now()): DailyReportRun | null {
    this.db.run(
      `UPDATE daily_report_runs
       SET status = 'running', trigger_kind = ?, session_id = NULL,
           window_start_ms = ?, window_end_ms = ?,
           facts_json = NULL, error = NULL,
           attempt_count = attempt_count + 1,
           created_at = ?, completed_at = NULL
       WHERE report_date = ?`,
      [claim.triggerKind, claim.windowStartMs, claim.windowEndMs, atMs, claim.reportDate],
    );
    if ((this.db.getRowsModified?.() ?? 0) <= 0) {
      return null;
    }
    this.saveDb();
    return this.getRunForDate(claim.reportDate);
  }

  markSkipped(id: number, atMs: number = Date.now()): void {
    this.db.run(
      `UPDATE daily_report_runs
       SET status = 'skipped', error = NULL, completed_at = ?
       WHERE id = ?`,
      [atMs, id],
    );
    this.saveDb();
  }

  markCompleted(id: number, sessionId: string, factsJson: string, atMs: number = Date.now()): void {
    this.db.run(
      `UPDATE daily_report_runs
       SET status = 'completed', session_id = ?, facts_json = ?, error = NULL, completed_at = ?
       WHERE id = ?`,
      [sessionId, factsJson, atMs, id],
    );
    this.saveDb();
  }

  markFailed(id: number, error: string, atMs: number = Date.now()): void {
    this.db.run(
      `UPDATE daily_report_runs
       SET status = 'failed', error = ?, completed_at = ?
       WHERE id = ?`,
      [error.slice(0, 2000), atMs, id],
    );
    this.saveDb();
  }

  /**
   * Persist the delivery session as soon as it exists so a later retry of a
   * failed day reuses it instead of creating a duplicate report session.
   */
  setRunSessionId(id: number, sessionId: string): void {
    this.db.run(
      'UPDATE daily_report_runs SET session_id = ? WHERE id = ?',
      [sessionId, id],
    );
    this.saveDb();
  }

  private rowToRun(row: DailyReportRunRow): DailyReportRun {
    return {
      id: row.id,
      reportDate: row.report_date,
      status: row.status as DailyReportRunStatus,
      triggerKind: row.trigger_kind as DailyReportTriggerKind,
      sessionId: row.session_id,
      windowStartMs: row.window_start_ms,
      windowEndMs: row.window_end_ms,
      factsJson: row.facts_json,
      error: row.error,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
