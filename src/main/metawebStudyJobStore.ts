import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * MetaWeb study jobs ("自主学习任务") — the M4 queue behind
 * "study topic X in your spare time".
 *
 * A job records one owner-assigned study topic for one MetaBot. Nightly
 * (inside the knowledge-base auto-learn window) a bounded background session
 * searches MetaWeb for the topic, saves worthwhile pin bodies into the bot's
 * knowledge base, and records progress here. A job stays pending across
 * nights — each run consumes up to `budgetPins` NEW pins — and completes when
 * a run adds nothing new (corpus exhausted for the topic) or the run-count
 * safety cap is reached.
 *
 * This table is queue state only; the learned content lives in the bot's
 * knowledge bases (raw documents + per-KB search index), never duplicated
 * here. Sibling to knowledge_bases: that table is the corpus registry, this
 * one is the autonomous-fetch work queue feeding it.
 */

export type MetawebStudyJobStatus = 'pending' | 'running' | 'done' | 'failed';

export const DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT = 20;
/** Safety bound so a topic with an ever-growing corpus cannot run forever. */
export const MAX_STUDY_RUNS_PER_JOB = 10;
/** A failing job stays pending (retried next nights) until this many consecutive failures. */
export const MAX_STUDY_CONSECUTIVE_FAILURES = 3;
const MAX_TOPIC_CHARS = 200;

