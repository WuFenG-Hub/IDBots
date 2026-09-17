import type { SqliteDatabase as Database } from '../sqliteTypes';
import {
  OrchestrationStore,
  type OrchestrationAttempt,
  type OrchestrationStep,
  type OrchestrationTask,
  type OrchestrationTaskStatus,
} from '../orchestrationStore';

/**
 * Long-task board (tracking board) over the single authoritative ledger
 * `orchestration_tasks`.
 *
 * Contract source: 《IDBots 长期任务看板 v1 · 架构规格》
 * pin://4c560264d874a569645142d671258908c26492509b9e03c813edae2035be1503i0 (§1–§4).
 *
 * Hard rules this module obeys:
 *  - One ledger. No fourth table is created; `card_state` is derived in memory
 *    and NEVER persisted (a persisted derived state drifts from the facts).
 *  - The ledger's `status` CHECK domain is NOT extended.
 *  - "待收口" (closure due) is an orthogonal flag, not a fifth column.
 *  - `deriveCardState` is a pure function: every input comes from the ledger,
 *    so an independent verifier can recompute the same verdict from the same rows.
 */

/** Idle thresholds (contract §3). Judgement uses strict greater-than. */
export const TRACKED_CARD_WARN_MS = 86_400_000; // 1 day
export const TRACKED_CARD_ZOMBIE_MS = 172_800_000; // 2 days

export type TrackedCardState = 'waiting_decision' | 'in_progress' | 'blocked_external' | 'closed';

/** Mutual-exclusion priority: closed > waiting_decision > blocked_external > in_progress. */
export const TRACKED_CARD_STATE_ORDER: TrackedCardState[] = [
  'waiting_decision',
  'in_progress',
  'blocked_external',
  'closed',
];

/**
 * Renderer-side i18n keys. UI copy stays in the renderer so the main process
 * never carries a second copy of the labels (AGENTS.md: UI copy is English by
 * default and lives in i18n).
 */
export const TRACKED_CARD_STATE_LABEL_KEY: Record<TrackedCardState, string> = {
  waiting_decision: 'trackedTask.column.waitingDecision',
  in_progress: 'trackedTask.column.inProgress',
  blocked_external: 'trackedTask.column.blockedExternal',
  closed: 'trackedTask.column.closed',
};

export type TrackedCardSourceKind = 'group_task' | 'scheduled_task' | 'session';

export interface TrackedCardSessionLink {
  sessionId: string;
  role: 'source' | 'worker_attempt' | 'scheduled_run' | 'group_chat' | 'scheduled_home';
}

export interface TrackedCardDerivationInput {
  task: OrchestrationTask;
  steps: OrchestrationStep[];
  attempts: OrchestrationAttempt[];
  /** group_task_checkpoints rows with status='open' for the linked group task. */
  openCheckpointCount: number;
  /** group_task_deliverables rows whose uri is verifiable (contract §2.3 R2). */
  verifiableDeliverableCount: number;
  /** Closing conclusion on the ledger row; NULL means the card is NOT closed. */
  closureConclusion: string | null;
  /** Linked scheduled task, when the card is attached to one (contract §1.2). */
  scheduled: { enabled: boolean; nextRunAtMs: number | null; running: boolean } | null;
  /** Every linked session status, for the "session ended" rule (contract §2.3 R3). */
  sessionStatuses: string[];
  /** All candidate activity timestamps in epoch ms; nulls are ignored. */
  activityAtMs: Array<number | null>;
  nowMs: number;
}

export interface TrackedCardDerivation {
  cardState: TrackedCardState;
  closureDue: boolean;
  closureWarn: boolean;
  closureSuggestion: string;
  lastActivityAtMs: number | null;
  idleMs: number | null;
  reasons: string[];
}

function formatDays(ms: number): string {
  return (ms / TRACKED_CARD_WARN_MS).toFixed(1);
}

/**
 * Pure derivation. No IO, no clock read — `nowMs` is an input.
 */
