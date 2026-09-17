import type { SqliteDatabase as Database } from '../sqliteTypes';
import { extractPinidToken, validateDeliverableLines } from './groupTaskDeliverableParser';
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
 * Contract source: 《IDBots 长期任务看板 v1 · 架构契约 v1.3（冻结版）》
 * pin://9d5feb452dad05b11714f8919d60bec316d87f10ce779b5cfe73a6ee91ea888fi0
 * (`[SEC-04]`..`[SEC-10]`), plus the chair's rulings.
 *
 * Hard rules this module obeys:
 *  - One ledger, no fourth table, `status` CHECK domain untouched.
 *  - **Storage holds facts (inputs) only; every derived value is computed at
 *    read time.** `cardState`, `closureDue`, `closureSuggestion` and
 *    `activityAtMs` are never persisted.
 *  - `deriveCardState` is a pure function: all inputs come from the ledger and
 *    `nowMs` is injected, so a third party recomputes the same verdict.
 *  - Daemon liveness lives in the existing `kv` table (`tracking_tick_beat`)
 *    and NEVER in a card row. Writing a heartbeat must not touch `updated_at`,
 *    or the >2 day zombie rule could never fire.
 */

/** Idle thresholds (contract `[SEC-07]`). Judgement uses strict greater-than. */
export const TRACKED_CARD_WARN_MS = 86_400_000; // 1 day
export const TRACKED_CARD_ZOMBIE_MS = 172_800_000; // 2 days

/** Default board scope: recent activity, plus every closureDue card (`[SEC-09]` D3). */
export const TRACKED_CARD_SCOPE_WINDOW_MS = 7 * 86_400_000;

/** Drawer summary is hard-truncated server-side to this many lines (`[SEC-09]`). */
export const TRACKED_CARD_REASON_LIMIT = 5;

export type TrackedCardState = 'waiting_decision' | 'in_progress' | 'blocked_external' | 'closed';

/** Mutual-exclusion priority (contract `[SEC-06]`); NOT the display order. */
export const TRACKED_CARD_STATE_ORDER: TrackedCardState[] = [
  'waiting_decision',
  'in_progress',
  'blocked_external',
  'closed',
];

/**
 * Renderer-side i18n keys. UI copy stays in the renderer (AGENTS.md: UI copy is
 * English by default and lives in i18n), so the main process never carries a
 * second copy of the labels.
 */
export const TRACKED_CARD_STATE_LABEL_KEY: Record<TrackedCardState, string> = {
  waiting_decision: 'trackedTask.column.waitingDecision',
  in_progress: 'trackedTask.column.inProgress',
  blocked_external: 'trackedTask.column.blockedExternal',
  closed: 'trackedTask.column.closed',
};

/**
 * Three separate closureDue levels, never merged (contract `[SEC-07]` + appendix
 * A-2). Fixed priority: `terminal_no_conclusion` > `zombie` > `sessions_ended`.
 * Each level is readable on its own, and `closureDue === true` iff any is set.
 */
export type TrackedClosureDueLevel = 'zombie' | 'terminal_no_conclusion' | 'sessions_ended';

/**
 * Structured facts, not UI copy (appendix B / A-6). The backend publishes a
 * closed `code` plus `args`; the renderer renders the human string from
 * `code + args` through i18n. The English `reasons` / `closureSuggestion`
 * strings are DIAGNOSTIC ONLY (logs, event stream) and must never be rendered
 * in the UI.
 */
export type TrackedReasonCode =
  | 'ledger_review'
  | 'steps_waiting_input'
  | 'open_checkpoints'
  | 'blocked_unmet_dependencies'
  | 'steps_active'
  | 'attempts_open'
  | 'deliverables_verifiable'
  | 'terminal_without_conclusion'
  | 'idle_days'
  | 'linked_sessions';

export type TrackedSuggestionCode =
  | 'terminal_no_conclusion'
  | 'deliverables_verifiable'
  | 'unresolved_dependencies'
  | 'session_ended'
  | 'stale_inactivity';

export type TrackedFactCode = TrackedReasonCode | TrackedSuggestionCode;

/**
 * i18n key per code — a PER-CODE index, NOT the renderer's key table.
 *
 * `deliverables_verifiable` exists on BOTH the reason side and the suggestion
 * side, and those two render from DIFFERENT keys. A per-code map therefore
 * cannot express the renderer's needs (E-6): the renderer resolves keys
 * per (side, code) via `TRACKED_REASON_I18N_KEY` / `TRACKED_SUGGESTION_I18N_KEY`
 * below. Keep this index for code discovery only; do not treat it as complete.
 */
