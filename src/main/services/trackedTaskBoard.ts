import { createHash } from 'crypto';
import type { SqliteDatabase as Database } from '../sqliteTypes';
// Type-only: erased at compile time, so the board never creates a runtime
// dependency on the group-task bridge (owner ruling C).
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
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
 * (`[SEC-04]`..`[SEC-10]`), plus the chair's rulings; v1.1 additions follow
 * 《长期任务看板 v1.1 · 口径冻结件 v1.0》
 * pin://4d633cb0b84843bcdc27727339654dbedb34ff488de84f867b2b1073c8127e1fi0
 * (§2 admission, §4 closureDue, §5 sessions_ended, §6 archive).
 *
 * Hard rules this module obeys:
 *  - One ledger, no fourth table, `status` CHECK domain untouched, zero DDL.
 *  - **Storage holds facts (inputs) only; every derived value is computed at
 *    read time.** `cardState`, `closureDue`, `closureSuggestion`, `activityAtMs`
 *    and v1.1's `admitted` / `archived` are never persisted — the archive is a
 *    projection (`archived := ¬admitted`), not a column. The single v1.3
 *    exception is a manual archive OVERRIDE as one `kv` row
 *    (`tracked_card_archive_override`): reversible, no DDL, it only shifts the
 *    projection (`admitted := admitted ∧ ¬override`), never the ledger.
 *  - `deriveCardState` and `trackAdmission` are pure functions: all inputs come
 *    from the ledger and its linked tables, `nowMs` is injected, so a third
 *    party recomputes the same verdict.
 *  - `admitted` is a NECESSARY condition of `closureDue`: the whole delegation
 *    ledger may not be projected into "needs closure".
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
 * Admission (v1.1, freeze doc §2). `admitted` is a NECESSARY condition of
 * `closureDue`: a row that does not qualify is archived, never queued for
 * closure. Like every other derived value it is computed at read time and never
 * persisted (I-2), and the judgement itself is a pure function so a third party
 * re-derives it from the same rows (I-4).
 */
export const TRACKED_LONG_TASK_REGISTRY_KV_KEY = 'tracked_long_task_registry';

/** `wide` (default) = ADM-1 ∨ ADM-2 ∨ ADM-3 ∨ ADM-4 ∨ ADM-5; `strict` = ADM-1 ∨ ADM-3. */
export const TRACKED_ADMISSION_MODE_KV_KEY = 'tracked_admission_mode';

/**
 * v1.3 manual archive override (owner ruling 2026-09-18): ONE `kv` row shaped
 * `{ [cardId]: archivedAtIso }`. No new column, no new table, reversible by
 * writing `archived:false` — the same pattern as `tracked_admission_mode`. It
 * is the second sanctioned card-level kv carrier next to the v1.1 registry.
 * The override only ever pushes a card INTO the archive: the projection below
 * computes `admitted := admitted ∧ ¬override` and `archived := ¬admitted`, so
 * `admitted + archived === total` keeps holding and an override-archived card
 * can never queue for closure (freeze doc §4: `admitted` is a NECESSARY
 * condition of `closureDue`).
 */
export const TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY = 'tracked_card_archive_override';

