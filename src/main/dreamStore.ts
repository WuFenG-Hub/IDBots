import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Dream consolidation storage layer.
 *
 * Dream tables (created idempotently both here and in sqliteStore.initializeTables):
 * - metabot_daily_summaries: one row per bot per date with the dream-produced
 *   narrative of that day (overall + per-category sections).
 * - metabot_dream_runs: one row per bot per date tracking consolidation runs;
 *   the UNIQUE(metabot_id, dream_date) constraint is the idempotency anchor.
 *
 * Also owns the "what did this bot do on date D" activity query used to build
 * the dream prompt. Raw messages are returned untruncated; budgeting for the
 * prompt is the caller's concern (libs/dreamPrompt).
 */

export type DreamRunStatus = 'running' | 'completed' | 'failed';
export type DreamFragmentStatus = 'running' | 'completed' | 'failed';

export interface DreamRun {
  id: string;
  metabotId: number;
  dreamDate: string;
  status: DreamRunStatus;
  attemptCount: number;
  llmId: string | null;
  /** Algorithm version the run was made with; 0 = legacy, pre-versioning. */
  dreamVersion: number;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface DreamFragment {
  id: string;
  metabotId: number;
  dreamDate: string;
  fragmentKey: string;
  sessionId: string;
  chunkIndex: number;
  contentHash: string;
  sourceMessageCount: number;
  sourceCharCount: number;
  estimatedInputTokens: number;
  status: DreamFragmentStatus;
  summaryJson: string | null;
  llmId: string | null;
  dreamVersion: number;
  error: string | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DailySummarySessionRef {
  sessionId: string;
  title: string;
  sessionType: string;
  isOrder: boolean;
}

export interface DailySummary {
  id: string;
  metabotId: number;
  summaryDate: string;
  summaryText: string;
  sections: Record<string, string>;
  stats: Record<string, number>;
  /** Sessions that fed this summary — the index from a recalled day back to
   * the full conversations (read them via idbots_session_read_all). */
  sessionRefs: DailySummarySessionRef[];
  llmId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DreamActivityMessage {
  type: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** Human's per-message rating (thumbs up/down), when the message was rated. */
  feedbackRating?: 'up' | 'down';
  /** Human's free-text comment attached to the rating, when present. */
  feedbackComment?: string | null;
}

export interface DreamSessionActivity {
  sessionId: string;
  title: string;
  sessionType: string;
  peerName: string | null;
  isOrder: boolean;
  messages: DreamActivityMessage[];
}

export interface DreamTaskRunActivity {
  taskName: string;
  status: string;
  startedAt: number;
  sessionId: string | null;
}

/** accepted = closed/rated that day; active = still open with same-day activity. */
export type DreamGroupTaskPhase = 'accepted' | 'active';

/**
 * One group task the bot participated in that belongs on this day's review —
 * either owner acceptance (rating/review) or still-open work with same-day
 * activity (on-chain chat or a skill-turn session).
 */
export interface DreamGroupTaskEvaluation {
  taskId: number;
  title: string;
  goal: string;
  /** This bot's role in the task ('chair' | 'worker'). */
  memberRole: string;
  /** 1-5 stars; null when the task was closed without a rating (automation). */
  rating: number | null;
  ratingComment: string | null;
  /** Task status at query time. Optional on older fixtures. */
  status?: string;
  /** Defaults to 'accepted' when omitted so older fixtures keep working. */
  phase?: DreamGroupTaskPhase;
  /** Same-day on-chain group-chat message count, when known. */
  dayMessageCount?: number;
}

export interface DreamGroupChatMessage {
  senderName: string;
  senderGlobalMetaID: string | null;
  content: string;
  occurredAt: number;
}

/** One group-task's on-chain group chat for the local day. */
export interface DreamGroupChatActivity {
  taskId: number;
  title: string;
  groupId: string;
  taskStatus: string;
  memberRole: string;
  messages: DreamGroupChatMessage[];
}

export interface DreamDayActivity {
  sessions: DreamSessionActivity[];
  taskRuns: DreamTaskRunActivity[];
  /** service_orders rows created that day (raw order count, not sessions). */
  orderCount: number;
  /** Group tasks accepted or still active that day where this bot was a member. */
  groupTasks: DreamGroupTaskEvaluation[];
  /** On-chain group-chat transcripts for member tasks that had messages that day. */
  groupChats?: DreamGroupChatActivity[];
}

interface DreamRunRow {
  id: string;
  metabot_id: number | string;
  dream_date: string;
  status: string;
  attempt_count: number | string;
  llm_id: string | null;
  dream_version?: number | string | null;
  error: string | null;
  started_at: number | string;
  completed_at: number | string | null;
}

interface DreamFragmentRow {
  id: string;
  metabot_id: number | string;
  dream_date: string;
  fragment_key: string;
  session_id: string;
  chunk_index: number | string;
  content_hash: string;
  source_message_count: number | string;
  source_char_count: number | string;
  estimated_input_tokens: number | string;
  status: string;
  summary_json: string | null;
  llm_id: string | null;
  dream_version: number | string | null;
  error: string | null;
  attempt_count: number | string;
  created_at: number | string;
  updated_at: number | string;
}

interface DailySummaryRow {
  id: string;
  metabot_id: number | string;
  summary_date: string;
  summary_text: string;
  sections_json: string | null;
  stats_json: string | null;
  session_refs_json?: string | null;
  llm_id: string | null;
  created_at: number | string;
  updated_at: number | string;
}

/** Bound one task's on-chain transcript so a busy group cannot flood the dream. */
const MAX_GROUP_CHAT_MESSAGES_PER_TASK = 400;

const parseIdNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
};

const parseJsonObject = <T = string>(raw: string | null): Record<string, T> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const parseSessionRefs = (raw: string | null | undefined): DailySummarySessionRef[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && typeof item.sessionId === 'string')
      .map((item) => ({
        sessionId: item.sessionId as string,
        title: typeof item.title === 'string' ? item.title : '',
        sessionType: typeof item.sessionType === 'string' ? item.sessionType : 'standard',
        isOrder: Boolean(item.isOrder),
      }));
  } catch {
    return [];
  }
};

