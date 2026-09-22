import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import type {
  LongTermActor,
  LongTermBoard,
  LongTermColumn,
  LongTermEvent,
  LongTermEventKind,
  LongTermEvidence,
  LongTermParticipant,
  LongTermPreferredChannel,
  LongTermProgress,
  LongTermResult,
  LongTermSubtask,
  LongTermSubtaskDraft,
  LongTermSubtaskStatus,
  LongTermSubtaskUpdateInput,
  LongTermTaskCreateInput,
  LongTermTaskDetail,
  LongTermTaskStage,
  LongTermTaskSummary,
  LongTermTaskUpdateInput,
} from '../renderer/types/longTermTask';
import { LONG_TERM_COLUMN_ORDER } from '../renderer/types/longTermTask';

/**
 * Long-term task board — first-class store (redesign, owner-ruled 2026-09-22).
 *
 * A long-term task is a persistent decomposition of a fuzzy goal into ordered
 * sub-projects with acceptance criteria; the TwinBot drives it over days/weeks
 * and the owner decides at blocking points. This store is the single authority:
 *
 *  - Tables are created idempotently in the constructor (same pattern as
 *    OrchestrationStore.ensureTables) — additive, upgrade-safe, no DDL on
 *    existing tables. The ledger (`orchestration_tasks`) is NOT reused: group
 *    tasks / delegations never appear here.
 *  - Facts only on disk: stage, per-subtask status, evidence, journal events.
 *    Column / progress / current-subtask are derived at read time by pure
 *    functions (`deriveColumn` / `deriveProgress` / `deriveCurrentSubtask`).
 *  - Every mutation writes a `long_term_events` row — the journal is the
 *    TwinBot's restart-proof memory of "where this task is and why".
 *  - Acceptance authority: `acceptSubtask` with actor 'twin' is refused unless
 *    the task carries acceptance_delegate = 1 (owner granted it explicitly).
 */

type Row = Record<string, unknown>;

const SUBTASK_STATUSES: LongTermSubtaskStatus[] = [
  'pending',
  'in_progress',
  'waiting_owner',
  'waiting_external',
  'accepted',
  'rejected',
  'skipped',
];

/** kv key of the per-task heartbeat nudge throttle map (advance service). */
export const LONGTERM_NUDGE_STATE_KV_KEY = 'longterm_nudge_state';

/** Throttle state for one task's heartbeat escalations. */
export interface LongTermNudgeState {
  lastNudgeAtMs: number;
  /** Event-journal id at the last nudge — anything newer counts as "changed". */
  lastEventId: number;
}

const CHANNELS: LongTermPreferredChannel[] = ['delegate_bot', 'group_task', 'owner_external', 'owner_together'];