export const TRACKED_FACT_CODE_I18N_KEY: Record<TrackedFactCode, string> = {
  ledger_review: 'trackedTask.reason.ledgerReview',
  steps_waiting_input: 'trackedTask.reason.stepsWaitingInput',
  open_checkpoints: 'trackedTask.reason.openCheckpoints',
  blocked_unmet_dependencies: 'trackedTask.reason.blockedUnmetDependencies',
  steps_active: 'trackedTask.reason.stepsActive',
  attempts_open: 'trackedTask.reason.attemptsOpen',
  deliverables_verifiable: 'trackedTask.reason.deliverablesVerifiable',
  terminal_without_conclusion: 'trackedTask.reason.terminalWithoutConclusion',
  idle_days: 'trackedTask.reason.idleDays',
  linked_sessions: 'trackedTask.reason.linkedSessions',
  terminal_no_conclusion: 'trackedTask.suggestion.terminalNoConclusion',
  unresolved_dependencies: 'trackedTask.suggestion.unresolvedDependencies',
  session_ended: 'trackedTask.suggestion.sessionEnded',
  stale_inactivity: 'trackedTask.suggestion.staleInactivity',
};

/**
 * The renderer's actual key table, resolved per (side, code) — 10 reason keys +
 * 5 suggestion keys = 15 distinct keys, independent of how many codes exist.
 */
export const TRACKED_REASON_I18N_KEY: Record<TrackedReasonCode, string> = {
  ledger_review: 'trackedTask.reason.ledgerReview',
  steps_waiting_input: 'trackedTask.reason.stepsWaitingInput',
  open_checkpoints: 'trackedTask.reason.openCheckpoints',
  blocked_unmet_dependencies: 'trackedTask.reason.blockedUnmetDependencies',
  steps_active: 'trackedTask.reason.stepsActive',
  attempts_open: 'trackedTask.reason.attemptsOpen',
  deliverables_verifiable: 'trackedTask.reason.deliverablesVerifiable',
  terminal_without_conclusion: 'trackedTask.reason.terminalWithoutConclusion',
  idle_days: 'trackedTask.reason.idleDays',
  linked_sessions: 'trackedTask.reason.linkedSessions',
};

export const TRACKED_SUGGESTION_I18N_KEY: Record<TrackedSuggestionCode, string> = {
  terminal_no_conclusion: 'trackedTask.suggestion.terminalNoConclusion',
  deliverables_verifiable: 'trackedTask.suggestion.deliverablesVerifiable',
  unresolved_dependencies: 'trackedTask.suggestion.unresolvedDependencies',
  session_ended: 'trackedTask.suggestion.sessionEnded',
  stale_inactivity: 'trackedTask.suggestion.staleInactivity',
};

export interface TrackedFact {
  code: TrackedFactCode;
  args: Record<string, string | number>;
}

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
  /** group_task_deliverables rows whose uri is verifiable (contract `[SEC-06]` R2). */
  verifiableDeliverableCount: number;
  /** Closing conclusion on the ledger row; NULL means the card is NOT closed. */
  closureConclusion: string | null;
  /** Linked scheduled task, when the card is attached to one. */
  scheduled: { enabled: boolean; nextRunAtMs: number | null; running: boolean } | null;
  /** Every linked session status, for the "session ended" rule. */
  sessionStatuses: string[];
  /**
   * All candidate activity timestamps in epoch ms. The daemon heartbeat is NOT
   * one of them (contract `[SEC-07]` R2 hard constraint).
   */
  activityAtMs: Array<number | null>;
  nowMs: number;
}

export interface TrackedCardDerivation {
  cardState: TrackedCardState;
  closureDue: boolean;
  closureWarn: boolean;
  closureDueLevel: TrackedClosureDueLevel | null;
  /** ENGLISH DIAGNOSTIC ONLY — never render this in the UI (appendix B). */
  closureSuggestion: string;
  closureSuggestionCode: TrackedSuggestionCode | null;
  closureSuggestionArgs: Record<string, string | number> | null;
  lastActivityAtMs: number | null;
  idleMs: number | null;
  /** ENGLISH DIAGNOSTIC ONLY — never render this in the UI (appendix B). */
  reasons: string[];
  /** Same length and order as `reasons`; this is what the renderer consumes. */
  reasonCodes: TrackedFact[];
  /** Lines dropped by the ≤5 hard truncation, surfaced as `…另有 N 条`. */
  reasonOverflow: number;
}

function formatDays(ms: number): string {
  return (ms / TRACKED_CARD_WARN_MS).toFixed(1);
}