export interface MetawebStudyJobRecord {
  id: string;
  metabotId: number;
  topic: string;
  topicFingerprint: string;
  status: MetawebStudyJobStatus;
  budgetPins: number;
  processedPinIds: string[];
  runCount: number;
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MetawebStudyJobRow {
  id: string;
  metabot_id: number;
  topic: string;
  topic_fingerprint: string;
  status: MetawebStudyJobStatus;
  budget_pins: number;
  processed_pin_ids: string;
  run_count: number;
  consecutive_failures: number;
  last_run_at: string | null;
  last_run_summary: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Normalize a topic for active-job dedupe: case- and whitespace-insensitive. */
export function studyTopicFingerprintOf(topic: string): string {
  return String(topic ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeStudyTopic(topic: unknown): string {
  return String(topic ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TOPIC_CHARS);
}

function parsePinIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const rowToRecord = (row: MetawebStudyJobRow): MetawebStudyJobRecord => ({
  id: row.id,
  metabotId: row.metabot_id,
  topic: row.topic,
  topicFingerprint: row.topic_fingerprint,
  status: row.status,
  budgetPins: Number(row.budget_pins) || DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT,
  processedPinIds: parsePinIds(row.processed_pin_ids),
  runCount: Number(row.run_count) || 0,
  consecutiveFailures: Number(row.consecutive_failures) || 0,
  lastRunAt: row.last_run_at || null,
  lastRunSummary: row.last_run_summary || null,
  lastError: row.last_error || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Create the study-job queue without changing existing user data. */
export function ensureMetawebStudyJobSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metaweb_study_jobs (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      topic TEXT NOT NULL CHECK (trim(topic) <> ''),
      topic_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'failed')),
      budget_pins INTEGER NOT NULL DEFAULT ${DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT},
      processed_pin_ids TEXT NOT NULL DEFAULT '[]',
      run_count INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_run_summary TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaweb_study_jobs_metabot
      ON metaweb_study_jobs(metabot_id, status, created_at);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaweb_study_jobs_runnable
      ON metaweb_study_jobs(status, created_at);
  `);
  // Additive migration for databases created before consecutive_failures
  // existed (CREATE TABLE IF NOT EXISTS is a no-op there).
  const columns = db.exec('PRAGMA table_info(metaweb_study_jobs)')[0]?.values ?? [];
  const names = columns.map((row) => String(row[1]));
  if (!names.includes('consecutive_failures')) {
    db.run('ALTER TABLE metaweb_study_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
  }
}

export class MetawebStudyJobStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    ensureMetawebStudyJobSchema(db);
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  insert(record: MetawebStudyJobRecord): void {
    this.db.run(
      `INSERT INTO metaweb_study_jobs
        (id, metabot_id, topic, topic_fingerprint, status, budget_pins,
         processed_pin_ids, run_count, consecutive_failures, last_run_at, last_run_summary, last_error,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.metabotId,
        record.topic,
        record.topicFingerprint,
        record.status,
        record.budgetPins,
        JSON.stringify(record.processedPinIds),
        record.runCount,
        record.consecutiveFailures,
        record.lastRunAt,
        record.lastRunSummary,
        record.lastError,
        record.createdAt,
        record.updatedAt,
      ],
    );
    this.saveDb();
  }

  getById(id: string): MetawebStudyJobRecord | null {
    const row = this.getOne<MetawebStudyJobRow>(
      'SELECT * FROM metaweb_study_jobs WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToRecord(row) : null;
  }

  /** Newest first, for the status tool and the UI list. */
  listByMetabot(metabotId: number): MetawebStudyJobRecord[] {
    return this.getAll<MetawebStudyJobRow>(
      'SELECT * FROM metaweb_study_jobs WHERE metabot_id = ? ORDER BY created_at DESC',
      [metabotId],
    ).map(rowToRecord);
  }

  /** The active (pending/running) job for a topic, if one exists — enqueue dedupe. */
  findActiveByFingerprint(metabotId: number, topicFingerprint: string): MetawebStudyJobRecord | null {
    const row = this.getOne<MetawebStudyJobRow>(
      `SELECT * FROM metaweb_study_jobs
       WHERE metabot_id = ? AND topic_fingerprint = ? AND status IN ('pending', 'running')
       LIMIT 1`,
      [metabotId, topicFingerprint],
    );
    return row ? rowToRecord(row) : null;
  }

  /** Oldest first across ALL bots — the nightly scheduler drains this queue. */
  listPending(): MetawebStudyJobRecord[] {
    return this.getAll<MetawebStudyJobRow>(
      `SELECT * FROM metaweb_study_jobs WHERE status = 'pending' ORDER BY created_at ASC`,
    ).map(rowToRecord);
  }

  markRunning(id: string, nowIso: string): void {
    this.db.run(
      `UPDATE metaweb_study_jobs SET status = 'running', updated_at = ? WHERE id = ?`,
      [nowIso, id],
    );
    this.saveDb();
  }

  /**
   * Record one finished nightly run. `nextStatus` is 'pending' when the job
   * continues tomorrow night (including retryable failures below the
   * consecutive-failure threshold), 'done' when the corpus gave nothing new
   * or the run cap hit, 'failed' after too many consecutive failures.
   * `processedPinIds` is the full cumulative list (the service merges, the
   * store just persists).
   */
  recordRun(
    id: string,
    outcome: {
      nextStatus: MetawebStudyJobStatus;
      processedPinIds: string[];
      consecutiveFailures: number;
      summary: string | null;
      error: string | null;
      nowIso: string;
    },
  ): void {
    this.db.run(
      `UPDATE metaweb_study_jobs
       SET status = ?, processed_pin_ids = ?, run_count = run_count + 1,
           consecutive_failures = ?,
           last_run_at = ?, last_run_summary = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        outcome.nextStatus,
        JSON.stringify(outcome.processedPinIds),
        outcome.consecutiveFailures,
        outcome.nowIso,
        outcome.summary,
        outcome.error,
        outcome.nowIso,
        id,
      ],
    );
    this.saveDb();
  }

  /**
   * Crash recovery: a job left 'running' by a killed process becomes pending
   * again. `excludeId` protects a job that is still running IN THIS PROCESS
   * (sqlite recovery restarts the schedule while an in-flight run lives on) —
   * resetting it would start a duplicate session.
   */
  resetRunningToPending(nowIso: string, excludeId?: string): number {
    if (excludeId) {
      this.db.run(
        `UPDATE metaweb_study_jobs SET status = 'pending', updated_at = ? WHERE status = 'running' AND id <> ?`,
        [nowIso, excludeId],
      );
    } else {
      this.db.run(
        `UPDATE metaweb_study_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`,
        [nowIso],
      );
    }
    this.saveDb();
    return this.db.getRowsModified?.() ?? 0;
  }
}