export function deriveCardState(input: TrackedCardDerivationInput): TrackedCardDerivation {
  const { task, steps, attempts, nowMs } = input;

  const blockedSteps = steps.filter((step) => step.status === 'blocked');
  const unmetDependencySteps = blockedSteps.filter((step) => {
    const completed = new Set(
      steps.filter((candidate) => candidate.status === 'completed').map((candidate) => candidate.id),
    );
    return step.dependencyStepIds.some((dependencyId) => !completed.has(dependencyId));
  });
  const waitingInputSteps = steps.filter((step) => step.status === 'waiting_input');
  const activeSteps = steps.filter(
    (step) => step.status === 'ready' || step.status === 'queued' || step.status === 'running',
  );
  const openAttempts = attempts.filter(
    (attempt) => attempt.status === 'queued' || attempt.status === 'running',
  );

  const activity = input.activityAtMs.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const lastActivityAtMs = activity.length ? Math.max(...activity) : null;
  const idleMs = lastActivityAtMs === null ? null : Math.max(0, nowMs - lastActivityAtMs);

  const terminal = task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed';
  const hasConclusion = Boolean(input.closureConclusion?.trim());
  const closed = (task.status === 'completed' || task.status === 'cancelled') && hasConclusion;
  // E6 generalised: a terminal ledger status without a conclusion is NOT closed.
  const terminalWithoutConclusion = terminal && !hasConclusion;

  let cardState: TrackedCardState;
  if (closed) {
    cardState = 'closed';
  } else if (
    input.openCheckpointCount > 0
    || waitingInputSteps.length > 0
    // `review` IS the ledger's "awaiting your decision" landing point. The
    // contract's §2.2 rows list the checkpoint / waiting_input cases; without
    // this clause a review card with finished steps would fall through to
    // 进行中, which contradicts §1.1 + §2.4 E1.
    || task.status === 'review'
    || terminalWithoutConclusion
  ) {
    cardState = 'waiting_decision';
  } else if (unmetDependencySteps.length > 0 || scheduledAwaitingExternal()) {
    cardState = 'blocked_external';
  } else {
    cardState = 'in_progress';
  }

  function scheduledAwaitingExternal(): boolean {
    const scheduled = input.scheduled;
    if (!scheduled) return false;
    return scheduled.enabled && !scheduled.running && (scheduled.nextRunAtMs ?? 0) > nowMs;
  }

  // Strictly greater-than: exactly 24h/48h must NOT trip (contract §2.4 E3).
  const closureWarn = idleMs !== null && idleMs > TRACKED_CARD_WARN_MS;
  const zombie = idleMs !== null && idleMs > TRACKED_CARD_ZOMBIE_MS;
  const sessionsEnded =
    input.sessionStatuses.length > 0
    && input.sessionStatuses.every((status) => status === 'idle')
    && openAttempts.length === 0;

  const closureDue =
    zombie
    || (terminal && !hasConclusion)
    || (sessionsEnded && cardState !== 'closed');

  const reasons: string[] = [];
  if (task.status === 'review') reasons.push('ledger status=review, awaiting a decision');
  if (waitingInputSteps.length > 0) reasons.push(`${waitingInputSteps.length} step(s) waiting_input`);
  if (input.openCheckpointCount > 0) reasons.push(`${input.openCheckpointCount} open group-task checkpoint(s)`);
  if (unmetDependencySteps.length > 0) {
    reasons.push(`${unmetDependencySteps.length} blocked step(s) with unmet dependencies`);
  }
  if (activeSteps.length > 0) reasons.push(`${activeSteps.length} step(s) ready/queued/running`);
  if (openAttempts.length > 0) reasons.push(`${openAttempts.length} attempt(s) queued/running`);
  if (input.verifiableDeliverableCount > 0) {
    reasons.push(`${input.verifiableDeliverableCount} verifiable deliverable(s)`);
  }
  if (terminal && !hasConclusion) reasons.push('terminal status without a closing conclusion');
  if (idleMs !== null && closureWarn) reasons.push(`idle for ${formatDays(idleMs)} day(s)`);
  if (input.sessionStatuses.length > 0) {
    reasons.push(`linked sessions: ${input.sessionStatuses.join(', ')}`);
  }

  return {
    cardState,
    closureDue,
    closureWarn,
    closureSuggestion: buildClosureSuggestion({
      cardState,
      closureDue,
      isTerminal: terminal,
      hasConclusion,
      verifiableDeliverableCount: input.verifiableDeliverableCount,
      unmetDependencyCount: unmetDependencySteps.length,
      idleMs,
    }),
    lastActivityAtMs,
    idleMs,
    reasons: reasons.slice(0, 5),
  };
}