function nowIso(): string {
  return new Date().toISOString();
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Pure: the kanban column of a task, from its stage + current sub-task. */
export function deriveColumn(
  stage: LongTermTaskStage,
  currentSubtaskStatus: LongTermSubtaskStatus | null,
): LongTermColumn | null {
  if (stage === 'defining') return 'defining';
  if (stage === 'paused') return 'paused';
  if (stage === 'done') return 'done';
  if (stage === 'cancelled') return null; // cancelled tasks stay in the data, off the board
  if (currentSubtaskStatus === 'waiting_owner') return 'waiting_owner';
  if (currentSubtaskStatus === 'waiting_external') return 'waiting_external';
  return 'in_progress';
}

/** Pure: progress over non-skipped sub-tasks. */
export function deriveProgress(subtasks: LongTermSubtask[]): LongTermProgress {
  const live = subtasks.filter((s) => s.status !== 'skipped');
  const accepted = live.filter((s) => s.status === 'accepted').length;
  const total = live.length;
  return { accepted, total, percent: total === 0 ? 0 : Math.round((accepted / total) * 100) };
}

/**
 * Pure: the sub-task the board/heartbeat should focus on. An explicit pin
 * (tasks.current_subtask_id) wins while it is still open; otherwise the
 * lowest-ordinal open sub-task whose dependencies are all accepted, falling
 * back to the lowest-ordinal open one (dependency-blocked) so the card never
 * shows a blank "current".
 */
export function deriveCurrentSubtask(
  pinnedId: string | null,
  subtasks: LongTermSubtask[],
): LongTermSubtask | null {
  const open = subtasks
    .filter((s) => s.status !== 'accepted' && s.status !== 'skipped')
    .sort((a, b) => a.ordinal - b.ordinal);
  if (open.length === 0) return null;
  if (pinnedId) {
    const pinned = open.find((s) => s.id === pinnedId);
    if (pinned) return pinned;
  }
  const acceptedIds = new Set(subtasks.filter((s) => s.status === 'accepted').map((s) => s.id));
  return open.find((s) => s.dependsOn.every((dep) => acceptedIds.has(dep))) ?? open[0];
}

interface TaskRow {
  id: string;
  title: string;
  goal: string;
  stage: LongTermTaskStage;
  acceptance_delegate: number;
  current_subtask_id: string | null;
  definition_session_id: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

interface SubtaskRow {
  id: string;
  task_id: string;
  ordinal: number;
  title: string;
  description: string;
  acceptance_criteria_json: string;
  status: LongTermSubtaskStatus;
  depends_on_json: string;
  preferred_channel: string | null;
  evidence_json: string;
  session_id: string | null;
  wait_note: string;
  wait_until: string | null;
  notes: string;
  accepted_by: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
}

interface EventRow {
  id: number;
  task_id: string;
  subtask_id: string | null;
  kind: LongTermEventKind;
  actor: LongTermActor;
  detail: string;
  created_at: string;
}

export class LongTermTaskStore {
  private readonly db: Database;
  private readonly saveDb: () => void;
  /** Resolves metabot ids to display rows (name + avatar) for participant chips. */
  private readonly resolveParticipants: (ids: number[]) => LongTermParticipant[];

  constructor(db: Database, saveDb: () => void, options?: { resolveParticipants?: (ids: number[]) => LongTermParticipant[] }) {
    this.db = db;
    this.saveDb = saveDb;
    this.resolveParticipants = options?.resolveParticipants ?? ((ids) => ids.map((id) => ({ id, name: `#${id}`, avatar: null })));
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS long_term_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'defining'
          CHECK(stage IN ('defining','active','paused','done','cancelled')),
        acceptance_delegate INTEGER NOT NULL DEFAULT 0,
        current_subtask_id TEXT,
        definition_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_long_term_tasks_stage
        ON long_term_tasks(stage, updated_at DESC);
      CREATE TABLE IF NOT EXISTS long_term_subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','in_progress','waiting_owner','waiting_external','accepted','rejected','skipped')),
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        preferred_channel TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        session_id TEXT,
        wait_note TEXT NOT NULL DEFAULT '',
        wait_until TEXT,
        notes TEXT NOT NULL DEFAULT '',
        accepted_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        UNIQUE(task_id, ordinal),
        FOREIGN KEY(task_id) REFERENCES long_term_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_long_term_subtasks_task
        ON long_term_subtasks(task_id, ordinal);
      CREATE TABLE IF NOT EXISTS long_term_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        subtask_id TEXT,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_term_events_task
        ON long_term_events(task_id, id DESC);
    `);
    this.saveDb();
  }

  // ── row mapping ──────────────────────────────────────────────────────────

  private getOne<T extends object>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values?.[0]) return null;
    const row: Row = {};
    result[0].columns.forEach((column, index) => {
      row[column] = result[0].values[0][index];
    });
    return row as T;
  }

  private getAll<T extends object>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    return (result[0]?.values ?? []).map((values) => {
      const row: Row = {};
      result[0].columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return row as T;
    });
  }

  private mapTask(row: TaskRow) {
    return {
      id: row.id,
      title: row.title,
      goal: row.goal,
      stage: row.stage,
      acceptanceDelegate: row.acceptance_delegate === 1,
      currentSubtaskIdPinned: row.current_subtask_id ?? null,
      definitionSessionId: row.definition_session_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at ?? null,
    };
  }

  private mapSubtask(row: SubtaskRow): LongTermSubtask {
    return {
      id: row.id,
      taskId: row.task_id,
      ordinal: row.ordinal,
      title: row.title,
      description: row.description ?? '',
      acceptanceCriteria: parseJsonArray<string>(row.acceptance_criteria_json),
      status: row.status,
      dependsOn: parseJsonArray<string>(row.depends_on_json),
      preferredChannel: CHANNELS.includes(row.preferred_channel as LongTermPreferredChannel)
        ? (row.preferred_channel as LongTermPreferredChannel)
        : null,
      evidence: parseJsonArray<LongTermEvidence>(row.evidence_json),
      sessionId: row.session_id ?? null,
      waitNote: row.wait_note ?? '',
      waitUntil: row.wait_until ?? null,
      notes: row.notes ?? '',
      acceptedBy: row.accepted_by === 'owner' || row.accepted_by === 'twin' ? row.accepted_by : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptedAt: row.accepted_at ?? null,
    };
  }

  private mapEvent(row: EventRow): LongTermEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      subtaskId: row.subtask_id ?? null,
      kind: row.kind,
      actor: row.actor,
      detail: row.detail ?? '',
      createdAt: row.created_at,
    };
  }

  private getTaskRow(taskId: string): TaskRow | null {
    return this.getOne<TaskRow>('SELECT * FROM long_term_tasks WHERE id = ?', [taskId]);
  }

  private listSubtaskRows(taskId: string): SubtaskRow[] {
    return this.getAll<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE task_id = ? ORDER BY ordinal ASC', [taskId]);
  }

  private addEvent(taskId: string, subtaskId: string | null, kind: LongTermEventKind, actor: LongTermActor, detail: string): void {
    this.db.run('INSERT INTO long_term_events (task_id, subtask_id, kind, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      taskId,
      subtaskId,
      kind,
      actor,
      detail.slice(0, 2000),
      nowIso(),
    ]);
  }

  private touch(taskId: string): void {
    this.db.run('UPDATE long_term_tasks SET updated_at = ? WHERE id = ?', [nowIso(), taskId]);
  }

  // ── derivation ───────────────────────────────────────────────────────────

  private toSummary(taskRow: TaskRow, subtasks: LongTermSubtask[]): LongTermTaskSummary {
    const task = this.mapTask(taskRow);
    const current = deriveCurrentSubtask(task.currentSubtaskIdPinned, subtasks);
    const column = deriveColumn(task.stage, current?.status ?? null);
    const counts = Object.fromEntries(SUBTASK_STATUSES.map((s) => [s, 0])) as Record<LongTermSubtaskStatus, number>;
    for (const subtask of subtasks) counts[subtask.status] += 1;
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      stage: task.stage,
      column: column ?? 'done',
      acceptanceDelegate: task.acceptanceDelegate,
      currentSubtaskId: current?.id ?? null,
      currentSubtaskTitle: current?.title ?? null,
      currentSubtaskStatus: current?.status ?? null,
      currentWaitNote: current && current.waitNote ? current.waitNote : null,
      progress: deriveProgress(subtasks),
      counts,
      participants: this.resolveParticipants(this.listParticipantIds(taskRow, subtasks)),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      doneAt: task.doneAt,
    };
  }

  /**
   * Participating bots, derived read-time from the task's sessions: the bot
   * that ran each bound session (the Twin on longterm/definition sessions) ∪
   * workers delegated from those sessions (orchestration assignees) ∪ members
   * of group tasks sourced from them.
   */
  private listParticipantIds(taskRow: TaskRow, subtasks: LongTermSubtask[]): number[] {
    const sessionIds = [taskRow.definition_session_id, ...subtasks.map((sub) => sub.sessionId)]
      .filter((id): id is string => Boolean(id));
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    const ids = new Set<number>();
    const collect = (sql: string) => {
      for (const row of this.getAll<{ id: unknown }>(sql, sessionIds)) {
        const id = Number(row.id);
        if (Number.isFinite(id)) ids.add(id);
      }
    };
    collect(`SELECT DISTINCT metabot_id AS id FROM cowork_sessions WHERE id IN (${placeholders}) AND metabot_id IS NOT NULL`);
    collect(`SELECT DISTINCT s.assignee_metabot_id AS id FROM orchestration_steps s
             JOIN orchestration_tasks t ON t.id = s.task_id
             WHERE t.source_session_id IN (${placeholders}) AND s.assignee_metabot_id IS NOT NULL`);
    collect(`SELECT DISTINCT m.metabot_id AS id FROM group_task_members m
             JOIN group_tasks g ON g.id = m.task_id
             WHERE g.source_session_id IN (${placeholders}) AND m.metabot_id IS NOT NULL`);
    return [...ids].sort((a, b) => a - b);
  }

  // ── task lifecycle ───────────────────────────────────────────────────────

  /**
   * Create a task in `defining` (draft) with its sub-projects. Nothing is
   * pushed forward until `activateTask` — creation is the grilling skill's
   * output, activation is the owner's sign-off.
   */
  createTask(input: LongTermTaskCreateInput, actor: LongTermActor): LongTermResult<LongTermTaskSummary> {
    const title = asText(input.title).trim();
    const goal = asText(input.goal).trim();
    if (!title || !goal) return { ok: false, code: 'VALIDATION', error: 'title and goal are required' };
    const drafts = input.subtasks ?? [];
    if (drafts.length === 0) return { ok: false, code: 'VALIDATION', error: 'at least one sub-project is required' };
    const taskId = `ltt_${uuidv4()}`;
    const now = nowIso();
    const subtaskIds = drafts.map(() => `lts_${uuidv4()}`);
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (!asText(draft.title).trim()) {
        return { ok: false, code: 'VALIDATION', error: `sub-project #${index + 1} has no title` };
      }
      for (const ordinal of draft.dependsOnOrdinals ?? []) {
        if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > drafts.length || ordinal === index + 1) {
          return { ok: false, code: 'VALIDATION', error: `sub-project #${index + 1} has an invalid dependsOn ordinal ${ordinal}` };
        }
      }
      void subtaskIds;
    }
    this.db.run(
      `INSERT INTO long_term_tasks (id, title, goal, stage, acceptance_delegate, definition_session_id, created_at, updated_at)
       VALUES (?, ?, ?, 'defining', 0, ?, ?, ?)`,
      [taskId, title, goal, input.definitionSessionId ?? null, now, now],
    );
    drafts.forEach((draft, index) => {
      const dependsOn = (draft.dependsOnOrdinals ?? []).map((ordinal) => subtaskIds[ordinal - 1]);
      this.db.run(
        `INSERT INTO long_term_subtasks
         (id, task_id, ordinal, title, description, acceptance_criteria_json, status, depends_on_json, preferred_channel, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          subtaskIds[index],
          taskId,
          index + 1,
          asText(draft.title).trim(),
          asText(draft.description ?? ''),
          JSON.stringify(draft.acceptanceCriteria ?? []),
          JSON.stringify(dependsOn),
          draft.preferredChannel && CHANNELS.includes(draft.preferredChannel) ? draft.preferredChannel : null,
          asText(draft.notes ?? ''),
          now,
          now,
        ],
      );
    });
    this.addEvent(taskId, null, 'created', actor, `created as draft with ${drafts.length} sub-project(s): ${title}`);
    this.saveDb();
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'creation failed' };
  }

  /** Owner confirmed the plan in chat → the task goes active. */
  activateTask(taskId: string, actor: LongTermActor): LongTermResult<LongTermTaskSummary> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage !== 'defining' && row.stage !== 'paused') {
      return { ok: false, code: 'VALIDATION', error: `cannot activate from stage ${row.stage}` };
    }
    this.db.run("UPDATE long_term_tasks SET stage = 'active', updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    this.addEvent(taskId, null, row.stage === 'paused' ? 'resumed' : 'created', actor,
      row.stage === 'paused' ? 'resumed' : 'plan confirmed, task activated');
    this.saveDb();
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  pauseTask(taskId: string, actor: LongTermActor, note = ''): LongTermResult<LongTermTaskSummary> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage !== 'active') return { ok: false, code: 'VALIDATION', error: `cannot pause from stage ${row.stage}` };
    this.db.run("UPDATE long_term_tasks SET stage = 'paused', updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    this.addEvent(taskId, null, 'paused', actor, note || 'paused');
    this.saveDb();
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  cancelTask(taskId: string, actor: LongTermActor, note = ''): LongTermResult<null> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage === 'done' || row.stage === 'cancelled') {
      return { ok: false, code: 'VALIDATION', error: `already ${row.stage}` };
    }
    this.db.run("UPDATE long_term_tasks SET stage = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    this.addEvent(taskId, null, 'note', actor, `cancelled${note ? `: ${note}` : ''}`);
    this.saveDb();
    return { ok: true, value: null };
  }

  updateTask(input: LongTermTaskUpdateInput, actor: LongTermActor): LongTermResult<LongTermTaskSummary> {
    const row = this.getTaskRow(input.taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const changes: string[] = [];
    if (typeof input.title === 'string' && input.title.trim() && input.title.trim() !== row.title) {
      this.db.run('UPDATE long_term_tasks SET title = ? WHERE id = ?', [input.title.trim(), row.id]);
      changes.push('title');
    }
    if (typeof input.goal === 'string' && input.goal.trim() && input.goal.trim() !== row.goal) {
      this.db.run('UPDATE long_term_tasks SET goal = ? WHERE id = ?', [input.goal.trim(), row.id]);
      changes.push('goal');
    }
    if (typeof input.acceptanceDelegate === 'boolean') {
      const next = input.acceptanceDelegate ? 1 : 0;
      if (next !== row.acceptance_delegate) {
        this.db.run('UPDATE long_term_tasks SET acceptance_delegate = ? WHERE id = ?', [next, row.id]);
        changes.push(`acceptance_delegate=${next === 1 ? 'on' : 'off'}`);
      }
    }
    if (changes.length === 0) return { ok: false, code: 'VALIDATION', error: 'nothing to update' };
    this.touch(row.id);
    this.addEvent(row.id, null, 'replanned', actor, `updated: ${changes.join(', ')}`);
    this.saveDb();
    const detail = this.getTask(row.id);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  getTask(taskId: string): LongTermTaskDetail | null {
    const row = this.getTaskRow(taskId);
    if (!row) return null;
    const subtasks = this.listSubtaskRows(taskId).map((sub) => this.mapSubtask(sub));
    const summary = this.toSummary(row, subtasks);
    const events = this.getAll<EventRow>(
      'SELECT * FROM long_term_events WHERE task_id = ? ORDER BY id DESC LIMIT 200',
      [taskId],
    ).map((event) => this.mapEvent(event));
    return { ...summary, subtasks, events, definitionSessionId: row.definition_session_id ?? null };
  }

  listBoard(): LongTermBoard {
    const taskRows = this.getAll<TaskRow>("SELECT * FROM long_term_tasks WHERE stage != 'cancelled'");
    const cards: LongTermTaskSummary[] = [];
    for (const row of taskRows) {
      const subtasks = this.listSubtaskRows(row.id).map((sub) => this.mapSubtask(sub));
      cards.push(this.toSummary(row, subtasks));
    }
    const columns = LONG_TERM_COLUMN_ORDER.map((column) => ({
      column,
      cardIds: cards
        .filter((card) => card.column === column)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((card) => card.id),
    }));
    return { generatedAtMs: Date.now(), columns, cards };
  }

  listEvents(taskId: string, limit = 200): LongTermEvent[] {
    return this.getAll<EventRow>('SELECT * FROM long_term_events WHERE task_id = ? ORDER BY id DESC LIMIT ?', [
      taskId,
      Math.max(1, Math.min(500, Math.trunc(limit))),
    ]).map((row) => this.mapEvent(row));
  }

  // ── sub-task mutations ───────────────────────────────────────────────────

  addSubtask(taskId: string, draft: LongTermSubtaskDraft, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const title = asText(draft.title).trim();
    if (!title) return { ok: false, code: 'VALIDATION', error: 'title is required' };
    const existing = this.listSubtaskRows(taskId);
    const ordinal = existing.reduce((max, sub) => Math.max(max, sub.ordinal), 0) + 1;
    const dependsOn = (draft.dependsOnOrdinals ?? []).map((ordinalRef) => existing.find((sub) => sub.ordinal === ordinalRef)?.id ?? '');
    if (dependsOn.some((id) => !id)) {
      return { ok: false, code: 'VALIDATION', error: 'dependsOnOrdinals must reference existing sub-projects' };
    }
    const id = `lts_${uuidv4()}`;
    const now = nowIso();
    this.db.run(
      `INSERT INTO long_term_subtasks
       (id, task_id, ordinal, title, description, acceptance_criteria_json, status, depends_on_json, preferred_channel, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        id,
        taskId,
        ordinal,
        title,
        asText(draft.description ?? ''),
        JSON.stringify(draft.acceptanceCriteria ?? []),
        JSON.stringify(dependsOn),
        draft.preferredChannel && CHANNELS.includes(draft.preferredChannel) ? draft.preferredChannel : null,
        asText(draft.notes ?? ''),
        now,
        now,
      ],
    );
    this.touch(taskId);
    this.addEvent(taskId, id, 'replanned', actor, `sub-project added (#${ordinal}): ${title}`);
    this.saveDb();
    const created = this.getSubtask(id);
    return created ? { ok: true, value: created } : { ok: false, code: 'NOT_FOUND', error: 'creation failed' };
  }

  getSubtask(subtaskId: string): LongTermSubtask | null {
    const row = this.getOne<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE id = ?', [subtaskId]);
    return row ? this.mapSubtask(row) : null;
  }

  /** Owner/Twin may redefine any open sub-project at any time (requirements drift). */
  updateSubtask(input: LongTermSubtaskUpdateInput, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(input.subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot edit a ${current.status} sub-project` };
    }
    const changes: string[] = [];
    const set = (column: string, value: unknown, label: string) => {
      this.db.run(`UPDATE long_term_subtasks SET ${column} = ? WHERE id = ?`, [value, current.id]);
      changes.push(label);
    };
    if (typeof input.title === 'string' && input.title.trim() && input.title.trim() !== current.title) {
      set('title', input.title.trim(), 'title');
    }
    if (typeof input.description === 'string' && input.description !== current.description) {
      set('description', input.description, 'description');
    }
    if (Array.isArray(input.acceptanceCriteria)) {
      set('acceptance_criteria_json', JSON.stringify(input.acceptanceCriteria), 'acceptance criteria');
    }
    if (typeof input.notes === 'string' && input.notes !== current.notes) set('notes', input.notes, 'notes');
    if (input.preferredChannel === null || CHANNELS.includes(input.preferredChannel as LongTermPreferredChannel)) {
      if (input.preferredChannel !== undefined && input.preferredChannel !== current.preferredChannel) {
        set('preferred_channel', input.preferredChannel, 'preferred channel');
      }
    }
    if (typeof input.ordinal === 'number' && Number.isInteger(input.ordinal) && input.ordinal > 0 && input.ordinal !== current.ordinal) {
      const occupied = this.getOne<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE task_id = ? AND ordinal = ? AND id != ?', [
        current.taskId,
        input.ordinal,
        current.id,
      ]);
      if (occupied) return { ok: false, code: 'VALIDATION', error: `ordinal ${input.ordinal} is taken by another sub-project` };
      set('ordinal', input.ordinal, 'order');
    }
    if (Array.isArray(input.dependsOn)) {
      const siblings = new Set(this.listSubtaskRows(current.taskId).map((sub) => sub.id));
      for (const dep of input.dependsOn) {
        if (!siblings.has(dep)) return { ok: false, code: 'VALIDATION', error: `dependency ${dep} is not a sibling sub-project` };
        if (dep === current.id) return { ok: false, code: 'VALIDATION', error: 'a sub-project cannot depend on itself' };
      }
      const next = { ...current, dependsOn: input.dependsOn };
      if (this.hasDependencyCycle(next)) {
        return { ok: false, code: 'VALIDATION', error: 'dependency cycle detected' };
      }
      set('depends_on_json', JSON.stringify(input.dependsOn), 'dependencies');
    }
    if (changes.length === 0) return { ok: false, code: 'VALIDATION', error: 'nothing to update' };
    this.db.run('UPDATE long_term_subtasks SET updated_at = ? WHERE id = ?', [nowIso(), current.id]);
    this.touch(current.taskId);
    this.addEvent(current.taskId, current.id, 'replanned', actor, `redefined: ${changes.join(', ')}`);
    this.saveDb();
    const updated = this.getSubtask(current.id);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  private hasDependencyCycle(start: LongTermSubtask): boolean {
    const byId = new Map(
      this.listSubtaskRows(start.taskId).map((row) => {
        const sub = this.mapSubtask(row);
        return [sub.id, sub.id === start.id ? start : sub] as const;
      }),
    );
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): boolean => {
      if (done.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      const node = byId.get(id);
      for (const dep of node?.dependsOn ?? []) {
        if (visit(dep)) return true;
      }
      visiting.delete(id);
      done.add(id);
      return false;
    };
    return visit(start.id);
  }

  /** Start pushing a sub-project. Refused while its dependencies are unmet. */
  beginSubtask(subtaskId: string, actor: LongTermActor, channel?: LongTermPreferredChannel | null): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'pending' && current.status !== 'in_progress') {
      return { ok: false, code: 'VALIDATION', error: `cannot begin from status ${current.status}` };
    }
    const siblings = this.listSubtaskRows(current.taskId).map((row) => this.mapSubtask(row));
    const unmet = current.dependsOn.filter((dep) => siblings.find((sub) => sub.id === dep)?.status !== 'accepted');
    if (unmet.length > 0) {
      const titles = unmet.map((dep) => siblings.find((sub) => sub.id === dep)?.title ?? dep);
      return { ok: false, code: 'VALIDATION', error: `dependencies not yet accepted: ${titles.join('; ')}` };
    }
    const task = this.getTaskRow(current.taskId);
    if (task?.stage === 'defining') {
      return { ok: false, code: 'VALIDATION', error: 'activate the task first (owner confirms the plan)' };
    }
    if (task?.stage === 'paused' || task?.stage === 'done' || task?.stage === 'cancelled') {
      return { ok: false, code: 'VALIDATION', error: `task is ${task.stage}` };
    }
    const channelClause = channel && CHANNELS.includes(channel) ? channel : current.preferredChannel;
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'in_progress', preferred_channel = ?, wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?",
      [channelClause, nowIso(), subtaskId],
    );
    // Pin the board focus onto the sub-project being pushed.
    this.db.run('UPDATE long_term_tasks SET current_subtask_id = ?, updated_at = ? WHERE id = ?', [subtaskId, nowIso(), current.taskId]);
    this.addEvent(current.taskId, subtaskId, 'began', actor, `began (channel: ${channelClause ?? 'undecided'})`);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Park the current sub-project on a blocking point (owner decision / external condition). */
  waitSubtask(
    subtaskId: string,
    input: { kind: 'owner' | 'external'; note: string; waitUntil?: string | null },
    actor: LongTermActor,
  ): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'in_progress' && current.status !== 'waiting_owner' && current.status !== 'waiting_external') {
      return { ok: false, code: 'VALIDATION', error: `cannot wait from status ${current.status}` };
    }
    const status: LongTermSubtaskStatus = input.kind === 'owner' ? 'waiting_owner' : 'waiting_external';
    this.db.run('UPDATE long_term_subtasks SET status = ?, wait_note = ?, wait_until = ?, updated_at = ? WHERE id = ?', [
      status,
      asText(input.note),
      input.waitUntil ?? null,
      nowIso(),
      subtaskId,
    ]);
    this.addEvent(current.taskId, subtaskId, 'waiting', actor, `${input.kind}: ${asText(input.note)}`);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Twin presents evidence against the acceptance criteria and asks the owner to accept. */
  proposeSubtask(subtaskId: string, input: { evidence: LongTermEvidence[]; summary: string }, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'in_progress' && current.status !== 'waiting_external') {
      return { ok: false, code: 'VALIDATION', error: `cannot propose acceptance from status ${current.status}` };
    }
    const evidence = (input.evidence ?? []).filter((entry) => entry && asText(entry.uri).trim());
    if (evidence.length === 0) return { ok: false, code: 'VALIDATION', error: 'at least one evidence URI is required' };
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'waiting_owner', evidence_json = ?, wait_note = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(evidence), `acceptance proposed: ${asText(input.summary).slice(0, 500)}`, nowIso(), subtaskId],
    );
    this.addEvent(current.taskId, subtaskId, 'proposed', actor, asText(input.summary).slice(0, 1000));
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /**
   * Accept a sub-project. Actor 'twin' requires the task's acceptance_delegate
   * flag (owner granted it once, explicitly); otherwise owner-only. When every
   * live sub-project is accepted the task itself completes.
   */
  acceptSubtask(subtaskId: string, actor: LongTermActor, note = ''): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    const task = this.getTaskRow(current.taskId);
    if (!task) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (actor === 'twin' && task.acceptance_delegate !== 1) {
      return { ok: false, code: 'FORBIDDEN', error: 'acceptance is owner-only for this task (delegate switch is off)' };
    }
    if (current.status !== 'waiting_owner' && current.status !== 'in_progress') {
      return { ok: false, code: 'VALIDATION', error: `cannot accept from status ${current.status}` };
    }
    const now = nowIso();
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'accepted', accepted_by = ?, accepted_at = ?, wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?",
      [actor, now, now, subtaskId],
    );
    // Clear the focus pin when it pointed here so derivation moves on.
    if (task.current_subtask_id === subtaskId) {
      this.db.run('UPDATE long_term_tasks SET current_subtask_id = NULL WHERE id = ?', [task.id]);
    }
    this.addEvent(task.id, subtaskId, 'accepted', actor, note || `accepted by ${actor}`);
    const remaining = this.listSubtaskRows(task.id)
      .map((row) => this.mapSubtask(row))
      .filter((sub) => sub.status !== 'accepted' && sub.status !== 'skipped');
    if (remaining.length === 0 && task.stage === 'active') {
      this.db.run("UPDATE long_term_tasks SET stage = 'done', done_at = ?, updated_at = ? WHERE id = ?", [now, now, task.id]);
      this.addEvent(task.id, null, 'completed', actor, 'all sub-projects accepted — task complete');
    } else {
      this.touch(task.id);
    }
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Reject a proposed acceptance: back to in_progress with the owner's feedback. */
  rejectSubtask(subtaskId: string, actor: LongTermActor, feedback: string): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'waiting_owner') {
      return { ok: false, code: 'VALIDATION', error: `cannot reject from status ${current.status}` };
    }
    const text = asText(feedback).trim();
    if (!text) return { ok: false, code: 'VALIDATION', error: 'feedback is required (it steers the next iteration)' };
    this.db.run("UPDATE long_term_subtasks SET status = 'in_progress', updated_at = ? WHERE id = ?", [nowIso(), subtaskId]);
    this.addEvent(current.taskId, subtaskId, 'rejected', actor, text.slice(0, 1000));
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Leave a waiting state (owner answered / external condition changed). */
  unblockSubtask(subtaskId: string, actor: LongTermActor, note = ''): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'waiting_owner' && current.status !== 'waiting_external') {
      return { ok: false, code: 'VALIDATION', error: `not waiting (status ${current.status})` };
    }
    this.db.run("UPDATE long_term_subtasks SET status = 'in_progress', wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?", [
      nowIso(),
      subtaskId,
    ]);
    this.addEvent(current.taskId, subtaskId, 'unblocked', actor, note || 'resumed');
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Bind (or rebind) the cowork session that hosts this sub-project's work. */
  bindSession(subtaskId: string, sessionId: string, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    const trimmed = asText(sessionId).trim();
    if (!trimmed) return { ok: false, code: 'VALIDATION', error: 'sessionId is required' };
    this.db.run('UPDATE long_term_subtasks SET session_id = ?, updated_at = ? WHERE id = ?', [trimmed, nowIso(), subtaskId]);
    this.addEvent(current.taskId, subtaskId, 'note', actor, `session bound: ${trimmed}`);
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  addNote(taskId: string, subtaskId: string | null, text: string, actor: LongTermActor): LongTermResult<null> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const trimmed = asText(text).trim();
    if (!trimmed) return { ok: false, code: 'VALIDATION', error: 'note text is required' };
    this.addEvent(taskId, subtaskId, 'note', actor, trimmed);
    this.touch(taskId);
    this.saveDb();
    return { ok: true, value: null };
  }

  // ── heartbeat nudge support (longTermAdvanceService) ─────────────────────

  /**
   * Journal a heartbeat escalation ('nudged' event, actor 'system'): the
   * advance handler opened/continued a session for this sub-project. The
   * journal is the owner's audit of every proactive move the TwinBot made.
   */
  recordNudge(taskId: string, subtaskId: string, detail: string): void {
    this.addEvent(taskId, subtaskId, 'nudged', 'system', detail);
    this.touch(taskId);
    this.saveDb();
  }

  /** Per-task nudge throttle state, one kv JSON map row (`longterm_nudge_state`). */
  getNudgeState(taskId: string): LongTermNudgeState | null {
    const map = this.readNudgeStateMap();
    const entry = map[taskId];
    if (!entry || typeof entry !== 'object') return null;
    const lastNudgeAtMs = Number((entry as LongTermNudgeState).lastNudgeAtMs);
    const lastEventId = Number((entry as LongTermNudgeState).lastEventId);
    if (!Number.isFinite(lastNudgeAtMs)) return null;
    return { lastNudgeAtMs, lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0 };
  }

  setNudgeState(taskId: string, state: LongTermNudgeState): void {
    const map = this.readNudgeStateMap();
    map[taskId] = { lastNudgeAtMs: Math.trunc(state.lastNudgeAtMs), lastEventId: Math.trunc(state.lastEventId) };
    this.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [LONGTERM_NUDGE_STATE_KV_KEY, JSON.stringify(map), Date.now()],
    );
    this.saveDb();
  }

  private readNudgeStateMap(): Record<string, LongTermNudgeState> {
    try {
      const row = this.getOne<{ value: string }>('SELECT value FROM kv WHERE key = ?', [LONGTERM_NUDGE_STATE_KV_KEY]);
      const parsed = row?.value ? JSON.parse(row.value) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, LongTermNudgeState>) : {};
    } catch {
      return {};
    }
  }

  /** Heartbeat read: open sub-projects waiting on a time-based condition that's now due. */
  listDueWaits(now: Date = new Date()): LongTermSubtask[] {
    return this.getAll<SubtaskRow>(
      "SELECT * FROM long_term_subtasks WHERE wait_until IS NOT NULL AND wait_until <= ? AND status IN ('waiting_owner','waiting_external')",
      [now.toISOString()],
    ).map((row) => this.mapSubtask(row));
  }
}
