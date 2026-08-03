import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Dream consolidation storage layer.
 *
 * Two tables (created idempotently both here and in sqliteStore.initializeTables):
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

export interface DreamRun {
  id: string;
  metabotId: number;
  dreamDate: string;
  status: DreamRunStatus;
  attemptCount: number;
  llmId: string | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
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

export interface DreamDayActivity {
  sessions: DreamSessionActivity[];
  taskRuns: DreamTaskRunActivity[];
}

interface DreamRunRow {
  id: string;
  metabot_id: number | string;
  dream_date: string;
  status: string;
  attempt_count: number | string;
  llm_id: string | null;
  error: string | null;
  started_at: number | string;
  completed_at: number | string | null;
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
    try {
      const cols = this.db.exec('PRAGMA table_info(metabot_daily_summaries);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('session_refs_json')) {
        this.db.run("ALTER TABLE metabot_daily_summaries ADD COLUMN session_refs_json TEXT NOT NULL DEFAULT '[]';");
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to verify metabot_daily_summaries columns:', error);
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
      error: row.error ?? null,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
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
  beginRun(metabotId: number, dreamDate: string, llmId: string | null): DreamRun {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_dream_runs (
        id, metabot_id, dream_date, status, attempt_count, llm_id, error,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', 1, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(metabot_id, dream_date) DO UPDATE SET
        status = 'running',
        attempt_count = attempt_count + 1,
        llm_id = excluded.llm_id,
        error = NULL,
        started_at = excluded.started_at,
        completed_at = NULL,
        updated_at = excluded.updated_at
    `, [uuidv4(), metabotId, dreamDate, llmId, now, now, now]);
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

  /** status + attempt_count for the given dates, keyed by dream_date. */
  getRunStates(metabotId: number, dreamDates: string[]): Map<string, { status: DreamRunStatus; attemptCount: number }> {
    const states = new Map<string, { status: DreamRunStatus; attemptCount: number }>();
    if (dreamDates.length === 0) return states;
    const placeholders = dreamDates.map(() => '?').join(', ');
    const rows = this.getAll<{ dream_date: string; status: string; attempt_count: number | string }>(
      `SELECT dream_date, status, attempt_count FROM metabot_dream_runs
       WHERE metabot_id = ? AND dream_date IN (${placeholders})`,
      [metabotId, ...dreamDates]
    );
    for (const row of rows) {
      states.set(row.dream_date, {
        status: (row.status === 'completed' || row.status === 'failed' ? row.status : 'running') as DreamRunStatus,
        attemptCount: parseIdNumber(row.attempt_count) ?? 1,
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
    const modified = this.db.getRowsModified?.() || 0;
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
   * user/assistant messages that day (orders flagged via service_orders) plus
   * scheduled task runs. Hidden sessions are included on purpose — order
   * execution sessions are hidden from the UI list but are still experience.
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
      const messageRows = this.getAll<{ type: string; content: string | null; created_at: number | string }>(`
        SELECT type, content, created_at
        FROM cowork_messages
        WHERE session_id = ?
          AND created_at >= ? AND created_at < ?
          AND type IN ('user', 'assistant')
        ORDER BY created_at ASC
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

    return { sessions, taskRuns };
  }
}
