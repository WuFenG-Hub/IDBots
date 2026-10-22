/**
 * Daily Report (每日汇报) fact collector — deterministic SQLite reads that
 * assemble everything the daily briefing needs for its window
 * [windowStartMs, windowEndMs).
 *
 * Pure shaping + an injectable SQL accessor (the service wires the real
 * database in; unit tests inject canned rows). NEVER throws: every bucket
 * fails soft to empty, so a broken query can shrink a section but can never
 * sink the report. Every bucket is hard-capped (top-N by recency plus char
 * caps) and the assembled facts are capped again at the JSON level so the
 * ledger row stays ≤ ~20 KB.
 *
 * Skip decision (owner-aligned rule E10): a day is skippable only when the
 * window holds literally zero activity — no new cowork sessions of any kind,
 * no private/group chat messages, no orchestration/scheduled/group-task/
 * long-term activity and no pending follow-ups. Nightly dream digests are
 * NOT an activity signal (dreams run autonomously regardless), so they feed
 * the briefing but never the skip bit.
 *
 * Kept free of runtime relative imports (type-only is erased) so plain-Node
 * tests can load it with type stripping.
 */

import type { SqliteDatabase } from '../sqliteTypes';

/** Minimal SQL reader the collector needs; the service adapts the shared db. */
export interface DailyReportDb {
  queryAll<T>(sql: string, params?: ReadonlyArray<string | number | null>): T[];
}

/** Adapt the app's sql.js-backed database to the collector's reader shape. */
export const createDailyReportDbAccessor = (db: SqliteDatabase): DailyReportDb => ({
  queryAll<T>(sql: string, params: ReadonlyArray<string | number | null> = []): T[] {
    const result = db.exec(sql, [...params]);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  },
});

// ── Caps ───────────────────────────────────────────────────────────────────

export const DAILY_REPORT_MAX_LOOKBACK_DAYS = 7;
export const DAILY_REPORT_MAX_PENDING_FOLLOW_UPS = 10;
export const DAILY_REPORT_FOLLOW_UP_TITLE_MAX_CHARS = 120;
export const DAILY_REPORT_FOLLOW_UP_OVERDUE_DAYS = 2;
export const DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS = 10;
export const DAILY_REPORT_ORCHESTRATION_TITLE_MAX_CHARS = 200;
export const DAILY_REPORT_MAX_HUMAN_SESSIONS = 12;
export const DAILY_REPORT_SESSION_TITLE_MAX_CHARS = 120;
export const DAILY_REPORT_SESSION_EXCERPT_MAX_CHARS = 1500;
export const DAILY_REPORT_SESSION_USER_EXCERPT_MAX_CHARS = 500;
export const DAILY_REPORT_MAX_SCHEDULED_RUNS = 10;
export const DAILY_REPORT_TASK_NAME_MAX_CHARS = 100;
export const DAILY_REPORT_MAX_GROUP_TASK_TRANSITIONS = 8;
export const DAILY_REPORT_GROUP_TASK_TITLE_MAX_CHARS = 100;
export const DAILY_REPORT_MAX_LONG_TERM_EVENTS = 10;
export const DAILY_REPORT_MAX_LONG_TERM_TASKS = 8;
export const DAILY_REPORT_LONG_TERM_TITLE_MAX_CHARS = 100;
export const DAILY_REPORT_MAX_BOT_DIGESTS = 12;
export const DAILY_REPORT_DIGEST_MAX_CHARS = 1200;
export const DAILY_REPORT_MAX_ONLINE_BOTS = 20;
export const DAILY_REPORT_MAX_FACTS_JSON_BYTES = 20 * 1024;

// ── Fact shapes ────────────────────────────────────────────────────────────

export interface DailyReportPendingFollowUp {
  sessionId: string;
  title: string;
  botName: string | null;
  source: string | null;
  ageDays: number | null;
  overdue: boolean;
}

export interface DailyReportOwnerOrchestration {
  taskId: string;
  title: string;
  status: string;
  stepsDone: number;
  stepsTotal: number;
  percentComplete: number | null;
  workerSessionIds: string[];
  updatedAt: string | null;
}

