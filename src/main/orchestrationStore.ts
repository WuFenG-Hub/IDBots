import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

export type OrchestrationTaskStatus = 'planning' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled';
export type OrchestrationStepStatus = 'blocked' | 'ready' | 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
export type OrchestrationAttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface OrchestrationTask {
  id: string;
  ownerIntent: string;
  enrichedGoal: string | null;
  acceptanceCriteria: unknown[];
  sourceSessionId: string | null;
  twinMetabotId: number;
  ownerGlobalMetaId: string;
  status: OrchestrationTaskStatus;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OrchestrationStep {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  objective: string;
  acceptanceCriteria: unknown[];
  dependencyStepIds: string[];
  assigneeMetabotId: number | null;
  permissionScope: unknown;
  deadlineAt: string | null;
  status: OrchestrationStepStatus;
  acceptedResult: unknown | null;
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationAttempt {
  id: string;
  stepId: string;
  idempotencyKey: string;
  workerMetabotId: number;
  workerSessionId: string | null;
  status: OrchestrationAttemptStatus;
  prompt: string;
  result: unknown | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateOrchestrationTaskInput {
  ownerIntent: string;
  enrichedGoal?: string | null;
  acceptanceCriteria?: unknown[];
  sourceSessionId?: string | null;
  twinMetabotId: number;
  ownerGlobalMetaId: string;
  planVersion?: number;
}

export interface CreateOrchestrationStepInput {
  taskId: string;
  ordinal: number;
  title: string;
  objective: string;
  acceptanceCriteria?: unknown[];
  dependencyStepIds?: string[];
  assigneeMetabotId?: number | null;
  permissionScope?: unknown;
  deadlineAt?: string | null;
  status?: OrchestrationStepStatus;
}

export interface CreateOrchestrationAttemptInput {
  stepId: string;
  idempotencyKey: string;
  workerMetabotId: number;
  workerSessionId?: string | null;
  prompt: string;
}

interface Row { [key: string]: unknown }

const TASK_TRANSITIONS: Record<OrchestrationTaskStatus, OrchestrationTaskStatus[]> = {
  planning: ['running', 'completed', 'failed', 'cancelled'],
  running: ['review', 'completed', 'failed', 'cancelled'],
  review: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['planning', 'running', 'cancelled'],
  cancelled: [],
};

const STEP_TRANSITIONS: Record<OrchestrationStepStatus, OrchestrationStepStatus[]> = {
  blocked: ['ready', 'cancelled'],
  ready: ['queued', 'cancelled'],
  queued: ['running', 'ready', 'failed', 'cancelled'],
  running: ['waiting_input', 'completed', 'failed', 'ready', 'cancelled'],
  waiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: ['ready'],
  // failed -> completed: used when a noise step (e.g. a mistaken worker mention
  // whose skill routing failed) is auto-ignored when the task enters review.
  failed: ['ready', 'cancelled', 'completed'],
  cancelled: [],
};
const ATTEMPT_TRANSITIONS: Record<OrchestrationAttemptStatus, OrchestrationAttemptStatus[]> = {
  queued: ['running', 'failed', 'timed_out', 'cancelled'],
  running: ['completed', 'failed', 'timed_out', 'cancelled'],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function taskFromRow(row: Row): OrchestrationTask {
  const status = String(row.status);
  return {
    id: String(row.id),
    ownerIntent: String(row.owner_intent ?? ''),
    enrichedGoal: row.enriched_goal == null ? null : String(row.enriched_goal),
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []) as unknown[],
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    twinMetabotId: Number(row.twin_metabot_id),
    ownerGlobalMetaId: String(row.owner_global_meta_id ?? ''),
    status: status in TASK_TRANSITIONS ? status as OrchestrationTaskStatus : 'planning',
    planVersion: Number(row.plan_version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

function stepFromRow(row: Row): OrchestrationStep {
  const status = String(row.status);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ordinal: Number(row.ordinal),
    title: String(row.title ?? ''),
    objective: String(row.objective ?? ''),
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []) as unknown[],
    dependencyStepIds: parseJson(row.dependency_step_ids_json, []) as string[],
    assigneeMetabotId: row.assignee_metabot_id == null ? null : Number(row.assignee_metabot_id),
    permissionScope: parseJson(row.permission_scope_json, {}),
    deadlineAt: row.deadline_at == null ? null : String(row.deadline_at),
    status: status in STEP_TRANSITIONS ? status as OrchestrationStepStatus : 'blocked',
    acceptedResult: parseJson(row.accepted_result_json, null),
    activeAttemptId: row.active_attempt_id == null ? null : String(row.active_attempt_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function attemptFromRow(row: Row): OrchestrationAttempt {
  const status = String(row.status);
  return {
    id: String(row.id),
    stepId: String(row.step_id),
    idempotencyKey: String(row.idempotency_key),
    workerMetabotId: Number(row.worker_metabot_id),
    workerSessionId: row.worker_session_id == null ? null : String(row.worker_session_id),
    status: status === 'timed_out' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'running' ? status : 'queued',
    prompt: String(row.prompt ?? ''),
    result: parseJson(row.result_json, null),
    error: row.error == null ? null : String(row.error),
    queuedAt: String(row.queued_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}

export class OrchestrationStore {
  private readonly db: Database;
  private readonly saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureTables();
  }

  private getOne<T extends Row>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values?.[0]) return null;
    const row: Row = {};
    result[0].columns.forEach((column, index) => { row[column] = result[0].values[0][index]; });
    return row as T;
  }

  private getAll<T extends Row>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    return (result[0]?.values ?? []).map((values) => {
      const row: Row = {};
      result[0].columns.forEach((column, index) => { row[column] = values[index]; });
      return row as T;
    });
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        id TEXT PRIMARY KEY,
        owner_intent TEXT NOT NULL,
        enriched_goal TEXT,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        source_session_id TEXT,
        twin_metabot_id INTEGER NOT NULL,
        owner_global_meta_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','running','review','completed','failed','cancelled')),
        plan_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_owner_status
        ON orchestration_tasks(owner_global_meta_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        dependency_step_ids_json TEXT NOT NULL DEFAULT '[]',
        assignee_metabot_id INTEGER,
        permission_scope_json TEXT NOT NULL DEFAULT '{}',
        deadline_at TEXT,
        status TEXT NOT NULL DEFAULT 'blocked' CHECK(status IN ('blocked','ready','queued','running','waiting_input','completed','failed','cancelled')),
        accepted_result_json TEXT,
        active_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, ordinal),
        FOREIGN KEY(task_id) REFERENCES orchestration_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_steps_assignee_status
        ON orchestration_steps(assignee_metabot_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_attempts (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        worker_metabot_id INTEGER NOT NULL,
        worker_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','timed_out','cancelled')),
        prompt TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY(step_id) REFERENCES orchestration_steps(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_attempts_step_status
        ON orchestration_attempts(step_id, status, queued_at DESC);
    `);
  }

  createTask(input: CreateOrchestrationTaskInput): OrchestrationTask {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO orchestration_tasks
      (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id, twin_metabot_id, owner_global_meta_id, plan_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, input.ownerIntent.trim(), input.enrichedGoal?.trim() || null,
      JSON.stringify(input.acceptanceCriteria ?? []), input.sourceSessionId ?? null,
      input.twinMetabotId, input.ownerGlobalMetaId.trim(), input.planVersion ?? 1, now, now,
    ]);
    this.saveDb();
    return this.getTask(id)!;
  }

  getTask(id: string): OrchestrationTask | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_tasks WHERE id = ?', [id]);
    return row ? taskFromRow(row) : null;
  }

  listActiveTasks(ownerGlobalMetaId?: string): OrchestrationTask[] {
    const rows = ownerGlobalMetaId
      ? this.getAll<Row>(`SELECT * FROM orchestration_tasks WHERE owner_global_meta_id = ? AND status NOT IN ('completed','cancelled') ORDER BY updated_at DESC`, [ownerGlobalMetaId])
      : this.getAll<Row>(`SELECT * FROM orchestration_tasks WHERE status NOT IN ('completed','cancelled') ORDER BY updated_at DESC`);
    return rows.map(taskFromRow);
  }

  getTaskBySourceSessionId(sourceSessionId: string): OrchestrationTask | null {
    const row = this.getOne<Row>(
      'SELECT * FROM orchestration_tasks WHERE source_session_id = ? ORDER BY created_at ASC LIMIT 1',
      [sourceSessionId],
    );
    return row ? taskFromRow(row) : null;
  }

  updateTaskStatus(id: string, status: OrchestrationTaskStatus): OrchestrationTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`Orchestration task ${id} not found`);
    if (current.status === status) return current;
    if (!TASK_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Illegal orchestration task status transition: ${current.status} -> ${status}`);
    }
    const now = new Date().toISOString();
    this.db.run('UPDATE orchestration_tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?', [
      status, now, status === 'completed' || status === 'cancelled' ? now : null, id,
    ]);
    this.saveDb();
    return this.getTask(id)!;
  }

  createStep(input: CreateOrchestrationStepInput): OrchestrationStep {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO orchestration_steps
      (id, task_id, ordinal, title, objective, acceptance_criteria_json, dependency_step_ids_json, assignee_metabot_id, permission_scope_json, deadline_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, input.taskId, Math.trunc(input.ordinal), input.title.trim(), input.objective.trim(),
      JSON.stringify(input.acceptanceCriteria ?? []), JSON.stringify(input.dependencyStepIds ?? []),
      input.assigneeMetabotId ?? null, JSON.stringify(input.permissionScope ?? {}), input.deadlineAt ?? null,
      input.status ?? 'blocked', now, now,
    ]);
    this.saveDb();
    return this.getStep(id)!;
  }

  getStep(id: string): OrchestrationStep | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_steps WHERE id = ?', [id]);
    return row ? stepFromRow(row) : null;
  }

  getTaskForStep(stepId: string): OrchestrationTask | null {
    const row = this.getOne<Row>(`SELECT t.* FROM orchestration_tasks t
      INNER JOIN orchestration_steps s ON s.task_id = t.id WHERE s.id = ?`, [stepId]);
    return row ? taskFromRow(row) : null;
  }

  listSteps(taskId: string): OrchestrationStep[] {
    return this.getAll<Row>('SELECT * FROM orchestration_steps WHERE task_id = ? ORDER BY ordinal ASC', [taskId]).map(stepFromRow);
  }

  updateStepStatus(id: string, status: OrchestrationStepStatus, patch: { acceptedResult?: unknown; activeAttemptId?: string | null } = {}): OrchestrationStep {
    const current = this.getStep(id);
    if (!current) throw new Error(`Orchestration step ${id} not found`);
    if (current.status !== status && !STEP_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Illegal orchestration step status transition: ${current.status} -> ${status}`);
    }
    this.db.run(`UPDATE orchestration_steps SET status = ?, accepted_result_json = ?, active_attempt_id = ?, updated_at = ? WHERE id = ?`, [
      status,
      patch.acceptedResult === undefined ? (current.acceptedResult == null ? null : JSON.stringify(current.acceptedResult)) : JSON.stringify(patch.acceptedResult),
      patch.activeAttemptId === undefined ? current.activeAttemptId : patch.activeAttemptId,
      new Date().toISOString(), id,
    ]);
    this.saveDb();
    return this.getStep(id)!;
  }

  updateStepAssignee(id: string, assigneeMetabotId: number): OrchestrationStep {
    const step = this.getStep(id);
    if (!step) throw new Error(`Orchestration step ${id} not found`);
    this.db.run('UPDATE orchestration_steps SET assignee_metabot_id = ?, updated_at = ? WHERE id = ?', [assigneeMetabotId, new Date().toISOString(), id]);
    this.saveDb();
    return this.getStep(id)!;
  }

  createAttempt(input: CreateOrchestrationAttemptInput): OrchestrationAttempt {
    const existing = this.getAttemptByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO orchestration_attempts
      (id, step_id, idempotency_key, worker_metabot_id, worker_session_id, prompt, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, input.stepId, input.idempotencyKey, input.workerMetabotId, input.workerSessionId ?? null, input.prompt, now]);
    this.db.run('UPDATE orchestration_steps SET active_attempt_id = ?, updated_at = ? WHERE id = ?', [id, now, input.stepId]);
    this.saveDb();
    return this.getAttempt(id)!;
  }

  getAttempt(id: string): OrchestrationAttempt | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_attempts WHERE id = ?', [id]);
    return row ? attemptFromRow(row) : null;
  }

  getAttemptByIdempotencyKey(key: string): OrchestrationAttempt | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_attempts WHERE idempotency_key = ?', [key]);
    return row ? attemptFromRow(row) : null;
  }

  listAttempts(stepId: string): OrchestrationAttempt[] {
    return this.getAll<Row>('SELECT * FROM orchestration_attempts WHERE step_id = ? ORDER BY queued_at ASC', [stepId]).map(attemptFromRow);
  }

  updateAttempt(id: string, status: OrchestrationAttemptStatus, patch: { workerSessionId?: string | null; result?: unknown; error?: string | null } = {}): OrchestrationAttempt {
    const current = this.getAttempt(id);
    if (!current) throw new Error(`Orchestration attempt ${id} not found`);
    if (current.status !== status && !ATTEMPT_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Illegal orchestration attempt status transition: ${current.status} -> ${status}`);
    }
    const now = new Date().toISOString();
    const startedAt = status === 'running' && !current.startedAt ? now : current.startedAt;
    const finishedAt = ['completed', 'failed', 'timed_out', 'cancelled'].includes(status) && !current.finishedAt
      ? now
      : current.finishedAt;
    this.db.run(`UPDATE orchestration_attempts
      SET status = ?, worker_session_id = ?, result_json = ?, error = ?, started_at = ?, finished_at = ?
      WHERE id = ?`, [
      status, patch.workerSessionId === undefined ? current.workerSessionId : patch.workerSessionId,
      patch.result === undefined ? (current.result == null ? null : JSON.stringify(current.result)) : JSON.stringify(patch.result),
      patch.error === undefined ? current.error : patch.error, startedAt, finishedAt, id,
    ]);
    this.saveDb();
    return this.getAttempt(id)!;
  }

  getActiveWorkload(metabotId: number): number {
    const row = this.getOne<{ count: number }>(`SELECT COUNT(*) AS count FROM orchestration_steps
      WHERE assignee_metabot_id = ? AND status IN ('ready','queued','running','waiting_input')`, [metabotId]);
    return Number(row?.count ?? 0);
  }

  cancelTaskCascade(taskId: string): OrchestrationTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Orchestration task ${taskId} not found`);
    const now = new Date().toISOString();
    const attempts = this.getAll<{ id: string }>(`SELECT a.id FROM orchestration_attempts a
      INNER JOIN orchestration_steps s ON s.id = a.step_id WHERE s.task_id = ? AND a.status IN ('queued','running')`, [taskId]);
    for (const attempt of attempts) {
      this.db.run(`UPDATE orchestration_attempts SET status = 'cancelled', error = 'CANCELLED_BY_OWNER', finished_at = ? WHERE id = ?`, [now, attempt.id]);
    }
    this.db.run(`UPDATE orchestration_steps SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status NOT IN ('completed','cancelled')`, [now, taskId]);
    this.db.run(`UPDATE orchestration_tasks SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled')`, [now, now, taskId]);
    this.saveDb();
    return this.getTask(taskId)!;
  }

  recoverAfterRestart(): { attempts: number; steps: number } {
    const now = new Date().toISOString();
    const running = this.getAll<{ id: string; step_id: string }>(`SELECT id, step_id FROM orchestration_attempts WHERE status = 'running'`);
    for (const attempt of running) {
      this.db.run(`UPDATE orchestration_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, ['RECOVERED_AFTER_RESTART', now, attempt.id]);
      this.db.run(`UPDATE orchestration_steps SET status = 'ready', active_attempt_id = NULL, updated_at = ? WHERE id = ? AND status IN ('running','queued')`, [now, attempt.step_id]);
    }
    if (running.length > 0) this.saveDb();
    return { attempts: running.length, steps: running.length };
  }
}