function buildClosureSuggestion(input: {
  cardState: TrackedCardState;
  closureDue: boolean;
  isTerminal: boolean;
  hasConclusion: boolean;
  verifiableDeliverableCount: number;
  unmetDependencyCount: number;
  idleMs: number | null;
}): string {
  if (input.cardState === 'closed') return '';
  if (input.verifiableDeliverableCount > 0) {
    return `Deliverables are verifiable (${input.verifiableDeliverableCount}); close the card with a one-line conclusion.`;
  }
  if (input.unmetDependencyCount > 0 && input.idleMs !== null) {
    return `Dependencies unresolved for ${formatDays(input.idleMs)} day(s); reassign or cancel.`;
  }
  if (input.isTerminal && !input.hasConclusion) {
    return 'Reached a terminal status without a conclusion; add a one-line closing note.';
  }
  if (input.closureDue && input.idleMs !== null) {
    return `No activity for ${formatDays(input.idleMs)} day(s); close it or redefine the acceptance criteria.`;
  }
  return '';
}

export interface TrackedCardSummary {
  id: string;
  title: string;
  goal: string;
  state: TrackedCardState;
  stateLabelKey: string;
  /** The ledger's own status, unchanged and never rewritten by the board. */
  ledgerStatus: OrchestrationTaskStatus;
  closureWarn: boolean;
  closureDue: boolean;
  closureSuggestion: string;
  closureConclusion: string | null;
  lastActivityAtMs: number | null;
  idleMs: number | null;
  createdAt: string;
  updatedAt: string;
  sourceSessionId: string | null;
  sourceKind: TrackedCardSourceKind;
  groupTaskId: number | null;
  scheduledTaskId: string | null;
  /** Cheap, deterministic ordering signal for the "needs my action" list view. */
  needsOwnerAction: boolean;
  actionRank: number;
  reasons: string[];
}

export interface TrackedCardBoard {
  ledger: 'orchestration_tasks';
  generatedAtMs: number;
  columns: Array<{ state: TrackedCardState; labelKey: string; cardIds: string[] }>;
  cards: TrackedCardSummary[];
  closureDueCardIds: string[];
  closureDueCount: number;
}

export interface TrackedCardDetail extends TrackedCardSummary {
  enrichedGoal: string | null;
  acceptanceCriteria: unknown[];
  owner: { twinMetabotId: number; ownerGlobalMetaId: string };
  planVersion: number;
  completedAt: string | null;
  nextCheckpointAt: string | null;
  checkpoints: Array<{ topic: string | null; status: string; createdAt: string | null }>;
  dependencies: Array<{ stepId: string; title: string; status: string; dependsOn: string[]; unmet: string[] }>;
  steps: Array<{ id: string; ordinal: number; title: string; status: string; assigneeMetabotId: number | null }>;
  sessions: TrackedCardSessionLink[];
  deliverables: Array<{ uri: string; status: string; confirmation: string }>;
  events: Array<{ at: string | null; kind: string; detail: string }>;
  closure: { conclusion: string | null; by: string | null; at: string | null; pinId: string | null };
}

export interface TrackedCardCloseInput {
  taskId: string;
  conclusion: string;
  by: 'owner' | 'twin';
  targetStatus?: 'completed' | 'cancelled';
  pinId?: string | null;
}

export interface TrackedCardCloseResult {
  ok: boolean;
  code?: 'NOT_FOUND' | 'VALIDATION' | 'TRANSITION_NOT_ALLOWED';
  error?: string;
  card?: TrackedCardSummary;
}

interface Row { [key: string]: unknown }