export interface DailyReportHumanSession {
  sessionId: string;
  title: string;
  botName: string | null;
  sessionType: string | null;
  humanUserMessages: number;
  assistantMessages: number;
  lastAssistantExcerpt: string | null;
  /** Latest human-submitted user message in the window (cerebellum triage). */
  lastUserExcerpt: string | null;
}

export interface DailyReportScheduledRun {
  taskName: string;
  botName: string | null;
  status: string;
  skipReason: string | null;
  startedAt: string | null;
  error: string | null;
}

export interface DailyReportGroupTaskTransition {
  taskId: number;
  title: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface DailyReportLongTermEvent {
  taskId: string;
  taskTitle: string;
  subtaskId: string | null;
  kind: string;
  actor: string;
  detail: string;
  createdAt: string | null;
}

export interface DailyReportLongTermProgress {
  taskId: string;
  title: string;
  stage: string;
  subtasksAccepted: number;
  subtasksTotal: number;
  percentComplete: number;
}

export interface DailyReportBotDigest {
  botName: string;
  isTwin: boolean;
  summaryDate: string;
  summaryText: string;
}

export interface DailyReportOnlineActivity {
  botName: string;
  privateMessageCount: number;
  groupMessageCount: number;
}

export interface DailyReportFacts {
  generatedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  pendingFollowUps: DailyReportPendingFollowUp[];
  ownerOrchestrations: DailyReportOwnerOrchestration[];
  humanSessions: DailyReportHumanSession[];
  machineActivity: {
    scheduledRuns: DailyReportScheduledRun[];
    groupTaskTransitions: DailyReportGroupTaskTransition[];
    longTermEvents: DailyReportLongTermEvent[];
    longTermProgress: DailyReportLongTermProgress[];
    twinDelegateOrchestrationsInWindow: number;
  };
  botDigests: DailyReportBotDigest[];
  onlineActivity: DailyReportOnlineActivity[];
  /** Any cowork session created in the window (the E10 "new sessions" bit). */
  newSessionCount: number;
  /** E10 skip bit: true only when the window holds literally zero activity. */
  hasAnyActivity: boolean;
}

// ── Pure helpers (unit-tested directly) ────────────────────────────────────

/** Local YYYY-MM-DD for a ms timestamp (the report's date vocabulary). */
export const formatDailyReportLocalDate = (ms: number): string => {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Report window: since the last SUCCESSFUL run's windowEndMs; a first report
 * covers yesterday 00:00 local → now. Lookback is hard-capped (a machine that
 * slept for two weeks must not digest fourteen days).
 */
export const computeDailyReportWindow = (input: {
  nowMs: number;
  lastSuccessfulWindowEndMs?: number | null;
  maxLookbackDays?: number;
}): { windowStartMs: number; windowEndMs: number } => {
  const windowEndMs = input.nowMs;
  const maxLookbackMs = Math.max(1, Math.floor(input.maxLookbackDays ?? DAILY_REPORT_MAX_LOOKBACK_DAYS)) * DAY_MS;
  const last = Number(input.lastSuccessfulWindowEndMs);
  let windowStartMs: number;
  if (Number.isFinite(last) && last > 0) {
    windowStartMs = last;
  } else {
    const yesterday = new Date(windowEndMs);
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    windowStartMs = yesterday.getTime();
  }
  windowStartMs = Math.max(windowStartMs, windowEndMs - maxLookbackMs);
  if (windowStartMs >= windowEndMs) {
    // Degenerate (clock skew / immediate re-run): keep a 1s window instead of
    // an inverted one so downstream SQL stays sane.
    windowStartMs = windowEndMs - 1000;
  }
  return { windowStartMs, windowEndMs };
};

/** Whitespace-collapse + UTF-16-safe prefix cut with an ellipsis marker. */
export const capDailyReportText = (text: unknown, maxChars: number): string => {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  if (maxChars <= 1) return '…';
  const cut = collapsed.slice(0, maxChars - 1);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
};

export const shapePendingFollowUpRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
  windowEndMs: number,
  maxItems: number = DAILY_REPORT_MAX_PENDING_FOLLOW_UPS,
): DailyReportPendingFollowUp[] =>
  rows.slice(0, maxItems).map((row) => {
    const followUpAtMs = row.follow_up_at ? Date.parse(String(row.follow_up_at)) : NaN;
    const ageDays = Number.isFinite(followUpAtMs)
      ? Math.max(0, Math.floor((windowEndMs - followUpAtMs) / DAY_MS))
      : null;
    return {
      sessionId: String(row.id ?? ''),
      title: capDailyReportText(row.title, DAILY_REPORT_FOLLOW_UP_TITLE_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
      source: row.follow_up_source ? String(row.follow_up_source) : null,
      ageDays,
      overdue: ageDays !== null && ageDays >= DAILY_REPORT_FOLLOW_UP_OVERDUE_DAYS,
    };
  }).filter((item) => item.sessionId);

export const shapeOwnerOrchestrationRows = (
  taskRows: ReadonlyArray<Record<string, unknown>>,
  stepRows: ReadonlyArray<Record<string, unknown>>,
  attemptRows: ReadonlyArray<Record<string, unknown>>,
  maxItems: number = DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS,
): DailyReportOwnerOrchestration[] =>
  taskRows.slice(0, maxItems).map((row) => {
    const taskId = String(row.id ?? '');
    const steps = stepRows.filter((s) => String(s.task_id ?? '') === taskId);
    const stepsTotal = steps.length;
    const stepsDone = steps.filter((s) => s.status === 'completed').length;
    const workerSessionIds = [
      ...new Set(
        attemptRows
          .filter((a) => String(a.task_id ?? '') === taskId && a.worker_session_id)
          .map((a) => String(a.worker_session_id)),
      ),
    ].slice(0, 5);
    return {
      taskId,
      title: capDailyReportText(row.owner_intent, DAILY_REPORT_ORCHESTRATION_TITLE_MAX_CHARS) || '(untitled)',
      status: String(row.status ?? 'planning'),
      stepsDone,
      stepsTotal,
      percentComplete: stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : null,
      workerSessionIds,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    };
  }).filter((item) => item.taskId);

export const shapeHumanSessionRows = (
  sessionRows: ReadonlyArray<Record<string, unknown>>,
  excerptBySessionId: ReadonlyMap<string, { assistant: string | null; user: string | null }>,
  maxItems: number = DAILY_REPORT_MAX_HUMAN_SESSIONS,
): DailyReportHumanSession[] =>
  sessionRows.slice(0, maxItems).map((row) => {
    const sessionId = String(row.id ?? '');
    const excerpts = excerptBySessionId.get(sessionId) ?? { assistant: null, user: null };
    return {
      sessionId,
      title: capDailyReportText(row.title, DAILY_REPORT_SESSION_TITLE_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
      sessionType: row.session_type ? String(row.session_type) : null,
      humanUserMessages: Number(row.human_user_count ?? 0) || 0,
      assistantMessages: Number(row.assistant_count ?? 0) || 0,
      lastAssistantExcerpt: excerpts.assistant
        ? capDailyReportText(excerpts.assistant, DAILY_REPORT_SESSION_EXCERPT_MAX_CHARS)
        : null,
      lastUserExcerpt: excerpts.user
        ? capDailyReportText(excerpts.user, DAILY_REPORT_SESSION_USER_EXCERPT_MAX_CHARS)
        : null,
    };
  }).filter((item) => item.sessionId);

/** E10 skip bit over the collected buckets. */
export const computeDailyReportHasAnyActivity = (facts: {
  pendingFollowUps: readonly unknown[];
  ownerOrchestrations: readonly unknown[];
  humanSessions: readonly unknown[];
  machineActivity: {
    scheduledRuns: readonly unknown[];
    groupTaskTransitions: readonly unknown[];
    longTermEvents: readonly unknown[];
    twinDelegateOrchestrationsInWindow: number;
  };
  onlineActivity: ReadonlyArray<{ privateMessageCount: number; groupMessageCount: number }>;
  newSessionCount: number;
}): boolean =>
  facts.pendingFollowUps.length > 0
  || facts.ownerOrchestrations.length > 0
  || facts.humanSessions.length > 0
  || facts.machineActivity.scheduledRuns.length > 0
  || facts.machineActivity.groupTaskTransitions.length > 0
  || facts.machineActivity.longTermEvents.length > 0
  || facts.machineActivity.twinDelegateOrchestrationsInWindow > 0
  || facts.onlineActivity.some((entry) => entry.privateMessageCount > 0 || entry.groupMessageCount > 0)
  || facts.newSessionCount > 0;

/**
 * Final JSON-level cap: shrink the cheapest-to-lose text fields until the
 * serialized facts fit the ledger budget. Deterministic: digests first, then
 * human-session excerpts.
 */
export const enforceDailyReportFactsCap = (
  facts: DailyReportFacts,
  maxBytes: number = DAILY_REPORT_MAX_FACTS_JSON_BYTES,
): DailyReportFacts => {
  const fits = (value: DailyReportFacts): boolean => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
  if (fits(facts)) return facts;
  const shrunk: DailyReportFacts = {
    ...facts,
    botDigests: facts.botDigests.map((d) => ({ ...d, summaryText: capDailyReportText(d.summaryText, 400) })),
  };
  if (fits(shrunk)) return shrunk;
  const shrunkMore: DailyReportFacts = {
    ...shrunk,
    humanSessions: shrunk.humanSessions.map((s) => ({
      ...s,
      lastAssistantExcerpt: s.lastAssistantExcerpt ? capDailyReportText(s.lastAssistantExcerpt, 300) : null,
    })),
  };
  if (fits(shrunkMore)) return shrunkMore;
  return {
    ...shrunkMore,
    botDigests: shrunkMore.botDigests.slice(0, 4),
    humanSessions: shrunkMore.humanSessions.slice(0, 6),
  };
};

// ── Collection ─────────────────────────────────────────────────────────────

const safeCollect = <T>(bucket: string, fallback: T, fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    console.warn(`[DailyReportCollector] bucket '${bucket}' failed soft to empty:`, error);
    return fallback;
  }
};

/**
 * Human-submitted turn predicate: a user message whose metadata carries no
 * origin (legacy/local composer) or explicitly origin 'user'. JSON tags are
 * matched literally — the write path JSON.stringify's metadata with no spaces.
 */
const HUMAN_USER_MESSAGE_SQL = `
  m.type = 'user'
  AND (m.metadata IS NULL
       OR m.metadata NOT LIKE '%"origin"%'
       OR m.metadata LIKE '%"origin":"user"%')`;

/** Daily-report sessions are excluded from the human-work bucket by title. */
const DAILY_REPORT_TITLE_LIKE = '每日汇报 %';

export const collectDailyReportFacts = (input: {
  db: DailyReportDb;
  windowStartMs: number;
  windowEndMs: number;
  twinId: number;
}): DailyReportFacts => {
  const { db } = input;
  const isoStart = new Date(input.windowStartMs).toISOString();
  const isoEnd = new Date(input.windowEndMs).toISOString();
  const msStart = input.windowStartMs;
  const msEnd = input.windowEndMs;

  const pendingFollowUps = safeCollect('pendingFollowUps', [], () =>
    shapePendingFollowUpRows(db.queryAll<Record<string, unknown>>(`
      SELECT s.id, s.title, s.follow_up_source, s.follow_up_at, mb.name AS bot_name
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      WHERE s.follow_up_state = 'pending'
        AND COALESCE(s.hidden_from_session_list, 0) = 0
        AND s.archived_at IS NULL
      ORDER BY COALESCE(s.follow_up_at, '') ASC, s.updated_at DESC
    `), msEnd));

  const ownerOrchestrations = safeCollect('ownerOrchestrations', [], () => {
    const taskRows = db.queryAll<Record<string, unknown>>(`
      SELECT t.id, t.owner_intent, t.status, t.updated_at
      FROM orchestration_tasks t
      WHERE t.origin = 'owner'
        AND ((t.updated_at >= ? AND t.updated_at < ?)
             OR t.status IN ('planning', 'running', 'review'))
      ORDER BY t.updated_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS * 2]);
    const taskIds = taskRows.slice(0, DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS).map((r) => String(r.id));
    const placeholders = taskIds.length ? taskIds.map(() => '?').join(',') : "''";
    const stepRows = taskIds.length
      ? db.queryAll<Record<string, unknown>>(`SELECT task_id, status FROM orchestration_steps WHERE task_id IN (${placeholders})`, taskIds)
      : [];
    const attemptRows = taskIds.length
      ? db.queryAll<Record<string, unknown>>(`
          SELECT s.task_id, a.worker_session_id
          FROM orchestration_attempts a
          JOIN orchestration_steps s ON s.id = a.step_id
          WHERE s.task_id IN (${placeholders}) AND a.worker_session_id IS NOT NULL AND a.worker_session_id != ''
        `, taskIds)
      : [];
    return shapeOwnerOrchestrationRows(taskRows, stepRows, attemptRows);
  });

  const humanSessions = safeCollect('humanSessions', [], () => {
    const sessionRows = db.queryAll<Record<string, unknown>>(`
      SELECT s.id, s.title, s.session_type, s.updated_at, mb.name AS bot_name,
        (SELECT COUNT(*) FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ? AND ${HUMAN_USER_MESSAGE_SQL}) AS human_user_count,
        (SELECT COUNT(*) FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ? AND m.type = 'assistant') AS assistant_count
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      WHERE s.archived_at IS NULL
        AND COALESCE(s.hidden_from_session_list, 0) = 0
        AND s.title NOT LIKE ?
        AND EXISTS(
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ? AND ${HUMAN_USER_MESSAGE_SQL}
        )
        AND NOT EXISTS(
          SELECT 1 FROM cowork_messages dm
          WHERE dm.session_id = s.id AND dm.metadata LIKE '%"origin":"daily_report"%'
        )
      ORDER BY s.updated_at DESC
      LIMIT ?
    `, [msStart, msEnd, msStart, msEnd, DAILY_REPORT_TITLE_LIKE, msStart, msEnd, DAILY_REPORT_MAX_HUMAN_SESSIONS]);
    const excerptBySessionId = new Map<string, { assistant: string | null; user: string | null }>();
    for (const row of sessionRows) {
      const sessionId = String(row.id ?? '');
      if (!sessionId) continue;
      const excerpts: { assistant: string | null; user: string | null } = { assistant: null, user: null };
      try {
        const assistantRows = db.queryAll<{ content: string | null }>(`
          SELECT m.content FROM cowork_messages m
          WHERE m.session_id = ? AND m.created_at >= ? AND m.created_at < ?
            AND m.type = 'assistant' AND COALESCE(m.content, '') != ''
          ORDER BY m.created_at DESC LIMIT 1
        `, [sessionId, msStart, msEnd]);
        excerpts.assistant = assistantRows[0]?.content ?? null;
      } catch {
        // One session's excerpt is not worth the bucket.
      }
      try {
        const userRows = db.queryAll<{ content: string | null }>(`
          SELECT m.content FROM cowork_messages m
          WHERE m.session_id = ? AND m.created_at >= ? AND m.created_at < ?
            AND ${HUMAN_USER_MESSAGE_SQL} AND COALESCE(m.content, '') != ''
          ORDER BY m.created_at DESC LIMIT 1
        `, [sessionId, msStart, msEnd]);
        excerpts.user = userRows[0]?.content ?? null;
      } catch {
        // One session's excerpt is not worth the bucket.
      }
      excerptBySessionId.set(sessionId, excerpts);
    }
    return shapeHumanSessionRows(sessionRows, excerptBySessionId);
  });

  const scheduledRuns = safeCollect('scheduledRuns', [] as DailyReportScheduledRun[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT t.name AS task_name, mb.name AS bot_name, r.status, r.skip_reason, r.started_at, r.error
      FROM scheduled_task_runs r
      JOIN scheduled_tasks t ON t.id = r.task_id
      LEFT JOIN metabots mb ON mb.id = t.metabot_id
      WHERE r.started_at >= ? AND r.started_at < ?
      ORDER BY r.started_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_SCHEDULED_RUNS]).map((row) => ({
      taskName: capDailyReportText(row.task_name, DAILY_REPORT_TASK_NAME_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
      status: String(row.status ?? 'unknown'),
      skipReason: row.skip_reason ? String(row.skip_reason) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      error: row.error ? capDailyReportText(row.error, 200) : null,
    })));

  const groupTaskTransitions = safeCollect('groupTaskTransitions', [] as DailyReportGroupTaskTransition[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT tr.task_id, gt.title, tr.from_status, tr.to_status, tr.actor, tr.reason, tr.created_at
      FROM group_task_transitions tr
      JOIN group_tasks gt ON gt.id = tr.task_id
      WHERE datetime(tr.created_at) >= datetime(?) AND datetime(tr.created_at) < datetime(?)
      ORDER BY tr.created_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_GROUP_TASK_TRANSITIONS]).map((row) => ({
      taskId: Number(row.task_id ?? 0) || 0,
      title: capDailyReportText(row.title, DAILY_REPORT_GROUP_TASK_TITLE_MAX_CHARS) || '(untitled)',
      fromStatus: row.from_status ? String(row.from_status) : null,
      toStatus: String(row.to_status ?? ''),
      actor: row.actor ? String(row.actor) : null,
      reason: row.reason ? capDailyReportText(row.reason, 200) : null,
      createdAt: row.created_at ? String(row.created_at) : null,
    })));

  const longTermEvents = safeCollect('longTermEvents', [] as DailyReportLongTermEvent[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT e.task_id, lt.title AS task_title, e.subtask_id, e.kind, e.actor, e.detail, e.created_at
      FROM long_term_events e
      JOIN long_term_tasks lt ON lt.id = e.task_id
      WHERE e.created_at >= ? AND e.created_at < ?
      ORDER BY e.created_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_LONG_TERM_EVENTS]).map((row) => ({
      taskId: String(row.task_id ?? ''),
      taskTitle: capDailyReportText(row.task_title, DAILY_REPORT_LONG_TERM_TITLE_MAX_CHARS) || '(untitled)',
      subtaskId: row.subtask_id ? String(row.subtask_id) : null,
      kind: String(row.kind ?? ''),
      actor: String(row.actor ?? ''),
      detail: capDailyReportText(row.detail, 300),
      createdAt: row.created_at ? String(row.created_at) : null,
    })));

  const longTermProgress = safeCollect('longTermProgress', [] as DailyReportLongTermProgress[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT t.id, t.title, t.stage,
        SUM(CASE WHEN st.status != 'skipped' THEN 1 ELSE 0 END) AS live_total,
        SUM(CASE WHEN st.status = 'accepted' THEN 1 ELSE 0 END) AS accepted
      FROM long_term_tasks t
      LEFT JOIN long_term_subtasks st ON st.task_id = t.id
      WHERE t.stage IN ('defining', 'active', 'paused')
      GROUP BY t.id
      ORDER BY t.updated_at DESC
      LIMIT ?
    `, [DAILY_REPORT_MAX_LONG_TERM_TASKS]).map((row) => {
      const liveTotal = Number(row.live_total ?? 0) || 0;
      const accepted = Number(row.accepted ?? 0) || 0;
      return {
        taskId: String(row.id ?? ''),
        title: capDailyReportText(row.title, DAILY_REPORT_LONG_TERM_TITLE_MAX_CHARS) || '(untitled)',
        stage: String(row.stage ?? 'defining'),
        subtasksAccepted: accepted,
        subtasksTotal: liveTotal,
        percentComplete: liveTotal === 0 ? 0 : Math.round((accepted / liveTotal) * 100),
      };
    }));

  const twinDelegateOrchestrationsInWindow = safeCollect('twinDelegateOrchestrations', 0, () => {
    const row = db.queryAll<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM orchestration_tasks
      WHERE origin = 'twin_delegate' AND updated_at >= ? AND updated_at < ?
    `, [isoStart, isoEnd])[0];
    return Number(row?.cnt ?? 0) || 0;
  });

  const botDigests = safeCollect('botDigests', [] as DailyReportBotDigest[], () => {
    const dateFrom = formatDailyReportLocalDate(msStart);
    const dateTo = formatDailyReportLocalDate(msEnd);
    return db.queryAll<Record<string, unknown>>(`
      SELECT mb.id AS metabot_id, mb.name AS bot_name, mb.metabot_type, ds.summary_date, ds.summary_text
      FROM metabot_daily_summaries ds
      JOIN metabots mb ON mb.id = ds.metabot_id
      WHERE ds.summary_date >= ? AND ds.summary_date <= ?
      ORDER BY ds.summary_date DESC, mb.id ASC
      LIMIT ?
    `, [dateFrom, dateTo, DAILY_REPORT_MAX_BOT_DIGESTS]).map((row) => ({
      botName: row.bot_name ? String(row.bot_name) : '(bot)',
      isTwin: Number(row.metabot_id) === input.twinId,
      summaryDate: String(row.summary_date ?? ''),
      summaryText: capDailyReportText(row.summary_text, DAILY_REPORT_DIGEST_MAX_CHARS),
    }));
  });

  const onlineActivity = safeCollect('onlineActivity', [] as DailyReportOnlineActivity[], () => {
    const privateRows = db.queryAll<Record<string, unknown>>(`
      SELECT mb.id AS metabot_id, mb.name AS bot_name, COUNT(*) AS message_count
      FROM private_chat_messages m
      JOIN metabots mb ON (mb.globalmetaid IS NOT NULL AND mb.globalmetaid != ''
        AND (mb.globalmetaid = m.from_global_metaid OR mb.globalmetaid = m.to_global_metaid))
      WHERE datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
      GROUP BY mb.id
    `, [isoStart, isoEnd]);
    const groupRows = db.queryAll<Record<string, unknown>>(`
      SELECT mb.id AS metabot_id, mb.name AS bot_name, COUNT(*) AS message_count
      FROM group_chat_messages m
      JOIN metabots mb ON (mb.globalmetaid IS NOT NULL AND mb.globalmetaid != ''
        AND mb.globalmetaid = m.sender_global_metaid)
      WHERE datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
      GROUP BY mb.id
    `, [isoStart, isoEnd]);
    const byBot = new Map<number, { botName: string; privateMessageCount: number; groupMessageCount: number }>();
    for (const row of privateRows) {
      const id = Number(row.metabot_id);
      if (!Number.isFinite(id)) continue;
      const entry = byBot.get(id) ?? { botName: String(row.bot_name ?? '(bot)'), privateMessageCount: 0, groupMessageCount: 0 };
      entry.privateMessageCount += Number(row.message_count ?? 0) || 0;
      byBot.set(id, entry);
    }
    for (const row of groupRows) {
      const id = Number(row.metabot_id);
      if (!Number.isFinite(id)) continue;
      const entry = byBot.get(id) ?? { botName: String(row.bot_name ?? '(bot)'), privateMessageCount: 0, groupMessageCount: 0 };
      entry.groupMessageCount += Number(row.message_count ?? 0) || 0;
      byBot.set(id, entry);
    }
    return [...byBot.entries()]
      .sort((a, b) => (b[1].privateMessageCount + b[1].groupMessageCount) - (a[1].privateMessageCount + a[1].groupMessageCount))
      .slice(0, DAILY_REPORT_MAX_ONLINE_BOTS)
      .map(([, entry]) => entry);
  });

  const newSessionCount = safeCollect('newSessionCount', 0, () => {
    const row = db.queryAll<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM cowork_sessions
      WHERE created_at >= ? AND created_at < ?
    `, [msStart, msEnd])[0];
    return Number(row?.cnt ?? 0) || 0;
  });

  const partial: DailyReportFacts = {
    generatedAtMs: msEnd,
    windowStartMs: msStart,
    windowEndMs: msEnd,
    pendingFollowUps,
    ownerOrchestrations,
    humanSessions,
    machineActivity: {
      scheduledRuns,
      groupTaskTransitions,
      longTermEvents,
      longTermProgress,
      twinDelegateOrchestrationsInWindow,
    },
    botDigests,
    onlineActivity,
    newSessionCount,
    hasAnyActivity: false,
  };
  return enforceDailyReportFactsCap({
    ...partial,
    hasAnyActivity: computeDailyReportHasAnyActivity(partial),
  });
};