/** Terminal ledger statuses (chair's unified rule). */
export function isTerminalStatus(status: OrchestrationTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** `closed` ⟺ a terminal status AND a non-empty conclusion (chair's unified rule). */
export function isClosedStatus(status: OrchestrationTaskStatus, conclusion: string | null): boolean {
  return isTerminalStatus(status) && Boolean(conclusion?.trim());
}

/** Pure derivation. No IO, no clock read — `nowMs` is an input. */
export function deriveCardState(input: TrackedCardDerivationInput): TrackedCardDerivation {
  const { task, steps, attempts, nowMs } = input;

  const completedStepIds = new Set(
    steps.filter((step) => step.status === 'completed').map((step) => step.id),
  );
  const unmetDependencySteps = steps.filter(
    (step) => step.status === 'blocked'
      && step.dependencyStepIds.some((dependencyId) => !completedStepIds.has(dependencyId)),
  );
  const waitingInputSteps = steps.filter((step) => step.status === 'waiting_input');
  const activeSteps = steps.filter(
    (step) => step.status === 'ready' || step.status === 'queued' || step.status === 'running',
  );
  const openAttempts = attempts.filter(
    (attempt) => attempt.status === 'queued' || attempt.status === 'running',
  );

  const activity = input.activityAtMs.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  const lastActivityAtMs = activity.length ? Math.max(...activity) : null;
  const idleMs = lastActivityAtMs === null ? null : Math.max(0, nowMs - lastActivityAtMs);

  const terminal = isTerminalStatus(task.status);
  const hasConclusion = Boolean(input.closureConclusion?.trim());
  const closed = terminal && hasConclusion;
  const terminalWithoutConclusion = terminal && !hasConclusion;

  function scheduledAwaitingExternal(): boolean {
    const scheduled = input.scheduled;
    if (!scheduled) return false;
    return scheduled.enabled && !scheduled.running && (scheduled.nextRunAtMs ?? 0) > nowMs;
  }

  let cardState: TrackedCardState;
  if (closed) {
    cardState = 'closed';
  } else if (
    input.openCheckpointCount > 0
    || waitingInputSteps.length > 0
    // `review` IS the ledger's "awaiting your decision" landing point (`[SEC-06]`).
    || task.status === 'review'
    || terminalWithoutConclusion
  ) {
    cardState = 'waiting_decision';
  } else if (unmetDependencySteps.length > 0 || scheduledAwaitingExternal()) {
    cardState = 'blocked_external';
  } else {
    cardState = 'in_progress';
  }

  // Strictly greater-than: exactly 24h/48h must NOT trip.
  const closureWarn = idleMs !== null && idleMs > TRACKED_CARD_WARN_MS;
  const zombie = idleMs !== null && idleMs > TRACKED_CARD_ZOMBIE_MS;
  const sessionsEnded =
    input.sessionStatuses.length > 0
    && input.sessionStatuses.every((status) => status === 'idle')
    && openAttempts.length === 0;

  const closureDue = (zombie && !closed) || terminalWithoutConclusion || (sessionsEnded && !closed);
  const closureDueLevel: TrackedClosureDueLevel | null = !closureDue
    ? null
    : terminalWithoutConclusion
      ? 'terminal_no_conclusion'
      : zombie && !closed
        ? 'zombie'
        : 'sessions_ended';

  const reasonEntries: Array<{ code: TrackedFactCode; args: Record<string, string | number>; text: string }> = [];
  if (task.status === 'review') {
    reasonEntries.push({
      code: 'ledger_review',
      args: {},
      text: 'ledger status=review, awaiting a decision',
    });
  }
  if (waitingInputSteps.length > 0) {
    reasonEntries.push({
      code: 'steps_waiting_input',
      args: { count: waitingInputSteps.length },
      text: `${waitingInputSteps.length} step(s) waiting_input`,
    });
  }
  if (input.openCheckpointCount > 0) {
    reasonEntries.push({
      code: 'open_checkpoints',
      args: { count: input.openCheckpointCount },
      text: `${input.openCheckpointCount} open group-task checkpoint(s)`,
    });
  }
  if (unmetDependencySteps.length > 0) {
    reasonEntries.push({
      code: 'blocked_unmet_dependencies',
      args: { count: unmetDependencySteps.length },
      text: `${unmetDependencySteps.length} blocked step(s) with unmet dependencies`,
    });
  }
  if (activeSteps.length > 0) {
    reasonEntries.push({
      code: 'steps_active',
      args: { count: activeSteps.length },
      text: `${activeSteps.length} step(s) ready/queued/running`,
    });
  }
  if (openAttempts.length > 0) {
    reasonEntries.push({
      code: 'attempts_open',
      args: { count: openAttempts.length },
      text: `${openAttempts.length} attempt(s) queued/running`,
    });
  }
  if (input.verifiableDeliverableCount > 0) {
    reasonEntries.push({
      code: 'deliverables_verifiable',
      args: { count: input.verifiableDeliverableCount },
      text: `${input.verifiableDeliverableCount} verifiable deliverable(s)`,
    });
  }
  if (terminalWithoutConclusion) {
    reasonEntries.push({
      code: 'terminal_without_conclusion',
      args: {},
      text: 'terminal status without a closing conclusion',
    });
  }
  if (idleMs !== null && closureWarn) {
    reasonEntries.push({
      code: 'idle_days',
      args: { days: idleMs / TRACKED_CARD_WARN_MS },
      text: `idle for ${formatDays(idleMs)} day(s)`,
    });
  }
  if (input.sessionStatuses.length > 0) {
    reasonEntries.push({
      code: 'linked_sessions',
      args: { count: input.sessionStatuses.length },
      text: `linked sessions: ${input.sessionStatuses.join(', ')}`,
    });
  }

  const keptReasons = reasonEntries.slice(0, TRACKED_CARD_REASON_LIMIT);
  const suggestion = pickClosureSuggestion({
    cardState,
    closureDue,
    closureDueLevel,
    terminal,
    hasConclusion,
    verifiableDeliverableCount: input.verifiableDeliverableCount,
    unmetDependencyCount: unmetDependencySteps.length,
    idleMs,
  });

  return {
    cardState,
    closureDue,
    closureWarn,
    closureDueLevel,
    // Derived from the structured facts below, never written twice by hand.
    closureSuggestion: suggestion ? renderTrackedSuggestion(suggestion.code, suggestion.args) : '',
    closureSuggestionCode: suggestion?.code ?? null,
    closureSuggestionArgs: suggestion?.args ?? null,
    lastActivityAtMs,
    idleMs,
    reasons: keptReasons.map((entry) => entry.text),
    reasonCodes: keptReasons.map((entry) => ({ code: entry.code, args: entry.args })),
    reasonOverflow: Math.max(0, reasonEntries.length - TRACKED_CARD_REASON_LIMIT),
  };
}


/**
 * The one renderer of the diagnostic string. `closureSuggestion` is always this
 * function applied to the structured facts, so the two can never drift.
 */
export function renderTrackedSuggestion(
  code: TrackedSuggestionCode,
  args: Record<string, string | number>,
): string {
  const days = typeof args.days === 'number' ? args.days.toFixed(1) : '0.0';
  switch (code) {
    case 'terminal_no_conclusion':
      return 'Reached a terminal status without a conclusion; add a one-line closing note.';
    case 'deliverables_verifiable':
      return `Deliverables are verifiable (${args.count}); close the card with a one-line conclusion.`;
    case 'unresolved_dependencies':
      return `Dependencies unresolved for ${days} day(s); reassign or cancel.`;
    case 'session_ended':
      return 'Every linked session has ended; close the card with a one-line conclusion.';
    case 'stale_inactivity':
      return `No activity for ${days} day(s); close it or redefine the acceptance criteria.`;
  }
}

function pickClosureSuggestion(input: {
  cardState: TrackedCardState;
  closureDue: boolean;
  closureDueLevel: TrackedClosureDueLevel | null;
  terminal: boolean;
  hasConclusion: boolean;
  verifiableDeliverableCount: number;
  unmetDependencyCount: number;
  idleMs: number | null;
}): { code: TrackedSuggestionCode; args: Record<string, string | number> } | null {
  // A suggestion exists exactly when the card is due for closure (A-6 rule 4).
  if (!input.closureDue || input.cardState === 'closed') return null;
  const days = input.idleMs === null ? 0 : input.idleMs / TRACKED_CARD_WARN_MS;
  if (input.terminal && !input.hasConclusion) return { code: 'terminal_no_conclusion', args: {} };
  if (input.verifiableDeliverableCount > 0) {
    return { code: 'deliverables_verifiable', args: { count: input.verifiableDeliverableCount } };
  }
  if (input.unmetDependencyCount > 0) return { code: 'unresolved_dependencies', args: { days } };
  if (input.closureDueLevel === 'sessions_ended') return { code: 'session_ended', args: {} };
  return { code: 'stale_inactivity', args: { days } };
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
  closureDueLevel: TrackedClosureDueLevel | null;
  /** ENGLISH DIAGNOSTIC ONLY — never render this in the UI (appendix B). */
  closureSuggestion: string;
  /** Structured facts for the renderer; `null` when nothing is due. */
  closureSuggestionCode: TrackedSuggestionCode | null;
  closureSuggestionArgs: Record<string, string | number> | null;
  closureConclusion: string | null;
  /** Computed activity anchor — never persisted, never fed by the daemon heartbeat. */
  activityAtMs: number | null;
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
  /** ENGLISH DIAGNOSTIC ONLY — never render this in the UI (appendix B). */
  reasons: string[];
  /** Same length and order as `reasons`; the renderer consumes this. */
  reasonCodes: TrackedFact[];
  reasonOverflow: number;
}

export interface TrackedCardCounts {
  total: number;
  visible: number;
  /** Folded away by the default scope; must stay reachable, never silently hidden. */
  folded: number;
  closureDue: number;
  /** Level 1: idle past the zombie threshold. */
  zombieLevel: number;
  /** Level 2: terminal status without a written conclusion. */
  terminalNoConclusionLevel: number;
  /** Level 3: every linked session ended and nothing is queued. */
  sessionsEndedLevel: number;
}

export interface TrackedCardBoard {
  ledger: 'orchestration_tasks';
  generatedAtMs: number;
  /** Echoed back so the UI can label the filter and offer a one-click clear. */
  scopeApplied: 'default' | 'all';
  scopeWindowMs: number;
  /** Monotonic per-process sequence for renderer-side event de-duplication. */
  seq: number;
  columns: Array<{ state: TrackedCardState; labelKey: string; cardIds: string[] }>;
  cards: TrackedCardSummary[];
  /**
   * PAGE scope, not the visible set: these two cover the current page only and
   * must never be rendered as a board-wide total or in a banner. For a
   * board-wide number read `counts.closureDue` / `counts.zombieLevel` /
   * `counts.terminalNoConclusionLevel` / `counts.sessionsEndedLevel`.
   */
  closureDueCardIdsPage: string[];
  closureDueCountPage: number;
  counts: TrackedCardCounts;
  /** True when more cards exist beyond `limit`/`offset`. */
  hasMore: boolean;
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
  participants: number[];
  sessions: TrackedCardSessionLink[];
  /**
   * `valid` is the verdict of the ONE parser (`validateDeliverableLines`) run
   * over the SOURCE message body, not a re-implementation. `null` means the
   * source body was not available — unknown, explicitly not "invalid".
   */
  deliverables: Array<{
    uri: string;
    status: string;
    confirmation: string;
    kind: string;
    valid: boolean | null;
    issues: string[];
    sourceMessageFound: boolean;
  }>;
  events: Array<{ at: string | null; kind: string; detail: string }>;
  closure: { conclusion: string | null; by: string | null; at: string | null; pinId: string | null };
}

export interface TrackedCardListInput {
  ownerGlobalMetaId?: string;
  /** `default` = recent activity ∪ every closureDue card; `all` = no folding. */
  scope?: 'default' | 'all';
  limit?: number;
  offset?: number;
}

export interface TrackedCardCloseInput {
  taskId: string;
  conclusion: string;
  by: 'owner' | 'twin';
  /** Only a hint: per the ledger whitelist the status may legitimately stay put. */
  targetStatus?: 'completed' | 'cancelled';
  pinId?: string | null;
}

export interface TrackedCardCloseResult {
  ok: boolean;
  code?: 'NOT_FOUND' | 'VALIDATION';
  error?: string;
  card?: TrackedCardSummary;
  /** Whether the ledger status actually moved. The conclusion is always written. */
  statusMoved?: boolean;
  statusNote?: string;
}

export interface TrackedScheduledAttachInput {
  scheduledTaskIds: string[];
  ownerGlobalMetaId: string;
  twinMetabotId: number;
}

export interface TrackedScheduledAttachResult {
  attached: Array<{ scheduledTaskId: string; cardId: string; reused: boolean }>;
  skipped: Array<{ scheduledTaskId: string; reason: string }>;
}

export interface TrackedUnattachedScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAtMs: number | null;
}

export interface TrackedSweepResult {
  assessed: number;
  closureDue: number;
  zombieLevel: number;
  terminalNoConclusionLevel: number;
  sessionsEndedLevel: number;
  beat: string;
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

/** kv key holding daemon liveness only — never any card state (`[SEC-07]`). */
export const TRACKED_TICK_BEAT_KV_KEY = 'tracking_tick_beat';

/** List-view rank (contract `[SEC-09]`); ties break on `activityAt` ascending. */
export function trackedCardActionRank(card: {
  state: TrackedCardState;
  closureDue: boolean;
}): number {
  if (card.closureDue && card.state !== 'closed') return 0;
  if (card.state === 'waiting_decision') return 1;
  if (card.state === 'blocked_external') return 2;
  if (card.state === 'in_progress') return 3;
  return 4;
}

export interface TrackedTaskBoardDeps {
  db: Database;
  orchestrationStore: OrchestrationStore;
  saveDb: () => void;
  instanceId?: string;
}

export class TrackedTaskBoardService {
  private seq = 0;

  constructor(private readonly deps: TrackedTaskBoardDeps) {}

  private getAll(sql: string, params: unknown[] = []): Row[] {
    return rowList(this.deps.db.exec(sql, params));
  }

  private getOne(sql: string, params: unknown[] = []): Row | null {
    return this.getAll(sql, params)[0] ?? null;
  }

  /** Monotonic sequence for renderer-side de-duplication; never persisted. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  listCards(input: TrackedCardListInput = {}): TrackedCardBoard {
    const nowMs = Date.now();
    const scope: 'default' | 'all' = input.scope === 'all' ? 'all' : 'default';
    const rows = input.ownerGlobalMetaId
      ? this.getAll(
        'SELECT id FROM orchestration_tasks WHERE owner_global_meta_id = ? ORDER BY updated_at DESC',
        [input.ownerGlobalMetaId],
      )
      : this.getAll('SELECT id FROM orchestration_tasks ORDER BY updated_at DESC');

    const all = rows
      .map((row) => this.buildSummary(String(row.id), nowMs))
      .filter((card): card is TrackedCardSummary => card !== null);

    const visible = scope === 'all'
      ? all
      : all.filter((card) => card.closureDue || isInsideScopeWindow(card, nowMs));
    const folded = all.length - visible.length;

    const sorted = [...visible].sort((a, b) => {
      const byRank = a.actionRank - b.actionRank;
      if (byRank !== 0) return byRank;
      // Same weight: earlier activity first (`[SEC-09]`).
      const aAt = a.activityAtMs ?? Number.MAX_SAFE_INTEGER;
      const bAt = b.activityAtMs ?? Number.MAX_SAFE_INTEGER;
      if (aAt !== bAt) return aAt - bAt;
      return a.id.localeCompare(b.id);
    });

    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : null;
    const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 0;
    const page = sorted.slice(offset, limit === null ? undefined : offset + limit);

    return {
      ledger: 'orchestration_tasks',
      generatedAtMs: nowMs,
      scopeApplied: scope,
      scopeWindowMs: TRACKED_CARD_SCOPE_WINDOW_MS,
      seq: this.nextSeq(),
      columns: TRACKED_CARD_STATE_ORDER.map((state) => ({
        state,
        labelKey: TRACKED_CARD_STATE_LABEL_KEY[state],
        cardIds: page.filter((card) => card.state === state).map((card) => card.id),
      })),
      cards: page,
      closureDueCardIdsPage: page.filter((card) => card.closureDue).map((card) => card.id),
      closureDueCountPage: page.filter((card) => card.closureDue).length,
      counts: {
        total: all.length,
        visible: sorted.length,
        folded,
        closureDue: sorted.filter((card) => card.closureDue).length,
        zombieLevel: sorted.filter((card) => card.closureDueLevel === 'zombie').length,
        terminalNoConclusionLevel: sorted.filter(
          (card) => card.closureDueLevel === 'terminal_no_conclusion',
        ).length,
        sessionsEndedLevel: sorted.filter((card) => card.closureDueLevel === 'sessions_ended').length,
      },
      hasMore: limit !== null && offset + limit < sorted.length,
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
        `SELECT d.uri, d.status, d.confirmation, d.msg_pin_id, m.content AS source_content
           FROM group_task_deliverables d
           LEFT JOIN group_chat_messages m ON m.pin_id = d.msg_pin_id
          WHERE d.task_id = ?
          ORDER BY d.id ASC`,
        [groupTaskId],
      );
    const memberRows = groupTaskId === null
      ? []
      : this.getAll('SELECT metabot_id FROM group_task_members WHERE task_id = ?', [groupTaskId]);

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

    const participants = new Set<number>();
    participants.add(task.twinMetabotId);
    for (const step of steps) if (step.assigneeMetabotId !== null) participants.add(step.assigneeMetabotId);
    for (const row of memberRows) {
      const id = Number(row.metabot_id);
      if (!Number.isNaN(id)) participants.add(id);
    }

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
      participants: [...participants].sort((a, b) => a - b),
      sessions: this.listCardSessions(taskId),
      deliverables: deliverables.map((row) => {
        const uri = String(row.uri ?? '');
        const source = text(row.source_content);
        // Kind comes from the ONE parser, never a second URI regex.
        const kind = trackedDeliverableKind(uri);
        let valid: boolean | null = null;
        let issues: string[] = [];
        if (source !== null) {
          const verdict = validateDeliverableLines(source);
          const matching = verdict.candidates.find((candidate) => candidate.uri === uri);
          if (matching) {
            valid = matching.valid === true;
            if (!valid) issues = [matching.note ?? 'invalid deliverable format'];
          } else {
            // The source body was available but carries no candidate for this
            // uri: the row and the parser disagree. Report it, do not guess.
            valid = false;
            issues = ['no [DELIVERABLE] candidate in the source message matches this uri'];
          }
        }
        return {
          uri,
          status: String(row.status ?? ''),
          confirmation: String(row.confirmation ?? ''),
          kind,
          valid,
          issues,
          sourceMessageFound: source !== null,
        };
      }),
      events,
      closure: this.readClosure(taskId),
    };
  }

  /**
   * Card -> every linked session. Five sources from the ledger, no mapping
   * table (`[SEC-08]`). S4 keeps the full group-chat predicate on
   * `cowork_sessions.session_type = 'group_task'`; that column is added by
   * `coworkStore.ensureMemorySchemaCompatibility()` (coworkStore.ts:1231), not
   * by sqliteStore's DDL — reading sqliteStore alone makes it look absent.
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
         SELECT cs.id AS session_id, 'group_chat' AS role
           FROM group_tasks gt JOIN cowork_sessions cs ON cs.id = gt.source_session_id
          WHERE gt.orchestration_task_id = ? AND cs.session_type = 'group_task'
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
         SELECT gt.orchestration_task_id AS card_id, 'group_chat' AS role
           FROM group_tasks gt JOIN cowork_sessions cs ON cs.id = gt.source_session_id
          WHERE gt.source_session_id = ? AND gt.orchestration_task_id IS NOT NULL
            AND cs.session_type = 'group_task'
         UNION
         SELECT orchestration_task_id AS card_id, 'scheduled_home' AS role
           FROM scheduled_tasks WHERE cowork_session_id = ? AND orchestration_task_id IS NOT NULL
       ) ORDER BY card_id`,
      [sessionId, sessionId, sessionId, sessionId, sessionId],
    );
    return rows.map((row) => ({ cardId: String(row.card_id), role: String(row.role) }));
  }

  /**
   * Close a card (`[SEC-10]`), two-stage per the chair's F1 ruling:
   *  1. always write the four closure columns;
   *  2. move `status` ONLY when the ledger whitelist allows it — otherwise the
   *     conclusion still closes the card through the terminal-status rule and
   *     the status legitimately stays put (e.g. a `failed` card).
   * `status` is never written directly: the move goes through
   * `orchestrationStore.updateTaskStatus` and its TASK_TRANSITIONS whitelist.
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

    let statusMoved = false;
    let statusNote = 'ledger status is already terminal; the conclusion alone closes the card.';
    if (!isTerminalStatus(task.status)) {
      const targetStatus: OrchestrationTaskStatus = input.targetStatus === 'cancelled' ? 'cancelled' : 'completed';
      try {
        this.deps.orchestrationStore.updateTaskStatus(input.taskId, targetStatus);
        statusMoved = true;
        statusNote = `ledger status ${task.status} -> ${targetStatus}`;
      } catch (error) {
        statusNote = `ledger transition refused (${error instanceof Error ? error.message : String(error)}); `
          + 'the conclusion is still recorded.';
      }
    }

    this.deps.db.run(
      'UPDATE orchestration_tasks SET closure_conclusion = ?, closure_by = ?, closure_at = ?, closure_pin_id = ? WHERE id = ?',
      [conclusion, input.by, new Date().toISOString(), input.pinId ?? null, input.taskId],
    );
    this.deps.saveDb();
    const card = this.buildSummary(input.taskId, Date.now());
    return card
      ? { ok: true, card, statusMoved, statusNote }
      : { ok: false, code: 'NOT_FOUND', error: 'card vanished after close' };
  }

  /** Daemon liveness only; carries no card state (`[SEC-07]`). */
  recordTickBeat(atMs = Date.now()): { key: string; value: string } {
    const instanceId = this.deps.instanceId ?? 'local';
    const value = `${instanceId}|${atMs}`;
    this.deps.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [TRACKED_TICK_BEAT_KV_KEY, value, atMs],
    );
    this.deps.saveDb();
    return { key: TRACKED_TICK_BEAT_KV_KEY, value };
  }

  readTickBeat(): string | null {
    return text(this.getOne('SELECT value FROM kv WHERE key = ?', [TRACKED_TICK_BEAT_KV_KEY])?.value);
  }

  /**
   * Scheduled tasks that are not on a card yet — the D2 batch-confirm list.
   * Historical rows are NEVER backfilled automatically; the owner confirms.
   */
  listUnattachedScheduledTasks(): TrackedUnattachedScheduledTask[] {
    return this.getAll(
      `SELECT id, name, enabled, next_run_at_ms FROM scheduled_tasks
        WHERE orchestration_task_id IS NULL
          AND ('scheduled-task:' || id) NOT IN (
            SELECT source_session_id FROM orchestration_tasks
             WHERE source_session_id IS NOT NULL
          )
        ORDER BY name ASC`,
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      enabled: Number(row.enabled) === 1,
      nextRunAtMs: row.next_run_at_ms === null || row.next_run_at_ms === undefined
        ? null
        : Number(row.next_run_at_ms),
    }));
  }

  /**
   * Attach the explicitly confirmed scheduled tasks to cards (D2). Idempotent
   * on `source_session_id = 'scheduled-task:<id>'`; re-running never creates a
   * second card, and nothing is attached unless it was named here.
   */
  attachScheduledTasks(input: TrackedScheduledAttachInput): TrackedScheduledAttachResult {
    const result: TrackedScheduledAttachResult = { attached: [], skipped: [] };
    const ownerGlobalMetaId = input.ownerGlobalMetaId?.trim();
    if (!ownerGlobalMetaId) {
      return { attached: [], skipped: (input.scheduledTaskIds ?? []).map((id) => ({
        scheduledTaskId: id,
        reason: 'no owner GlobalMetaID is bound to this host',
      })) };
    }
    for (const scheduledTaskId of input.scheduledTaskIds ?? []) {
      const scheduled = this.getOne('SELECT id, name, orchestration_task_id FROM scheduled_tasks WHERE id = ?', [
        scheduledTaskId,
      ]);
      if (!scheduled) {
        result.skipped.push({ scheduledTaskId, reason: 'scheduled task not found' });
        continue;
      }
      const anchor = `scheduled-task:${scheduledTaskId}`;
      let card = this.deps.orchestrationStore.getTaskBySourceSessionId(anchor);
      const boundCardId = text(scheduled.orchestration_task_id);
      if (!card && boundCardId) card = this.deps.orchestrationStore.getTask(boundCardId);
      if (card) {
        if (boundCardId !== card.id) {
          this.deps.db.run('UPDATE scheduled_tasks SET orchestration_task_id = ? WHERE id = ?', [card.id, scheduledTaskId]);
          this.deps.saveDb();
        }
        result.attached.push({ scheduledTaskId, cardId: card.id, reused: true });
        continue;
      }
      const created = this.deps.orchestrationStore.createTask({
        ownerIntent: String(scheduled.name ?? scheduledTaskId),
        enrichedGoal: null,
        acceptanceCriteria: [],
        sourceSessionId: anchor,
        twinMetabotId: input.twinMetabotId,
        ownerGlobalMetaId,
      });
      this.deps.db.run('UPDATE scheduled_tasks SET orchestration_task_id = ? WHERE id = ?', [created.id, scheduledTaskId]);
      this.deps.saveDb();
      result.attached.push({ scheduledTaskId, cardId: created.id, reused: false });
    }
    return result;
  }

  /**
   * Zombie sweep: read-only assessment plus the tick beat. Deliberately writes
   * no card row, no `status`, and never touches `group_tasks`.
   */
  sweep(atMs = Date.now()): TrackedSweepResult {
    const cards = this.listCards({ scope: 'all' }).cards;
    const beat = this.recordTickBeat(atMs).value;
    return {
      assessed: cards.length,
      closureDue: cards.filter((card) => card.closureDue).length,
      zombieLevel: cards.filter((card) => card.closureDueLevel === 'zombie').length,
      terminalNoConclusionLevel: cards.filter(
        (card) => card.closureDueLevel === 'terminal_no_conclusion',
      ).length,
      sessionsEndedLevel: cards.filter((card) => card.closureDueLevel === 'sessions_ended').length,
      beat,
    };
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
    const closure = this.readClosure(taskId);

    const derivation = deriveCardState({
      task,
      steps,
      attempts,
      openCheckpointCount,
      verifiableDeliverableCount,
      closureConclusion: closure.conclusion,
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
      // The daemon heartbeat (kv `tracking_tick_beat`) is intentionally absent:
      // it is liveness of the process, not activity of the card.
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
      closureDueLevel: derivation.closureDueLevel,
      closureSuggestion: derivation.closureSuggestion,
      closureSuggestionCode: derivation.closureSuggestionCode,
      closureSuggestionArgs: derivation.closureSuggestionArgs,
      closureConclusion: closure.conclusion,
      activityAtMs: derivation.lastActivityAtMs,
      lastActivityAtMs: derivation.lastActivityAtMs,
      idleMs: derivation.idleMs,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sourceSessionId: task.sourceSessionId,
      sourceKind,
      groupTaskId,
      scheduledTaskId,
      needsOwnerAction: derivation.cardState === 'waiting_decision' || derivation.closureDue,
      actionRank: trackedCardActionRank({
        state: derivation.cardState,
        closureDue: derivation.closureDue,
      }),
      reasons: derivation.reasons,
      reasonCodes: derivation.reasonCodes,
      reasonOverflow: derivation.reasonOverflow,
    };
  }
}

/** Deliverable kind, delegated to the single parser (`[SEC-11]`). */
export function trackedDeliverableKind(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return 'none';
  if (extractPinidToken(trimmed)) return trimmed.startsWith('metafile://') ? 'metafile' : 'pin';
  if (trimmed.startsWith('metaapp://')) return 'metaapp';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url';
  return 'other';
}

function isInsideScopeWindow(card: TrackedCardSummary, nowMs: number): boolean {
  if (card.activityAtMs === null) return true; // unknown activity is never silently hidden
  return nowMs - card.activityAtMs <= TRACKED_CARD_SCOPE_WINDOW_MS;
}