function rowList(result: Array<{ columns: string[]; values: unknown[][] }> | undefined): Row[] {
  if (!result?.[0]) return [];
  return (result[0].values ?? []).map((values) => {
    const row: Row = {};
    result[0].columns.forEach((column, index) => { row[column] = values[index]; });
    return row;
  });
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asText = String(value).trim();
  return asText ? asText : null;
}

function epochMs(value: unknown): number | null {
  const asText = text(value);
  if (asText === null) return null;
  const asNumber = Number(asText);
  if (!Number.isNaN(asNumber) && /^\d+$/.test(asText)) {
    // group_tasks.last_driven_at is epoch SECONDS, everything else is ISO.
    return asText.length <= 10 ? asNumber * 1000 : asNumber;
  }
  const parsed = Date.parse(asText);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface TrackedTaskBoardDeps {
  db: Database;
  orchestrationStore: OrchestrationStore;
  saveDb: () => void;
}

/**
 * Read/derive side of the board. Writes only two things: the closure columns on
 * the ledger row (via the state-machine whitelist for `status`).
 */
export class TrackedTaskBoardService {
  constructor(private readonly deps: TrackedTaskBoardDeps) {}

  private getAll(sql: string, params: unknown[] = []): Row[] {
    return rowList(this.deps.db.exec(sql, params));
  }

  private getOne(sql: string, params: unknown[] = []): Row | null {
    return this.getAll(sql, params)[0] ?? null;
  }

  listCards(ownerGlobalMetaId?: string): TrackedCardBoard {
    const nowMs = Date.now();
    const tasks = ownerGlobalMetaId
      ? this.getAll(
        'SELECT * FROM orchestration_tasks WHERE owner_global_meta_id = ? ORDER BY updated_at DESC',
        [ownerGlobalMetaId],
      )
      : this.getAll('SELECT * FROM orchestration_tasks ORDER BY updated_at DESC');

    const cards = tasks
      .map((row) => this.buildSummary(String(row.id), nowMs))
      .filter((card): card is TrackedCardSummary => card !== null);

    return {
      ledger: 'orchestration_tasks',
      generatedAtMs: nowMs,
      columns: TRACKED_CARD_STATE_ORDER.map((state) => ({
        state,
        labelKey: TRACKED_CARD_STATE_LABEL_KEY[state],
        cardIds: cards.filter((card) => card.state === state).map((card) => card.id),
      })),
      cards: [...cards].sort((a, b) => (a.actionRank - b.actionRank) || (b.updatedAt.localeCompare(a.updatedAt))),
      closureDueCardIds: cards.filter((card) => card.closureDue).map((card) => card.id),
      closureDueCount: cards.filter((card) => card.closureDue).length,
    };
  }

  getCard(taskId: string): TrackedCardDetail | null {
    const summary = this.buildSummary(taskId, Date.now());
    if (!summary) return null;
    const task = this.deps.orchestrationStore.getTask(taskId);
    if (!task) return null;
    const steps = this.deps.orchestrationStore.listSteps(taskId);
    const attempts = steps.flatMap((step) => this.deps.orchestrationStore.listAttempts(step.id));
    const groupTask = this.getOne(
      'SELECT id, status, source_session_id, title FROM group_tasks WHERE orchestration_task_id = ? ORDER BY id ASC LIMIT 1',
      [taskId],
    );
    const groupTaskId = groupTask ? Number(groupTask.id) : null;

    const checkpoints = groupTaskId === null
      ? []
      : this.getAll(
        'SELECT topic, status, created_at, resolved_at FROM group_task_checkpoints WHERE task_id = ? ORDER BY id ASC',
        [groupTaskId],
      );
    const deliverables = groupTaskId === null
      ? []
      : this.getAll(
        'SELECT uri, status, confirmation FROM group_task_deliverables WHERE task_id = ? ORDER BY id ASC',
        [groupTaskId],
      );

    const completedStepIds = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.id));
    const dependencies = steps
      .filter((step) => step.dependencyStepIds.length > 0 || step.status === 'blocked')
      .map((step) => ({
        stepId: step.id,
        title: step.title,
        status: step.status,
        dependsOn: step.dependencyStepIds,
        unmet: step.dependencyStepIds.filter((dependencyId) => !completedStepIds.has(dependencyId)),
      }));

    const openCheckpoint = checkpoints.find((row) => String(row.status) === 'open');
    const events: TrackedCardDetail['events'] = [
      { at: task.createdAt, kind: 'card_created', detail: `plan version ${task.planVersion}` },
      ...steps.map((step) => ({
        at: step.updatedAt,
        kind: 'step_updated',
        detail: `${step.title} -> ${step.status}`,
      })),
      ...attempts.map((attempt) => ({
        at: attempt.finishedAt ?? attempt.startedAt ?? attempt.queuedAt,
        kind: 'attempt',
        detail: `${attempt.status} (worker ${attempt.workerMetabotId})`,
      })),
      ...checkpoints.map((row) => ({
        at: text(row.resolved_at) ?? text(row.created_at),
        kind: 'checkpoint',
        detail: `${String(row.status)}${row.topic ? `: ${String(row.topic)}` : ''}`,
      })),
    ]
      .filter((event) => Boolean(event.at))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));

    const closure = this.readClosure(taskId);

    return {
      ...summary,
      enrichedGoal: task.enrichedGoal,
      acceptanceCriteria: task.acceptanceCriteria,
      owner: { twinMetabotId: task.twinMetabotId, ownerGlobalMetaId: task.ownerGlobalMetaId },
      planVersion: task.planVersion,
      completedAt: task.completedAt,
      nextCheckpointAt: text(openCheckpoint?.created_at),
      checkpoints: checkpoints.map((row) => ({
        topic: text(row.topic),
        status: String(row.status),
        createdAt: text(row.created_at),
      })),
      dependencies,
      steps: steps.map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        title: step.title,
        status: step.status,
        assigneeMetabotId: step.assigneeMetabotId,
      })),
      sessions: this.listCardSessions(taskId),
      deliverables: deliverables.map((row) => ({
        uri: String(row.uri ?? ''),
        status: String(row.status ?? ''),
        confirmation: String(row.confirmation ?? ''),
      })),
      events,
      closure,
    };
  }

  /**
   * Card -> every linked session. Five sources from the ledger, no mapping
   * table (contract §4). S4 is reduced to `group_tasks.source_session_id`:
   * the specified extra predicate on `cowork_sessions.session_type` cannot be
   * expressed because that column does not exist (verified on f2e1cb82).
   */
  listCardSessions(taskId: string): TrackedCardSessionLink[] {
    const rows = this.getAll(
      `SELECT DISTINCT session_id, role FROM (
         SELECT source_session_id AS session_id, 'source' AS role
           FROM orchestration_tasks WHERE id = ? AND source_session_id IS NOT NULL
         UNION
         SELECT a.worker_session_id AS session_id, 'worker_attempt' AS role
           FROM orchestration_attempts a JOIN orchestration_steps s ON s.id = a.step_id
          WHERE s.task_id = ? AND a.worker_session_id IS NOT NULL
         UNION
         SELECT r.session_id AS session_id, 'scheduled_run' AS role
           FROM scheduled_task_runs r JOIN scheduled_tasks st ON st.id = r.task_id
          WHERE st.orchestration_task_id = ? AND r.session_id IS NOT NULL
         UNION
         SELECT gt.source_session_id AS session_id, 'group_chat' AS role
           FROM group_tasks gt WHERE gt.orchestration_task_id = ? AND gt.source_session_id IS NOT NULL
         UNION
         SELECT st.cowork_session_id AS session_id, 'scheduled_home' AS role
           FROM scheduled_tasks st WHERE st.orchestration_task_id = ? AND st.cowork_session_id IS NOT NULL
       ) ORDER BY role, session_id`,
      [taskId, taskId, taskId, taskId, taskId],
    );
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      role: String(row.role) as TrackedCardSessionLink['role'],
    }));
  }

  /** Session -> its cards. Zero rows means an independent session: never invent an owner. */
  listCardsForSession(sessionId: string): Array<{ cardId: string; role: string }> {
    const rows = this.getAll(
      `SELECT DISTINCT card_id, role FROM (
         SELECT id AS card_id, 'source' AS role FROM orchestration_tasks WHERE source_session_id = ?
         UNION
         SELECT s.task_id AS card_id, 'worker_attempt' AS role
           FROM orchestration_attempts a JOIN orchestration_steps s ON s.id = a.step_id
          WHERE a.worker_session_id = ?
         UNION
         SELECT st.orchestration_task_id AS card_id, 'scheduled_run' AS role
           FROM scheduled_task_runs r JOIN scheduled_tasks st ON st.id = r.task_id
          WHERE r.session_id = ? AND st.orchestration_task_id IS NOT NULL
         UNION
         SELECT orchestration_task_id AS card_id, 'group_chat' AS role
           FROM group_tasks WHERE source_session_id = ? AND orchestration_task_id IS NOT NULL
         UNION
         SELECT orchestration_task_id AS card_id, 'scheduled_home' AS role
           FROM scheduled_tasks WHERE cowork_session_id = ? AND orchestration_task_id IS NOT NULL
       ) ORDER BY card_id`,
      [sessionId, sessionId, sessionId, sessionId, sessionId],
    );
    return rows.map((row) => ({ cardId: String(row.card_id), role: String(row.role) }));
  }

  /**
   * Close a card: persist the conclusion on the ledger row and move `status`
   * through the state machine whitelist. Never writes `status` directly.
   */
  closeCard(input: TrackedCardCloseInput): TrackedCardCloseResult {
    const conclusion = input.conclusion?.trim();
    if (!conclusion) {
      return { ok: false, code: 'VALIDATION', error: 'A one-line closing conclusion is required.' };
    }
    if (input.by !== 'owner' && input.by !== 'twin') {
      return { ok: false, code: 'VALIDATION', error: "closeCard: 'by' must be 'owner' or 'twin'." };
    }
    const task = this.deps.orchestrationStore.getTask(input.taskId);
    if (!task) {
      return { ok: false, code: 'NOT_FOUND', error: `orchestration task ${input.taskId} not found` };
    }
    const targetStatus: OrchestrationTaskStatus = input.targetStatus === 'cancelled' ? 'cancelled' : 'completed';
    if (task.status !== targetStatus) {
      try {
        this.deps.orchestrationStore.updateTaskStatus(input.taskId, targetStatus);
      } catch (error) {
        return {
          ok: false,
          code: 'TRANSITION_NOT_ALLOWED',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    this.deps.db.run(
      'UPDATE orchestration_tasks SET closure_conclusion = ?, closure_by = ?, closure_at = ?, closure_pin_id = ? WHERE id = ?',
      [conclusion, input.by, new Date().toISOString(), input.pinId ?? null, input.taskId],
    );
    this.deps.saveDb();
    const card = this.buildSummary(input.taskId, Date.now());
    return card ? { ok: true, card } : { ok: false, code: 'NOT_FOUND', error: 'card vanished after close' };
  }

  private readClosure(taskId: string): TrackedCardDetail['closure'] {
    const row = this.getOne(
      'SELECT closure_conclusion, closure_by, closure_at, closure_pin_id FROM orchestration_tasks WHERE id = ?',
      [taskId],
    );
    return {
      conclusion: text(row?.closure_conclusion),
      by: text(row?.closure_by),
      at: text(row?.closure_at),
      pinId: text(row?.closure_pin_id),
    };
  }

  private buildSummary(taskId: string, nowMs: number): TrackedCardSummary | null {
    const task = this.deps.orchestrationStore.getTask(taskId);
    if (!task) return null;
    const steps = this.deps.orchestrationStore.listSteps(taskId);
    const attempts = steps.flatMap((step) => this.deps.orchestrationStore.listAttempts(step.id));
    const groupTask = this.getOne(
      'SELECT id, status, source_session_id, updated_at, last_driven_at FROM group_tasks WHERE orchestration_task_id = ? ORDER BY id ASC LIMIT 1',
      [taskId],
    );
    const groupTaskId = groupTask ? Number(groupTask.id) : null;
    const scheduled = this.getOne(
      'SELECT id, enabled, next_run_at_ms, running_at_ms, cowork_session_id, updated_at FROM scheduled_tasks WHERE orchestration_task_id = ? ORDER BY id ASC LIMIT 1',
      [taskId],
    );
    const scheduledTaskId = scheduled ? String(scheduled.id) : null;

    const openCheckpointCount = groupTaskId === null
      ? 0
      : Number(this.getOne(
        "SELECT COUNT(*) AS n FROM group_task_checkpoints WHERE task_id = ? AND status = 'open'",
        [groupTaskId],
      )?.n ?? 0);
    const verifiableDeliverableCount = groupTaskId === null
      ? 0
      : Number(this.getOne(
        "SELECT COUNT(*) AS n FROM group_task_deliverables WHERE task_id = ? AND status IN ('delivered','accepted') AND uri IS NOT NULL AND uri <> ''",
        [groupTaskId],
      )?.n ?? 0);

    const scheduledRuns = scheduledTaskId === null
      ? []
      : this.getAll(
        'SELECT started_at, finished_at FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 5',
        [scheduledTaskId],
      );
    const sessions = this.listCardSessions(taskId);
    const sessionStatuses = this.getAll(
      `SELECT status FROM cowork_sessions WHERE id IN (${sessions.map(() => '?').join(',') || "''"})`,
      sessions.map((link) => link.sessionId),
    ).map((row) => String(row.status));

    const derivation = deriveCardState({
      task,
      steps,
      attempts,
      openCheckpointCount,
      verifiableDeliverableCount,
      closureConclusion: this.readClosure(taskId).conclusion,
      scheduled: scheduled
        ? {
          enabled: Number(scheduled.enabled) === 1,
          nextRunAtMs: scheduled.next_run_at_ms === null || scheduled.next_run_at_ms === undefined
            ? null
            : Number(scheduled.next_run_at_ms),
          running: scheduled.running_at_ms !== null && scheduled.running_at_ms !== undefined,
        }
        : null,
      sessionStatuses,
      activityAtMs: [
        epochMs(task.updatedAt),
        ...steps.map((step) => epochMs(step.updatedAt)),
        ...attempts.flatMap((attempt) => [
          epochMs(attempt.finishedAt),
          epochMs(attempt.startedAt),
          epochMs(attempt.queuedAt),
        ]),
        epochMs(groupTask?.updated_at),
        epochMs(groupTask?.last_driven_at),
        epochMs(scheduled?.updated_at),
        ...scheduledRuns.flatMap((row) => [epochMs(row.finished_at), epochMs(row.started_at)]),
      ],
      nowMs,
    });

    const sourceKind: TrackedCardSourceKind = groupTaskId !== null
      ? 'group_task'
      : scheduledTaskId !== null
        ? 'scheduled_task'
        : 'session';

    return {
      id: task.id,
      title: task.ownerIntent,
      goal: task.enrichedGoal ?? task.ownerIntent,
      state: derivation.cardState,
      stateLabelKey: TRACKED_CARD_STATE_LABEL_KEY[derivation.cardState],
      ledgerStatus: task.status,
      closureWarn: derivation.closureWarn,
      closureDue: derivation.closureDue,
      closureSuggestion: derivation.closureSuggestion,
      closureConclusion: this.readClosure(taskId).conclusion,
      lastActivityAtMs: derivation.lastActivityAtMs,
      idleMs: derivation.idleMs,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sourceSessionId: task.sourceSessionId,
      sourceKind,
      groupTaskId,
      scheduledTaskId,
      needsOwnerAction: derivation.cardState === 'waiting_decision' || derivation.closureDue,
      actionRank: derivation.cardState === 'waiting_decision'
        ? 0
        : derivation.closureDue
          ? 1
          : derivation.cardState === 'blocked_external'
            ? 2
            : derivation.cardState === 'in_progress'
              ? 3
              : 4,
      reasons: derivation.reasons,
    };
  }
}
