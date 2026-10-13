/**
 * Group-task durable working-state block (host side, deterministic).
 *
 * The per-turn group prompt used to carry only the positions ledger plus a
 * status line: a worker whose assignment slid out of the 20-message group-log
 * window (an overnight restart, a long-running turn) had NO durable reminder
 * of what it owed. This block re-injects the durable truth every turn — the
 * canonical orchestration steps/attempts and the armed per-member delivery
 * clocks — so an assignment survives as long as the ledger says it is open.
 *
 * Pure + Electron-free so it is unit-testable in plain Node; the daemon
 * gathers the live rows and passes plain data in. Mirrors the format and
 * language idiom of buildGroupTaskConstraintsBlock (positions ledger): a
 * bracketed host-ledger header, one `- ` line per open entry, a closing
 * guidance line, and a budget loop that drops the least-urgent tail lines
 * first (never the header).
 */

import { truncateUtf16Units } from '../libs/llmSafeText';

/** Step statuses that no longer bind anyone (terminal or noise). */
const TERMINAL_STEP_STATUSES = new Set(['completed', 'failed', 'cancelled']);
/** Attempt statuses that still represent live work (timed_out is recoverable). */
const OPEN_ATTEMPT_STATUSES = new Set(['queued', 'running', 'timed_out']);

export const GROUP_WORKING_STATE_MAX_ENTRIES = 12;
export const GROUP_WORKING_STATE_MAX_CHARS = 2000;
export const GROUP_WORKING_STATE_OBJECTIVE_MAX_CHARS = 160;

/** One active orchestration step, flattened to prompt-ready plain data. */
export interface GroupTaskWorkingStateStep {
  ordinal: number;
  title?: string | null;
  objective?: string | null;
  status: string;
  /** Assignee display name (group roster); null when unassigned/unknown. */
  assigneeName?: string | null;
  /** ISO timestamp; parsed defensively (unparsable = no deadline). */
  deadlineAt?: string | null;
}

/** One open orchestration attempt. */
export interface GroupTaskWorkingStateAttempt {
  status: string;
  /** Owning step's ordinal when known. */
  stepOrdinal?: number | null;
  workerName?: string | null;
  /** ISO timestamps; startedAt preferred, queuedAt as the fallback label. */
  startedAt?: string | null;
  queuedAt?: string | null;
}

/** One armed per-member delivery clock (kv group_task_expected_delivery:*). */
export interface GroupTaskWorkingStateExpectedDelivery {
  memberName: string;
  /** Epoch ms deadline. */
  dueAtMs: number;
  taskDescription?: string | null;
}

export interface BuildGroupTaskWorkingStateBlockInput {
  /** Host clock (epoch ms) — decides the OVERDUE markers. */
  nowMs: number;
  steps?: GroupTaskWorkingStateStep[];
  attempts?: GroupTaskWorkingStateAttempt[];
  expectedDeliveries?: GroupTaskWorkingStateExpectedDelivery[];
  maxEntries?: number;
  maxChars?: number;
}

interface WorkingStateEntry {
  /** Sort keys: overdue first, then earliest deadline, then status rank. */
  overdue: boolean;
  deadlineMs: number;
  statusRank: number;
  /** Stable tiebreak: insertion order of the assembled entry list. */
  insertionIndex: number;
  line: string;
}

const STATUS_RANK: Record<string, number> = {
  running: 0,
  timed_out: 1,
  queued: 2,
  waiting_input: 3,
  ready: 4,
  blocked: 5,
};

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 6;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Surrogate-safe cut with an explicit ellipsis when text was actually dropped. */
function truncateWithEllipsis(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  return `${truncateUtf16Units(value, Math.max(1, maxUnits - 1))}…`;
}