/** Malformed JSON reads as an empty override set, never a throw (registry rule). */
export function parseArchiveOverrides(raw: string | null): Record<string, string> {
  const asText = raw?.trim();
  if (!asText) return {};
  try {
    const parsed = JSON.parse(asText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const overrides: Record<string, string> = {};
    for (const [cardId, archivedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (cardId !== '' && typeof archivedAt === 'string') overrides[cardId] = archivedAt;
    }
    return overrides;
  } catch {
    return {};
  }
}

export const TRACKED_ADMISSION_MODES = ['wide', 'strict'] as const;

export type TrackedAdmissionMode = (typeof TRACKED_ADMISSION_MODES)[number];

export type TrackedAdmissionRule = 'ADM-1' | 'ADM-2' | 'ADM-3' | 'ADM-4' | 'ADM-5';

export interface TrackedAdmissionInput {
  /** ADM-1: the id is listed in the `tracked_long_task_registry` kv entry. */
  registered: boolean;
  /** ADM-2: `count(orchestration_steps)`; the rule is strictly greater than 1. */
  stepCount: number;
  /** ADM-3 first branch: a group_tasks row points at this card. */
  groupTaskLinked: boolean;
  /** ADM-3 second branch: a scheduled_tasks row points at this card. */
  scheduledTaskLinked: boolean;
  /** ADM-4 first branch: some step carries a non-empty dependency list. */
  hasDependencies: boolean;
  /** ADM-4 second branch: a linked group task carries checkpoint rows. */
  hasCheckpoints: boolean;
  /** ADM-5: a linked group task was created by the owner (`created_by='user'`). */
  ownerInitiated: boolean;
  mode: TrackedAdmissionMode;
}

export interface TrackedAdmissionVerdict {
  admitted: boolean;
  mode: TrackedAdmissionMode;
  /** Every rule that matched, in ADM-1..ADM-5 order. Empty means archived. */
  matched: TrackedAdmissionRule[];
}

/** The exact rules the freeze doc pins; the mode switch never changes storage. */
export function trackAdmission(input: TrackedAdmissionInput): TrackedAdmissionVerdict {
  const matched: TrackedAdmissionRule[] = [];
  if (input.registered) matched.push('ADM-1');
  const attached = input.groupTaskLinked || input.scheduledTaskLinked;
  if (input.mode === 'strict') {
    // Strict = ADM-1 ∨ ADM-3 — the long-lived shapes only.
    if (attached) matched.push('ADM-3');
    return { admitted: matched.length > 0, mode: input.mode, matched };
  }
  if (input.stepCount > 1) matched.push('ADM-2');
  if (attached) matched.push('ADM-3');
  if (input.hasDependencies || input.hasCheckpoints) matched.push('ADM-4');
  if (input.ownerInitiated) matched.push('ADM-5');
  return { admitted: matched.length > 0, mode: input.mode, matched };
}

/** Exact string equality, per the freeze doc; malformed JSON is an empty set, never a throw. */
export function parseLongTaskRegistry(raw: string | null): string[] {
  const asText = raw?.trim();
  if (!asText) return [];
  try {
    const parsed = JSON.parse(asText);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  } catch {
    return [];
  }
}

/** Anything that is not exactly `strict` reads as the `wide` default. */
export function resolveAdmissionMode(raw: string | null): TrackedAdmissionMode {
  return raw?.trim() === 'strict' ? 'strict' : 'wide';
}

/**
 * Three separate closureDue levels, never merged (contract `[SEC-07]` + appendix
 * A-2). Fixed priority: `terminal_no_conclusion` > `zombie` > `sessions_ended`.
 * Each level is readable on its own, and `closureDue === true` iff any is set.
 */
export type TrackedClosureDueLevel = 'zombie' | 'terminal_no_conclusion' | 'sessions_ended';

/**
 * Structured facts, not UI copy (appendix B / A-6). The backend publishes a
 * closed `code` plus `params`; the renderer renders the human string from
 * `code + params` through i18n. The English `reasons` / `closureSuggestion`
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
  params: Record<string, string | number>;
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
  /** Closing conclusion on the ledger row; NULL means no instruction text. */
  closureConclusion: string | null;
  /**
   * v1.4: the closure timestamp (closure_at). A non-null value means a human
   * acceptance was RECORDED — this, not the conclusion text, is what makes a
   * card closed. Backward compatible: every historical writer set closure_at
   * together with the conclusion in the same UPDATE.
   */
  closureAt: string | null;
  /**
   * v1.1: `trackAdmission(...).admitted`. A NECESSARY condition of
   * `closureDue` — an unadmitted row is archived and never queued for closure
   * (freeze doc §4). Supplied by the caller, never read from storage.
   */
  admitted: boolean;
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
  /**
   * True when `admitted` arrived as a non-boolean (e.g. a caller that forgot it).
   * The derivation still fails closed to `closureDue: false`, but the miss is
   * REPORTED rather than swallowed: a future caller that bypasses
   * `trackAdmission` would otherwise silently stop queueing anything.
   */
  admissionInputMissing: boolean;
  closureDue: boolean;
  closureWarn: boolean;
  closureDueLevel: TrackedClosureDueLevel | null;
  /** ENGLISH DIAGNOSTIC ONLY — never render this in the UI (appendix B). */
  closureSuggestion: string;
  closureSuggestionCode: TrackedSuggestionCode | null;
  closureSuggestionParams: Record<string, string | number> | null;
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

/* ------------------------------------------------------------------------- *
 * v1.2 (task #86 / owner ruling B): the closing conclusion is an INSTRUCTION.
 *
 * The card row carries both halves of a two-state cursor — the conclusion and
 * its processing mark — so "still pending" is DERIVED at read time and the
 * queue can never drift from the ledger. A read has no side effects; the write
 * is ONE CAS statement. `closureDue` (this card needs closing) and
 * `closurePending` (this conclusion needs executing) stay two orthogonal facts
 * and are never merged (freeze doc §1 / §3).
 * ------------------------------------------------------------------------- */

/** Audit-only side channel. Written, never judged: it is NOT a state source (§3 rule 2). */
export const TRACKED_CLOSURE_ACK_LOG_KV_KEY = 'tracked_closure_ack_log';

/** Ring-buffer size for the audit side channel; the oldest entry is dropped (§2.2). */
export const TRACKED_CLOSURE_ACK_LOG_LIMIT = 200;

/** Receipts are one-liners; the cap keeps a runaway model from writing a novel. */
export const TRACKED_CLOSURE_RECEIPT_MAX_CHARS = 1000;

export const TRACKED_PENDING_CLOSURE_DEFAULT_LIMIT = 50;
export const TRACKED_PENDING_CLOSURE_HARD_LIMIT = 200;

/** An explicit "nothing to do" receipt is a complete receipt (§4 step 1). */
export const TRACKED_CLOSURE_NO_ACTION_MARKER_ZH = '仅记录、无需动作';
export const TRACKED_CLOSURE_NO_ACTION_MARKER_EN = 'record-only, no action required';

/**
 * Who may be recorded as having executed a conclusion. `system_backfill` is
 * deliberately absent: a migration-written conclusion is not an instruction, so
 * it can never be a pending item nor be marked processed (freeze doc §3.1 T2).
 */
export type TrackedClosureProcessedBy = 'owner' | 'twin';

/**
 * `sha256(conclusion.trim(), utf8)` lower-case hex. Computed in JS, never in
 * SQL, so the browser and the daemon agree byte for byte (freeze doc §2.2).
 */
export function closureHash(conclusion: string): string {
  return createHash('sha256').update(conclusion.trim(), 'utf8').digest('hex');
}

/**
 * Conservative destructive-action lexicon (freeze doc §5). Substring scan,
 * case-insensitive. Deliberately over-eager: its job is to CUT the silent path,
 * not to judge intent — one extra confirmation is cheap, one silent delete is not.
 */
export const TRACKED_DESTRUCTIVE_CLOSURE_TERMS: readonly string[] = [
  // Deletion
  '删除', '移除', '清理', '卸载', 'delete', 'remove', 'uninstall', 'rm -rf',
  // Money
  '转账', '打款', '付款', '支付', '发币', '空投', 'transfer', 'pay', 'payment', 'airdrop',
  // Public publishing
  '发布', '上链', '发帖', '公开', '广播', 'publish', 'post', 'broadcast', 'upload',
  // Irreversible state changes
  '撤销', '撤销授权', '关闭', '停用', '覆盖', '重置', '回滚',
  'revoke', 'cancel', 'overwrite', 'reset', 'rollback',
];

export function classifyClosureConclusion(conclusion: string): {
  destructive: boolean;
  reasons: string[];
} {
  const haystack = (conclusion ?? '').toLowerCase();
  const reasons = TRACKED_DESTRUCTIVE_CLOSURE_TERMS
    .filter((term) => haystack.includes(term.toLowerCase()));
  return { destructive: reasons.length > 0, reasons };
}

/**
 * THE queue predicate (freeze doc §3, single implementation — every downstream
 * reader must delegate here; a second derivation is forbidden).
 *
 * Three conditions, all necessary:
 *  - a non-blank conclusion: an empty card can never produce a pending item (T3);
 *  - `closure_by ∈ {owner, twin}`: the v1.1 startup backfill writes
 *    `system_backfill` and must never flood the queue on upgrade (T2);
 *  - the mark's hash differs from the CURRENT conclusion's hash: a card that was
 *    already acked and then closed again with a NEW conclusion re-enters the
 *    queue instead of being silently swallowed (T1).
 */
export function isClosurePending(row: {
  closureConclusion: string | null;
  closureBy: string | null;
  closureProcessedHash: string | null;
}): boolean {
  const conclusion = row.closureConclusion?.trim() ?? '';
  if (!conclusion) return false;
  if (row.closureBy !== 'owner' && row.closureBy !== 'twin') return false;
  return closureHash(conclusion) !== (row.closureProcessedHash ?? null);
}

/** A receipt is complete with an evidence URI, or with the explicit no-action marker. */
export function closureReceiptIsComplete(receipt: string, evidenceUri?: string | null): boolean {
  if (evidenceUri?.trim()) return true;
  const text = receipt ?? '';
  return text.includes(TRACKED_CLOSURE_NO_ACTION_MARKER_ZH)
    || text.toLowerCase().includes(TRACKED_CLOSURE_NO_ACTION_MARKER_EN);
}

export interface TrackedPendingClosure {
  cardId: string;
  title: string;
  status: OrchestrationTaskStatus;
  /** The conclusion verbatim — the instruction to execute. */
  conclusion: string;
  closureBy: 'owner' | 'twin';
  closureAt: string | null;
  closurePinId: string | null;
  conclusionHash: string;
  destructive: boolean;
  /** Which lexicon entries matched; reported so the caller can explain the gate. */
  destructiveReasons: string[];
}

export interface TrackedPendingClosureList {
  generatedAt: string;
  /** The queue's REAL size, even when `items` was truncated by `limit`. */
  count: number;
  truncated: boolean;
  items: TrackedPendingClosure[];
}

export interface TrackedClosureAckInput {
  taskId: string;
  processedBy: TrackedClosureProcessedBy;
  /** How it was handled + the evidence, or the explicit no-action marker. */
  receipt: string;
  evidenceUri?: string | null;
  /** Proof the EXISTING safety gate cleared this action; a new channel is never opened. */
  confirmationRef?: string | null;
}

export type TrackedClosureAckCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'NO_CONCLUSION'
  | 'RECEIPT_INCOMPLETE'
  | 'CONFIRMATION_REQUIRED';

export interface TrackedClosureAckResult {
  ok: boolean;
  code?: TrackedClosureAckCode;
  error?: string;
  /** `true` when the CAS matched 0 rows: the conclusion was already executed. */
  alreadyProcessed: boolean;
  processedAt: string | null;
  processedBy: TrackedClosureProcessedBy | null;
  receipt: string | null;
}

/** Every non-null mark currently on the row, in one shape. */
export interface TrackedCardClosureProcessing {
  pending: boolean;
  processedAt: string | null;
  processedBy: TrackedClosureProcessedBy | null;
  receipt: string | null;
  receiptPinId: string | null;
}

/** One audit row of the side channel; `evidence` is a URI, a commit sha or a confirmation ref. */
export interface TrackedClosureAckAuditEntry {
  cardId: string;
  conclusionHash: string;
  at: string;
  by: TrackedClosureProcessedBy;
  evidence: string | null;
}

/**
 * Malformed audit JSON reads as an empty log, never a throw — same discipline as
 * `parseLongTaskRegistry`. Only the append path is best-effort-logged; reading a
 * broken side channel must not take the board down.
 */
export function parseClosureAckLog(raw: string | null): TrackedClosureAckAuditEntry[] {
  const asText = raw?.trim();
  if (!asText) return [];
  try {
    const parsed = JSON.parse(asText);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is TrackedClosureAckAuditEntry => (
      Boolean(entry) && typeof entry === 'object'
      && typeof (entry as TrackedClosureAckAuditEntry).cardId === 'string'
      && typeof (entry as TrackedClosureAckAuditEntry).conclusionHash === 'string'
    ));
  } catch {
    return [];
  }
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
  // v1.4 (owner ruling): "closed" == the human acceptance is RECORDED, i.e.
  // closure_at IS NOT NULL — the conclusion text is optional now. Backward
  // compatible: every historical closure write set closure_at alongside the
  // conclusion, so no legacy row changes meaning.
  const closureRecorded = Boolean(input.closureAt);
  const closed = terminal && closureRecorded;
  // A terminal card the human has not closed out yet: it lands in
  // waiting_decision and queues the terminal_no_conclusion suggestion.
  const terminalUnclosed = terminal && !closureRecorded;

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
    || terminalUnclosed
  ) {
    cardState = 'waiting_decision';
  } else if (unmetDependencySteps.length > 0 || scheduledAwaitingExternal()) {
    cardState = 'blocked_external';
  } else {
    cardState = 'in_progress';
  }

  // v1.4 fix: the stale badge never fires on a CLOSED card. An accepted card
  // whose activity anchors stay old (the common case — acceptance does not
  // touch updated_at) used to keep wearing the 预警 badge forever. The
  // idle_days fact below is gated by the same flag, so fixing the badge fixes
  // the fact with it.
  const closureWarn = !closed && idleMs !== null && idleMs > TRACKED_CARD_WARN_MS;
  const zombie = !closed && idleMs !== null && idleMs > TRACKED_CARD_ZOMBIE_MS;
  const sessionsEnded =
    input.sessionStatuses.length > 0
    && input.sessionStatuses.every((status) => status === 'idle')
    && openAttempts.length === 0;

  // v1.1: admission is a NECESSARY condition (freeze doc §4). Unadmitted rows
  // produce no closureDue and no suggestion at ANY level — not even zombie or
  // sessions_ended. This is the gate that stops the v1 board from projecting
  // the whole delegation ledger into "needs closure".
  //
  // `admitted` is coerced, not trusted: it is a required input, but a caller that
  // omits it must NOT produce a non-boolean `closureDue`. It fails closed to
  // `false` — the quiet direction, so a missed argument can never masquerade as
  // "nothing needs closure" through a truthy accident.
  const admissionInputMissing = typeof input.admitted !== 'boolean';
  const closureDue = input.admitted === true && !closed
    && (zombie || terminalUnclosed || sessionsEnded);
  const closureDueLevel: TrackedClosureDueLevel | null = !closureDue
    ? null
    : terminalUnclosed
      ? 'terminal_no_conclusion'
      : zombie && !closed
        ? 'zombie'
        : 'sessions_ended';

  const reasonEntries: Array<{ code: TrackedFactCode; params: Record<string, string | number>; text: string }> = [];
  // First on purpose: this fact is the trigger of the `terminal_no_conclusion`
  // suggestion, and the payload keeps only the first five reason lines. If it
  // could be truncated away, the pair's reverse implication (suggestion present
  // => this reason present) would silently stop holding.
  if (terminalUnclosed) {
    reasonEntries.push({
      code: 'terminal_without_conclusion',
      params: {},
      text: 'terminal status not closed out yet (no acceptance recorded)',
    });
  }
  if (task.status === 'review') {
    reasonEntries.push({
      code: 'ledger_review',
      params: {},
      text: 'ledger status=review, awaiting a decision',
    });
  }
  if (waitingInputSteps.length > 0) {
    reasonEntries.push({
      code: 'steps_waiting_input',
      params: { count: waitingInputSteps.length },
      text: `${waitingInputSteps.length} step(s) waiting_input`,
    });
  }
  if (input.openCheckpointCount > 0) {
    reasonEntries.push({
      code: 'open_checkpoints',
      params: { count: input.openCheckpointCount },
      text: `${input.openCheckpointCount} open group-task checkpoint(s)`,
    });
  }
  if (unmetDependencySteps.length > 0) {
    reasonEntries.push({
      code: 'blocked_unmet_dependencies',
      params: { count: unmetDependencySteps.length },
      text: `${unmetDependencySteps.length} blocked step(s) with unmet dependencies`,
    });
  }
  if (activeSteps.length > 0) {
    reasonEntries.push({
      code: 'steps_active',
      params: { count: activeSteps.length },
      text: `${activeSteps.length} step(s) ready/queued/running`,
    });
  }
  if (openAttempts.length > 0) {
    reasonEntries.push({
      code: 'attempts_open',
      params: { count: openAttempts.length },
      text: `${openAttempts.length} attempt(s) queued/running`,
    });
  }
  if (input.verifiableDeliverableCount > 0) {
    reasonEntries.push({
      code: 'deliverables_verifiable',
      params: { count: input.verifiableDeliverableCount },
      text: `${input.verifiableDeliverableCount} verifiable deliverable(s)`,
    });
  }
  if (idleMs !== null && closureWarn) {
    reasonEntries.push({
      code: 'idle_days',
      params: { days: idleMs / TRACKED_CARD_WARN_MS },
      text: `idle for ${formatDays(idleMs)} day(s)`,
    });
  }
  if (input.sessionStatuses.length > 0) {
    reasonEntries.push({
      code: 'linked_sessions',
      params: { count: input.sessionStatuses.length },
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
    closureRecorded,
    verifiableDeliverableCount: input.verifiableDeliverableCount,
    unmetDependencyCount: unmetDependencySteps.length,
    idleMs,
  });

  return {
    cardState,
    admissionInputMissing,
    closureDue,
    closureWarn,
    closureDueLevel,
    // Derived from the structured facts below, never written twice by hand.
    closureSuggestion: suggestion ? renderTrackedSuggestion(suggestion.code, suggestion.params) : '',
    closureSuggestionCode: suggestion?.code ?? null,
    closureSuggestionParams: suggestion?.params ?? null,
    lastActivityAtMs,
    idleMs,
    reasons: keptReasons.map((entry) => entry.text),
    reasonCodes: keptReasons.map((entry) => ({ code: entry.code, params: entry.params })),
    reasonOverflow: Math.max(0, reasonEntries.length - TRACKED_CARD_REASON_LIMIT),
  };
}


/**
 * The one renderer of the diagnostic string. `closureSuggestion` is always this
 * function applied to the structured facts, so the two can never drift.
 */
export function renderTrackedSuggestion(
  code: TrackedSuggestionCode,
  params: Record<string, string | number>,
): string {
  const days = typeof params.days === 'number' ? params.days.toFixed(1) : '0.0';
  switch (code) {
    case 'terminal_no_conclusion':
      return 'Reached a terminal status that is not closed out yet; close the card to record the acceptance.';
    case 'deliverables_verifiable':
      return `Deliverables are verifiable (${params.count}); close the card with a one-line conclusion.`;
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
  closureRecorded: boolean;
  verifiableDeliverableCount: number;
  unmetDependencyCount: number;
  idleMs: number | null;
}): { code: TrackedSuggestionCode; params: Record<string, string | number> } | null {
  // A suggestion exists exactly when the card is due for closure (A-6 rule 4).
  if (!input.closureDue || input.cardState === 'closed') return null;
  const days = input.idleMs === null ? 0 : input.idleMs / TRACKED_CARD_WARN_MS;
  // Same condition as the `terminal_without_conclusion` REASON (A-6 appendix B:
  // the two homes of one fact may never diverge), v1.4: it reads the closure
  // RECORD, not the conclusion text.
  if (input.terminal && !input.closureRecorded) return { code: 'terminal_no_conclusion', params: {} };
  if (input.verifiableDeliverableCount > 0) {
    return { code: 'deliverables_verifiable', params: { count: input.verifiableDeliverableCount } };
  }
  if (input.unmetDependencyCount > 0) return { code: 'unresolved_dependencies', params: { days } };
  if (input.closureDueLevel === 'sessions_ended') return { code: 'session_ended', params: {} };
  return { code: 'stale_inactivity', params: { days } };
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
  closureSuggestionParams: Record<string, string | number> | null;
  closureConclusion: string | null;
  /**
   * v1.2 read-time projection (freeze doc §2.3): the conclusion has NOT been
   * executed yet. Orthogonal to `closureDue` — this one asks "is there an
   * instruction still waiting?", that one asks "should this card be closed?".
   */
  closurePending: boolean;
  closureProcessedAt: string | null;
  closureProcessedBy: TrackedClosureProcessedBy | null;
  closureReceipt: string | null;
  closureReceiptPinId: string | null;
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
  /**
   * v1.1 read-time projection (freeze doc §6): `archived := ¬admitted`. Nothing
   * is written, moved or deleted — this flag IS the archive. v1.3: the manual
   * kv override additionally forces `false` (see TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY).
   */
  admitted: boolean;
  /** Which admission rules matched; empty only for ¬admitted cards WITHOUT the v1.3 override. */
  admissionMatched: TrackedAdmissionRule[];
  /** Diagnostic: the admission input was not a boolean for this card. Must be false. */
  admissionInputMissing: boolean;
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
  /** Every ledger row; `admitted + archived === total` is a hard invariant. */
  total: number;
  /** Cards the board shows (the current scope's visible set). */
  visible: number;
  /** Folded away by the default scope; must stay reachable, never silently hidden. */
  folded: number;
  /** Cards that passed admission — the only rows that can ever be closureDue. */
  admitted: number;
  /** `¬admitted`: queryable through `scope:'archived'`, never in the closure queue. */
  archived: number;
  /** Diagnostic only: registry ids that no longer exist in the ledger (freeze §2 ADM-1). */
  staleRegistration: number;
  /**
   * Diagnostic only: cards whose admission input was missing/not a boolean.
   * Expected 0 — the board always supplies `trackAdmission`'s verdict, so a
   * non-zero value means some caller bypassed it and is silently queueing nothing.
   */
  admissionInputMissing: number;
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
  /** Exactly what the caller asked for; `null` when the scope was omitted. */
  scopeRequested: string | null;
  /** Echoed back so the UI can label the filter and offer a one-click clear. */
  scopeApplied: TrackedCardScope;
  /**
   * True when `scopeRequested` was not one of the three known scopes. The
   * fallback to `default` is then EXPLICIT — never a silent re-shaping of the
   * board, which is exactly how the v1 build answered `scope:'archived'` with
   * the default view.
   */
  scopeFallback: boolean;
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

/**
 * Board scope (v1.1). `default` = recent activity ∪ every closureDue card;
 * `all` = every admitted card, no folding; `archived` = exactly the rows that
 * failed admission (kept queryable, never in the closure queue).
 */
export type TrackedCardScope = 'default' | 'all' | 'archived';

export const TRACKED_CARD_SCOPES: readonly TrackedCardScope[] = ['default', 'all', 'archived'];

export interface TrackedCardListInput {
  ownerGlobalMetaId?: string;
  scope?: TrackedCardScope;
  limit?: number;
  offset?: number;
}

export interface TrackedCardCloseInput {
  taskId: string;
  /**
   * v1.4: OPTIONAL. Closing a card is the human ACCEPTANCE; a blank/whitespace
   * conclusion normalizes to NULL ("accepted, no instruction") and never
   * enters the pending-closure queue. A non-blank conclusion stays an
   * instruction the Twin's sweep executes (T1: it re-enters the queue).
   */
  conclusion: string | null;
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

/** v1.3 manual archive override (kv single row, reversible, ledger untouched). */
export interface TrackedCardArchiveResult {
  ok: boolean;
  code?: 'NOT_FOUND' | 'VALIDATION';
  error?: string;
  /** The refreshed summary; `admitted` is already false when archived. */
  card?: TrackedCardSummary;
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

/**
 * Sort sentinel for a card whose activity timestamp is unknown (`null`). It sits
 * below every real epoch, so a descending sort keeps those cards last rather than
 * silently promoting them to the top.
 */
const NO_ACTIVITY_AT_MS = Number.NEGATIVE_INFINITY;

/** List-view rank (contract `[SEC-09]`); ties break on `activityAt` descending. */
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
  /**
   * v1.4: the group-task orchestration bridge, injected as a getter so the
   * board never imports it at runtime (type-only import) and the two services
   * stay decoupled. When a card is linked to a group task and a bridge is
   * available, closing goes THROUGH the bridge (accept/cancel) so the group
   * task and the canonical ledger move together; without the getter (or with
   * no group-task link) the legacy path applies unchanged.
   */
  resolveGroupTaskBridge?: () => GroupTaskOrchestrationBridge | null;
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

  /**
   * The v1.1/v1.3 kv facts, read ONCE per board read (registry + mode +
   * archive override). No DDL: the whole admission switch and the manual
   * archive live in the existing `kv` table (I-3).
   */
  private readAdmissionContext(): {
    registeredIds: Set<string>;
    mode: TrackedAdmissionMode;
    archivedIds: Set<string>;
  } {
    const rows = this.getAll('SELECT key, value FROM kv WHERE key IN (?, ?, ?)', [
      TRACKED_LONG_TASK_REGISTRY_KV_KEY,
      TRACKED_ADMISSION_MODE_KV_KEY,
      TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY,
    ]);
    const byKey = new Map(rows.map((row) => [String(row.key), text(row.value)]));
    return {
      registeredIds: new Set(parseLongTaskRegistry(byKey.get(TRACKED_LONG_TASK_REGISTRY_KV_KEY) ?? null)),
      mode: resolveAdmissionMode(byKey.get(TRACKED_ADMISSION_MODE_KV_KEY) ?? null),
      archivedIds: new Set(
        Object.keys(parseArchiveOverrides(byKey.get(TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY) ?? null)),
      ),
    };
  }

  listCards(input: TrackedCardListInput = {}): TrackedCardBoard {
    const nowMs = Date.now();
    // A scope is only ever one of the three declared values. An omitted scope is
    // the documented default; anything else is reported as `scopeFallback`
    // rather than being quietly answered with the default view.
    const scopeRequested = typeof input.scope === 'string' && input.scope.trim() !== '' ? input.scope : null;
    const scopeFallback = scopeRequested !== null && !TRACKED_CARD_SCOPES.includes(scopeRequested as TrackedCardScope);
    const scope: TrackedCardScope = scopeFallback || scopeRequested === null
      ? 'default'
      : (scopeRequested as TrackedCardScope);
    const rows = input.ownerGlobalMetaId
      ? this.getAll(
        'SELECT id FROM orchestration_tasks WHERE owner_global_meta_id = ? ORDER BY updated_at DESC',
        [input.ownerGlobalMetaId],
      )
      : this.getAll('SELECT id FROM orchestration_tasks ORDER BY updated_at DESC');

    const admission = this.readAdmissionContext();
    const built = rows
      .map((row) => this.buildSummary(String(row.id), nowMs, admission))
      .filter((card): card is TrackedCardSummary => card !== null);
    const admittedCards = built.filter((card) => card.admitted);
    const archivedCards = built.filter((card) => !card.admitted);

    // The archive view is its own population: it is NOT "folded away", it is
    // "not admitted", and the two must never be conflated (freeze doc §6).
    const visible = scope === 'archived'
      ? archivedCards
      : scope === 'all'
        ? admittedCards
        : admittedCards.filter((card) => card.closureDue || isInsideScopeWindow(card, nowMs));
    const folded = scope === 'archived' ? 0 : admittedCards.length - visible.length;

    const sorted = [...visible].sort((a, b) => {
      const byRank = a.actionRank - b.actionRank;
      if (byRank !== 0) return byRank;
      // Same weight: most recent activity first (`[SEC-09]`), so the closed and
      // archived columns lead with the card that moved last.
      const aAt = a.activityAtMs ?? NO_ACTIVITY_AT_MS;
      const bAt = b.activityAtMs ?? NO_ACTIVITY_AT_MS;
      if (aAt !== bAt) return bAt - aAt;
      return a.id.localeCompare(b.id);
    });

    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : null;
    const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 0;
    const page = sorted.slice(offset, limit === null ? undefined : offset + limit);

    const ledgerIds = new Set(built.map((card) => card.id));

    return {
      ledger: 'orchestration_tasks',
      generatedAtMs: nowMs,
      scopeRequested,
      scopeApplied: scope,
      scopeFallback,
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
        total: built.length,
        visible: sorted.length,
        folded,
        admitted: admittedCards.length,
        archived: archivedCards.length,
        staleRegistration: [...admission.registeredIds].filter((id) => !ledgerIds.has(id)).length,
        admissionInputMissing: built.filter((card) => card.admissionInputMissing).length,
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
    const summary = this.buildSummary(taskId, Date.now(), this.readAdmissionContext());
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
   * Close a card = record the human ACCEPTANCE (v1.4 semantics), two shapes:
   *
   * Group-task-linked card + bridge available (owner ruling B): the close goes
   * THROUGH the bridge so both models move together —
   *  - targetStatus=completed (default) -> `acceptGroupTask` (unfinished steps
   *    or a non-review group task makes it THROW: the whole close is then
   *    rejected with code=VALIDATION and the card stays byte-identical — never
   *    half-written);
   *  - targetStatus=cancelled -> `cancelGroupTask` cascade.
   * The bridge error text is surfaced verbatim so the UI can show the remedy.
   *
   * Unlinked card (or no bridge in this build): the legacy two-stage per the
   * chair's F1 ruling —
   *  1. always write the closure columns;
   *  2. move `status` ONLY when the ledger whitelist allows it — otherwise the
   *     acceptance still closes the card through the terminal-status rule and
   *     the status legitimately stays put (e.g. a `failed` card).
   * `status` is never written directly: the move goes through
   * `orchestrationStore.updateTaskStatus` and its TASK_TRANSITIONS whitelist.
   *
   * The closure columns are written by `orchestrationStore.recordClosure` in
   * BOTH paths (owner ruling A: exactly one writer, and a new close resets the
   * processing marks — T1 — so a fresh instruction re-enters the queue).
   */
  closeCard(input: TrackedCardCloseInput): TrackedCardCloseResult {
    // v1.4: blank/empty normalizes to NULL — acceptance without an instruction.
    const conclusion = input.conclusion?.trim() || null;
    if (input.by !== 'owner' && input.by !== 'twin') {
      return { ok: false, code: 'VALIDATION', error: "closeCard: 'by' must be 'owner' or 'twin'." };
    }
    const task = this.deps.orchestrationStore.getTask(input.taskId);
    if (!task) {
      return { ok: false, code: 'NOT_FOUND', error: `orchestration task ${input.taskId} not found` };
    }

    // Group-task linkage is checked BEFORE any write, so a rejecting bridge
    // error can never leave a half-closed card behind.
    const groupTaskRow = this.getOne(
      'SELECT id, status FROM group_tasks WHERE orchestration_task_id = ? ORDER BY id ASC LIMIT 1',
      [input.taskId],
    );
    const bridge = groupTaskRow ? (this.deps.resolveGroupTaskBridge?.() ?? null) : null;
    if (groupTaskRow && bridge) {
      const groupTaskId = Number(groupTaskRow.id);
      try {
        if (input.targetStatus === 'cancelled') {
          bridge.cancelGroupTask(groupTaskId, { kind: 'owner' });
        } else {
          bridge.acceptGroupTask(groupTaskId, { kind: 'owner' });
        }
      } catch (error) {
        // Whole-card rejection: nothing was written by closeCard itself.
        return {
          ok: false,
          code: 'VALIDATION',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // The bridge owns the status moves (accept -> completed/done, cancel ->
      // cancelled cascade). The owner's close still decides the final closure
      // record: the supplied conclusion (or NULL) plus the T1 mark reset.
      this.deps.orchestrationStore.recordClosure(input.taskId, {
        conclusion,
        by: input.by,
        pinId: input.pinId ?? null,
      });
      this.deps.saveDb();
      const refreshed = this.deps.orchestrationStore.getTask(input.taskId);
      const card = this.buildSummary(input.taskId, Date.now(), this.readAdmissionContext());
      return card
        ? {
          ok: true,
          card,
          statusMoved: refreshed != null && refreshed.status !== task.status,
          statusNote: input.targetStatus === 'cancelled'
            ? `group task ${groupTaskId} cancelled via bridge; the closure record is written.`
            : `group task ${groupTaskId} accepted via bridge; the closure record is written.`,
        }
        : { ok: false, code: 'NOT_FOUND', error: 'card vanished after close' };
    }

    let statusMoved = false;
    let statusNote = 'ledger status is already terminal; the acceptance alone closes the card.';
    if (!isTerminalStatus(task.status)) {
      const targetStatus: OrchestrationTaskStatus = input.targetStatus === 'cancelled' ? 'cancelled' : 'completed';
      try {
        this.deps.orchestrationStore.updateTaskStatus(input.taskId, targetStatus);
        statusMoved = true;
        statusNote = `ledger status ${task.status} -> ${targetStatus}`;
      } catch (error) {
        statusNote = `ledger transition refused (${error instanceof Error ? error.message : String(error)}); `
          + 'the acceptance is still recorded.';
      }
    }

    // T1 (freeze doc §3.1): writing a NEW closure must reset the processing
    // mark and the receipt IN THE SAME statement. A card that was already acked
    // and is closed again carries a different instruction, so it has to
    // re-enter the execution queue — leaving the old mark in place would
    // silently swallow the new instruction. recordClosure is ONE UPDATE, so no
    // reader can observe a half-reset row.
    this.deps.orchestrationStore.recordClosure(input.taskId, {
      conclusion,
      by: input.by,
      pinId: input.pinId ?? null,
    });
    this.deps.saveDb();
    const card = this.buildSummary(input.taskId, Date.now(), this.readAdmissionContext());
    return card
      ? { ok: true, card, statusMoved, statusNote }
      : { ok: false, code: 'NOT_FOUND', error: 'card vanished after close' };
  }

  /**
   * THE read entry for "conclusions still waiting to be executed" (freeze doc
   * §3 / §6). The Twin's routine sweep calls this; the agent tool and the
   * optional IPC handler are thin wrappers over THIS method — a second
   * derivation anywhere else is a defect.
   *
   * Read-only by contract: no write, no mark, no chain write. Two consecutive
   * reads over the same rows agree field for field, `generatedAt` aside, so a
   * third party can re-run the queue and compare.
   */
  listPendingClosures(input: { limit?: number } = {}): TrackedPendingClosureList {
    const requested = input?.limit;
    const limit = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), TRACKED_PENDING_CLOSURE_HARD_LIMIT)
      : TRACKED_PENDING_CLOSURE_DEFAULT_LIMIT;
    // The SQL narrows, `isClosurePending` decides — the hash comparison lives in
    // the one pure function above, never duplicated here.
    const rows = this.getAll(
      `SELECT id, owner_intent, status, closure_conclusion, closure_by, closure_at,
              closure_pin_id, closure_processed_hash
         FROM orchestration_tasks
        WHERE closure_conclusion IS NOT NULL AND trim(closure_conclusion) <> ''
          AND closure_by IN ('owner', 'twin')
        ORDER BY closure_at ASC, id ASC`,
    );
    const items = rows
      .filter((row) => isClosurePending({
        closureConclusion: text(row.closure_conclusion),
        closureBy: text(row.closure_by),
        closureProcessedHash: text(row.closure_processed_hash),
      }))
      .map((row) => this.toPendingClosure(row));
    return {
      generatedAt: new Date().toISOString(),
      // `count` is the QUEUE's size, not the page's: a truncated list must never
      // read as "the queue is done".
      count: items.length,
      truncated: items.length > limit,
      items: items.slice(0, limit),
    };
  }

  private toPendingClosure(row: Row): TrackedPendingClosure {
    const conclusion = text(row.closure_conclusion) ?? '';
    const verdict = classifyClosureConclusion(conclusion);
    return {
      cardId: String(row.id),
      title: String(row.owner_intent ?? ''),
      status: String(row.status) as OrchestrationTaskStatus,
      conclusion,
      closureBy: text(row.closure_by) === 'twin' ? 'twin' : 'owner',
      closureAt: text(row.closure_at),
      closurePinId: text(row.closure_pin_id),
      conclusionHash: closureHash(conclusion),
      destructive: verdict.destructive,
      destructiveReasons: verdict.reasons,
    };
  }

  /**
   * Mark one conclusion as executed and file its receipt (freeze doc §4).
   *
   * Order is the contract: validate → refuse an incomplete receipt → refuse an
   * unconfirmed destructive action → ONE CAS statement. Every refusal returns
   * before the write, so a rejected ack leaves the row byte-identical — there is
   * deliberately no "in progress" state to get stuck in.
   *
   * `changes === 0` is NOT an error: it means another reader already executed
   * this exact conclusion. The existing mark is read back and reported.
   */
  acknowledgeClosure(input: TrackedClosureAckInput): TrackedClosureAckResult {
    const refused = (code: TrackedClosureAckCode, error: string): TrackedClosureAckResult => ({
      ok: false,
      code,
      error,
      alreadyProcessed: false,
      processedAt: null,
      processedBy: null,
      receipt: null,
    });

    const receipt = input?.receipt?.trim() ?? '';
    if (!receipt || receipt.length > TRACKED_CLOSURE_RECEIPT_MAX_CHARS) {
      return refused(
        'VALIDATION',
        `receipt must be 1..${TRACKED_CLOSURE_RECEIPT_MAX_CHARS} characters`,
      );
    }
    if (input.processedBy !== 'owner' && input.processedBy !== 'twin') {
      return refused('VALIDATION', "processedBy must be 'owner' or 'twin'");
    }

    const row = this.getOne(
      `SELECT id, closure_conclusion, closure_processed_at, closure_processed_by,
              closure_processed_hash, closure_receipt, closure_receipt_pin_id
         FROM orchestration_tasks WHERE id = ?`,
      [input.taskId],
    );
    if (!row) return refused('NOT_FOUND', `orchestration task ${input.taskId} not found`);
    const conclusion = text(row.closure_conclusion);
    if (!conclusion) {
      return refused('NO_CONCLUSION', 'the card carries no closing conclusion to execute');
    }

    const evidenceUri = input.evidenceUri?.trim() || null;
    if (!closureReceiptIsComplete(receipt, evidenceUri)) {
      return refused(
        'RECEIPT_INCOMPLETE',
        'a receipt needs an evidence URI, or the explicit "'
          + TRACKED_CLOSURE_NO_ACTION_MARKER_ZH + '" / "'
          + TRACKED_CLOSURE_NO_ACTION_MARKER_EN + '" marker',
      );
    }

    const verdict = classifyClosureConclusion(conclusion);
    const confirmationRef = input.confirmationRef?.trim() || null;
    if (verdict.destructive && !confirmationRef) {
      return refused(
        'CONFIRMATION_REQUIRED',
        'this conclusion looks destructive (' + verdict.reasons.join(', ')
          + '); it must go through the existing safety confirmation first — a conclusion never bypasses the gate',
      );
    }

    const hash = closureHash(conclusion);
    const at = new Date().toISOString();
    const evidence = evidenceUri ?? confirmationRef;
    this.deps.db.run(
      `UPDATE orchestration_tasks
          SET closure_processed_at = ?, closure_processed_by = ?, closure_processed_hash = ?,
              closure_receipt = ?, closure_receipt_pin_id = ?
        WHERE id = ?
          AND (closure_processed_hash IS NULL OR closure_processed_hash <> ?)`,
      [at, input.processedBy, hash, receipt, evidence, input.taskId, hash],
    );
    const changes = this.deps.db.getRowsModified?.() ?? 0;

    if (changes === 0) {
      const current = this.getOne(
        `SELECT closure_processed_at, closure_processed_by, closure_receipt
           FROM orchestration_tasks WHERE id = ?`,
        [input.taskId],
      );
      return {
        ok: true,
        alreadyProcessed: true,
        processedAt: text(current?.closure_processed_at),
        processedBy: (text(current?.closure_processed_by) as TrackedClosureProcessedBy | null) ?? null,
        receipt: text(current?.closure_receipt),
      };
    }

    this.deps.saveDb();
    this.appendClosureAckAudit({
      cardId: input.taskId,
      conclusionHash: hash,
      at,
      by: input.processedBy,
      evidence,
    });
    return {
      ok: true,
      alreadyProcessed: false,
      processedAt: at,
      processedBy: input.processedBy,
      receipt,
    };
  }

  /**
   * Best-effort audit trail (freeze doc §2.2 / §4 step 5). The mark and the
   * receipt are already committed on the card row by the time this runs, so a
   * failure here must never fail the ack — but it is logged, never swallowed
   * silently. Auditors read this; the queue never does.
   */
  private appendClosureAckAudit(entry: TrackedClosureAckAuditEntry): void {
    try {
      const next = [...this.readClosureAckAuditLog(), entry].slice(-TRACKED_CLOSURE_ACK_LOG_LIMIT);
      this.writeKv(TRACKED_CLOSURE_ACK_LOG_KV_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn('appendClosureAckAudit:', error);
    }
  }

  readClosureAckAuditLog(): TrackedClosureAckAuditEntry[] {
    return parseClosureAckLog(this.readKv(TRACKED_CLOSURE_ACK_LOG_KV_KEY));
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
    return this.readKv(TRACKED_TICK_BEAT_KV_KEY);
  }

  private readKv(key: string): string | null {
    return text(this.getOne('SELECT value FROM kv WHERE key = ?', [key])?.value);
  }

  private writeKv(key: string, value: string): void {
    this.deps.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, Date.now()],
    );
    this.deps.saveDb();
  }

  /**
   * ADM-1's face (freeze doc §2): the owner's explicit "this is a long task"
   * registration. It is data in the existing `kv` table — no column, no table,
   * no migration. A malformed registry reads as an empty set, never an error.
   */
  listRegisteredLongTaskIds(): string[] {
    return parseLongTaskRegistry(this.readKv(TRACKED_LONG_TASK_REGISTRY_KV_KEY));
  }

  registerLongTask(taskId: string): { ok: boolean; registered: string[] } {
    const id = taskId?.trim();
    if (!id) return { ok: false, registered: this.listRegisteredLongTaskIds() };
    const current = this.listRegisteredLongTaskIds();
    if (!current.includes(id)) {
      this.writeKv(TRACKED_LONG_TASK_REGISTRY_KV_KEY, JSON.stringify([...current, id]));
    }
    return { ok: true, registered: this.listRegisteredLongTaskIds() };
  }

  unregisterLongTask(taskId: string): { ok: boolean; registered: string[] } {
    const id = taskId?.trim();
    const current = this.listRegisteredLongTaskIds();
    const next = current.filter((entry) => entry !== id);
    if (next.length !== current.length) {
      this.writeKv(TRACKED_LONG_TASK_REGISTRY_KV_KEY, JSON.stringify(next));
    }
    return { ok: true, registered: next };
  }

  /** `wide` unless the kv entry says exactly `strict`. */
  getAdmissionMode(): TrackedAdmissionMode {
    return resolveAdmissionMode(this.readKv(TRACKED_ADMISSION_MODE_KV_KEY));
  }

  setAdmissionMode(mode: string): TrackedAdmissionMode {
    const resolved = resolveAdmissionMode(mode);
    this.writeKv(TRACKED_ADMISSION_MODE_KV_KEY, resolved);
    return resolved;
  }

  /**
   * v1.3 manual archive write path (owner ruling 2026-09-18): archive the
   * closed card from the drawer, or undo it with `archived: false` (reversible
   * by design even though the read-only archive view exposes no unarchive UI).
   * ONE kv row per the admission-mode pattern — no new column, no new table —
   * and the ledger row itself is untouched: admission stays a read-time
   * projection, the override only shifts it (`admitted := admitted ∧ ¬override`).
   * A no-op call writes nothing.
   */
  archiveCard(input: { cardId: string; archived: boolean }): TrackedCardArchiveResult {
    const cardId = typeof input?.cardId === 'string' ? input.cardId.trim() : '';
    if (!cardId) {
      return { ok: false, code: 'VALIDATION', error: "archiveCard: 'cardId' is required." };
    }
    if (typeof input?.archived !== 'boolean') {
      return { ok: false, code: 'VALIDATION', error: "archiveCard: 'archived' must be a boolean." };
    }
    const task = this.deps.orchestrationStore.getTask(cardId);
    if (!task) {
      return { ok: false, code: 'NOT_FOUND', error: `orchestration task ${cardId} not found` };
    }
    const overrides = parseArchiveOverrides(this.readKv(TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY));
    if (input.archived) {
      if (!(cardId in overrides)) {
        overrides[cardId] = new Date().toISOString();
        this.writeKv(TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY, JSON.stringify(overrides));
      }
    } else if (cardId in overrides) {
      delete overrides[cardId];
      this.writeKv(TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY, JSON.stringify(overrides));
    }
    const card = this.buildSummary(cardId, Date.now(), this.readAdmissionContext());
    return card
      ? { ok: true, card }
      : { ok: false, code: 'NOT_FOUND', error: 'card vanished after archive' };
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

  /**
   * The closure half of a card. v1.2 reads the processing mark alongside the
   * conclusion so a projection can derive `closurePending` without a second
   * query and without ever persisting the derived flag.
   */
  private readClosure(taskId: string): TrackedCardDetail['closure'] & TrackedCardClosureProcessing {
    const row = this.getOne(
      `SELECT closure_conclusion, closure_by, closure_at, closure_pin_id,
              closure_processed_at, closure_processed_by, closure_processed_hash,
              closure_receipt, closure_receipt_pin_id
         FROM orchestration_tasks WHERE id = ?`,
      [taskId],
    );
    const conclusion = text(row?.closure_conclusion);
    const closureBy = text(row?.closure_by);
    return {
      conclusion,
      by: closureBy,
      at: text(row?.closure_at),
      pinId: text(row?.closure_pin_id),
      pending: isClosurePending({
        closureConclusion: conclusion,
        closureBy,
        closureProcessedHash: text(row?.closure_processed_hash),
      }),
      processedAt: text(row?.closure_processed_at),
      processedBy: (text(row?.closure_processed_by) as TrackedClosureProcessedBy | null) ?? null,
      receipt: text(row?.closure_receipt),
      receiptPinId: text(row?.closure_receipt_pin_id),
    };
  }

  private buildSummary(
    taskId: string,
    nowMs: number,
    admission: { registeredIds: Set<string>; mode: TrackedAdmissionMode; archivedIds?: Set<string> },
  ): TrackedCardSummary | null {
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

    // Admission facts, straight off the ledger and its linked tables. The two
    // EXISTS-style branches (owner-initiated, checkpoints) ignore the LIMIT 1
    // pick above on purpose — the freeze doc words them as EXISTS.
    const admissionFacts = this.getOne(
      `SELECT
         (SELECT COUNT(*) FROM group_tasks WHERE orchestration_task_id = ? AND created_by = 'user') AS owner_initiated,
         (SELECT COUNT(*) FROM group_task_checkpoints c
            JOIN group_tasks g ON g.id = c.task_id
           WHERE g.orchestration_task_id = ?) AS checkpoint_count`,
      [taskId, taskId],
    ) ?? {};
    const admissionVerdict = trackAdmission({
      registered: admission.registeredIds.has(taskId),
      stepCount: steps.length,
      groupTaskLinked: groupTaskId !== null,
      scheduledTaskLinked: scheduledTaskId !== null,
      hasDependencies: steps.some((step) => step.dependencyStepIds.length > 0),
      hasCheckpoints: Number(admissionFacts.checkpoint_count ?? 0) > 0,
      ownerInitiated: Number(admissionFacts.owner_initiated ?? 0) > 0,
      mode: admission.mode,
    });
    // v1.3 manual archive override: the DERIVATION sees the effective verdict,
    // so closureDue dies with the archive (an archived card is never queued for
    // closure) with zero second derivation. The matched rules stay on the card:
    // they are admission facts, the override is a layer on top.
    const overrideArchived = admission.archivedIds?.has(taskId) ?? false;
    const admitted = admissionVerdict.admitted && !overrideArchived;

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
      closureAt: closure.at,
      admitted,
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
      closureSuggestionParams: derivation.closureSuggestionParams,
      closureConclusion: closure.conclusion,
      closurePending: closure.pending,
      closureProcessedAt: closure.processedAt,
      closureProcessedBy: closure.processedBy,
      closureReceipt: closure.receipt,
      closureReceiptPinId: closure.receiptPinId,
      activityAtMs: derivation.lastActivityAtMs,
      lastActivityAtMs: derivation.lastActivityAtMs,
      idleMs: derivation.idleMs,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sourceSessionId: task.sourceSessionId,
      sourceKind,
      groupTaskId,
      scheduledTaskId,
      admitted,
      admissionMatched: admissionVerdict.matched,
      admissionInputMissing: derivation.admissionInputMissing,
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

/**
 * Deliverable kind, delegated to the single parser (`[SEC-11]`).
 *
 * Scheme FIRST, then the pinid token (owner 2026-09-18 反馈③): every MetaWeb
 * scheme carries a pinid in its payload, so probing the token before the
 * scheme labels `metaapp://<pinid>` as 'pin' and turns the metaapp branch into
 * dead code. Order: metaapp:// → metafile:// → pinid token → http(s):// → other.
 */
export function trackedDeliverableKind(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return 'none';
  if (trimmed.startsWith('metaapp://')) return 'metaapp';
  if (trimmed.startsWith('metafile://')) return 'metafile';
  if (extractPinidToken(trimmed)) return 'pin';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url';
  return 'other';
}

function isInsideScopeWindow(card: TrackedCardSummary, nowMs: number): boolean {
  if (card.activityAtMs === null) return true; // unknown activity is never silently hidden
  return nowMs - card.activityAtMs <= TRACKED_CARD_SCOPE_WINDOW_MS;
}