export class DreamStore {
  constructor(
    private db: Database,
    private saveDb: () => void
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_daily_summaries (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        summary_date TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        sections_json TEXT NOT NULL DEFAULT '{}',
        stats_json TEXT NOT NULL DEFAULT '{}',
        session_refs_json TEXT NOT NULL DEFAULT '[]',
        llm_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, summary_date)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_runs (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        llm_id TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_fragments (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        fragment_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_char_count INTEGER NOT NULL DEFAULT 0,
        estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        summary_json TEXT,
        llm_id TEXT,
        dream_version INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date, fragment_key)
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_dream_fragments_date
      ON metabot_dream_fragments(metabot_id, dream_date)
    `);
    try {
      const cols = this.db.exec('PRAGMA table_info(metabot_daily_summaries);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('session_refs_json')) {
        this.db.run("ALTER TABLE metabot_daily_summaries ADD COLUMN session_refs_json TEXT NOT NULL DEFAULT '[]';");
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to verify metabot_daily_summaries columns:', error);
    }
    try {
      const cols = this.db.exec('PRAGMA table_info(metabot_dream_runs);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('dream_version')) {
        this.db.run('ALTER TABLE metabot_dream_runs ADD COLUMN dream_version INTEGER NOT NULL DEFAULT 0;');
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to verify metabot_dream_runs columns:', error);
    }
    // dream_date tags on dream-origin memory sources: the idempotency anchor
    // that lets a re-dream replace exactly one day's memory batch.
    try {
      const cols = this.db.exec('PRAGMA table_info(user_memory_sources);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('dream_date')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN dream_date TEXT NULL;');
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_dream_date
        ON user_memory_sources(metabot_id, dream_date)
      `);
    } catch (error) {
      console.warn('[DreamStore] Failed to verify user_memory_sources dream columns:', error);
    }
    this.backfillLegacyDreamMemoryDates();
  }

  /**
   * One-time attribution of pre-versioning dream memories to their dream date.
   * Legacy source rows (source_type='dream', dream_date NULL) are matched to
   * the same-bot run whose completion is closest to — and not more than 5
   * minutes after — the memory write. Runs only keep their latest attempt's
   * window, so batches from superseded attempts may land on an adjacent date;
   * acceptable, since every attributed date is re-dreamed once by version
   * repair and each batch is then replaced wholesale. Rows with no matching
   * run stay untagged and are never auto-removed. Only NULL rows are touched,
   * so this is idempotent.
   */
  private backfillLegacyDreamMemoryDates(): void {
    try {
      this.db.run(`
        UPDATE user_memory_sources
        SET dream_date = (
          SELECT r.dream_date
          FROM metabot_dream_runs r
          WHERE r.metabot_id = user_memory_sources.metabot_id
            AND r.completed_at IS NOT NULL
            AND r.completed_at <= user_memory_sources.created_at + 300000
          ORDER BY r.completed_at DESC
          LIMIT 1
        )
        WHERE dream_date IS NULL AND source_type = 'dream'
      `);
      if ((this.db.getRowsModified?.() || 0) > 0) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to backfill legacy dream memory dates:', error);
    }
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

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | null {
    return this.getAll<T>(sql, params)[0] ?? null;
  }

  private mapRunRow(row: DreamRunRow): DreamRun {
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      dreamDate: row.dream_date,
      status: (row.status === 'completed' || row.status === 'failed' ? row.status : 'running') as DreamRunStatus,
      attemptCount: parseIdNumber(row.attempt_count) ?? 1,
      llmId: row.llm_id ?? null,
      dreamVersion: parseIdNumber(row.dream_version) ?? 0,
      error: row.error ?? null,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  private mapFragmentRow(row: DreamFragmentRow): DreamFragment {
    const status = row.status === 'completed' || row.status === 'failed' ? row.status : 'running';
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      dreamDate: row.dream_date,
      fragmentKey: row.fragment_key,
      sessionId: row.session_id,
      chunkIndex: parseIdNumber(row.chunk_index) ?? 0,
      contentHash: row.content_hash,
      sourceMessageCount: parseIdNumber(row.source_message_count) ?? 0,
      sourceCharCount: parseIdNumber(row.source_char_count) ?? 0,
      estimatedInputTokens: parseIdNumber(row.estimated_input_tokens) ?? 0,
      status: status as DreamFragmentStatus,
      summaryJson: row.summary_json ?? null,
      llmId: row.llm_id ?? null,
      dreamVersion: parseIdNumber(row.dream_version) ?? 0,
      error: row.error ?? null,
      attemptCount: parseIdNumber(row.attempt_count) ?? 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapSummaryRow(row: DailySummaryRow): DailySummary {
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      summaryDate: row.summary_date,
      summaryText: row.summary_text,
      sections: parseJsonObject<string>(row.sections_json),
      stats: parseJsonObject<number>(row.stats_json),
      sessionRefs: parseSessionRefs(row.session_refs_json),
      llmId: row.llm_id ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Start (or restart) a run for (metabot, date). Re-running a completed/failed
   * date resets the row to running and bumps attempt_count.
   */
  beginRun(metabotId: number, dreamDate: string, llmId: string | null, dreamVersion: number): DreamRun {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_dream_runs (
        id, metabot_id, dream_date, status, attempt_count, llm_id, dream_version, error,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', 1, ?, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(metabot_id, dream_date) DO UPDATE SET
        status = 'running',
        attempt_count = attempt_count + 1,
        llm_id = excluded.llm_id,
        dream_version = excluded.dream_version,
        error = NULL,
        started_at = excluded.started_at,
        completed_at = NULL,
        updated_at = excluded.updated_at
    `, [uuidv4(), metabotId, dreamDate, llmId, dreamVersion, now, now, now]);
    this.saveDb();
    const run = this.getRun(metabotId, dreamDate);
    if (!run) {
      throw new Error('Failed to load dream run after beginRun');
    }
    return run;
  }

  finishRun(metabotId: number, dreamDate: string, status: 'completed' | 'failed', error?: string | null): void {
    const now = Date.now();
    this.db.run(`
      UPDATE metabot_dream_runs
      SET status = ?, error = ?, completed_at = ?, updated_at = ?
      WHERE metabot_id = ? AND dream_date = ?
    `, [status, error ?? null, now, now, metabotId, dreamDate]);
    this.saveDb();
  }

  getRun(metabotId: number, dreamDate: string): DreamRun | null {
    const row = this.getOne<DreamRunRow>(
      'SELECT * FROM metabot_dream_runs WHERE metabot_id = ? AND dream_date = ? LIMIT 1',
      [metabotId, dreamDate]
    );
    return row ? this.mapRunRow(row) : null;
  }

  /**
   * Recent run rows for display (dream diary failure fallback), newest date
   * first. Read-only: scheduling decisions use getRunStates/computeDueDreamDates
   * on this same table, so surfacing these rows can never mark a date as done.
   */
  listRecentRuns(metabotId: number, limit: number = 30): DreamRun[] {
    const clampedLimit = Math.max(1, Math.min(365, Math.floor(limit)));
    const rows = this.getAll<DreamRunRow>(
      'SELECT * FROM metabot_dream_runs WHERE metabot_id = ? ORDER BY dream_date DESC LIMIT ?',
      [metabotId, clampedLimit]
    );
    return rows.map((row) => this.mapRunRow(row));
  }

  getDreamFragment(metabotId: number, dreamDate: string, fragmentKey: string): DreamFragment | null {
    const row = this.getOne<DreamFragmentRow>(
      `SELECT * FROM metabot_dream_fragments
       WHERE metabot_id = ? AND dream_date = ? AND fragment_key = ? LIMIT 1`,
      [metabotId, dreamDate, fragmentKey]
    );
    return row ? this.mapFragmentRow(row) : null;
  }

  listDreamFragments(metabotId: number, dreamDate: string): DreamFragment[] {
    const rows = this.getAll<DreamFragmentRow>(
      `SELECT * FROM metabot_dream_fragments
       WHERE metabot_id = ? AND dream_date = ? ORDER BY chunk_index ASC, fragment_key ASC`,
      [metabotId, dreamDate]
    );
    return rows.map((row) => this.mapFragmentRow(row));
  }

  beginDreamFragment(input: {
    metabotId: number;
    dreamDate: string;
    fragmentKey: string;
    sessionId: string;
    chunkIndex: number;
    contentHash: string;
    sourceMessageCount: number;
    sourceCharCount: number;
    estimatedInputTokens: number;
    llmId: string | null;
    dreamVersion: number;
  }): DreamFragment {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_dream_fragments (
        id, metabot_id, dream_date, fragment_key, session_id, chunk_index,
        content_hash, source_message_count, source_char_count, estimated_input_tokens,
        status, summary_json, llm_id, dream_version, error, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, NULL, 1, ?, ?)
      ON CONFLICT(metabot_id, dream_date, fragment_key) DO UPDATE SET
        session_id = excluded.session_id,
        chunk_index = excluded.chunk_index,
        content_hash = excluded.content_hash,
        source_message_count = excluded.source_message_count,
        source_char_count = excluded.source_char_count,
        estimated_input_tokens = excluded.estimated_input_tokens,
        status = 'running',
        summary_json = NULL,
        llm_id = excluded.llm_id,
        dream_version = excluded.dream_version,
        error = NULL,
        attempt_count = metabot_dream_fragments.attempt_count + 1,
        updated_at = excluded.updated_at
    `, [
      uuidv4(),
      input.metabotId,
      input.dreamDate,
      input.fragmentKey,
      input.sessionId,
      input.chunkIndex,
      input.contentHash,
      input.sourceMessageCount,
      input.sourceCharCount,
      input.estimatedInputTokens,
      input.llmId,
      input.dreamVersion,
      now,
      now,
    ]);
    this.saveDb();
    const fragment = this.getDreamFragment(input.metabotId, input.dreamDate, input.fragmentKey);
    if (!fragment) throw new Error('Failed to load dream fragment after beginDreamFragment');
    return fragment;
  }

  finishDreamFragment(
    metabotId: number,
    dreamDate: string,
    fragmentKey: string,
    status: 'completed' | 'failed',
    summaryJson: string | null = null,
    error: string | null = null,
  ): void {
    this.db.run(`
      UPDATE metabot_dream_fragments
      SET status = ?, summary_json = ?, error = ?, updated_at = ?
      WHERE metabot_id = ? AND dream_date = ? AND fragment_key = ?
    `, [status, summaryJson, error, Date.now(), metabotId, dreamDate, fragmentKey]);
    this.saveDb();
  }

  /** status + attempt_count + started_at + dream_version for the given dates, keyed by dream_date. */
  getRunStates(metabotId: number, dreamDates: string[]): Map<string, { status: DreamRunStatus; attemptCount: number; startedAt: number; dreamVersion: number }> {
    const states = new Map<string, { status: DreamRunStatus; attemptCount: number; startedAt: number; dreamVersion: number }>();
    if (dreamDates.length === 0) return states;
    const placeholders = dreamDates.map(() => '?').join(', ');
    const rows = this.getAll<{ dream_date: string; status: string; attempt_count: number | string; started_at: number | string; dream_version: number | string | null }>(
      `SELECT dream_date, status, attempt_count, started_at, dream_version FROM metabot_dream_runs
       WHERE metabot_id = ? AND dream_date IN (${placeholders})`,
      [metabotId, ...dreamDates]
    );
    for (const row of rows) {
      states.set(row.dream_date, {
        status: (row.status === 'completed' || row.status === 'failed' ? row.status : 'running') as DreamRunStatus,
        attemptCount: parseIdNumber(row.attempt_count) ?? 1,
        startedAt: Number(row.started_at),
        dreamVersion: parseIdNumber(row.dream_version) ?? 0,
      });
    }
    return states;
  }

  /** Raw cowork_config lookup (e.g. the dreamLlmId global override). */
  getCoworkConfigValue(key: string): string | null {
    try {
      const row = this.getOne<{ value: string }>(
        'SELECT value FROM cowork_config WHERE key = ? LIMIT 1',
        [key]
      );
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Runs left in 'running' by an app restart are marked failed. */
  resetStaleRunningRuns(): number {
    this.db.run(`
      UPDATE metabot_dream_runs
      SET status = 'failed', error = 'Application restarted during dream run', updated_at = ?
      WHERE status = 'running'
    `, [Date.now()]);
    const runModified = this.db.getRowsModified?.() || 0;
    this.db.run(`
      UPDATE metabot_dream_fragments
      SET status = 'failed', error = 'Application restarted during dream run', updated_at = ?
      WHERE status = 'running'
    `, [Date.now()]);
    const fragmentModified = this.db.getRowsModified?.() || 0;
    const modified = runModified + fragmentModified;
    if (modified > 0) {
      this.saveDb();
    }
    return modified;
  }

  upsertDailySummary(input: {
    metabotId: number;
    summaryDate: string;
    summaryText: string;
    sections: Record<string, string>;
    stats: Record<string, number>;
    sessionRefs?: DailySummarySessionRef[];
    llmId: string | null;
  }): DailySummary {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_daily_summaries (
        id, metabot_id, summary_date, summary_text, sections_json, stats_json, session_refs_json, llm_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id, summary_date) DO UPDATE SET
        summary_text = excluded.summary_text,
        sections_json = excluded.sections_json,
        stats_json = excluded.stats_json,
        session_refs_json = excluded.session_refs_json,
        llm_id = excluded.llm_id,
        updated_at = excluded.updated_at
    `, [
      uuidv4(),
      input.metabotId,
      input.summaryDate,
      input.summaryText,
      JSON.stringify(input.sections ?? {}),
      JSON.stringify(input.stats ?? {}),
      JSON.stringify(input.sessionRefs ?? []),
      input.llmId,
      now,
      now,
    ]);
    this.saveDb();
    const summary = this.getDailySummary(input.metabotId, input.summaryDate);
    if (!summary) {
      throw new Error('Failed to load daily summary after upsert');
    }
    return summary;
  }

  getDailySummary(metabotId: number, summaryDate: string): DailySummary | null {
    const row = this.getOne<DailySummaryRow>(
      'SELECT * FROM metabot_daily_summaries WHERE metabot_id = ? AND summary_date = ? LIMIT 1',
      [metabotId, summaryDate]
    );
    return row ? this.mapSummaryRow(row) : null;
  }

  listDailySummaries(metabotId: number, limit: number = 30, offset: number = 0): DailySummary[] {
    const clampedLimit = Math.max(1, Math.min(365, Math.floor(limit)));
    const clampedOffset = Math.max(0, Math.floor(offset));
    const rows = this.getAll<DailySummaryRow>(`
      SELECT * FROM metabot_daily_summaries
      WHERE metabot_id = ?
      ORDER BY summary_date DESC
      LIMIT ? OFFSET ?
    `, [metabotId, clampedLimit, clampedOffset]);
    return rows.map((row) => this.mapSummaryRow(row));
  }

  /**
   * Warm/cold experience retrieval over daily summaries. Without a query this
   * is a date-range lookup (warm layer); with a query it is a LIKE search
   * across the bot's full summary history (cold/deep layer). LIKE is used
   * deliberately: the sql.js fallback backend has no FTS5, and this table is
   * small by design (one row per bot per day).
   */
  searchDailySummaries(
    metabotId: number,
    options: { query?: string; dateFrom?: string; dateTo?: string; limit?: number } = {}
  ): DailySummary[] {
    const clauses: string[] = ['metabot_id = ?'];
    const params: Array<string | number> = [metabotId];

    const dateFrom = options.dateFrom?.trim();
    if (dateFrom) {
      clauses.push('summary_date >= ?');
      params.push(dateFrom);
    }
    const dateTo = options.dateTo?.trim();
    if (dateTo) {
      clauses.push('summary_date <= ?');
      params.push(dateTo);
    }
    const query = options.query?.trim();
    if (query) {
      const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
      clauses.push(`(summary_text LIKE ? ESCAPE '\\' OR sections_json LIKE ? ESCAPE '\\')`);
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 30)));
    const rows = this.getAll<DailySummaryRow>(`
      SELECT * FROM metabot_daily_summaries
      WHERE ${clauses.join(' AND ')}
      ORDER BY summary_date DESC
      LIMIT ?
    `, [...params, limit]);
    return rows.map((row) => this.mapSummaryRow(row));
  }

  /**
   * Everything the bot did on [dayStartMs, dayEndMs): cowork sessions with
   * user/assistant messages that day (orders flagged via service_orders),
   * scheduled task runs, same-day group-task acceptances / in-progress
   * summaries, and on-chain group-chat transcripts for member tasks.
   * Hidden sessions are included on purpose — order execution sessions are
   * hidden from the UI list but are still experience.
   */
  getActivityForDate(metabotId: number, dayStartMs: number, dayEndMs: number): DreamDayActivity {
    const sessionRows = this.getAll<{
      id: string;
      title: string;
      session_type: string | null;
      peer_name: string | null;
      is_order: number;
    }>(`
      SELECT s.id, s.title, s.session_type, s.peer_name,
        EXISTS(SELECT 1 FROM service_orders o WHERE o.cowork_session_id = s.id) AS is_order
      FROM cowork_sessions s
      WHERE s.metabot_id = ?
        AND EXISTS(
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?
        )
      ORDER BY s.updated_at ASC
    `, [metabotId, dayStartMs, dayEndMs]);

    const sessions: DreamSessionActivity[] = sessionRows.map((session) => {
      const messageRows = this.getAll<{
        type: string;
        content: string | null;
        created_at: number | string;
        feedback_rating: string | null;
        feedback_comment: string | null;
      }>(`
        SELECT m.type, m.content, m.created_at,
          mf.rating AS feedback_rating, mf.comment AS feedback_comment
        FROM cowork_messages m
        LEFT JOIN message_feedback mf ON mf.message_id = m.id
        WHERE m.session_id = ?
          AND m.created_at >= ? AND m.created_at < ?
          AND m.type IN ('user', 'assistant')
        ORDER BY m.created_at ASC
      `, [session.id, dayStartMs, dayEndMs]);
      return {
        sessionId: session.id,
        title: session.title,
        sessionType: session.session_type === 'agent_agent' ? 'a2a' : (session.session_type || 'standard'),
        peerName: session.peer_name ?? null,
        isOrder: Number(session.is_order) !== 0,
        messages: messageRows
          .filter((row) => (row.type === 'user' || row.type === 'assistant') && typeof row.content === 'string')
          .map((row) => ({
            type: row.type as 'user' | 'assistant',
            content: row.content as string,
            createdAt: Number(row.created_at),
            feedbackRating: row.feedback_rating === 'up' || row.feedback_rating === 'down'
              ? row.feedback_rating
              : undefined,
            feedbackComment: row.feedback_comment ?? undefined,
          })),
      };
    });

    // scheduled_task_runs.started_at is a UTC ISO string (scheduledTaskStore
    // writes new Date().toISOString()); lexicographic comparison is safe for
    // that uniform format.
    const taskRuns = this.getAll<{
      name: string;
      status: string;
      started_at: string;
      session_id: string | null;
    }>(`
      SELECT t.name, r.status, r.started_at, r.session_id
      FROM scheduled_task_runs r
      JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE t.metabot_id = ? AND r.started_at >= ? AND r.started_at < ?
      ORDER BY r.started_at ASC
    `, [metabotId, new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString()]).map((row) => ({
      taskName: row.name,
      status: row.status,
      startedAt: Date.parse(row.started_at),
      sessionId: row.session_id ?? null,
    }));

    // Raw order count for the day — one order session can carry several
    // orders, so counting sessions alone under-reports (stats vs narrative).
    const orderCountRow = this.getOne<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM service_orders WHERE local_metabot_id = ? AND created_at >= ? AND created_at < ?',
      [metabotId, dayStartMs, dayEndMs]
    );

    // group_chat_messages.chain_timestamp is unix seconds (see sqliteStore).
    // Day attribution for acceptances uses rated_at, falling back to closed_at;
    // both are UTC datetime('now') strings.
    const dayStartSec = Math.floor(dayStartMs / 1000);
    const dayEndSec = Math.floor(dayEndMs / 1000);

    const groupChatRows = this.getAll<{
      task_id: number;
      title: string;
      group_id: string;
      status: string;
      role: string;
      sender_name: string | null;
      sender_global_metaid: string | null;
      content: string;
      chain_timestamp: number | string;
    }>(`
      SELECT t.id AS task_id, t.title, t.group_id, t.status, m.role,
        g.sender_name, g.sender_global_metaid, g.content, g.chain_timestamp
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      JOIN group_chat_messages g ON g.group_id = t.group_id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.group_id IS NOT NULL AND TRIM(t.group_id) != ''
        AND g.chain_timestamp IS NOT NULL
        AND g.content IS NOT NULL AND TRIM(g.content) != ''
        AND g.chain_timestamp >= ? AND g.chain_timestamp < ?
      ORDER BY t.id ASC, g.chain_timestamp ASC, g.id ASC
    `, [metabotId, dayStartSec, dayEndSec]);

    const groupChatsByTask = new Map<number, DreamGroupChatActivity>();
    for (const row of groupChatRows) {
      const taskId = parseIdNumber(row.task_id);
      if (taskId == null) continue;
      const existing = groupChatsByTask.get(taskId) ?? {
        taskId,
        title: row.title,
        groupId: row.group_id,
        taskStatus: row.status,
        memberRole: row.role === 'chair' ? 'chair' : 'worker',
        messages: [],
      };
      if (existing.messages.length >= MAX_GROUP_CHAT_MESSAGES_PER_TASK) continue;
      const occurredSec = parseIdNumber(row.chain_timestamp);
      existing.messages.push({
        senderName: (row.sender_name ?? '').trim() || 'unknown',
        senderGlobalMetaID: (row.sender_global_metaid ?? '').trim() || null,
        content: row.content,
        occurredAt: occurredSec == null ? dayStartMs : occurredSec * 1000,
      });
      groupChatsByTask.set(taskId, existing);
    }
    const groupChats = [...groupChatsByTask.values()];
    const dayMessageCountByTask = new Map(
      groupChats.map((chat) => [chat.taskId, chat.messages.length]),
    );

    const acceptedTasks = this.getAll<{
      id: number;
      title: string;
      goal: string;
      status: string;
      role: string;
      rating: number | null;
      rating_comment: string | null;
    }>(`
      SELECT t.id, t.title, t.goal, t.status, m.role, t.rating, t.rating_comment
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.status IN ('done', 'cancelled')
        AND CAST(strftime('%s', COALESCE(t.rated_at, t.closed_at)) AS INTEGER) >= ?
        AND CAST(strftime('%s', COALESCE(t.rated_at, t.closed_at)) AS INTEGER) < ?
      ORDER BY t.id ASC
    `, [metabotId, dayStartSec, dayEndSec]).map((row) => ({
      taskId: row.id,
      title: row.title,
      goal: row.goal,
      memberRole: row.role === 'chair' ? 'chair' : 'worker',
      rating: row.rating ?? null,
      ratingComment: row.rating_comment ?? null,
      status: row.status,
      phase: 'accepted' as const,
      dayMessageCount: dayMessageCountByTask.get(row.id),
    }));
    const acceptedIds = new Set(acceptedTasks.map((task) => task.taskId));

    // Still-open tasks appear only when this bot had same-day activity:
    // on-chain group chat, or a mapped group-task cowork skill turn.
    const activeTasks = this.getAll<{
      id: number;
      title: string;
      goal: string;
      status: string;
      role: string;
    }>(`
      SELECT t.id, t.title, t.goal, t.status, m.role
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.status IN ('planning', 'executing', 'review')
        AND (
          EXISTS (
            SELECT 1 FROM group_chat_messages g
            WHERE g.group_id = t.group_id
              AND g.chain_timestamp IS NOT NULL
              AND g.chain_timestamp >= ? AND g.chain_timestamp < ?
          )
          OR EXISTS (
            SELECT 1 FROM cowork_conversation_mappings map
            JOIN cowork_messages cm ON cm.session_id = map.cowork_session_id
            WHERE map.channel = 'metaweb_group_task'
              AND map.external_conversation_id = 'group-task:' || t.id
              AND map.metabot_id = ?
              AND cm.created_at >= ? AND cm.created_at < ?
          )
        )
      ORDER BY t.id ASC
    `, [metabotId, dayStartSec, dayEndSec, metabotId, dayStartMs, dayEndMs])
      .filter((row) => !acceptedIds.has(row.id))
      .map((row) => ({
        taskId: row.id,
        title: row.title,
        goal: row.goal,
        memberRole: row.role === 'chair' ? 'chair' : 'worker',
        rating: null,
        ratingComment: null,
        status: row.status,
        phase: 'active' as const,
        dayMessageCount: dayMessageCountByTask.get(row.id),
      }));

    return {
      sessions,
      taskRuns,
      orderCount: parseIdNumber(orderCountRow?.n) ?? 0,
      groupTasks: [...acceptedTasks, ...activeTasks],
      groupChats,
    };
  }
}