/** Local minute-precision timestamp, same shape as the per-turn time line. */
function formatLocalMinute(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildGroupTaskWorkingStateBlock(
  input: BuildGroupTaskWorkingStateBlockInput,
): string {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const maxEntries = Math.max(1, Math.floor(input.maxEntries ?? GROUP_WORKING_STATE_MAX_ENTRIES));
  const cap = Math.max(200, Math.floor(input.maxChars ?? GROUP_WORKING_STATE_MAX_CHARS));

  const entries: WorkingStateEntry[] = [];
  let insertionIndex = 0;

  for (const delivery of input.expectedDeliveries ?? []) {
    const memberName = collapseWhitespace(String(delivery.memberName ?? ''));
    if (!memberName || !Number.isFinite(delivery.dueAtMs)) continue;
    const overdue = delivery.dueAtMs <= nowMs;
    const description = collapseWhitespace(String(delivery.taskDescription ?? ''));
    const line = `- ${overdue ? '[OVERDUE] ' : ''}${escapeXml(memberName)} owes a delivery`
      + (description ? `: "${escapeXml(truncateWithEllipsis(description, GROUP_WORKING_STATE_OBJECTIVE_MAX_CHARS))}"` : '')
      + ` — due ${formatLocalMinute(delivery.dueAtMs)}`;
    entries.push({
      overdue,
      deadlineMs: delivery.dueAtMs,
      statusRank: 0,
      insertionIndex: insertionIndex++,
      line,
    });
  }

  for (const step of input.steps ?? []) {
    const status = String(step.status ?? '');
    if (TERMINAL_STEP_STATUSES.has(status)) continue;
    const objective = collapseWhitespace(String(step.objective ?? step.title ?? ''));
    if (!objective) continue;
    const deadlineMs = parseIsoMs(step.deadlineAt);
    const overdue = deadlineMs != null && deadlineMs <= nowMs;
    const assignee = collapseWhitespace(String(step.assigneeName ?? ''));
    const ordinal = Number.isFinite(step.ordinal) ? `#${Math.trunc(step.ordinal)}` : '(unnumbered)';
    const line = `- ${overdue ? '[OVERDUE] ' : ''}Step ${ordinal} [${escapeXml(status)}]`
      + (assignee ? ` ${escapeXml(assignee)}:` : '')
      + ` ${escapeXml(truncateWithEllipsis(objective, GROUP_WORKING_STATE_OBJECTIVE_MAX_CHARS))}`
      + (deadlineMs != null ? ` — deadline ${formatLocalMinute(deadlineMs)}` : '');
    entries.push({
      overdue,
      deadlineMs: deadlineMs ?? Number.POSITIVE_INFINITY,
      statusRank: statusRank(status),
      insertionIndex: insertionIndex++,
      line,
    });
  }

  for (const attempt of input.attempts ?? []) {
    const status = String(attempt.status ?? '');
    if (!OPEN_ATTEMPT_STATUSES.has(status)) continue;
    const startedMs = parseIsoMs(attempt.startedAt);
    const queuedMs = parseIsoMs(attempt.queuedAt);
    const anchorMs = startedMs ?? queuedMs;
    const workerName = collapseWhitespace(String(attempt.workerName ?? ''));
    const stepOrdinal = attempt.stepOrdinal != null && Number.isFinite(attempt.stepOrdinal)
      ? `#${Math.trunc(attempt.stepOrdinal)}`
      : null;
    const line = `- Attempt [${escapeXml(status)}]`
      + (workerName ? ` ${escapeXml(workerName)}` : '')
      + (stepOrdinal ? ` on step ${stepOrdinal}` : '')
      + (anchorMs != null ? ` — ${startedMs != null ? 'started' : 'queued'} ${formatLocalMinute(anchorMs)}` : '');
    entries.push({
      overdue: false,
      deadlineMs: Number.POSITIVE_INFINITY,
      statusRank: statusRank(status),
      insertionIndex: insertionIndex++,
      line,
    });
  }

  if (entries.length === 0) return '';

  entries.sort((left, right) => {
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    if (left.deadlineMs !== right.deadlineMs) return left.deadlineMs - right.deadlineMs;
    if (left.statusRank !== right.statusRank) return left.statusRank - right.statusRank;
    return left.insertionIndex - right.insertionIndex;
  });

  const visible = entries.slice(0, maxEntries);
  const entryOmitted = entries.length - visible.length;

  const render = (lines: string[], omitted: number): string => [
    '<taskWorkingState>',
    `[Durable working state (host ledger) — assignments, open attempts and delivery clocks that still bind this task${omitted > 0 ? `; ${omitted} least-urgent line(s) omitted` : ''}:`,
    ...lines,
    'Act on them every turn: an assignment or clock clears only when its deliverable lands or the chair retracts it — never because it scrolled out of the recent message window.]',
    '</taskWorkingState>',
  ].join('\n');

  // Over budget (or over the entry cap): drop the LEAST-urgent tail lines
  // first — the sorted order puts overdue/earliest-deadline work at the head.
  let omitted = entryOmitted;
  let lines = visible.map((entry) => entry.line);
  let block = render(lines, omitted);
  while (block.length > cap && lines.length > 1) {
    lines = lines.slice(0, -1);
    omitted += 1;
    block = render(lines, omitted);
  }
  return block;
}
